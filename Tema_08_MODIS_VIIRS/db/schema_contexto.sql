-- Monitor Cinder · extensão de CONTEXTO e VALIDAÇÃO EXTERNA (INPE, Embrapa, NASA POWER).
-- Aplicar depois de schema.sql e schema_cinder.sql. Idempotente.
-- Regra: nada aqui entra no cálculo da harmonização nem da anomalia; é contexto e conferência.
\set ON_ERROR_STOP 1

-- 1) Série de referência do INPE (satélite de referência, Aqua MODIS, tarde), agregada por município e mês.
--    Uso: conferir a nossa ingestão do FIRMS (focos MODIS do Aqua) contra a série oficial brasileira.
CREATE TABLE IF NOT EXISTS fire.inpe_reference_monthly (
  region_id   bigint   NOT NULL REFERENCES fire.region(id) ON DELETE CASCADE,
  year        smallint NOT NULL CHECK (year BETWEEN 1998 AND 2100),
  month       smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  hotspots    integer  NOT NULL CHECK (hotspots >= 0),
  source_file text     NOT NULL CHECK (source_file ~ '^focos_br_ref_[0-9]{4}\.(zip|csv)$'),
  loaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, year, month)
);

-- 2) Indicadores anuais de contexto por município, um por (fonte, métrica, ano).
--    Fontes previstas: inpe_prodes (km² desmatados no Cerrado), inpe_deter (km² de alertas),
--    embrapa_satveg (NDVI médio da seca), nasa_power (vento e chuva).
CREATE TABLE IF NOT EXISTS fire.context_yearly (
  region_id  bigint   NOT NULL REFERENCES fire.region(id) ON DELETE CASCADE,
  year       smallint NOT NULL CHECK (year BETWEEN 1981 AND 2100),
  source     text     NOT NULL CHECK (source IN ('inpe_prodes', 'inpe_deter', 'embrapa_satveg', 'nasa_power')),
  metric     text     NOT NULL CHECK (metric ~ '^[a-z0-9_]{2,40}$'),
  value      double precision CHECK (value IS NULL OR value NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)), -- no PostgreSQL NaN = NaN, então a checagem é explícita
  unit       text     NOT NULL DEFAULT '' CHECK (length(unit) <= 16),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, year, source, metric)
);

-- Rótulos exibidos na interface (inglês), mantidos no banco para a API não inventar texto.
CREATE TABLE IF NOT EXISTS fire.context_metric (
  source text NOT NULL,
  metric text NOT NULL,
  label  text NOT NULL CHECK (length(label) <= 80),
  source_label text NOT NULL CHECK (length(source_label) <= 80),
  sort   smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (source, metric)
);
INSERT INTO fire.context_metric (source, metric, label, source_label, sort) VALUES
  ('inpe_prodes',    'deforestation_km2', 'PRODES Cerrado deforestation (year)', 'INPE · PRODES/TerraBrasilis', 10),
  ('inpe_deter',     'alerts_km2',        'DETER Cerrado alerts (year)',         'INPE · DETER/TerraBrasilis',  20),
  ('embrapa_satveg', 'ndvi_dry_mean',     'Mean NDVI, dry season (Jun–Sep)',     'Embrapa · SATVeg (MODIS)',    30),
  ('nasa_power',     'ws10m_dry_mean',    'Dry-season mean wind speed',          'NASA POWER (MERRA-2)',        40),
  ('nasa_power',     'precip_dry_mm',     'Dry-season precipitation',            'NASA POWER (MERRA-2)',        50)
ON CONFLICT (source, metric) DO UPDATE SET label = EXCLUDED.label, source_label = EXCLUDED.source_label, sort = EXCLUDED.sort;

-- 3) Comparação FIRMS (MODIS) × INPE por município e ano: base da frase de validação externa.
--    O FIRMS traz Terra + Aqua; o INPE de referência usa só o Aqua da tarde, então a razão esperada é < 1.
CREATE OR REPLACE FUNCTION fire.inpe_vs_firms(p_region_id bigint, p_from smallint, p_to smallint)
RETURNS TABLE (year smallint, firms_modis bigint, inpe_reference bigint, ratio numeric)
LANGUAGE sql STABLE AS $$
  SELECT c.year,
         sum(c.modis_count)::bigint,
         sum(i.hotspots)::bigint,
         round(sum(i.hotspots)::numeric / nullif(sum(c.modis_count), 0), 3)
  FROM fire.calendar_monthly c
  JOIN fire.inpe_reference_monthly i
    ON i.region_id = c.region_id AND i.year = c.year AND i.month = c.month
  WHERE c.region_id = p_region_id AND c.method = 'monthly_ratio' AND c.year BETWEEN p_from AND p_to
  GROUP BY c.year
  ORDER BY c.year;
$$;

-- Acesso da API (somente leitura).
GRANT SELECT ON fire.inpe_reference_monthly, fire.context_yearly, fire.context_metric TO fire_api_ro;
GRANT EXECUTE ON FUNCTION fire.inpe_vs_firms(bigint, smallint, smallint) TO fire_api_ro;
