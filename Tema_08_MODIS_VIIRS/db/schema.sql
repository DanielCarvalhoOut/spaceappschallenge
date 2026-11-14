-- Tema 8 · Harmonization of MODIS and VIIRS Hot Spots
-- Banco: PostgreSQL 15+ com PostGIS 3+ (funciona no Supabase)
--
-- Decisões:
--   * Um esquema próprio (fire) e um papel só-leitura para a API do app (menor privilégio).
--   * Focos particionados por ano: a consulta típica é "região + período" e o histórico tem 26 anos.
--   * Carga idempotente: chave única natural (sensor, instante, lat, lon) + lote de ingestão com hash do arquivo.
--   * Geometria em SRID 4326 para guardar; grade de harmonização em SRID 5880
--     (SIRGAS 2000 / Brazil Polyconic, em metros).
--   * Confiança normalizada numa escala comum (0 baixa, 1 nominal, 2 alta), guardando também o valor original.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS fire;

-- 1. Catálogo de sensores ------------------------------------------------------
CREATE TABLE fire.sensor (
    id             smallint PRIMARY KEY,
    code           text    NOT NULL UNIQUE,      -- igual ao SOURCE da API sem sufixo: MODIS, VIIRS_SNPP, VIIRS_NOAA20, VIIRS_NOAA21
    instrument     text    NOT NULL,             -- MODIS | VIIRS
    platform       text    NOT NULL,             -- Terra/Aqua | Suomi-NPP | NOAA-20 | NOAA-21
    pixel_m        integer NOT NULL CHECK (pixel_m > 0),
    first_year     smallint NOT NULL,
    country_folder text,                          -- pasta do arquivo anual: modis | viirs-snpp | viirs-jpss1
    CONSTRAINT sensor_instrument_ck CHECK (instrument IN ('MODIS', 'VIIRS'))
);

INSERT INTO fire.sensor (id, code, instrument, platform, pixel_m, first_year, country_folder) VALUES
    (1, 'MODIS',        'MODIS', 'Terra/Aqua', 1000, 2000, 'modis'),
    (2, 'VIIRS_SNPP',   'VIIRS', 'Suomi-NPP',   375, 2012, 'viirs-snpp'),
    (3, 'VIIRS_NOAA20', 'VIIRS', 'NOAA-20',     375, 2018, 'viirs-jpss1'),
    (4, 'VIIRS_NOAA21', 'VIIRS', 'NOAA-21',     375, 2023, NULL);
-- first_year do NOAA-21 é aproximado: conferir em /api/data_availability antes de usar.

-- 2. Rastreabilidade da carga --------------------------------------------------
CREATE TABLE fire.ingest_batch (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sensor_id    smallint    NOT NULL REFERENCES fire.sensor (id),
    kind         text        NOT NULL CHECK (kind IN ('country_yearly', 'api_area')),
    processing   text        NOT NULL CHECK (processing IN ('SP', 'NRT')),
    source_url   text        NOT NULL,           -- URL sem a MAP_KEY (nunca gravar a chave)
    period_start date        NOT NULL,
    period_end   date        NOT NULL,
    file_sha256  char(64),
    rows_read    integer     NOT NULL DEFAULT 0,
    rows_loaded  integer     NOT NULL DEFAULT 0,
    loaded_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ingest_period_ck CHECK (period_end >= period_start),
    CONSTRAINT ingest_url_no_key_ck CHECK (source_url !~* 'api/(area|country)/csv/[0-9a-f]{32}')
);
CREATE UNIQUE INDEX ingest_batch_file_ux ON fire.ingest_batch (sensor_id, file_sha256) WHERE file_sha256 IS NOT NULL;

-- 3. Focos de calor (particionado por ano) ---------------------------------------
CREATE TABLE fire.hotspot (
    id              bigint GENERATED ALWAYS AS IDENTITY,
    sensor_id       smallint    NOT NULL REFERENCES fire.sensor (id),
    batch_id        bigint      NOT NULL REFERENCES fire.ingest_batch (id),
    acq_ts          timestamptz NOT NULL,         -- acq_date + acq_time (UTC)
    latitude        numeric(8,5) NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude       numeric(9,5) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    geom            geometry(Point, 4326) GENERATED ALWAYS AS
                        (ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)) STORED,
    satellite       text        NOT NULL,         -- Terra, Aqua, N, N20, N21
    brightness_k    real,                         -- MODIS brightness | VIIRS bright_ti4
    brightness2_k   real,                         -- MODIS bright_t31 | VIIRS bright_ti5
    scan            real,
    track           real,
    confidence_raw  text        NOT NULL,         -- MODIS '0'..'100' | VIIRS 'l','n','h'
    confidence_norm smallint    NOT NULL CHECK (confidence_norm BETWEEN 0 AND 2),
    frp_mw          real CHECK (frp_mw >= 0),
    daynight        char(1)     CHECK (daynight IN ('D', 'N')),
    fire_type       smallint,                     -- coluna type (ausente no NRT)
    processing      text        NOT NULL CHECK (processing IN ('SP', 'NRT')),
    PRIMARY KEY (id, acq_ts),
    CONSTRAINT hotspot_natural_ux UNIQUE (sensor_id, acq_ts, latitude, longitude)
) PARTITION BY RANGE (acq_ts);

-- Uma partição por ano, 2000 a 2027.
DO $$
DECLARE y int;
BEGIN
    FOR y IN 2000..2027 LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS fire.hotspot_%s PARTITION OF fire.hotspot
               FOR VALUES FROM (%L) TO (%L)',
            y, make_date(y, 1, 1), make_date(y + 1, 1, 1));
    END LOOP;
END $$;

CREATE INDEX hotspot_geom_gix   ON fire.hotspot USING gist (geom);
CREATE INDEX hotspot_acq_brin   ON fire.hotspot USING brin (acq_ts);
CREATE INDEX hotspot_sensor_ts  ON fire.hotspot (sensor_id, acq_ts);

-- Regra de normalização da confiança (um único lugar para mudar o corte).
-- MODIS: < 30 baixa, 30..79 nominal, >= 80 alta (corte usual na literatura; documentar no projeto).
CREATE OR REPLACE FUNCTION fire.normalize_confidence(p_instrument text, p_raw text)
RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE
        WHEN p_instrument = 'VIIRS' THEN
            CASE lower(p_raw) WHEN 'l' THEN 0 WHEN 'n' THEN 1 WHEN 'h' THEN 2 END
        WHEN p_instrument = 'MODIS' AND p_raw ~ '^\d{1,3}$' THEN
            CASE WHEN p_raw::int < 30 THEN 0 WHEN p_raw::int < 80 THEN 1 ELSE 2 END
    END::smallint
$$;

-- 4. Regiões (IBGE e desenhadas pelo usuário) -------------------------------------
CREATE TABLE fire.region (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('uf', 'municipio', 'custom')),
    ibge_code   text,                             -- 52 = Goiás; 7 dígitos para município
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    owner_id    uuid,                             -- só para kind = 'custom'
    geom        geometry(MultiPolygon, 4326) NOT NULL,
    area_km2    numeric GENERATED ALWAYS AS (ST_Area(geom::geography) / 1e6) STORED,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT region_custom_owner_ck CHECK ((kind = 'custom') = (owner_id IS NOT NULL)),
    CONSTRAINT region_geom_valid_ck   CHECK (ST_IsValid(geom)),
    CONSTRAINT region_vertices_ck     CHECK (ST_NPoints(geom) <= 20000)
);
CREATE UNIQUE INDEX region_ibge_ux ON fire.region (kind, ibge_code) WHERE ibge_code IS NOT NULL;
CREATE INDEX region_geom_gix ON fire.region USING gist (geom);

-- 5. Grade comum para harmonização (método "células com fogo") -----------------------
-- Célula de 1 km em SIRGAS 2000 / Brazil Polyconic. O mesmo fogo visto por VIIRS em
-- vários pixels de 375 m tende a cair numa mesma célula de 1 km, como no MODIS.
CREATE OR REPLACE FUNCTION fire.cell_key(p_geom geometry, p_size_m integer DEFAULT 1000)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT ((floor(ST_X(t.g) / p_size_m)::bigint + 10000000) * 100000000)
         +  (floor(ST_Y(t.g) / p_size_m)::bigint + 50000000)
    FROM (SELECT ST_Transform(p_geom, 5880) AS g) t
$$;

CREATE MATERIALIZED VIEW fire.hotspot_cell_day AS
SELECT
    fire.cell_key(h.geom)              AS cell_key,
    (h.acq_ts AT TIME ZONE 'UTC')::date AS day,
    s.instrument,
    count(*)                           AS n_pixels,
    max(h.frp_mw)                      AS max_frp_mw,
    max(h.confidence_norm)             AS max_confidence,
    ST_Centroid(ST_Collect(h.geom))    AS geom
FROM fire.hotspot h
JOIN fire.sensor s ON s.id = h.sensor_id
WHERE h.confidence_norm >= 1           -- nominal ou alta nos dois sensores
GROUP BY 1, 2, 3
WITH NO DATA;
CREATE UNIQUE INDEX hotspot_cell_day_ux ON fire.hotspot_cell_day (cell_key, day, instrument);
CREATE INDEX hotspot_cell_day_geom_gix ON fire.hotspot_cell_day USING gist (geom);

-- 6. Fatores de harmonização ------------------------------------------------------
CREATE TABLE fire.harmonization_factor (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    region_id     bigint   NOT NULL REFERENCES fire.region (id) ON DELETE CASCADE,
    method        text     NOT NULL CHECK (method IN ('grid_cells', 'monthly_ratio', 'confidence_match')),
    month         smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
    factor        numeric  NOT NULL CHECK (factor > 0),     -- multiplica a contagem MODIS para escala VIIRS
    calib_from    smallint NOT NULL,
    calib_to      smallint NOT NULL,
    n_years       smallint NOT NULL,
    r2            numeric,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    notes         text,
    CONSTRAINT harm_unique UNIQUE (region_id, method, month),
    CONSTRAINT harm_period_ck CHECK (calib_to >= calib_from)
);

-- 7. Calendário de queimadas (o que o app mostra) -----------------------------------
CREATE TABLE fire.calendar_monthly (
    region_id         bigint   NOT NULL REFERENCES fire.region (id) ON DELETE CASCADE,
    method            text     NOT NULL,
    year              smallint NOT NULL,
    month             smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
    modis_count       integer,
    viirs_count       integer,
    harmonized_count  numeric  NOT NULL,
    baseline_mean     numeric,                    -- média do mesmo mês no período de referência
    baseline_sd       numeric,
    anomaly_z         numeric,                    -- (harmonized - mean) / sd
    days_missing      smallint NOT NULL DEFAULT 0, -- de /api/missing_data: dias sem satélite no mês
    computed_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (region_id, method, year, month)
);

-- 8. Contagem por região e mês (base do calendário) ----------------------------------
-- Usa a grade comum: conta células-dia com fogo, por instrumento.
CREATE OR REPLACE FUNCTION fire.monthly_cell_counts(p_region_id bigint, p_from date, p_to date)
RETURNS TABLE (year int, month int, instrument text, cell_days bigint)
LANGUAGE sql STABLE AS $$
    SELECT extract(year FROM c.day)::int, extract(month FROM c.day)::int, c.instrument, count(*)
    FROM fire.hotspot_cell_day c
    JOIN fire.region r ON r.id = p_region_id
    WHERE c.day >= p_from AND c.day < p_to
      AND ST_Intersects(c.geom, r.geom)
    GROUP BY 1, 2, 3
$$;

-- 9. Acesso: a API do app só lê ---------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fire_api_ro') THEN
        CREATE ROLE fire_api_ro NOLOGIN;
    END IF;
END $$;
GRANT USAGE ON SCHEMA fire TO fire_api_ro;
GRANT SELECT ON fire.sensor, fire.region, fire.calendar_monthly, fire.harmonization_factor, fire.hotspot_cell_day TO fire_api_ro;
GRANT SELECT (id, sensor_id, acq_ts, latitude, longitude, geom, satellite, confidence_norm, frp_mw, daynight)
    ON fire.hotspot TO fire_api_ro;
GRANT EXECUTE ON FUNCTION fire.monthly_cell_counts(bigint, date, date) TO fire_api_ro;
-- Regiões custom: a escrita passa por um papel separado na API, sempre filtrando owner_id = usuário autenticado (evita IDOR).

-- Primeira vez (a view nasce vazia):
--   REFRESH MATERIALIZED VIEW fire.hotspot_cell_day;
-- Depois de cada carga (sem travar leituras):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY fire.hotspot_cell_day;
--
-- Testado em PostgreSQL 16 + PostGIS em 14/11/2026 (ver db/teste_schema.sql).
-- Limite observado no teste: 3 pixels VIIRS do mesmo fogo na borda entre células
-- caíram em 2 células de 1 km. A grade reduz a contagem dupla, mas não a elimina.
