-- Teste funcional da extensão operacional (A, B, C): rodar depois de teste_contexto.sql
\set ON_ERROR_STOP 1

-- A. Teste de clustering espacial DBSCAN (MODIS 1 km + VIIRS 375 m no mesmo foco) e escala de recursos por FRP
SELECT 'dbscan_clusters', day, cluster_id, n_detections, sensors, modis_pixels, viirs_pixels, max_frp_mw, sum_frp_mw
FROM fire.cluster_hotspots_dbscan(1, '2024-08-01', '2024-08-31', 1000.0);

SELECT 'escala_recursos', * FROM fire.estimate_resources_by_frp(12, 28.5, 95.0);

-- B. Teste de análise de Focos Raízes & Histórico (recorrência sazonal vs anomalia climática)
SELECT 'focos_raizes', month, years_observed, years_with_fire, recurrence_pct, is_root_month, pattern_regime
FROM fire.root_fire_analysis(1, 'monthly_ratio', 2012::smallint, 2024::smallint)
WHERE month IN (2, 8, 9);

-- C. Teste de Clima Diário NASA POWER e Previsibilidade / Propagação
INSERT INTO fire.weather_daily_power (region_id, day, t2m_max_c, rh2m_pct, prectotcorr_mm, ws10m_ms, wd10m_deg)
VALUES (1, '2024-09-10', 37.8, 21.5, 0.0, 4.6, 85.0)
ON CONFLICT (region_id, day) DO UPDATE SET t2m_max_c = EXCLUDED.t2m_max_c;

SELECT 'previsibilidade_power', *
FROM fire.calculate_fire_predictability(37.8, 21.5, 0.0, 4.6, 85.0, 92.0);
