-- Teste da extensão de contexto: rodar depois de teste_firehub.sql. Valores SINTÉTICOS.
\set ON_ERROR_STOP 1
UPDATE fire.calendar_monthly SET modis_count = round(harmonized_count / 3.5) WHERE region_id = 1;
INSERT INTO fire.inpe_reference_monthly (region_id, year, month, hotspots, source_file)
SELECT region_id, year, month, round(modis_count * 0.48), 'focos_br_ref_' || year || '.zip'
FROM fire.calendar_monthly WHERE region_id = 1 AND year BETWEEN 2020 AND 2024
ON CONFLICT (region_id, year, month) DO UPDATE SET hotspots = EXCLUDED.hotspots;
SELECT 'inpe_vs_firms', * FROM fire.inpe_vs_firms(1, 2020::smallint, 2024::smallint) LIMIT 2;
INSERT INTO fire.context_yearly (region_id, year, source, metric, value, unit) VALUES
  (1, 2024, 'inpe_prodes', 'deforestation_km2', 12.4, 'km²'),
  (1, 2024, 'nasa_power', 'ws10m_dry_mean', 2.9, 'm/s')
ON CONFLICT (region_id, year, source, metric) DO UPDATE SET value = EXCLUDED.value;
SELECT 'contexto', m.label, c.value, c.unit, m.source_label
FROM fire.context_yearly c JOIN fire.context_metric m USING (source, metric)
WHERE c.region_id = 1 AND c.year = 2024 ORDER BY m.sort;
-- negativos esperados (cada um deve falhar)
DO $$ BEGIN
  BEGIN INSERT INTO fire.context_yearly VALUES (1, 2024, 'site_qualquer', 'x1', 1, ''); RAISE EXCEPTION 'fonte invalida aceita';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: fonte desconhecida recusada'; END;
  BEGIN INSERT INTO fire.context_yearly VALUES (1, 2024, 'nasa_power', 'x2', 'NaN'::float8, ''); RAISE EXCEPTION 'NaN aceito';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: NaN recusado'; END;
  BEGIN INSERT INTO fire.inpe_reference_monthly VALUES (1, 2024, 1, 5, '../../etc/passwd'); RAISE EXCEPTION 'nome de arquivo invalido aceito';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: nome de arquivo recusado'; END;
END $$;
SET ROLE fire_api_ro;
SELECT 'api_le_contexto', count(*) FROM fire.context_yearly;
DO $$ BEGIN
  BEGIN INSERT INTO fire.context_yearly VALUES (1, 2023, 'nasa_power', 'x3', 1, ''); RAISE EXCEPTION 'api escreveu';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: API sem escrita'; END;
END $$;
RESET ROLE;
