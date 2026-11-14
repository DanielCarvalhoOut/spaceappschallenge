-- FireHub / Monitor Cinder · Normalização calculada, validação do erro e projeção empírica.
-- Aplicar depois de schema.sql, schema_firehub.sql, schema_contexto.sql e schema_operacional.sql. Idempotente.
--
-- Paradigma: projeção empírica a partir do histórico, sempre testada no passado (retroprojeção com origem móvel).
--   1. Normalização: confiança (normalize_confidence) → grade comum de 1 km → fator VIIRS÷MODIS por mês,
--      CALCULADO da sobreposição dos dois sensores (nunca fixo no código), com encolhimento em direção ao estado.
--   2. Validação do erro da harmonização: calibra 2012–2019, testa 2020–2025 (WAPE, MAPE, Pearson, viés).
--   3. Projeção: faixa P10/P50/P90 do mesmo mês nos anos anteriores (climatologia empírica), anos análogos,
--      encolhimento para áreas pequenas; retroprojeção mede cobertura, erro e ganho sobre a persistência.
--   4. Focos-raiz: recorrência por célula (1 km harmonizado; 500 m só VIIRS 2012+), com vizinhança 3×3 e
--      exclusão de fontes fixas de calor (indústrias, usinas).
--   5. Histórico exato dentro de um raio.
-- Vocabulário: "faixa esperada" e "frequência histórica". Nada aqui é modelo nem atribui causa.
\set ON_ERROR_STOP 1

-- 0. Utilitários ---------------------------------------------------------------------------------------
-- Centro de uma célula da grade (inverso de fire.cell_key), em SRID 5880.
CREATE OR REPLACE FUNCTION fire.cell_center_5880(p_key bigint, p_size_m integer DEFAULT 1000)
RETURNS geometry LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT ST_SetSRID(ST_MakePoint(
           ((p_key / 100000000) - 10000000) * p_size_m + p_size_m / 2.0,
           ((p_key % 100000000) - 50000000) * p_size_m + p_size_m / 2.0), 5880)
$$;

-- Muda a resolução de uma chave de célula sem reprojetar: índice grosso = floor(índice fino × fino / grosso).
-- Exato porque as resoluções usadas são múltiplas umas das outras (500, 1000, 2000, 5000, 10000 m).
CREATE OR REPLACE FUNCTION fire.cell_key_coarsen(p_key bigint, p_from_m integer, p_to_m integer)
RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$   -- sem STRICT: assim o planejador embute a expressão (sem chamada por linha)
  SELECT CASE WHEN p_from_m = p_to_m THEN p_key ELSE
    ((floor((((p_key / 100000000) - 10000000) * p_from_m)::numeric / p_to_m)::bigint + 10000000) * 100000000)
    + (floor((((p_key % 100000000) - 50000000) * p_from_m)::numeric / p_to_m)::bigint + 50000000) END
$$;

CREATE OR REPLACE FUNCTION fire.uf_region_id(p_ibge text DEFAULT '52')
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT id FROM fire.region WHERE kind = 'uf' AND ibge_code = p_ibge
$$;

-- 1. Fontes fixas de calor (não são queimadas) ----------------------------------------------------------
-- Regra: célula de 1 km com fogo em 8+ meses distintos do ano em pelo menos 3 anos, ou marcada pelo FIRMS
-- como "static land source" (type = 2) na maioria das detecções.
CREATE TABLE IF NOT EXISTS fire.static_cell (
  cell_key  bigint PRIMARY KEY,
  reason    text NOT NULL CHECK (reason IN ('year_round', 'firms_type_static')),
  years_flagged smallint,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION fire.build_static_cells(p_min_months smallint DEFAULT 8, p_min_years smallint DEFAULT 3)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM fire.static_cell;
  INSERT INTO fire.static_cell (cell_key, reason, years_flagged)
  SELECT cell_key, 'year_round', count(*)::smallint
  FROM (
    SELECT cell_key, extract(year FROM day) AS y
    FROM fire.hotspot_cell_day
    GROUP BY 1, 2
    HAVING count(DISTINCT extract(month FROM day)) >= p_min_months
  ) t
  GROUP BY cell_key
  HAVING count(*) >= p_min_years;

  INSERT INTO fire.static_cell (cell_key, reason)
  SELECT fire.cell_key(h.geom), 'firms_type_static'
  FROM fire.hotspot h
  WHERE h.fire_type IS NOT NULL
  GROUP BY 1
  HAVING avg((h.fire_type = 2)::int) > 0.5
  ON CONFLICT (cell_key) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN (SELECT count(*) FROM fire.static_cell);
END $$;

-- 2. Célula → município e contagens mensais por região -----------------------------------------------
CREATE TABLE IF NOT EXISTS fire.cell_region (
  cell_key  bigint NOT NULL,
  region_id bigint NOT NULL REFERENCES fire.region (id) ON DELETE CASCADE,
  PRIMARY KEY (cell_key, region_id)
);
CREATE INDEX IF NOT EXISTS cell_region_region_ix ON fire.cell_region (region_id);

CREATE TABLE IF NOT EXISTS fire.region_month_counts (
  region_id  bigint   NOT NULL REFERENCES fire.region (id) ON DELETE CASCADE,
  year       smallint NOT NULL,
  month      smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  instrument text     NOT NULL CHECK (instrument IN ('MODIS', 'VIIRS')),
  cell_days  integer  NOT NULL CHECK (cell_days >= 0),
  PRIMARY KEY (region_id, year, month, instrument)
);

-- Anos efetivamente carregados por instrumento (para distinguir "zero focos" de "sem dado").
CREATE TABLE IF NOT EXISTS fire.loaded_year (
  instrument text     NOT NULL CHECK (instrument IN ('MODIS', 'VIIRS')),
  year       smallint NOT NULL,
  PRIMARY KEY (instrument, year)
);

CREATE OR REPLACE FUNCTION fire.build_region_counts()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  -- célula → municípios e UF pelo centro da célula (cada célula conta uma vez por região)
  DELETE FROM fire.cell_region;
  INSERT INTO fire.cell_region (cell_key, region_id)
  SELECT c.cell_key, r.id
  FROM (SELECT DISTINCT cell_key FROM fire.hotspot_cell_day) c
  JOIN fire.region r
    ON r.kind IN ('uf', 'municipio')
   AND ST_Intersects(r.geom, ST_Transform(fire.cell_center_5880(c.cell_key), 4326));

  DELETE FROM fire.loaded_year;
  INSERT INTO fire.loaded_year (instrument, year)
  SELECT DISTINCT s.instrument, extract(year FROM b.period_start)::smallint
  FROM fire.ingest_batch b JOIN fire.sensor s ON s.id = b.sensor_id
  WHERE s.code IN ('MODIS', 'VIIRS_SNPP');

  DELETE FROM fire.region_month_counts;
  INSERT INTO fire.region_month_counts (region_id, year, month, instrument, cell_days)
  SELECT cr.region_id, extract(year FROM d.day)::smallint, extract(month FROM d.day)::smallint, d.instrument, count(*)
  FROM fire.hotspot_cell_day d
  JOIN fire.cell_region cr ON cr.cell_key = d.cell_key
  WHERE NOT EXISTS (SELECT 1 FROM fire.static_cell s WHERE s.cell_key = d.cell_key)
  GROUP BY 1, 2, 3, 4;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Série mensal completa de uma região (zeros explícitos nos anos carregados; NULL se o ano não foi carregado).
CREATE OR REPLACE FUNCTION fire.region_monthly_series(p_region_id bigint, p_from smallint DEFAULT 2000, p_to smallint DEFAULT 2026)
RETURNS TABLE (year smallint, month smallint, modis integer, viirs integer)
LANGUAGE sql STABLE AS $$
  SELECT y::smallint, m::smallint,
         CASE WHEN EXISTS (SELECT 1 FROM fire.loaded_year l WHERE l.instrument = 'MODIS' AND l.year = y)
              THEN coalesce((SELECT c.cell_days FROM fire.region_month_counts c
                             WHERE c.region_id = p_region_id AND c.year = y AND c.month = m AND c.instrument = 'MODIS'), 0) END,
         CASE WHEN EXISTS (SELECT 1 FROM fire.loaded_year l WHERE l.instrument = 'VIIRS' AND l.year = y)
              THEN coalesce((SELECT c.cell_days FROM fire.region_month_counts c
                             WHERE c.region_id = p_region_id AND c.year = y AND c.month = m AND c.instrument = 'VIIRS'), 0) END
  FROM generate_series(p_from::int, p_to::int) y, generate_series(1, 12) m
  WHERE EXISTS (SELECT 1 FROM fire.loaded_year l WHERE l.year = y)
$$;

-- 3. Fator de harmonização calculado (VIIRS ÷ MODIS por mês), com encolhimento para o estado ---------
-- w = MODIS_região / (MODIS_região + k): áreas com poucos focos herdam o fator do estado.
CREATE OR REPLACE FUNCTION fire.harmonization_factors(p_region_id bigint, p_calib_from smallint, p_calib_to smallint,
                                                      p_shrink_k numeric DEFAULT 30)
RETURNS TABLE (month smallint, factor numeric, weight numeric, modis_sum bigint, viirs_sum bigint, n_years integer)
LANGUAGE sql STABLE AS $$
  WITH uf AS (
    SELECT s.month, sum(s.modis) AS m, sum(s.viirs) AS v
    FROM fire.region_monthly_series(fire.uf_region_id(), p_calib_from, p_calib_to) s
    WHERE s.modis IS NOT NULL AND s.viirs IS NOT NULL
    GROUP BY s.month
  ),
  uf_all AS (SELECT sum(v)::numeric / nullif(sum(m), 0) AS ratio FROM uf),
  reg AS (
    SELECT s.month, sum(s.modis) AS m, sum(s.viirs) AS v, count(*) AS ny
    FROM fire.region_monthly_series(p_region_id, p_calib_from, p_calib_to) s
    WHERE s.modis IS NOT NULL AND s.viirs IS NOT NULL
    GROUP BY s.month
  )
  SELECT reg.month,
         round(CASE
           WHEN p_region_id = fire.uf_region_id() THEN coalesce(reg.v::numeric / nullif(reg.m, 0), (SELECT ratio FROM uf_all))
           ELSE (reg.m / (reg.m + p_shrink_k)) * coalesce(reg.v::numeric / nullif(reg.m, 0), 0)
              + (p_shrink_k / (reg.m + p_shrink_k)) * coalesce(uf.v::numeric / nullif(uf.m, 0), (SELECT ratio FROM uf_all))
         END, 4),
         round(CASE WHEN p_region_id = fire.uf_region_id() THEN 1 ELSE reg.m / (reg.m + p_shrink_k) END, 4),
         reg.m::bigint, reg.v::bigint, reg.ny::int
  FROM reg LEFT JOIN uf ON uf.month = reg.month
$$;

CREATE OR REPLACE FUNCTION fire.compute_harmonization(p_region_id bigint, p_calib_from smallint DEFAULT 2012,
                                                      p_calib_to smallint DEFAULT 2025, p_shrink_k numeric DEFAULT 30)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  INSERT INTO fire.harmonization_factor (region_id, method, month, factor, calib_from, calib_to, n_years, notes)
  SELECT p_region_id, 'monthly_ratio', f.month, greatest(f.factor, 0.01), p_calib_from, p_calib_to, f.n_years,
         format('VIIRS/MODIS cell-days; shrink weight %s (MODIS=%s, VIIRS=%s)', f.weight, f.modis_sum, f.viirs_sum)
  FROM fire.harmonization_factors(p_region_id, p_calib_from, p_calib_to, p_shrink_k) f
  ON CONFLICT ON CONSTRAINT harm_unique DO UPDATE
    SET factor = EXCLUDED.factor, calib_from = EXCLUDED.calib_from, calib_to = EXCLUDED.calib_to,
        n_years = EXCLUDED.n_years, notes = EXCLUDED.notes, computed_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- 4. Validação do erro da harmonização (dados separados) ----------------------------------------------
-- Calibra no período 1, aplica o fator ao MODIS do período 2 e compara com o VIIRS real do período 2.
CREATE OR REPLACE FUNCTION fire.validate_harmonization(p_region_id bigint,
    p_calib_from smallint DEFAULT 2012, p_calib_to smallint DEFAULT 2019,
    p_test_from smallint DEFAULT 2020, p_test_to smallint DEFAULT 2025, p_shrink_k numeric DEFAULT 30)
RETURNS TABLE (n_months integer, wape_pct numeric, mape_pct numeric, pearson_r numeric, bias_pct numeric,
               sum_predicted numeric, sum_actual numeric)
LANGUAGE sql STABLE AS $$
  WITH f AS (SELECT month, factor FROM fire.harmonization_factors(p_region_id, p_calib_from, p_calib_to, p_shrink_k)),
  t AS (
    SELECT s.year, s.month, s.modis * f.factor AS pred, s.viirs::numeric AS actual
    FROM fire.region_monthly_series(p_region_id, p_test_from, p_test_to) s
    JOIN f ON f.month = s.month
    WHERE s.modis IS NOT NULL AND s.viirs IS NOT NULL
  )
  SELECT count(*)::int,
         round(100 * sum(abs(pred - actual)) / nullif(sum(actual), 0), 1),
         round(100 * avg(abs(pred - actual) / actual) FILTER (WHERE actual >= 10), 1),
         round(corr(pred, actual)::numeric, 3),
         round(100 * (sum(pred) - sum(actual)) / nullif(sum(actual), 0), 1),
         round(sum(pred), 1), sum(actual)
  FROM t
$$;

-- 5. Calendário harmonizado (VIIRS a partir de 2012; MODIS × fator antes) -------------------------------
CREATE OR REPLACE FUNCTION fire.build_calendar(p_region_id bigint, p_from smallint DEFAULT 2001, p_to smallint DEFAULT 2026,
                                               p_base_from smallint DEFAULT 2002, p_base_to smallint DEFAULT 2024)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  INSERT INTO fire.calendar_monthly (region_id, method, year, month, modis_count, viirs_count, harmonized_count)
  SELECT p_region_id, 'monthly_ratio', s.year, s.month, s.modis, s.viirs,
         CASE WHEN s.viirs IS NOT NULL AND s.year >= 2012 THEN s.viirs
              ELSE round(s.modis * coalesce(h.factor, 1), 1) END
  FROM fire.region_monthly_series(p_region_id, p_from, p_to) s
  LEFT JOIN fire.harmonization_factor h ON h.region_id = p_region_id AND h.method = 'monthly_ratio' AND h.month = s.month
  WHERE s.viirs IS NOT NULL OR s.modis IS NOT NULL
  ON CONFLICT (region_id, method, year, month) DO UPDATE
    SET modis_count = EXCLUDED.modis_count, viirs_count = EXCLUDED.viirs_count,
        harmonized_count = EXCLUDED.harmonized_count, computed_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM fire.refresh_baseline(p_region_id, 'monthly_ratio', p_base_from, p_base_to);
  RETURN n;
END $$;

-- 6. Projeção empírica ------------------------------------------------------------------------------------
-- Valores do mesmo mês nos anos anteriores, com encolhimento para o estado proporcional à área.
CREATE OR REPLACE FUNCTION fire.past_month_values(p_region_id bigint, p_year smallint, p_month smallint,
                                                  p_base text DEFAULT 'all', p_shrink_k numeric DEFAULT 30)
RETURNS TABLE (year smallint, value numeric, weight numeric)
LANGUAGE sql STABLE AS $$
  WITH win AS (
    SELECT CASE WHEN p_base = 'recent10' THEN p_year - 10 ELSE 2002 END AS y0, p_year - 1 AS y1
  ),
  r AS (
    SELECT c.year, c.harmonized_count AS v FROM fire.calendar_monthly c, win
    WHERE c.region_id = p_region_id AND c.method = 'monthly_ratio' AND c.month = p_month AND c.year BETWEEN win.y0 AND win.y1
  ),
  u AS (
    SELECT c.year, c.harmonized_count AS v FROM fire.calendar_monthly c, win
    WHERE c.region_id = fire.uf_region_id() AND c.method = 'monthly_ratio' AND c.month = p_month AND c.year BETWEEN win.y0 AND win.y1
  ),
  scale AS (
    SELECT (SELECT area_km2 FROM fire.region WHERE id = p_region_id)
         / nullif((SELECT area_km2 FROM fire.region WHERE id = fire.uf_region_id()), 0) AS a
  ),
  w AS (
    SELECT CASE WHEN p_region_id = fire.uf_region_id() THEN 1
                ELSE coalesce(sum(r.v), 0) / (coalesce(sum(r.v), 0) + p_shrink_k) END AS w
    FROM r
  )
  SELECT r.year, round(w.w * r.v + (1 - w.w) * coalesce(u.v, r.v) * coalesce(scale.a, 1), 2), round(w.w, 3)
  FROM r LEFT JOIN u ON u.year = r.year, w, scale
$$;

CREATE OR REPLACE FUNCTION fire.expected_range(p_region_id bigint, p_year smallint, p_month smallint,
                                               p_base text DEFAULT 'all', p_shrink_k numeric DEFAULT 30)
RETURNS TABLE (p10 numeric, p50 numeric, p90 numeric, n_years integer, base_used text, shrink_weight numeric)
LANGUAGE sql STABLE AS $$
  SELECT round(percentile_cont(0.1) WITHIN GROUP (ORDER BY value)::numeric, 1),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY value)::numeric, 1),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY value)::numeric, 1),
         count(*)::int, p_base, max(weight)
  FROM fire.past_month_values(p_region_id, p_year, p_month, p_base, p_shrink_k)
  HAVING count(*) >= 5
$$;

-- Anos análogos: os N anos com acumulado de janeiro até o mês anterior mais parecido com o do ano alvo.
CREATE OR REPLACE FUNCTION fire.analog_range(p_region_id bigint, p_year smallint, p_month smallint, p_n integer DEFAULT 5)
RETURNS TABLE (p10 numeric, p50 numeric, p90 numeric, analog_years smallint[])
LANGUAGE sql STABLE AS $$
  WITH acc AS (
    SELECT c.year, sum(c.harmonized_count) AS cum
    FROM fire.calendar_monthly c
    WHERE c.region_id = p_region_id AND c.method = 'monthly_ratio' AND c.month < p_month AND c.year <= p_year AND c.year >= 2002
    GROUP BY c.year
  ),
  target AS (SELECT cum FROM acc WHERE year = p_year),
  pick AS (
    SELECT a.year FROM acc a, target t
    WHERE a.year < p_year
    ORDER BY abs(ln(a.cum + 1) - ln(t.cum + 1)), a.year DESC
    LIMIT p_n
  ),
  vals AS (
    SELECT c.year, c.harmonized_count AS v FROM fire.calendar_monthly c JOIN pick ON pick.year = c.year
    WHERE c.region_id = p_region_id AND c.method = 'monthly_ratio' AND c.month = p_month
  )
  SELECT round(percentile_cont(0.1) WITHIN GROUP (ORDER BY v)::numeric, 1),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::numeric, 1),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY v)::numeric, 1),
         array_agg(year ORDER BY year)
  FROM vals
  HAVING p_month > 1 AND count(*) >= 3
$$;

-- Retroprojeção com origem móvel: para cada mês de cada ano de teste, projeta só com anos anteriores.
-- Métodos: 'all' (climatologia 2002→ano-1), 'recent10' (últimos 10 anos), 'analog5' (5 anos análogos).
-- Referência ingênua: persistência (mesmo mês do ano anterior). skill = 1 − MAE_método / MAE_persistência.
CREATE OR REPLACE FUNCTION fire.hindcast_projection(p_region_id bigint, p_method text DEFAULT 'all',
                                                    p_from smallint DEFAULT 2015, p_to smallint DEFAULT 2025)
RETURNS TABLE (method text, n_months integer, coverage_p10_p90_pct numeric, mean_width numeric,
               mae_p50 numeric, mae_persistence numeric, skill_pct numeric)
LANGUAGE sql STABLE AS $$
  WITH obs AS (
    SELECT c.year, c.month, c.harmonized_count AS actual,
           (SELECT p.harmonized_count FROM fire.calendar_monthly p
             WHERE p.region_id = c.region_id AND p.method = c.method AND p.year = c.year - 1 AND p.month = c.month) AS persist
    FROM fire.calendar_monthly c
    WHERE c.region_id = p_region_id AND c.method = 'monthly_ratio' AND c.year BETWEEN p_from AND p_to
  ),
  pr AS (
    SELECT o.*, x.p10, x.p50, x.p90
    FROM obs o
    CROSS JOIN LATERAL (
      SELECT e.p10, e.p50, e.p90 FROM fire.expected_range(p_region_id, o.year, o.month, p_method) e
      WHERE p_method IN ('all', 'recent10')
      UNION ALL
      SELECT a.p10, a.p50, a.p90 FROM fire.analog_range(p_region_id, o.year, o.month) a
      WHERE p_method = 'analog5'
    ) x
  )
  SELECT p_method, count(*)::int,
         round(100.0 * avg((actual BETWEEN p10 AND p90)::int), 1),
         round(avg(p90 - p10), 1),
         round(avg(abs(actual - p50)), 2),
         round(avg(abs(actual - persist)) FILTER (WHERE persist IS NOT NULL), 2),
         round(100 * (1 - avg(abs(actual - p50)) / nullif(avg(abs(actual - persist)) FILTER (WHERE persist IS NOT NULL), 0)), 1)
  FROM pr
$$;

-- 7. Focos-raiz: recorrência por célula ----------------------------------------------------------------
-- VIIRS 500 m (2012+), sem pixels muito deformados na borda da passagem (scan ≤ 0,6 km).
DROP MATERIALIZED VIEW IF EXISTS fire.viirs_cell500_day;
CREATE MATERIALIZED VIEW fire.viirs_cell500_day AS
SELECT fire.cell_key(h.geom, 500)            AS cell_key,
       fire.cell_key(h.geom, 1000)           AS cell1k,
       (h.acq_ts AT TIME ZONE 'UTC')::date   AS day,
       count(*)                              AS n_pixels,
       ST_Centroid(ST_Collect(h.geom))       AS geom
FROM fire.hotspot h
JOIN fire.sensor s ON s.id = h.sensor_id
WHERE s.instrument = 'VIIRS' AND h.confidence_norm >= 1 AND coalesce(h.scan, 0.4) <= 0.6
GROUP BY 1, 2, 3
WITH NO DATA;
CREATE UNIQUE INDEX IF NOT EXISTS viirs_cell500_day_ux ON fire.viirs_cell500_day (cell_key, day);

-- p_source: 'harmonized1k' (MODIS+VIIRS na grade de 1 km) | 'viirs500' (só VIIRS, 500 m, 2012+).
-- p_res_m: 500 | 1000 | 2000 | 5000 | 10000 (agregação para a visão de estado). Vizinhança 3×3 só em 500/1000.
CREATE OR REPLACE FUNCTION fire.cell_recurrence(
    p_west double precision, p_south double precision, p_east double precision, p_north double precision,
    p_from smallint, p_to smallint, p_month smallint DEFAULT NULL,
    p_source text DEFAULT 'harmonized1k', p_res_m integer DEFAULT 1000, p_limit integer DEFAULT 20000)
RETURNS TABLE (cell_key bigint, lon double precision, lat double precision, years_burned integer,
               years_burned_nb integer, years_observed integer, last_year integer, peak_month integer)
LANGUAGE plpgsql STABLE
SET enable_nestloop = off   -- CTEs have no statistics; hash joins keep this linear in the number of cells
SET jit = off             -- custo estimado inflado pelas CTEs disparava JIT (~0,5 s de compilação para 20 ms de trabalho)
AS $$
DECLARE
  v_base integer := CASE WHEN p_source = 'viirs500' THEN 500 ELSE 1000 END;
BEGIN
  IF p_source NOT IN ('harmonized1k', 'viirs500') THEN RAISE EXCEPTION 'invalid source %', p_source; END IF;
  IF p_res_m NOT IN (500, 1000, 2000, 5000, 10000) OR p_res_m < v_base THEN RAISE EXCEPTION 'invalid resolution %', p_res_m; END IF;
  IF p_to < p_from OR p_to - p_from > 30 THEN RAISE EXCEPTION 'invalid period'; END IF;
  IF p_month IS NOT NULL AND p_month NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'invalid month'; END IF;
  IF p_limit NOT BETWEEN 1 AND 50000 THEN RAISE EXCEPTION 'invalid limit'; END IF;

  RETURN QUERY
  WITH raw AS (
    SELECT d.cell_key AS k, d.cell_key AS k1k, d.day, ST_X(d.geom) AS x, ST_Y(d.geom) AS yy FROM fire.hotspot_cell_day d
    WHERE p_source = 'harmonized1k'
      AND d.day >= make_date(p_from, 1, 1) AND d.day < make_date(p_to + 1, 1, 1)
      AND (p_month IS NULL OR extract(month FROM d.day) = p_month)
    UNION ALL
    SELECT v.cell_key, v.cell1k, v.day, ST_X(v.geom), ST_Y(v.geom) FROM fire.viirs_cell500_day v
    WHERE p_source = 'viirs500'
      AND v.day >= make_date(greatest(p_from, 2012::smallint), 1, 1) AND v.day < make_date(p_to + 1, 1, 1)
      AND (p_month IS NULL OR extract(month FROM v.day) = p_month)
  ),
  agg AS MATERIALIZED (   -- célula na resolução pedida, ano e mês; sem fontes fixas
    SELECT fire.cell_key_coarsen(r.k, v_base, p_res_m) AS k,
           extract(year FROM r.day)::int AS y, extract(month FROM r.day)::int AS m, r.x, r.yy
    FROM raw r
    WHERE NOT EXISTS (SELECT 1 FROM fire.static_cell s WHERE s.cell_key = r.k1k)
  ),
  cy AS MATERIALIZED (SELECT DISTINCT a.k, a.y FROM agg a),
  pos AS (SELECT a.k, avg(a.x) AS lon, avg(a.yy) AS lat FROM agg a GROUP BY a.k),
  st AS (SELECT c.k, count(*)::int AS yb, max(c.y)::int AS ly FROM cy c GROUP BY c.k),
  inbox AS MATERIALIZED (
    SELECT st.k, st.yb, st.ly, pos.lon, pos.lat FROM st JOIN pos ON pos.k = st.k
    WHERE pos.lon BETWEEN p_west AND p_east AND pos.lat BETWEEN p_south AND p_north
  ),
  off(d) AS (VALUES (-100000001::bigint), (-100000000), (-99999999), (-1), (0), (1), (99999999), (100000000), (100000001)),
  nb AS (    -- anos em que a célula OU uma vizinha (3×3) teve fogo: junção por deslocamento de chave (linear)
    SELECT x.k2 AS k, count(DISTINCT x.y)::int AS yrs
    FROM (SELECT c.k + o.d AS k2, c.y FROM cy c CROSS JOIN off o) x
    JOIN inbox i ON i.k = x.k2
    WHERE p_res_m IN (500, 1000)
    GROUP BY x.k2
  ),
  pk AS (
    SELECT DISTINCT ON (a.k) a.k, a.m FROM agg a JOIN inbox i ON i.k = a.k
    GROUP BY a.k, a.m ORDER BY a.k, count(*) DESC, a.m
  )
  SELECT i.k, i.lon::double precision, i.lat::double precision, i.yb, coalesce(nb.yrs, i.yb),
         (p_to - CASE WHEN p_source = 'viirs500' THEN greatest(p_from, 2012::smallint) ELSE p_from END + 1)::int,
         i.ly, pk.m
  FROM inbox i LEFT JOIN nb ON nb.k = i.k LEFT JOIN pk ON pk.k = i.k
  ORDER BY 5 DESC, 4 DESC
  LIMIT p_limit;
END $$;

-- Acerto dos focos-raiz no passado: que parte dos focos do ano de teste caiu em células marcadas como
-- recorrentes (≥ p_min_years anos com fogo, vizinhança 3×3) nos p_window anos anteriores, e quanto da
-- área essas células ocupam. lift = acerto / fração de área.
CREATE OR REPLACE FUNCTION fire.recurrence_hit_rate(p_test_year smallint, p_window smallint DEFAULT 10,
                                                    p_min_years smallint DEFAULT 5)
RETURNS TABLE (test_year smallint, flagged_cells integer, cells_with_fire integer, hit_pct numeric,
               area_share_pct numeric, lift numeric)
LANGUAGE sql STABLE AS $$
  WITH past AS (
    SELECT d.cell_key AS k, extract(year FROM d.day)::int AS y
    FROM fire.hotspot_cell_day d
    WHERE d.day >= make_date(p_test_year - p_window, 1, 1) AND d.day < make_date(p_test_year, 1, 1)
      AND NOT EXISTS (SELECT 1 FROM fire.static_cell s WHERE s.cell_key = d.cell_key)
    GROUP BY 1, 2
  ),
  off(d) AS (VALUES (-100000001::bigint), (-100000000), (-99999999), (-1), (0), (1), (99999999), (100000000), (100000001)),
  cand AS MATERIALIZED (SELECT DISTINCT k FROM past),
  flagged AS MATERIALIZED (
    SELECT x.k2 AS k FROM (SELECT p.k + o.d AS k2, p.y FROM past p CROSS JOIN off o) x
    JOIN cand c ON c.k = x.k2
    GROUP BY x.k2 HAVING count(DISTINCT x.y) >= p_min_years
  ),
  test AS (
    SELECT d.cell_key AS k, count(*) AS n FROM fire.hotspot_cell_day d
    WHERE d.day >= make_date(p_test_year, 1, 1) AND d.day < make_date(p_test_year + 1, 1, 1)
      AND NOT EXISTS (SELECT 1 FROM fire.static_cell s WHERE s.cell_key = d.cell_key)
    GROUP BY 1
  ),
  uf AS (SELECT area_km2 FROM fire.region WHERE id = fire.uf_region_id())
  SELECT p_test_year,
         (SELECT count(*)::int FROM flagged),
         (SELECT count(*)::int FROM test),
         round(100.0 * (SELECT coalesce(sum(t.n), 0) FROM test t JOIN flagged f ON f.k = t.k) / nullif((SELECT sum(n) FROM test), 0), 1),
         round(100.0 * (SELECT count(*) FROM flagged) / nullif((SELECT area_km2 FROM uf), 0), 2),
         round(((SELECT coalesce(sum(t.n), 0) FROM test t JOIN flagged f ON f.k = t.k)::numeric / nullif((SELECT sum(n) FROM test), 0))
               / nullif((SELECT count(*) FROM flagged)::numeric / nullif((SELECT area_km2 FROM uf), 0), 0), 1)
$$;

-- 8. Histórico exato dentro de um raio ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS hotspot_cell_day_geom5880_gix ON fire.hotspot_cell_day USING gist (ST_Transform(geom, 5880));

CREATE OR REPLACE FUNCTION fire.circle_info(p_lon double precision, p_lat double precision, p_radius_km numeric)
RETURNS TABLE (area_km2 numeric, area_in_state_km2 numeric, pct_in_state numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_c geometry; v_uf geometry;
BEGIN
  IF p_radius_km IS NULL OR p_radius_km < 1 OR p_radius_km > 300 THEN RAISE EXCEPTION 'radius must be between 1 and 300 km'; END IF;
  v_c := ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326), 5880), p_radius_km * 1000, 64);
  SELECT ST_Transform(geom, 5880) INTO v_uf FROM fire.region WHERE id = fire.uf_region_id();
  IF v_uf IS NULL OR NOT ST_Intersects(v_uf, ST_Centroid(v_c)) THEN RAISE EXCEPTION 'center must be inside the state'; END IF;
  RETURN QUERY SELECT round((ST_Area(v_c) / 1e6)::numeric, 1),
                      round((ST_Area(ST_Intersection(v_c, v_uf)) / 1e6)::numeric, 1),
                      round((100 * ST_Area(ST_Intersection(v_c, v_uf)) / ST_Area(v_c))::numeric, 1);
END $$;

-- p_source 'harmonized1k': raio mínimo 5 km (pixel MODIS ~1 km); 'viirs500': mínimo 1 km, só 2012+.
CREATE OR REPLACE FUNCTION fire.circle_history(p_lon double precision, p_lat double precision, p_radius_km numeric,
                                               p_source text DEFAULT 'harmonized1k')
RETURNS TABLE (year smallint, month smallint, modis integer, viirs integer, harmonized numeric, anomaly_z numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_c geometry; v_r double precision;
BEGIN
  IF p_source NOT IN ('harmonized1k', 'viirs500') THEN RAISE EXCEPTION 'invalid source %', p_source; END IF;
  IF p_source = 'harmonized1k' AND p_radius_km < 5 THEN RAISE EXCEPTION 'radius below 5 km needs VIIRS (source viirs500)'; END IF;
  PERFORM fire.circle_info(p_lon, p_lat, p_radius_km);      -- valida raio e centro
  v_c := ST_Transform(ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326), 5880);
  v_r := p_radius_km * 1000;

  RETURN QUERY
  WITH cells AS (
    SELECT d.cell_key, d.day, d.instrument FROM fire.hotspot_cell_day d
    WHERE ST_DWithin(ST_Transform(d.geom, 5880), v_c, v_r)
      AND NOT EXISTS (SELECT 1 FROM fire.static_cell s WHERE s.cell_key = d.cell_key)
  ),
  m AS (
    SELECT date_part('year', day)::smallint AS y, date_part('month', day)::smallint AS mo,
           count(*) FILTER (WHERE instrument = 'MODIS')::int AS mc,
           count(*) FILTER (WHERE instrument = 'VIIRS')::int AS vc
    FROM cells GROUP BY 1, 2
  ),
  grid AS (   -- todos os meses dos anos carregados, com zero explícito
    SELECT y::smallint AS y, mo::smallint AS mo FROM generate_series(2000, 2026) y, generate_series(1, 12) mo
    WHERE EXISTS (SELECT 1 FROM fire.loaded_year l WHERE l.year = y)
  ),
  s AS (
    SELECT g.y, g.mo,
           CASE WHEN EXISTS (SELECT 1 FROM fire.loaded_year l WHERE l.instrument = 'MODIS' AND l.year = g.y) THEN coalesce(m.mc, 0) END AS mc,
           CASE WHEN EXISTS (SELECT 1 FROM fire.loaded_year l WHERE l.instrument = 'VIIRS' AND l.year = g.y) THEN coalesce(m.vc, 0) END AS vc
    FROM grid g LEFT JOIN m ON m.y = g.y AND m.mo = g.mo
  ),
  h AS (
    SELECT s.y, s.mo, s.mc, s.vc,
           CASE WHEN p_source = 'viirs500' THEN s.vc::numeric
                WHEN s.vc IS NOT NULL AND s.y >= 2012 THEN s.vc::numeric
                ELSE round(s.mc * coalesce(f.factor, 1), 1) END AS hv
    FROM s
    LEFT JOIN fire.harmonization_factor f
      ON f.region_id = fire.uf_region_id() AND f.method = 'monthly_ratio' AND f.month = s.mo
    WHERE p_source <> 'viirs500' OR s.y >= 2012
  ),
  b AS (
    SELECT h.mo, avg(h.hv) AS mean, stddev_samp(h.hv) AS sd FROM h
    WHERE h.y BETWEEN 2002 AND 2024 AND h.hv IS NOT NULL GROUP BY h.mo
  )
  SELECT h.y, h.mo, h.mc, h.vc, h.hv,
         CASE WHEN b.sd > 0 THEN round((h.hv - b.mean) / b.sd, 2) END
  FROM h LEFT JOIN b ON b.mo = h.mo
  WHERE h.hv IS NOT NULL
  ORDER BY 1, 2;
END $$;

-- 8b. Detalhe dentro da área: células da grade com fogo no mês (harmonizado) e recorrência. ----------------
-- Município: as células atribuídas a ele pelo centro (as mesmas que somam o calendário dele).
-- Círculo: os focos cujo centróide está dentro do raio (o mesmo critério de circle_history).
-- Mês ≥ 2012: células-dia VIIRS; antes: células-dia MODIS × fator do mesmo mês (do município ou, no círculo, da UF).
-- Assim a soma das células é o valor harmonizado da área naquele mês.
CREATE OR REPLACE FUNCTION fire.area_cells(p_region_id bigint, p_lon double precision, p_lat double precision,
                                           p_radius_km numeric, p_year smallint, p_month smallint, p_res_m integer DEFAULT 1000)
RETURNS TABLE (cell_key bigint, lon double precision, lat double precision, cell_days numeric,
               years_burned integer, last_year integer)
LANGUAGE plpgsql STABLE
SET enable_nestloop = off
SET jit = off
AS $$
DECLARE
  v_factor numeric;
  v_c geometry;
  v_r double precision;
  v_from date := make_date(p_year, p_month, 1);
BEGIN
  IF p_res_m NOT IN (1000, 2000, 5000) THEN RAISE EXCEPTION 'invalid resolution %', p_res_m; END IF;
  IF p_month NOT BETWEEN 1 AND 12 OR p_year NOT BETWEEN 2000 AND 2100 THEN RAISE EXCEPTION 'invalid period'; END IF;
  IF p_region_id IS NULL THEN
    PERFORM fire.circle_info(p_lon, p_lat, p_radius_km);    -- valida raio e centro
    IF p_radius_km < 5 THEN RAISE EXCEPTION 'radius below 5 km needs VIIRS (source viirs500)'; END IF;
    v_c := ST_Transform(ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326), 5880);
    v_r := p_radius_km * 1000;
  END IF;
  SELECT f.factor INTO v_factor FROM fire.harmonization_factor f
  WHERE f.region_id = coalesce(p_region_id, fire.uf_region_id()) AND f.method = 'monthly_ratio' AND f.month = p_month;

  RETURN QUERY
  WITH d AS MATERIALIZED (
    SELECT h.cell_key AS k1, h.day, h.instrument FROM fire.hotspot_cell_day h
    WHERE p_region_id IS NOT NULL
      AND h.cell_key IN (SELECT cr.cell_key FROM fire.cell_region cr WHERE cr.region_id = p_region_id)
    UNION ALL
    SELECT h.cell_key, h.day, h.instrument FROM fire.hotspot_cell_day h
    WHERE p_region_id IS NULL AND ST_DWithin(ST_Transform(h.geom, 5880), v_c, v_r)
  ),
  dd AS MATERIALIZED (
    SELECT fire.cell_key_coarsen(d.k1, 1000, p_res_m) AS k, d.day, d.instrument FROM d
    WHERE NOT EXISTS (SELECT 1 FROM fire.static_cell s WHERE s.cell_key = d.k1)
  ),
  yrs AS (
    SELECT dd.k, count(DISTINCT date_part('year', dd.day))::int AS yb, max(date_part('year', dd.day))::int AS ly
    FROM dd GROUP BY dd.k
  ),
  mon AS (
    SELECT dd.k,
           CASE WHEN p_year >= 2012 THEN count(*) FILTER (WHERE dd.instrument = 'VIIRS')::numeric
                ELSE round(count(*) FILTER (WHERE dd.instrument = 'MODIS') * coalesce(v_factor, 1), 2) END AS cd
    FROM dd WHERE dd.day >= v_from AND dd.day < (v_from + interval '1 month')::date
    GROUP BY dd.k
  ),
  pts AS (
    SELECT y.k, y.yb, y.ly, ST_Transform(fire.cell_center_5880(y.k, p_res_m), 4326) AS g FROM yrs y
  )
  SELECT p.k, ST_X(p.g), ST_Y(p.g), coalesce(m.cd, 0), p.yb, p.ly
  FROM pts p LEFT JOIN mon m ON m.k = p.k
  ORDER BY 4 DESC, 5 DESC
  LIMIT 20000;
END $$;

-- 9. Acesso da API (só leitura) -----------------------------------------------------------------------------
GRANT SELECT ON fire.static_cell, fire.cell_region, fire.region_month_counts, fire.loaded_year, fire.viirs_cell500_day TO fire_api_ro;
GRANT EXECUTE ON FUNCTION
  fire.cell_center_5880(bigint, integer), fire.cell_key_coarsen(bigint, integer, integer), fire.uf_region_id(text),
  fire.region_monthly_series(bigint, smallint, smallint),
  fire.harmonization_factors(bigint, smallint, smallint, numeric),
  fire.validate_harmonization(bigint, smallint, smallint, smallint, smallint, numeric),
  fire.past_month_values(bigint, smallint, smallint, text, numeric),
  fire.expected_range(bigint, smallint, smallint, text, numeric),
  fire.analog_range(bigint, smallint, smallint, integer),
  fire.hindcast_projection(bigint, text, smallint, smallint),
  fire.cell_recurrence(double precision, double precision, double precision, double precision, smallint, smallint, smallint, text, integer, integer),
  fire.recurrence_hit_rate(smallint, smallint, smallint),
  fire.circle_info(double precision, double precision, numeric),
  fire.circle_history(double precision, double precision, numeric, text),
  fire.area_cells(bigint, double precision, double precision, numeric, smallint, smallint, integer)
TO fire_api_ro;
REVOKE EXECUTE ON FUNCTION fire.build_static_cells(smallint, smallint), fire.build_region_counts(),
  fire.compute_harmonization(bigint, smallint, smallint, numeric),
  fire.build_calendar(bigint, smallint, smallint, smallint, smallint) FROM PUBLIC;
