-- Teste de schema_projecao.sql em banco NOVO (schema.sql → schema_cinder.sql → schema_contexto.sql →
-- schema_operacional.sql → schema_projecao.sql → este arquivo). Dados SINTÉTICOS com resposta conhecida:
--   * VIIRS vê ~3x mais células-dia que o MODIS (fator verdadeiro ≈ 3, varia pouco por mês);
--   * temporada concentrada em ago–set; 50 locais fixos queimam em ~80% dos anos (focos-raiz);
--   * uma "usina" esquenta o ano todo em 2012–2025 (fonte fixa: deve ser excluída).
\set ON_ERROR_STOP 1
SELECT setseed(0.42);

INSERT INTO fire.region (kind, ibge_code, name, geom) VALUES
 ('uf', '52', 'Goiás (caixa de teste)', ST_Multi(ST_MakeEnvelope(-53.25, -19.50, -45.90, -12.39, 4326))),
 ('municipio', '5200001', 'Quadrante NO', ST_Multi(ST_MakeEnvelope(-53.25, -15.945, -49.575, -12.39, 4326))),
 ('municipio', '5200002', 'Quadrante NE', ST_Multi(ST_MakeEnvelope(-49.575, -15.945, -45.90, -12.39, 4326))),
 ('municipio', '5200003', 'Quadrante SO', ST_Multi(ST_MakeEnvelope(-53.25, -19.50, -49.575, -15.945, 4326))),
 ('municipio', '5200004', 'Quadrante SE', ST_Multi(ST_MakeEnvelope(-49.575, -19.50, -45.90, -15.945, 4326)));

INSERT INTO fire.ingest_batch (sensor_id, kind, processing, source_url, period_start, period_end, rows_read)
SELECT s, 'country_yearly', 'SP',
       format('https://firms.modaps.eosdis.nasa.gov/data/country/%s/%s/%s_%s_Brazil.csv',
              CASE s WHEN 1 THEN 'modis' ELSE 'viirs-snpp' END, y, CASE s WHEN 1 THEN 'modis' ELSE 'viirs-snpp' END, y),
       make_date(y, 1, 1), make_date(y, 12, 31), 0
FROM generate_series(2001, 2025) y, (VALUES (1), (2)) v(s)
WHERE s = 1 OR y >= 2012;

-- Eventos de fogo por ano e mês (sazonal), 40% em 50 locais fixos.
CREATE TEMP TABLE roots AS
SELECT i AS site, -53.0 + random() * 6.8 AS lon, -19.2 + random() * 6.5 AS lat FROM generate_series(1, 50) i;

CREATE TEMP TABLE ev AS
WITH season(m, w) AS (VALUES (1,.01),(2,.01),(3,.015),(4,.02),(5,.04),(6,.07),(7,.12),(8,.25),(9,.30),(10,.12),(11,.04),(12,.015)),
yr AS (SELECT y, 0.8 + random() * 0.6 AS level FROM generate_series(2001, 2025) y),
cnt AS (SELECT y, m, greatest(1, round(220 * level * w * (0.7 + random() * 0.6)))::int AS n FROM yr, season)
SELECT row_number() OVER () AS id, c.y, c.m,
       make_date(c.y, c.m, 1 + floor(random() * 27)::int) AS d,
       (random() < 0.4) AS is_root, floor(random() * 50)::int + 1 AS site,
       -53.0 + random() * 6.8 AS rlon, -19.2 + random() * 6.5 AS rlat
FROM cnt c, generate_series(1, c.n) g;

-- MODIS: vê ~35% dos eventos (1 pixel); VIIRS (2012+): vê ~95% (1–3 pixels de 375 m)
INSERT INTO fire.hotspot (sensor_id, batch_id, acq_ts, latitude, longitude, satellite, scan, track,
                          confidence_raw, confidence_norm, frp_mw, daynight, processing)
SELECT 1, b.id, e.d + time '16:40' + (e.id % 50) * interval '1 second',
       round((CASE WHEN e.is_root THEN r.lat + (random() - .5) * .004 ELSE e.rlat END)::numeric, 5),
       round((CASE WHEN e.is_root THEN r.lon + (random() - .5) * .004 ELSE e.rlon END)::numeric, 5),
       'Aqua', 1.0, 1.0, '75', fire.normalize_confidence('MODIS', '75'), 20, 'D', 'SP'
FROM ev e JOIN roots r ON r.site = e.site
JOIN fire.ingest_batch b ON b.sensor_id = 1 AND extract(year FROM b.period_start) = e.y
WHERE random() < 0.35
ON CONFLICT ON CONSTRAINT hotspot_natural_ux DO NOTHING;

INSERT INTO fire.hotspot (sensor_id, batch_id, acq_ts, latitude, longitude, satellite, scan, track,
                          confidence_raw, confidence_norm, frp_mw, daynight, processing)
SELECT 2, b.id, e.d + time '17:10' + (e.id % 50) * interval '1 second' + k * interval '1 millisecond',
       round((CASE WHEN e.is_root THEN r.lat ELSE e.rlat END + (random() - .5) * .006)::numeric, 5),
       round((CASE WHEN e.is_root THEN r.lon ELSE e.rlon END + (random() - .5) * .006)::numeric, 5),
       'N', 0.4, 0.4, 'n', fire.normalize_confidence('VIIRS', 'n'), 6, 'D', 'SP'
FROM ev e JOIN roots r ON r.site = e.site
JOIN fire.ingest_batch b ON b.sensor_id = 2 AND extract(year FROM b.period_start) = e.y
CROSS JOIN LATERAL generate_series(1, 1 + floor(random() * 3)::int) k
WHERE e.y >= 2012 AND random() < 0.95
ON CONFLICT ON CONSTRAINT hotspot_natural_ux DO NOTHING;

-- "Usina": a cada 3 dias, todo o ano, 2012–2025, nos dois sensores (fonte fixa).
INSERT INTO fire.hotspot (sensor_id, batch_id, acq_ts, latitude, longitude, satellite, scan, track,
                          confidence_raw, confidence_norm, frp_mw, daynight, processing)
SELECT s, b.id, d + time '13:00', -17.50000, -50.50000, CASE s WHEN 1 THEN 'Aqua' ELSE 'N' END, 0.4, 0.4,
       CASE s WHEN 1 THEN '90' ELSE 'h' END, 2, 30, 'D', 'SP'
FROM generate_series(date '2012-01-01', date '2025-12-31', interval '3 days') d, (VALUES (1), (2)) v(s)
JOIN fire.ingest_batch b ON b.sensor_id = v.s
WHERE extract(year FROM b.period_start) = extract(year FROM d)
ON CONFLICT ON CONSTRAINT hotspot_natural_ux DO NOTHING;

SELECT 'focos carregados', s.instrument, count(*) FROM fire.hotspot h JOIN fire.sensor s ON s.id = h.sensor_id GROUP BY 2 ORDER BY 2;

-- Pipeline: grade → fontes fixas → contagens → harmonização → validação → calendário
REFRESH MATERIALIZED VIEW fire.hotspot_cell_day;
REFRESH MATERIALIZED VIEW fire.viirs_cell500_day;
SELECT 'fontes fixas', fire.build_static_cells();
SELECT 'contagens', fire.build_region_counts() > 0;

SELECT 'validação UF (calibra 2012–2019, testa 2020–2025)', * FROM fire.validate_harmonization(fire.uf_region_id());

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM fire.validate_harmonization(fire.uf_region_id());
  IF v.n_months <> 72 THEN RAISE EXCEPTION 'esperava 72 meses de teste, veio %', v.n_months; END IF;
  IF v.wape_pct > 35 THEN RAISE EXCEPTION 'erro de harmonização alto demais: % %%', v.wape_pct; END IF;
  IF v.pearson_r < 0.9 THEN RAISE EXCEPTION 'correlação baixa: %', v.pearson_r; END IF;
  RAISE NOTICE 'ok: harmonização validada (WAPE %, r %, viés %)', v.wape_pct, v.pearson_r, v.bias_pct;
END $$;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM fire.region WHERE kind IN ('uf', 'municipio') LOOP PERFORM fire.compute_harmonization(r.id); END LOOP;
END $$;
SELECT 'fatores calculados', count(*), round(min(factor), 2), round(max(factor), 2) FROM fire.harmonization_factor WHERE method = 'monthly_ratio';

DO $$
DECLARE r record; n int;
BEGIN
  FOR r IN SELECT id FROM fire.region WHERE kind IN ('uf', 'municipio') LOOP
    PERFORM fire.build_calendar(r.id);
  END LOOP;
  SELECT count(*) INTO n FROM fire.calendar_monthly WHERE region_id = fire.uf_region_id() AND method = 'monthly_ratio';
  IF n <> 300 THEN RAISE EXCEPTION 'calendário da UF deveria ter 300 meses (2001–2025), tem %', n; END IF;
  -- antes de 2012 o harmonizado é MODIS × fator; depois é o VIIRS
  IF EXISTS (SELECT 1 FROM fire.calendar_monthly c
             WHERE c.region_id = fire.uf_region_id() AND c.year >= 2012 AND c.harmonized_count <> c.viirs_count) THEN
    RAISE EXCEPTION 'a partir de 2012 o harmonizado deve ser o VIIRS';
  END IF;
  IF EXISTS (SELECT 1 FROM fire.calendar_monthly c WHERE c.region_id = fire.uf_region_id() AND c.year < 2012 AND c.viirs_count IS NOT NULL) THEN
    RAISE EXCEPTION 'antes de 2012 não pode haver VIIRS';
  END IF;
  RAISE NOTICE 'ok: calendários construídos (UF 300 meses; VIIRS desde 2012; MODIS×fator antes)';
END $$;

-- A usina não pode entrar nas contagens
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fire.static_cell WHERE cell_key = fire.cell_key(ST_SetSRID(ST_MakePoint(-50.5, -17.5), 4326))) THEN
    RAISE EXCEPTION 'a usina deveria ter sido marcada como fonte fixa';
  END IF;
  RAISE NOTICE 'ok: fonte fixa detectada e excluída';
END $$;

-- Projeção: faixa, análogos e retroprojeção
SELECT 'faixa set/2025 UF', * FROM fire.expected_range(fire.uf_region_id(), 2025::smallint, 9::smallint);
SELECT 'faixa set/2025 NO (encolhida)', * FROM fire.expected_range((SELECT id FROM fire.region WHERE ibge_code = '5200001'), 2025::smallint, 9::smallint);
SELECT 'análogos set/2025 UF', * FROM fire.analog_range(fire.uf_region_id(), 2025::smallint, 9::smallint);
SELECT 'retroprojeção', h.* FROM unnest(ARRAY['all', 'recent10', 'analog5']) m, fire.hindcast_projection(fire.uf_region_id(), m) h;

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM fire.hindcast_projection(fire.uf_region_id(), 'all');
  IF v.n_months <> 132 THEN RAISE EXCEPTION 'retroprojeção 2015–2025 deveria avaliar 132 meses, avaliou %', v.n_months; END IF;
  IF v.coverage_p10_p90_pct < 55 OR v.coverage_p10_p90_pct > 98 THEN RAISE EXCEPTION 'cobertura implausível: %', v.coverage_p10_p90_pct; END IF;
  RAISE NOTICE 'ok: retroprojeção (cobertura P10–P90 %, ganho sobre persistência % %%)', v.coverage_p10_p90_pct, v.skill_pct;
END $$;

-- Focos-raiz: recorrência e acerto no passado
SELECT 'recorrência 1 km (top 3)', * FROM fire.cell_recurrence(-53.25, -19.5, -45.9, -12.39, 2015::smallint, 2024::smallint, NULL, 'harmonized1k', 1000, 3);
SELECT 'recorrência 10 km (contagem)', count(*) FROM fire.cell_recurrence(-53.25, -19.5, -45.9, -12.39, 2015::smallint, 2024::smallint, NULL, 'harmonized1k', 10000, 20000);
SELECT 'recorrência VIIRS 500 m set (top 2)', * FROM fire.cell_recurrence(-53.25, -19.5, -45.9, -12.39, 2015::smallint, 2024::smallint, 9::smallint, 'viirs500', 500, 2);
SELECT 'acerto focos-raiz 2025', * FROM fire.recurrence_hit_rate(2025::smallint);

DO $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM fire.recurrence_hit_rate(2025::smallint);
  IF v.lift < 5 THEN RAISE EXCEPTION 'os focos-raiz deveriam concentrar fogo (lift %)', v.lift; END IF;
  IF EXISTS (SELECT 1 FROM fire.cell_recurrence(-50.6, -17.6, -50.4, -17.4, 2012::smallint, 2025::smallint)
             WHERE cell_key = fire.cell_key(ST_SetSRID(ST_MakePoint(-50.5, -17.5), 4326))) THEN
    RAISE EXCEPTION 'a usina não pode aparecer como foco-raiz';
  END IF;
  RAISE NOTICE 'ok: focos-raiz (acerto % %% em % %% da área, lift %)', v.hit_pct, v.area_share_pct, v.lift;
END $$;

-- Raio exato: só o que está dentro do círculo conta
SELECT 'círculo 50 km', * FROM fire.circle_info(-49.25, -16.68, 50);
DO $$
DECLARE inside int; total_uf int; n_raio int;
BEGIN
  SELECT sum(harmonized) INTO inside FROM fire.circle_history(-49.25, -16.68, 50) WHERE year = 2020;
  SELECT sum(harmonized_count) INTO total_uf FROM fire.calendar_monthly WHERE region_id = fire.uf_region_id() AND year = 2020;
  SELECT count(*) INTO n_raio FROM fire.hotspot_cell_day d
   WHERE d.instrument = 'VIIRS' AND d.day BETWEEN '2020-01-01' AND '2020-12-31'
     AND ST_DWithin(ST_Transform(d.geom, 5880), ST_Transform(ST_SetSRID(ST_MakePoint(-49.25, -16.68), 4326), 5880), 50000);
  IF inside <> n_raio THEN RAISE EXCEPTION 'círculo deveria contar % células-dia em 2020, contou %', n_raio, inside; END IF;
  IF inside >= total_uf THEN RAISE EXCEPTION 'o círculo não pode ter tanto quanto o estado'; END IF;
  RAISE NOTICE 'ok: círculo de 50 km conta só o que está dentro (% de % no estado em 2020)', inside, total_uf;
END $$;

-- Casos que devem ser recusados
DO $$ BEGIN
  BEGIN PERFORM fire.circle_history(-49.25, -16.68, 3); RAISE EXCEPTION 'aceitou raio de 3 km com MODIS';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'aceitou%' THEN RAISE; END IF; RAISE NOTICE 'ok: raio < 5 km exige VIIRS'; END;
  BEGIN PERFORM fire.circle_history(-49.25, -16.68, 500); RAISE EXCEPTION 'aceitou raio de 500 km';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'aceitou%' THEN RAISE; END IF; RAISE NOTICE 'ok: raio > 300 km recusado'; END;
  BEGIN PERFORM fire.circle_history(-60, -5, 20); RAISE EXCEPTION 'aceitou centro fora do estado';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'aceitou%' THEN RAISE; END IF; RAISE NOTICE 'ok: centro fora do estado recusado'; END;
  BEGIN PERFORM fire.cell_recurrence(-53, -19, -46, -12, 2015::smallint, 2024::smallint, NULL, 'qualquer', 1000); RAISE EXCEPTION 'aceitou fonte inválida';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'aceitou%' THEN RAISE; END IF; RAISE NOTICE 'ok: fonte inválida recusada'; END;
  BEGIN PERFORM fire.cell_recurrence(-53, -19, -46, -12, 2015::smallint, 2024::smallint, NULL, 'harmonized1k', 500); RAISE EXCEPTION 'aceitou 500 m com MODIS';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'aceitou%' THEN RAISE; END IF; RAISE NOTICE 'ok: 500 m só com VIIRS'; END;
END $$;

-- Detalhe por célula: a soma das células de um município é o valor harmonizado dele no mês (antes e depois de 2012)
DO $$
DECLARE r record; v_cells numeric; v_cells5 numeric; n int := 0;
BEGIN
  FOR r IN SELECT cm.region_id, cm.year, cm.month, cm.harmonized_count FROM fire.calendar_monthly cm
           JOIN fire.region g ON g.id = cm.region_id AND g.kind = 'municipio'
           WHERE cm.method = 'monthly_ratio' AND cm.harmonized_count > 0 AND cm.year IN (2005, 2009, 2014, 2024)
  LOOP
    SELECT sum(cell_days) INTO v_cells FROM fire.area_cells(r.region_id, NULL, NULL, NULL, r.year, r.month, 1000);
    SELECT sum(cell_days) INTO v_cells5 FROM fire.area_cells(r.region_id, NULL, NULL, NULL, r.year, r.month, 5000);
    IF abs(coalesce(v_cells, 0) - r.harmonized_count) > 0.15 OR abs(coalesce(v_cells5, 0) - coalesce(v_cells, 0)) > 0.01 THEN
      RAISE EXCEPTION 'células (% / % a 5 km) ≠ calendário % em %/%', v_cells, v_cells5, r.harmonized_count, r.month, r.year;
    END IF;
    n := n + 1;
  END LOOP;
  IF n < 10 THEN RAISE EXCEPTION 'poucos meses testados (%)', n; END IF;
  BEGIN PERFORM * FROM fire.area_cells(NULL, -49.5, -16.5, 3, 2020::smallint, 9::smallint, 1000); RAISE EXCEPTION 'aceitou raio 3 km';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'aceitou%' THEN RAISE; END IF; END;
  BEGIN PERFORM * FROM fire.area_cells(1, NULL, NULL, NULL, 2020::smallint, 9::smallint, 500); RAISE EXCEPTION 'aceitou 500 m';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'aceitou%' THEN RAISE; END IF; END;
  RAISE NOTICE 'ok: células do município somam o calendário (% meses); raio < 5 km e 500 m recusados', n;
END $$;

-- Reexecução não duplica (idempotência)
DO $$
DECLARE a bigint; b bigint;
BEGIN
  SELECT sum(harmonized_count) INTO a FROM fire.calendar_monthly;
  PERFORM fire.build_region_counts();
  PERFORM fire.compute_harmonization(fire.uf_region_id());
  PERFORM fire.build_calendar(fire.uf_region_id());
  SELECT sum(harmonized_count) INTO b FROM fire.calendar_monthly;
  IF a <> b THEN RAISE EXCEPTION 'reexecução mudou o calendário (% → %)', a, b; END IF;
  RAISE NOTICE 'ok: pipeline idempotente';
END $$;

-- A API (papel só leitura) consulta mas não constrói
SET ROLE fire_api_ro;
SELECT 'api lê faixa', p50 IS NOT NULL FROM fire.expected_range(fire.uf_region_id(), 2025::smallint, 9::smallint);
DO $$ BEGIN
  BEGIN PERFORM fire.build_calendar(1); RAISE EXCEPTION 'API construiu calendário';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: API sem permissão de construir'; END;
END $$;
RESET ROLE;
