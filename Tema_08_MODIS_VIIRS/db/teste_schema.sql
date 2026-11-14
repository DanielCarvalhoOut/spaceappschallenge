-- Teste funcional do schema.sql: psql -d <banco> -f teste_schema.sql (rodar depois do schema, em banco vazio)
\set ON_ERROR_STOP 1
INSERT INTO fire.region (kind, ibge_code, name, geom) VALUES
 ('uf','52','Goiás (caixa de teste)', ST_Multi(ST_MakeEnvelope(-53.25,-19.50,-45.90,-12.39,4326)));
INSERT INTO fire.ingest_batch (sensor_id, kind, processing, source_url, period_start, period_end, file_sha256, rows_read)
VALUES (1,'country_yearly','SP','https://firms.modaps.eosdis.nasa.gov/data/country/modis/2024/modis_2024_Brazil.csv','2024-01-01','2024-12-31', repeat('a',64), 3),
       (2,'country_yearly','SP','https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/2024/viirs-snpp_2024_Brazil.csv','2024-01-01','2024-12-31', repeat('b',64), 4);
-- MODIS: 1 pixel; VIIRS: 3 pixels do mesmo fogo (~375 m) + 1 baixa confiança
INSERT INTO fire.hotspot (sensor_id,batch_id,acq_ts,latitude,longitude,satellite,brightness_k,brightness2_k,scan,track,confidence_raw,confidence_norm,frp_mw,daynight,fire_type,processing) VALUES
 (1,1,'2024-08-10 16:40+00',-16.68000,-49.25000,'Aqua',330.1,300.2,1.0,1.0,'72',fire.normalize_confidence('MODIS','72'),25.0,'D',0,'SP'),
 (2,2,'2024-08-10 17:10+00',-16.68010,-49.25010,'N',340.0,295.0,0.4,0.4,'n',fire.normalize_confidence('VIIRS','n'),8.1,'D',0,'SP'),
 (2,2,'2024-08-10 17:10+00',-16.68200,-49.25100,'N',338.0,294.0,0.4,0.4,'n',fire.normalize_confidence('VIIRS','n'),7.5,'D',0,'SP'),
 (2,2,'2024-08-10 17:10+00',-16.67900,-49.24850,'N',345.0,296.0,0.4,0.4,'h',fire.normalize_confidence('VIIRS','h'),12.0,'D',0,'SP'),
 (2,2,'2024-09-02 05:00+00',-15.90000,-48.10000,'N',310.0,290.0,0.4,0.4,'l',fire.normalize_confidence('VIIRS','l'),1.0,'N',0,'SP');
-- idempotência: repetir o mesmo foco deve ser ignorado
INSERT INTO fire.hotspot (sensor_id,batch_id,acq_ts,latitude,longitude,satellite,confidence_raw,confidence_norm,processing)
VALUES (1,1,'2024-08-10 16:40+00',-16.68000,-49.25000,'Aqua','72',1,'SP') ON CONFLICT ON CONSTRAINT hotspot_natural_ux DO NOTHING;
SELECT 'partição', tableoid::regclass, count(*) FROM fire.hotspot GROUP BY 2;
SELECT 'conf', fire.normalize_confidence('MODIS','29'), fire.normalize_confidence('MODIS','30'), fire.normalize_confidence('MODIS','80'), fire.normalize_confidence('VIIRS','H');
REFRESH MATERIALIZED VIEW fire.hotspot_cell_day;
REFRESH MATERIALIZED VIEW CONCURRENTLY fire.hotspot_cell_day;
SELECT 'celulas', day, instrument, n_pixels FROM fire.hotspot_cell_day ORDER BY 2,3;
SELECT 'mensal', * FROM fire.monthly_cell_counts(1,'2024-01-01','2025-01-01') ORDER BY 2,3;
SELECT 'area_km2', round(area_km2) FROM fire.region;
