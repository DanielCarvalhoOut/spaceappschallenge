-- Monitor Cinder · Extensão Operacional (A, B, C)
-- A. Harmonização MODIS (1 km) + VIIRS (375 m) + LANDSAT (30 m) via Clustering Espacial (DBSCAN / Grade H3-Polyconic)
--    & Escala de Recursos Operacionais via FRP (Fire Radiative Power, MW).
-- B. Calendário de Focos Raízes & Histórico (2000–Presente): recorrência sazonal e separação entre
--    padrões antrópicos recorrentes (focos raízes) e anomalias climáticas.
-- C. Clima Diário NASA POWER (T2M_MAX, RH2M, PRECTOTCORR, WS10M, WD10M) & Previsibilidade de Ignição e Propagação.
-- Aplicar depois de schema.sql, schema_cinder.sql e schema_contexto.sql. Idempotente.
\set ON_ERROR_STOP 1

-- 1. Ampliar catálogo de sensores para incluir LANDSAT_NRT (OLI 30m) além de MODIS e VIIRS
ALTER TABLE fire.sensor DROP CONSTRAINT IF EXISTS sensor_instrument_ck;
ALTER TABLE fire.sensor ADD CONSTRAINT sensor_instrument_ck CHECK (instrument IN ('MODIS', 'VIIRS', 'OLI'));

INSERT INTO fire.sensor (id, code, instrument, platform, pixel_m, first_year, country_folder) VALUES
  (5, 'LANDSAT', 'OLI', 'Landsat-8/9', 30, 2022, NULL)
ON CONFLICT (id) DO NOTHING;

-- 2. A. Clustering Espacial DBSCAN + Grade Comum & Escala de Recursos via FRP (MW)
-- Agrupa detecções próximas no mesmo dia (ex.: múltiplos pixels VIIRS 375 m + pixel MODIS 1 km do mesmo incêndio)
-- usando ST_ClusterDBSCAN em SRID 5880 (eps = 1000 m, minpoints = 1) para eliminar duplicidade entre satélites.
CREATE OR REPLACE FUNCTION fire.cluster_hotspots_dbscan(
  p_region_id bigint,
  p_from date,
  p_to date,
  p_eps_m double precision DEFAULT 1000.0
)
RETURNS TABLE (
  day date,
  cluster_id integer,
  centroid_lat double precision,
  centroid_lon double precision,
  cell_key bigint,
  n_detections bigint,
  sensors text[],
  modis_pixels bigint,
  viirs_pixels bigint,
  max_frp_mw real,
  sum_frp_mw real,
  mean_frp_mw real,
  max_confidence smallint
)
LANGUAGE sql STABLE AS $$
  WITH filtered AS (
    SELECT
      h.id,
      (h.acq_ts AT TIME ZONE 'UTC')::date AS day,
      s.code AS sensor_code,
      s.instrument,
      h.geom,
      coalesce(h.frp_mw, 0.0)::real AS frp_mw,
      h.confidence_norm,
      ST_ClusterDBSCAN(ST_Transform(h.geom, 5880), eps := p_eps_m, minpoints := 1)
        OVER (PARTITION BY (h.acq_ts AT TIME ZONE 'UTC')::date) AS cid
    FROM fire.hotspot h
    JOIN fire.sensor s ON s.id = h.sensor_id
    JOIN fire.region r ON r.id = p_region_id
    WHERE h.acq_ts >= p_from::timestamptz
      AND h.acq_ts < (p_to + 1)::timestamptz
      AND h.confidence_norm >= 1
      AND ST_Intersects(h.geom, r.geom)
  ),
  clustered AS (
    SELECT
      f.day,
      f.cid AS cluster_id,
      ST_Centroid(ST_Collect(f.geom)) AS center_geom,
      count(*) AS n_detections,
      array_agg(DISTINCT f.sensor_code ORDER BY f.sensor_code) AS sensors,
      count(*) FILTER (WHERE f.instrument = 'MODIS') AS modis_pixels,
      count(*) FILTER (WHERE f.instrument = 'VIIRS') AS viirs_pixels,
      max(f.frp_mw)::real AS max_frp_mw,
      sum(f.frp_mw)::real AS sum_frp_mw,
      avg(f.frp_mw)::real AS mean_frp_mw,
      max(f.confidence_norm)::smallint AS max_confidence
    FROM filtered f
    GROUP BY f.day, f.cid
  )
  SELECT
    c.day,
    c.cluster_id,
    round(ST_Y(c.center_geom)::numeric, 5)::double precision AS centroid_lat,
    round(ST_X(c.center_geom)::numeric, 5)::double precision AS centroid_lon,
    fire.cell_key(c.center_geom, 1000) AS cell_key,
    c.n_detections,
    c.sensors,
    c.modis_pixels,
    c.viirs_pixels,
    round(c.max_frp_mw::numeric, 2)::real,
    round(c.sum_frp_mw::numeric, 2)::real,
    round(c.mean_frp_mw::numeric, 2)::real,
    c.max_confidence
  FROM clustered c
  ORDER BY c.day DESC, c.max_frp_mw DESC;
$$;

-- Estimativa de Escala de Recursos Operacionais baseada em FRP (MW) e focos deduplicados
CREATE OR REPLACE FUNCTION fire.estimate_resources_by_frp(
  p_active_clusters integer,
  p_mean_frp_mw numeric,
  p_max_frp_mw numeric DEFAULT NULL
)
RETURNS TABLE (
  intensity_class text,
  total_frp_mw numeric,
  brigadistas integer,
  squads integer,
  water_liters integer,
  water_trucks integer,
  manual_kits integer,
  aircraft_support integer
)
LANGUAGE sql IMMUTABLE AS $$
  WITH calc AS (
    SELECT
      greatest(coalesce(p_active_clusters, 0), 0) AS clusters,
      greatest(coalesce(p_mean_frp_mw, 0), 0) AS mean_frp,
      greatest(coalesce(p_max_frp_mw, coalesce(p_mean_frp_mw, 0)), 0) AS peak_frp,
      round(greatest(coalesce(p_active_clusters, 0), 0) * greatest(coalesce(p_mean_frp_mw, 12.0), 1.0), 1) AS tot_frp
  )
  SELECT
    CASE
      WHEN calc.clusters = 0 THEN 'low'
      WHEN calc.peak_frp >= 150 OR calc.tot_frp >= 1500 THEN 'extreme'
      WHEN calc.peak_frp >= 50  OR calc.tot_frp >= 500  THEN 'high'
      WHEN calc.peak_frp >= 15  OR calc.tot_frp >= 120  THEN 'moderate'
      ELSE 'low'
    END AS intensity_class,
    calc.tot_frp AS total_frp_mw,
    -- Escala tática: 1 brigadista a cada ~18 MW de FRP ativo (mínimo 4 por frente ativa)
    CASE WHEN calc.clusters = 0 THEN 0
         ELSE greatest(4, ceil(calc.clusters * 2.2 + calc.tot_frp / 22.0)::int)
    END AS brigadistas,
    CASE WHEN calc.clusters = 0 THEN 0
         ELSE greatest(1, ceil((calc.clusters * 2.2 + calc.tot_frp / 22.0) / 6.0)::int)
    END AS squads,
    -- Volume estimado de água para combate direto e rescaldo: ~350 L por MW de FRP + 1.200 L por foco agrupado
    CASE WHEN calc.clusters = 0 THEN 0
         ELSE (round((calc.tot_frp * 350.0 + calc.clusters * 1200.0) / 500.0) * 500)::int
    END AS water_liters,
    -- Caminhões-pipa / autobombas (capacidade padrão de 8.000 L)
    CASE WHEN calc.clusters = 0 THEN 0
         ELSE greatest(1, ceil((calc.tot_frp * 350.0 + calc.clusters * 1200.0) / 8000.0)::int)
    END AS water_trucks,
    -- Kits de equipamentos manuais (abafadores, bombas costais 20L, sopradores, EPIs)
    CASE WHEN calc.clusters = 0 THEN 0
         ELSE greatest(4, ceil(calc.clusters * 2.5 + calc.tot_frp / 20.0)::int)
    END AS manual_kits,
    -- Aeronaves Air Tractor / helicóptero com Bambi Bucket (quando FRP extremo ou múltiplas frentes)
    CASE WHEN calc.tot_frp >= 1200 OR calc.peak_frp >= 150 THEN greatest(1, floor(calc.tot_frp / 1200.0)::int)
         ELSE 0
    END AS aircraft_support
  FROM calc;
$$;

-- 3. B. Calendário de Focos Raízes & Histórico (2000–Presente)
-- Separa recorrência sazonal antrópica (focos raízes: queima todos os anos na mesma janela do calendário)
-- de anomalias climáticas (picos z >= 1.5 fora do padrão recorrente ou em anos de seca extrema).
CREATE OR REPLACE FUNCTION fire.root_fire_analysis(
  p_region_id bigint,
  p_method text DEFAULT 'monthly_ratio',
  p_from smallint DEFAULT 2001,
  p_to smallint DEFAULT 2025
)
RETURNS TABLE (
  month smallint,
  years_observed integer,
  years_with_fire integer,
  recurrence_pct numeric,
  mean_harmonized numeric,
  sd_harmonized numeric,
  cv_ratio numeric,
  is_root_month boolean,
  pattern_regime text
)
LANGUAGE sql STABLE AS $$
  WITH stats AS (
    SELECT
      c.month,
      count(*)::int AS years_observed,
      count(*) FILTER (WHERE c.harmonized_count >= greatest(5, coalesce(c.baseline_mean * 0.35, 5)))::int AS years_with_fire,
      avg(c.harmonized_count) AS mean_h,
      stddev_samp(c.harmonized_count) AS sd_h
    FROM fire.calendar_monthly c
    WHERE c.region_id = p_region_id
      AND c.method = p_method
      AND c.year BETWEEN p_from AND p_to
    GROUP BY c.month
  ),
  overall AS (
    SELECT coalesce(avg(mean_h), 0) AS annual_monthly_avg FROM stats
  )
  SELECT
    s.month,
    s.years_observed,
    s.years_with_fire,
    round(100.0 * s.years_with_fire / nullif(s.years_observed, 0), 1) AS recurrence_pct,
    round(s.mean_h, 1) AS mean_harmonized,
    round(coalesce(s.sd_h, 0), 1) AS sd_harmonized,
    round(coalesce(s.sd_h / nullif(s.mean_h, 0), 0), 2) AS cv_ratio,
    -- Mês de foco raiz: recorrência >= 65% dos anos na série de 20+ anos e média relevante
    (100.0 * s.years_with_fire / nullif(s.years_observed, 0) >= 65.0
     AND s.mean_h >= greatest(8.0, o.annual_monthly_avg * 0.8)) AS is_root_month,
    CASE
      WHEN 100.0 * s.years_with_fire / nullif(s.years_observed, 0) >= 70.0
           AND coalesce(s.sd_h / nullif(s.mean_h, 0), 1) <= 0.85
           AND s.mean_h >= greatest(8.0, o.annual_monthly_avg * 0.8)
        THEN 'anthropogenic_root'     -- Padrão antrópico recorrente (ex.: manejo agrícola / limpeza na mesma janela)
      WHEN 100.0 * s.years_with_fire / nullif(s.years_observed, 0) >= 50.0
           AND coalesce(s.sd_h / nullif(s.mean_h, 0), 0) > 0.85
        THEN 'root_with_climate_spikes' -- Foco raiz crônico amplificado por anomalias climáticas
      WHEN s.mean_h >= greatest(5.0, o.annual_monthly_avg * 0.5)
        THEN 'climatic_anomaly_driven' -- Ocorrência episódica comandada por secas/ondas de calor
      ELSE 'low_activity'
    END AS pattern_regime
  FROM stats s
  CROSS JOIN overall o
  ORDER BY s.month;
$$;

-- 4. C. Clima Diário NASA POWER (T2M_MAX, RH2M, PRECTOTCORR, WS10M, WD10M) & Risco/Propagação
CREATE TABLE IF NOT EXISTS fire.weather_daily_power (
  region_id    bigint   NOT NULL REFERENCES fire.region(id) ON DELETE CASCADE,
  day          date     NOT NULL,
  t2m_max_c    real     CHECK (t2m_max_c IS NULL OR t2m_max_c BETWEEN -50 AND 65),
  rh2m_pct     real     CHECK (rh2m_pct IS NULL OR rh2m_pct BETWEEN 0 AND 100),
  prectotcorr_mm real   CHECK (prectotcorr_mm IS NULL OR prectotcorr_mm >= 0),
  ws10m_ms     real     CHECK (ws10m_ms IS NULL OR ws10m_ms >= 0),
  wd10m_deg    real     CHECK (wd10m_deg IS NULL OR wd10m_deg BETWEEN 0 AND 360),
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, day)
);

-- Adicionar métricas climáticas essenciais do NASA POWER na tabela fire.context_metric
INSERT INTO fire.context_metric (source, metric, label, source_label, sort) VALUES
  ('nasa_power', 't2m_max_dry_c',  'Max temperature, dry season (T2M_MAX)', 'NASA POWER (MERRA-2)', 35),
  ('nasa_power', 'rh2m_dry_pct',   'Relative humidity, dry season (RH2M)',  'NASA POWER (MERRA-2)', 38),
  ('nasa_power', 'wd10m_dry_deg',  'Prevailing wind direction (WD10M)',     'NASA POWER (MERRA-2)', 45)
ON CONFLICT (source, metric) DO UPDATE
  SET label = EXCLUDED.label, source_label = EXCLUDED.source_label, sort = EXCLUDED.sort;

-- Função de Risco de Ignição e Vetor de Propagação combinando NASA POWER + Histórico de Focos Raízes
CREATE OR REPLACE FUNCTION fire.calculate_fire_predictability(
  p_t2m_max_c numeric,
  p_rh2m_pct numeric,
  p_precip_mm numeric,
  p_ws10m_ms numeric,
  p_wd10m_deg numeric,
  p_root_recurrence_pct numeric DEFAULT 50.0
)
RETURNS TABLE (
  ignition_risk_score numeric,
  ignition_risk_Class text,
  propagation_azimuth_deg numeric,
  propagation_cardinal text,
  spread_rate_kmh numeric
)
LANGUAGE sql IMMUTABLE AS $$
  WITH factors AS (
    SELECT
      -- Fator térmico (0..30 pts): cresce entre 24°C e 42°C
      least(30.0, greatest(0.0, (coalesce(p_t2m_max_c, 30.0) - 22.0) * 1.5)) AS temp_pts,
      -- Fator de secura / baixa umidade relativa (0..30 pts): crítico abaixo de 30% RH
      least(30.0, greatest(0.0, (80.0 - coalesce(p_rh2m_pct, 45.0)) * 0.5)) AS rh_pts,
      -- Fator de déficit de precipitação (0..15 pts)
      least(15.0, greatest(0.0, 15.0 - coalesce(p_precip_mm, 0.0) * 1.2)) AS rain_pts,
      -- Fator eólico (0..10 pts)
      least(10.0, greatest(0.0, coalesce(p_ws10m_ms, 2.5) * 1.4)) AS wind_pts,
      -- Fator de memória histórica / foco raiz (0..15 pts)
      least(15.0, greatest(0.0, coalesce(p_root_recurrence_pct, 50.0) * 0.15)) AS hist_pts,
      -- Azimute para onde o fogo se propaga = (WD10M + 180) mod 360
      mod((coalesce(p_wd10m_deg, 90.0) + 180.0)::numeric, 360.0) AS prop_deg,
      greatest(0.1, coalesce(p_ws10m_ms, 2.5)) AS ws,
      greatest(10.0, coalesce(p_rh2m_pct, 45.0)) AS rh
  ),
  scored AS (
    SELECT
      round(least(100.0, greatest(0.0, temp_pts + rh_pts + rain_pts + wind_pts + hist_pts)), 1) AS score,
      round(prop_deg, 0) AS az_deg,
      -- Velocidade estimada de propagação (km/h) no Cerrado/pastagem em função do vento e umidade
      round((0.18 * ws * (1.0 + greatest(0.0, (60.0 - rh)) / 45.0))::numeric, 2) AS rate_kmh
    FROM factors
  )
  SELECT
    s.score AS ignition_risk_score,
    CASE
      WHEN s.score >= 80 THEN 'extreme'
      WHEN s.score >= 60 THEN 'high'
      WHEN s.score >= 40 THEN 'moderate'
      ELSE 'low'
    END AS ignition_risk_class,
    s.az_deg AS propagation_azimuth_deg,
    (ARRAY['N','NE','E','SE','S','SW','W','NW'])[floor(((s.az_deg + 22.5) % 360) / 45.0)::int + 1] AS propagation_cardinal,
    s.rate_kmh AS spread_rate_kmh
  FROM scored s;
$$;

GRANT SELECT ON fire.weather_daily_power TO fire_api_ro;
GRANT EXECUTE ON FUNCTION
  fire.cluster_hotspots_dbscan(bigint, date, date, double precision),
  fire.estimate_resources_by_frp(integer, numeric, numeric),
  fire.root_fire_analysis(bigint, text, smallint, smallint),
  fire.calculate_fire_predictability(numeric, numeric, numeric, numeric, numeric, numeric)
TO fire_api_ro;
