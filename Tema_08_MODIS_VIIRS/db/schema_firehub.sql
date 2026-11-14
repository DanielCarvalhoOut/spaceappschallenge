-- FireHub · extensão do banco do tema 8 (rodar DEPOIS de schema.sql)
-- PostgreSQL 15+ com PostGIS.
--
-- O que acrescenta:
--   * Padrão histórico por região: participação de cada mês nos focos, pico e "época típica de fogo".
--   * Linha de base e anomalia no calendário (quanto o mês atual foge do normal).
--   * Regras de alerta e eventos de alerta para gestores (entrega simulada no MVP).
--   * Contexto de vegetação: cobertura da terra MODIS MCD12Q1 (IGBP, 500 m, anual) por célula da grade.
--
-- Nada aqui prevê o futuro: tudo é estatística descritiva sobre a série harmonizada.

-- 1. Padrão sazonal ---------------------------------------------------------------
-- Média por mês do ano, participação no total anual e posição (1 = mês com mais focos).
CREATE OR REPLACE FUNCTION fire.seasonal_pattern(p_region_id bigint, p_method text, p_from smallint, p_to smallint)
RETURNS TABLE (month smallint, mean_count numeric, sd_count numeric, share_pct numeric, rank_in_year integer, years_used bigint)
LANGUAGE sql STABLE AS $$
    WITH m AS (
        SELECT c.month, avg(c.harmonized_count) AS mean_count, stddev_samp(c.harmonized_count) AS sd_count,
               count(*) AS years_used
        FROM fire.calendar_monthly c
        WHERE c.region_id = p_region_id AND c.method = p_method AND c.year BETWEEN p_from AND p_to
        GROUP BY c.month
    )
    SELECT m.month, round(m.mean_count, 1), round(m.sd_count, 1),
           round(100 * m.mean_count / nullif(sum(m.mean_count) OVER (), 0), 1),
           rank() OVER (ORDER BY m.mean_count DESC)::int,
           m.years_used
    FROM m
    ORDER BY m.month
$$;

-- Época típica de fogo: os meses de maior média que, somados, chegam a p_share_pct do total.
CREATE OR REPLACE FUNCTION fire.fire_season(p_region_id bigint, p_method text, p_from smallint, p_to smallint,
                                            p_share_pct numeric DEFAULT 80)
RETURNS TABLE (months smallint[], covered_pct numeric, peak_month smallint)
LANGUAGE sql STABLE AS $$
    WITH p AS (SELECT * FROM fire.seasonal_pattern(p_region_id, p_method, p_from, p_to)),
    acc AS (
        SELECT p.month, p.share_pct, p.rank_in_year,
               sum(p.share_pct) OVER (ORDER BY p.rank_in_year, p.month) AS cum,
               coalesce(sum(p.share_pct) OVER (ORDER BY p.rank_in_year, p.month
                                               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS cum_before
        FROM p
    )
    SELECT array_agg(month ORDER BY month), max(cum),
           (SELECT month FROM p ORDER BY rank_in_year, month LIMIT 1)
    FROM acc
    WHERE cum_before < least(greatest(p_share_pct, 1), 100)
$$;

-- 2. Linha de base e anomalia --------------------------------------------------------
-- Preenche baseline_mean, baseline_sd e anomaly_z no calendário de uma região,
-- usando o mesmo mês do ano no período de referência [p_base_from, p_base_to].
CREATE OR REPLACE FUNCTION fire.refresh_baseline(p_region_id bigint, p_method text, p_base_from smallint, p_base_to smallint)
RETURNS integer
LANGUAGE sql VOLATILE AS $$
    WITH b AS (
        SELECT month, avg(harmonized_count) AS mu, stddev_samp(harmonized_count) AS sd
        FROM fire.calendar_monthly
        WHERE region_id = p_region_id AND method = p_method AND year BETWEEN p_base_from AND p_base_to
        GROUP BY month
    ),
    u AS (
        UPDATE fire.calendar_monthly c
        SET baseline_mean = round(b.mu, 2),
            baseline_sd   = round(b.sd, 2),
            anomaly_z     = CASE WHEN b.sd > 0 THEN round((c.harmonized_count - b.mu) / b.sd, 2) END,
            computed_at   = now()
        FROM b
        WHERE c.region_id = p_region_id AND c.method = p_method AND c.month = b.month
        RETURNING 1
    )
    SELECT count(*)::int FROM u
$$;

-- 3. Alertas para gestores ----------------------------------------------------------
-- Contatos são dado pessoal: tabela separada, sem acesso do papel de leitura da API.
CREATE TABLE fire.stakeholder (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    role        text NOT NULL CHECK (role IN ('brigada', 'defesa_civil', 'prefeitura', 'orgao_ambiental', 'pesquisa', 'outro')),
    channel     text NOT NULL CHECK (channel IN ('email', 'webhook', 'demo')),
    contact     text NOT NULL CHECK (length(contact) <= 320),   -- e-mail ou URL https do webhook
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stakeholder_webhook_https_ck CHECK (channel <> 'webhook' OR contact ~ '^https://')
);

CREATE TABLE fire.alert_rule (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stakeholder_id  bigint   NOT NULL REFERENCES fire.stakeholder (id) ON DELETE CASCADE,
    region_id       bigint   NOT NULL REFERENCES fire.region (id) ON DELETE CASCADE,
    method          text     NOT NULL DEFAULT 'monthly_ratio',
    min_anomaly_z   numeric  NOT NULL DEFAULT 1.5 CHECK (min_anomaly_z BETWEEN 0.5 AND 5),
    min_count       numeric  NOT NULL DEFAULT 10 CHECK (min_count >= 0),     -- evita alertar meses quase sem fogo
    active          boolean  NOT NULL DEFAULT true,
    UNIQUE (stakeholder_id, region_id, method)
);

CREATE TABLE fire.alert_event (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_id         bigint   NOT NULL REFERENCES fire.alert_rule (id) ON DELETE CASCADE,
    region_id       bigint   NOT NULL REFERENCES fire.region (id) ON DELETE CASCADE,
    year            smallint NOT NULL,
    month           smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
    harmonized_count numeric NOT NULL,
    baseline_mean   numeric,
    anomaly_z       numeric  NOT NULL,
    message         text     NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz,                                   -- null = pendente; no MVP a entrega é simulada
    UNIQUE (rule_id, year, month)                                  -- um alerta por regra e mês (idempotente)
);

-- Gera os alertas de um mês a partir do calendário já com anomalia. Pode rodar várias vezes.
CREATE OR REPLACE FUNCTION fire.evaluate_alerts(p_year smallint, p_month smallint)
RETURNS integer
LANGUAGE sql VOLATILE AS $$
    WITH ins AS (
        INSERT INTO fire.alert_event (rule_id, region_id, year, month, harmonized_count, baseline_mean, anomaly_z, message)
        SELECT r.id, c.region_id, c.year, c.month, c.harmonized_count, c.baseline_mean, c.anomaly_z,
               format('%s: %s/%s com %s focos harmonizados, %s desvios-padrão acima do padrão histórico (média %s).',
                      g.name, lpad(c.month::text, 2, '0'), c.year, round(c.harmonized_count), round(c.anomaly_z, 1),
                      round(c.baseline_mean))
        FROM fire.alert_rule r
        JOIN fire.calendar_monthly c ON c.region_id = r.region_id AND c.method = r.method
        JOIN fire.region g ON g.id = r.region_id
        WHERE r.active AND c.year = p_year AND c.month = p_month
          AND c.anomaly_z >= r.min_anomaly_z AND c.harmonized_count >= r.min_count
          AND c.days_missing <= 5                                   -- mês com muitos dias sem satélite não gera alerta
        ON CONFLICT (rule_id, year, month) DO NOTHING
        RETURNING 1
    )
    SELECT count(*)::int FROM ins
$$;

-- 4. Contexto de vegetação (MCD12Q1, IGBP) ------------------------------------------------
CREATE TABLE fire.land_cover_class (
    code   smallint PRIMARY KEY,
    name   text NOT NULL,
    group_pt text NOT NULL
);
INSERT INTO fire.land_cover_class VALUES
 (1,'Evergreen Needleleaf Forests','Floresta'),(2,'Evergreen Broadleaf Forests','Floresta'),
 (3,'Deciduous Needleleaf Forests','Floresta'),(4,'Deciduous Broadleaf Forests','Floresta'),
 (5,'Mixed Forests','Floresta'),(6,'Closed Shrublands','Arbustiva'),(7,'Open Shrublands','Arbustiva'),
 (8,'Woody Savannas','Savana (cerrado)'),(9,'Savannas','Savana (cerrado)'),(10,'Grasslands','Campo / pastagem'),
 (11,'Permanent Wetlands','Área úmida'),(12,'Croplands','Agricultura'),(13,'Urban and Built-up Lands','Urbano'),
 (14,'Cropland/Natural Vegetation Mosaics','Mosaico agrícola'),(15,'Permanent Snow and Ice','Gelo'),
 (16,'Barren','Solo exposto'),(17,'Water Bodies','Água');

-- Classe dominante de cada célula de 1 km por ano (amostrada do MCD12Q1 de 500 m na ingestão).
CREATE TABLE fire.cell_land_cover (
    cell_key    bigint   NOT NULL,
    year        smallint NOT NULL CHECK (year BETWEEN 2001 AND 2100),
    class_code  smallint NOT NULL REFERENCES fire.land_cover_class (code),
    PRIMARY KEY (cell_key, year)
);

-- Focos por tipo de vegetação numa região e período (contexto, não causa).
CREATE OR REPLACE FUNCTION fire.fires_by_land_cover(p_region_id bigint, p_from date, p_to date)
RETURNS TABLE (group_pt text, cell_days bigint, share_pct numeric)
LANGUAGE sql STABLE AS $$
    WITH f AS (
        SELECT coalesce(k.group_pt, 'Sem classe') AS group_pt, count(*) AS n
        FROM fire.hotspot_cell_day h
        JOIN fire.region r ON r.id = p_region_id AND ST_Intersects(h.geom, r.geom)
        LEFT JOIN fire.cell_land_cover lc
               ON lc.cell_key = h.cell_key
              AND lc.year = least(greatest(extract(year FROM h.day)::int, 2001), 2024)  -- MCD12Q1 v6.1: 2001 a 2024
        LEFT JOIN fire.land_cover_class k ON k.code = lc.class_code
        WHERE h.day >= p_from AND h.day < p_to AND h.instrument = 'VIIRS'
        GROUP BY 1
    )
    SELECT group_pt, n, round(100.0 * n / nullif(sum(n) OVER (), 0), 1)
    FROM f
    ORDER BY n DESC
$$;

-- 5. Acesso -------------------------------------------------------------------------
GRANT SELECT ON fire.land_cover_class, fire.cell_land_cover TO fire_api_ro;
GRANT SELECT (id, region_id, year, month, harmonized_count, baseline_mean, anomaly_z, message, created_at)
    ON fire.alert_event TO fire_api_ro;
GRANT EXECUTE ON FUNCTION fire.seasonal_pattern(bigint, text, smallint, smallint),
                          fire.fire_season(bigint, text, smallint, smallint, numeric),
                          fire.fires_by_land_cover(bigint, date, date) TO fire_api_ro;
-- fire.stakeholder e fire.alert_rule: sem acesso para a API pública (dados pessoais).
-- refresh_baseline e evaluate_alerts: só o worker de ingestão executa.
REVOKE EXECUTE ON FUNCTION fire.refresh_baseline(bigint, text, smallint, smallint),
                           fire.evaluate_alerts(smallint, smallint) FROM PUBLIC;
