/**
 * job:ingest-firms-history — NASA FIRMS yearly country archives (Brazil, no MAP_KEY needed) → fire.hotspot.
 *
 *   npm run job:ingest-firms-history -- --from=2001 --to=2025 --sensors=MODIS_SP,VIIRS_SNPP_SP [--force]
 *
 * - Uses the existing FIRMS connector (country_archive mode), already clipped to the Goiás bounding box;
 *   the exact state polygon is applied later in SQL (fire.cell_region).
 * - Confidence is normalized at ingestion (MODIS 0–100 and VIIRS l/n/h → 0/1/2, same rule as fire.normalize_confidence).
 * - Idempotent: natural key (sensor, time, lat, lon) + ON CONFLICT DO NOTHING; a year already loaded is skipped
 *   unless --force. Each file is traced in fire.ingest_batch (URL without any key).
 * - The harmonized series uses MODIS + VIIRS S-NPP only; other VIIRS satellites would need their own factor.
 */
import { buildSafeSourceUrl, firmsConnector, type FirmsQuery } from '../connectors/firms.js';
import { logger } from '../core/logger.js';
import type { FirmsHotspotRecord } from '../core/types.js';
import { getPool } from '../db/pool.js';
import { isMain } from '../core/entry.js';

type ArchiveSensor = 'MODIS_SP' | 'VIIRS_SNPP_SP' | 'VIIRS_NOAA20_SP';

const SENSOR_IDS: Record<ArchiveSensor, { id: number; firstYear: number }> = {
  MODIS_SP: { id: 1, firstYear: 2000 },
  VIIRS_SNPP_SP: { id: 2, firstYear: 2012 },
  VIIRS_NOAA20_SP: { id: 3, firstYear: 2018 },
};

const BATCH_ROWS = 1000; // 16 params per row → 16k params per INSERT (PostgreSQL limit is 65,535)

export interface IngestOptions {
  from: number;
  to: number;
  sensors: ArchiveSensor[];
  force: boolean;
}

export function parseArgs(argv: string[]): IngestOptions {
  const get = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const from = Number(get('from') ?? 2001);
  const to = Number(get('to') ?? 2025);
  const sensors = (get('sensors') ?? 'MODIS_SP,VIIRS_SNPP_SP').split(',').map((s) => s.trim());
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 2000 || to > 2100 || to < from) {
    throw new Error('Invalid --from/--to');
  }
  for (const s of sensors) if (!(s in SENSOR_IDS)) throw new Error(`Invalid sensor ${s}`);
  return { from, to, sensors: sensors as ArchiveSensor[], force: argv.includes('--force') };
}

export async function insertHotspots(batchId: number, sensorId: number, rows: FirmsHotspotRecord[]): Promise<number> {
  if (!rows.length) return 0;
  const pool = getPool();
  let loaded = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      const b = j * 16;
      values.push(
        sensorId, batchId, r.acqIsoUtc,
        Math.round(r.latitude * 1e5) / 1e5, Math.round(r.longitude * 1e5) / 1e5,
        r.satellite.slice(0, 10), r.brightnessK, r.brightness2K, r.scan, r.track,
        r.confidenceRaw.slice(0, 8), r.confidenceNorm, r.frpMw, r.daynight, r.fireType ?? null, r.processing
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16})`;
    });
    const res = await pool.query(
      `INSERT INTO fire.hotspot (sensor_id, batch_id, acq_ts, latitude, longitude, satellite, brightness_k, brightness2_k,
                                 scan, track, confidence_raw, confidence_norm, frp_mw, daynight, fire_type, processing)
       VALUES ${tuples.join(',')}
       ON CONFLICT ON CONSTRAINT hotspot_natural_ux DO NOTHING`,
      values
    );
    loaded += res.rowCount ?? 0;
  }
  return loaded;
}

async function yearAlreadyLoaded(sensorId: number, year: number): Promise<boolean> {
  const res = await getPool().query(
    `SELECT 1 FROM fire.ingest_batch
      WHERE sensor_id = $1 AND kind = 'country_yearly' AND extract(year FROM period_start) = $2 AND rows_loaded > 0
      LIMIT 1`,
    [sensorId, year]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function ingestYear(sensor: ArchiveSensor, year: number, force = false): Promise<{ read: number; loaded: number } | null> {
  const meta = SENSOR_IDS[sensor];
  if (year < meta.firstYear) return null;
  if (!force && (await yearAlreadyLoaded(meta.id, year))) {
    logger.info({ sensor, year }, 'already loaded, skipping (use --force to reload)');
    return null;
  }
  const query: FirmsQuery = { mode: 'country_archive', sensor, year };
  const url = buildSafeSourceUrl(query); // never contains a key
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15 * 60 * 1000);
  const rows: FirmsHotspotRecord[] = [];
  try {
    for await (const rec of firmsConnector.fetch(query, ctrl.signal)) rows.push(rec);
  } finally {
    clearTimeout(timer);
  }
  return storeYear(sensor, year, url, rows);
}

/** Writes one parsed yearly file: trace row in fire.ingest_batch, then the hotspots (idempotent). */
export async function storeYear(sensor: ArchiveSensor, year: number, sourceUrl: string, rows: FirmsHotspotRecord[]): Promise<{ read: number; loaded: number }> {
  const meta = SENSOR_IDS[sensor];
  const pool = getPool();
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO fire.ingest_batch (sensor_id, kind, processing, source_url, period_start, period_end, rows_read)
     VALUES ($1, 'country_yearly', 'SP', $2, make_date($3, 1, 1), make_date($3, 12, 31), $4) RETURNING id`,
    [meta.id, sourceUrl, year, rows.length]
  );
  const batchId = Number(batch.rows[0]!.id);
  const loaded = await insertHotspots(batchId, meta.id, rows);
  await pool.query('UPDATE fire.ingest_batch SET rows_loaded = $2 WHERE id = $1', [batchId, loaded]);
  logger.info({ sensor, year, read: rows.length, loaded }, 'FIRMS year ingested');
  return { read: rows.length, loaded };
}

export async function runIngestFirmsHistory(opts: IngestOptions): Promise<void> {
  for (const sensor of opts.sensors) {
    for (let year = opts.from; year <= opts.to; year++) {
      try {
        await ingestYear(sensor, year, opts.force);
      } catch (err) {
        // A missing yearly file (e.g. current year not yet archived) must not stop the other years.
        logger.warn({ sensor, year, err: err instanceof Error ? err.message : String(err) }, 'year skipped');
      }
    }
  }
}

if (isMain(import.meta.url)) {
  runIngestFirmsHistory(parseArgs(process.argv.slice(2)))
    .then(() => getPool().end())
    .catch((err) => {
      logger.error({ err: String(err) }, 'job:ingest-firms-history failed');
      process.exit(1);
    });
}
