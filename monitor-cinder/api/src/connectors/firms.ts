import { z } from 'zod';
import { config } from '../config.js';
import { logger, redactSecrets } from '../core/logger.js';
import type { FirmsHotspotRecord, FirmsSensorCode, SourceConnector } from '../core/types.js';
import { FirmsSensorSchema } from '../core/types.js';

/**
 * Normalizes confidence across MODIS (0..100) and VIIRS/OLI ('l' | 'n' | 'h').
 * 0 = low, 1 = nominal, 2 = high
 */
export function normalizeConfidence(instrument: 'MODIS' | 'VIIRS' | 'OLI', raw: string): 0 | 1 | 2 {
  const clean = raw.trim().toLowerCase();
  if (instrument === 'VIIRS' || instrument === 'OLI') {
    if (clean === 'h' || clean === 'high') return 2;
    if (clean === 'l' || clean === 'low') return 0;
    const n = Number(clean);
    if (Number.isFinite(n)) return n < 30 ? 0 : n < 80 ? 1 : 2;
    return 1;
  }
  const num = Number(clean);
  if (!Number.isFinite(num)) return 1;
  if (num < 30) return 0;
  if (num < 80) return 1;
  return 2;
}

export type FirmsQuery =
  | {
      mode: 'area_api';
      sensor: FirmsSensorCode;
      bbox: [number, number, number, number]; // [west, south, east, north]
      dayRange: number; // 1..10
      date?: string; // optional YYYY-MM-DD
    }
  | {
      mode: 'country_archive';
      sensor: 'MODIS_SP' | 'VIIRS_SNPP_SP' | 'VIIRS_NOAA20_SP';
      year: number;
      bbox?: [number, number, number, number];
    };

const CsvRowSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  acq_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  acq_time: z.string().min(1).max(4),
  satellite: z.string().min(1),
  confidence: z.string().min(1),
  frp: z.coerce.number().min(0).default(0),
  daynight: z.enum(['D', 'N']).default('D'),
  brightness: z.coerce.number().optional(),
  bright_ti4: z.coerce.number().optional(),
  bright_t31: z.coerce.number().optional(),
  bright_ti5: z.coerce.number().optional(),
  scan: z.coerce.number().optional(),
  track: z.coerce.number().optional(),
  type: z.coerce.number().int().min(0).max(9).optional(),
});

function sensorMetadata(sensor: FirmsSensorCode): {
  instrument: 'MODIS' | 'VIIRS' | 'OLI';
  pixelM: 1000 | 375 | 30;
  processing: 'NRT' | 'SP';
  archiveFolder: 'modis' | 'viirs-snpp' | 'viirs-jpss1' | null;
} {
  if (sensor.startsWith('MODIS')) {
    return {
      instrument: 'MODIS',
      pixelM: 1000,
      processing: sensor.endsWith('_SP') ? 'SP' : 'NRT',
      archiveFolder: 'modis',
    };
  }
  if (sensor.startsWith('VIIRS')) {
    return {
      instrument: 'VIIRS',
      pixelM: 375,
      processing: sensor.endsWith('_SP') ? 'SP' : 'NRT',
      archiveFolder: sensor.includes('NOAA20') ? 'viirs-jpss1' : sensor.includes('SNPP') ? 'viirs-snpp' : null,
    };
  }
  return {
    instrument: 'OLI',
    pixelM: 30,
    processing: 'NRT',
    archiveFolder: null,
  };
}

/**
 * Builds the NASA FIRMS Area REST API URL:
 * GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SENSOR}/{COORDINATES}/{DAY_RANGE}
 */
export function buildFirmsAreaUrl(
  mapKey: string,
  sensor: FirmsSensorCode,
  bbox: [number, number, number, number],
  dayRange: number,
  date?: string
): string {
  const validSensor = FirmsSensorSchema.parse(sensor);
  const days = Math.max(1, Math.min(10, Math.trunc(dayRange)));
  const coords = bbox.map((c) => Number(c.toFixed(4))).join(',');
  const base = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${validSensor}/${coords}/${days}`;
  return date ? `${base}/${date}` : base;
}

/**
 * Builds the public URL (with MAP_KEY redacted) safe for storing in `fire.ingest_batch.source_url` or logging.
 */
export function buildSafeSourceUrl(query: FirmsQuery): string {
  if (query.mode === 'area_api') {
    const coords = query.bbox.map((c) => Number(c.toFixed(4))).join(',');
    const days = Math.max(1, Math.min(10, Math.trunc(query.dayRange)));
    const base = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/REDACTED/${query.sensor}/${coords}/${days}`;
    return query.date ? `${base}/${query.date}` : base;
  }
  const meta = sensorMetadata(query.sensor);
  const folder = meta.archiveFolder ?? 'modis';
  return `https://firms.modaps.eosdis.nasa.gov/data/country/${folder}/${query.year}/${folder}_${query.year}_Brazil.csv`;
}

/**
 * Parses FIRMS CSV text (MODIS 1 km, VIIRS 375 m, or LANDSAT 30 m) into normalized records.
 */
export function parseFirmsCsv(
  csvText: string,
  sensor: FirmsSensorCode,
  bbox?: [number, number, number, number]
): FirmsHotspotRecord[] {
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const meta = sensorMetadata(sensor);
  const out: FirmsHotspotRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < headers.length) continue;

    const rawObj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      rawObj[headers[c]!] = cols[c]!.trim();
    }

    const parsed = CsvRowSchema.safeParse(rawObj);
    if (!parsed.success) continue;
    const row = parsed.data;

    if (bbox) {
      const [west, south, east, north] = bbox;
      if (row.longitude < west || row.longitude > east || row.latitude < south || row.latitude > north) {
        continue;
      }
    }

    const hhmm = row.acq_time.padStart(4, '0');
    const hh = hhmm.slice(0, 2);
    const mm = hhmm.slice(2, 4);
    const acqIsoUtc = `${row.acq_date}T${hh}:${mm}:00Z`;

    const brightnessK = row.brightness ?? row.bright_ti4 ?? null;
    const brightness2K = row.bright_t31 ?? row.bright_ti5 ?? null;

    out.push({
      sensor,
      instrument: meta.instrument,
      pixelM: meta.pixelM,
      latitude: row.latitude,
      longitude: row.longitude,
      brightnessK: brightnessK !== null && Number.isFinite(brightnessK) ? brightnessK : null,
      brightness2K: brightness2K !== null && Number.isFinite(brightness2K) ? brightness2K : null,
      scan: row.scan ?? null,
      track: row.track ?? null,
      acqDate: row.acq_date,
      acqTime: hhmm,
      acqIsoUtc,
      satellite: row.satellite,
      confidenceRaw: row.confidence,
      confidenceNorm: normalizeConfidence(meta.instrument, row.confidence),
      frpMw: Number.isFinite(row.frp) && row.frp >= 0 ? row.frp : 0,
      daynight: row.daynight,
      processing: meta.processing,
      fireType: row.type ?? null,
    });
  }

  return out;
}

async function fetchWithRetry(url: string, signal: AbortSignal, maxAttempts = 3): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        signal,
        headers: {
          'User-Agent': 'MonitorCinder/1.0 (NASA Space Apps 2026 Goiania)',
          Accept: 'text/csv,text/plain,*/*',
        },
      });
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(`Non-retryable HTTP ${res.status}${body ? `: ${body}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      const msg = err instanceof Error ? redactSecrets(err.message) : 'Network error';
      lastErr = new Error(msg);
      if (attempt < maxAttempts && !msg.startsWith('Non-retryable')) {
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt - 1)));
      } else {
        break;
      }
    }
  }
  throw lastErr ?? new Error('FIRMS request failed');
}

/** Date range FIRMS currently serves per stream (data_availability API), e.g. VIIRS_NOAA20_SP → 2018-04-01..2026-07-31. */
const AvailabilityRow = z.object({
  data_id: z.string().min(1).max(40),
  min_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  max_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type FirmsAvailability = Map<string, { min: string; max: string }>;

export async function fetchFirmsAvailability(signal: AbortSignal): Promise<FirmsAvailability> {
  const key = config.FIRMS_MAP_KEY;
  if (!key) throw new Error('FIRMS_MAP_KEY is not configured in .env');
  const text = await fetchWithRetry(`https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/${key}/ALL`, signal);
  const lines = text.trim().split(/\r?\n/);
  const header = (lines.shift() ?? '').split(',').map((h) => h.trim());
  const out: FirmsAvailability = new Map();
  for (const line of lines) {
    const cells = line.split(',');
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    const row = AvailabilityRow.safeParse(obj);
    if (row.success) out.set(row.data.data_id, { min: row.data.min_date, max: row.data.max_date });
  }
  if (!out.size) throw new Error('FIRMS data_availability returned no rows');
  return out;
}

export class FirmsConnector implements SourceConnector<FirmsQuery, FirmsHotspotRecord> {
  public readonly id = 'firms' as const;
  public readonly license = 'NASA Earthdata / FIRMS Open Data Policy (MODIS C6.1 & VIIRS 375m)';

  public async *fetch(query: FirmsQuery, signal: AbortSignal): AsyncIterable<FirmsHotspotRecord> {
    let url: string;
    let bbox: [number, number, number, number] | undefined;

    if (query.mode === 'area_api') {
      const mapKey = config.FIRMS_MAP_KEY;
      if (!mapKey) {
        throw new Error('FIRMS_MAP_KEY is not configured in .env');
      }
      url = buildFirmsAreaUrl(mapKey, query.sensor, query.bbox, query.dayRange, query.date);
      bbox = query.bbox;
    } else {
      url = buildSafeSourceUrl(query);
      bbox = query.bbox ?? config.bbox;
    }

    logger.info({ source: this.id, url: redactSecrets(url), sensor: query.sensor }, 'Fetching FIRMS CSV');
    const csvText = await fetchWithRetry(url, signal);
    // FIRMS sometimes answers 200 with a message instead of CSV (e.g. the transaction limit). Without the CSV header
    // that would silently read as "no fire"; make it an error so the caller retries or leaves a recorded gap.
    const head = (csvText.split(/\r?\n/, 1)[0] ?? '').trim();
    if (head && !/(^|,)\s*latitude\s*(,|$)/i.test(head)) {
      throw new Error(`FIRMS returned no CSV: ${redactSecrets(head.slice(0, 160))}`);
    }
    const records = parseFirmsCsv(csvText, query.sensor, bbox);
    for (const rec of records) {
      yield rec;
    }
  }

  /**
   * Fetches multi-sensor active hotspots across MODIS (1km) and VIIRS (375m) for an area box
   * and returns the raw records ready for spatial DBSCAN/H3 deduplication.
   */
  public async fetchMultiSensorArea(
    bbox: [number, number, number, number],
    dayRange = 5,
    sensors: FirmsSensorCode[] = ['MODIS_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'],
    date?: string
  ): Promise<FirmsHotspotRecord[]> {
    const out: FirmsHotspotRecord[] = [];
    for (const sensor of sensors) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        for await (const r of this.fetch({ mode: 'area_api', sensor, bbox, dayRange, date }, ctrl.signal)) {
          out.push(r);
        }
      } catch (err) {
        logger.warn(
          { sensor, err: err instanceof Error ? redactSecrets(err.message) : String(err) },
          'Sensor area fetch skipped or failed'
        );
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  }
}

export const firmsConnector = new FirmsConnector();
