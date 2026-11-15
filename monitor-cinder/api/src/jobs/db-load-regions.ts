/**
 * job:db-load-regions — IBGE municipalities (UF 52) → fire.region, plus the state polygon as their union.
 * Idempotent: re-running updates names/geometries in place (upsert on kind + ibge_code).
 */
import { ibgeConnector } from '../connectors/ibge.js';
import { logger } from '../core/logger.js';
import { getPool } from '../db/pool.js';
import { isMain } from '../core/entry.js';

const MAX_VERTICES = 20000; // matches region_vertices_ck

export async function runDbLoadRegions(uf = '52', ufName = 'Goiás'): Promise<{ municipalities: number }> {
  const munis = await ibgeConnector.loadMunicipalities(uf);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const m of munis.values()) {
      if (!/^\d{7}$/.test(m.ibgeCode)) continue;
      await client.query(
        `INSERT INTO fire.region (kind, ibge_code, name, geom)
         VALUES ('municipio', $1, $2,
                 ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)), 3)))
         ON CONFLICT (kind, ibge_code) WHERE ibge_code IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom`,
        [m.ibgeCode, m.name.slice(0, 120), JSON.stringify(m.geometry)]
      );
      n++;
    }
    // State polygon = union of its municipalities (simplified only if it exceeds the vertex limit)
    await client.query(
      `WITH u AS (
         SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Union(geom)), 3)) AS g
         FROM fire.region WHERE kind = 'municipio' AND left(ibge_code, 2) = $1
       ), s AS (
         SELECT CASE WHEN ST_NPoints(g) > $3 THEN ST_Multi(ST_SimplifyPreserveTopology(g, 0.001)) ELSE g END AS g FROM u
       )
       INSERT INTO fire.region (kind, ibge_code, name, geom)
       SELECT 'uf', $1, $2, g FROM s
       ON CONFLICT (kind, ibge_code) WHERE ibge_code IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom`,
      [uf, ufName, MAX_VERTICES]
    );
    await client.query('COMMIT');
    logger.info({ uf, municipalities: n }, 'job:db-load-regions completed');
    return { municipalities: n };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (isMain(import.meta.url)) {
  runDbLoadRegions()
    .then(() => getPool().end())
    .catch((err) => {
      logger.error({ err: String(err) }, 'job:db-load-regions failed');
      process.exit(1);
    });
}
