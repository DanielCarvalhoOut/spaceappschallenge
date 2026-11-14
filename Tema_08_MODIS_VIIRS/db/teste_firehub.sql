-- Teste da extensão FireHub: rodar depois de schema.sql, schema_firehub.sql e teste_schema.sql.
-- ATENÇÃO: os números do calendário abaixo são SINTÉTICOS (formato sazonal inventado só para testar as funções).
\set ON_ERROR_STOP 1
INSERT INTO fire.calendar_monthly (region_id, method, year, month, harmonized_count)
SELECT 1, 'monthly_ratio', y, m,
       (CASE m WHEN 7 THEN 300 WHEN 8 THEN 900 WHEN 9 THEN 1200 WHEN 10 THEN 500 WHEN 6 THEN 120 ELSE 30 END)
       * (1 + ((y * 7 + m) % 5 - 2) / 20.0)
FROM generate_series(2012, 2024) y, generate_series(1, 12) m;
INSERT INTO fire.calendar_monthly (region_id, method, year, month, harmonized_count) VALUES (1,'monthly_ratio',2025,9,2100);
SELECT 'baseline_atualizadas', fire.refresh_baseline(1,'monthly_ratio',2012::smallint,2024::smallint);
SELECT 'padrao', month, mean_count, share_pct, rank_in_year FROM fire.seasonal_pattern(1,'monthly_ratio',2012::smallint,2024::smallint) WHERE rank_in_year <= 4 ORDER BY rank_in_year;
SELECT 'epoca_de_fogo', * FROM fire.fire_season(1,'monthly_ratio',2012::smallint,2024::smallint,80);
SELECT 'set_2025', harmonized_count, baseline_mean, anomaly_z FROM fire.calendar_monthly WHERE region_id=1 AND year=2025 AND month=9;
INSERT INTO fire.stakeholder (name, role, channel, contact) VALUES ('Brigada de teste','brigada','demo','demo');
INSERT INTO fire.alert_rule (stakeholder_id, region_id) VALUES (1, 1);
SELECT 'alertas_gerados', fire.evaluate_alerts(2025::smallint, 9::smallint);
SELECT 'alertas_repetido', fire.evaluate_alerts(2025::smallint, 9::smallint);
SELECT 'mensagem', message FROM fire.alert_event;
INSERT INTO fire.cell_land_cover SELECT cell_key, 2024, 9 FROM fire.hotspot_cell_day WHERE instrument='VIIRS' LIMIT 1;
SELECT 'vegetacao', * FROM fire.fires_by_land_cover(1,'2024-01-01','2025-01-01');
