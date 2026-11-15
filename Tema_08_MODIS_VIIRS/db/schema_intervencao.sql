-- Tema 8 · Intervenções declaradas (aplicar depois de schema_projecao.sql)
--
-- Uma intervenção é algo que alguém declara ter feito num município (brigada, aceiro, campanha, queima prescrita
-- autorizada…), com data, tipo, fonte e quem cadastrou. O Monitor Cinder só compara os focos antes e depois na mesma
-- janela sazonal e contra o nível esperado pelo modelo. O resultado é uma ASSOCIAÇÃO, nunca o efeito da intervenção.
-- A API (fire_api_ro) só lê. Sem banco, a API lê monitor-cinder/api/seed/interventions.json com os mesmos campos.

CREATE TABLE IF NOT EXISTS fire.intervention (
    id             bigserial   PRIMARY KEY,
    region_id      bigint      NOT NULL REFERENCES fire.region (id),
    happened_on    date        NOT NULL,
    kind           text        NOT NULL,
    source_ref     text        NOT NULL,            -- fonte ou URL pública que comprova a declaração
    registered_by  text        NOT NULL,            -- quem cadastrou (nome de órgão ou equipe; sem dado de contato)
    registered_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT intervention_date_ck   CHECK (happened_on >= DATE '2000-11-01' AND happened_on <= CURRENT_DATE),
    CONSTRAINT intervention_kind_ck   CHECK (char_length(btrim(kind)) BETWEEN 2 AND 80),
    CONSTRAINT intervention_source_ck CHECK (char_length(btrim(source_ref)) BETWEEN 3 AND 300),
    CONSTRAINT intervention_who_ck    CHECK (char_length(btrim(registered_by)) BETWEEN 2 AND 120 AND registered_by !~ '@'),
    CONSTRAINT intervention_ux        UNIQUE (region_id, happened_on, kind)
);
CREATE INDEX IF NOT EXISTS intervention_region_ix ON fire.intervention (region_id, happened_on);

-- Antes e depois na mesma janela sazonal (maio–outubro por padrão), com o n de anos de cada lado.
-- "Antes" = até 3 temporadas anteriores; "depois" = todas as temporadas completas seguintes já carregadas.
CREATE OR REPLACE FUNCTION fire.intervention_before_after(p_intervention_id bigint,
                                                          p_month_from smallint DEFAULT 5,
                                                          p_month_to smallint DEFAULT 10,
                                                          p_before_years smallint DEFAULT 3)
RETURNS TABLE (first_season_after smallint, before_mean numeric, before_n integer, after_mean numeric, after_n integer)
LANGUAGE sql STABLE AS $$
    WITH i AS (
        SELECT region_id,
               (CASE WHEN extract(month FROM happened_on) < p_month_from
                     THEN extract(year FROM happened_on) ELSE extract(year FROM happened_on) + 1 END)::smallint AS first_after,
               extract(year FROM happened_on)::smallint AS yr,
               extract(month FROM happened_on)::smallint AS mo
        FROM fire.intervention WHERE id = p_intervention_id
    ), season AS (
        SELECT c.year, sum(c.harmonized_count) AS total, count(*) AS months
        FROM fire.calendar_monthly c JOIN i ON c.region_id = i.region_id
        WHERE c.month BETWEEN p_month_from AND p_month_to
        GROUP BY c.year
        HAVING count(*) = p_month_to - p_month_from + 1
    )
    SELECT i.first_after,
           round(avg(s.total) FILTER (WHERE s.year < i.first_after AND s.year >= i.first_after - p_before_years
                                        AND NOT (s.year = i.yr AND i.mo >= p_month_from)), 1),
           count(*) FILTER (WHERE s.year < i.first_after AND s.year >= i.first_after - p_before_years
                              AND NOT (s.year = i.yr AND i.mo >= p_month_from))::integer,
           round(avg(s.total) FILTER (WHERE s.year >= i.first_after), 1),
           count(*) FILTER (WHERE s.year >= i.first_after)::integer
    FROM i LEFT JOIN season s ON true
    GROUP BY i.first_after;
$$;

GRANT SELECT ON fire.intervention TO fire_api_ro;
GRANT EXECUTE ON FUNCTION fire.intervention_before_after(bigint, smallint, smallint, smallint) TO fire_api_ro;
