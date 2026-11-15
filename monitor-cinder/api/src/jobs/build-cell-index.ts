/**
 * job:build-cell-index — real FIRMS cells for Goiás without PostGIS.
 *
 *   npm run job:build-cell-index -- --from=2001
 *
 * Four sensors of the harmonized chain: MODIS (Terra+Aqua), VIIRS S-NPP, VIIRS NOAA-20, VIIRS NOAA-21.
 * With FIRMS_MAP_KEY it reads the FIRMS area API for the Goiás box in 5-day windows, from each sensor's first day up
 * to the last day FIRMS serves: standard processing (SP) where it exists, near-real-time (NRT) after it — those days
 * are marked provisional. Ranges come from the FIRMS data_availability API. Without a key, or if the area API refuses
 * a year, the yearly country archive is read instead (SP only).
 * Keeps nominal/high confidence inside Goiás municipalities, removes static sources (same rule as
 * fire.build_static_cells) and writes data/firms_goias_cells.json (version 2). Complete years are cached under
 * data/firms_years/ for good; the current year is fetched again when its cache is older than 6 hours.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { fetchFirmsAvailability, firmsConnector, type FirmsAvailability, type FirmsQuery } from '../connectors/firms.js';
import { ibgeConnector, pointInMunicipality } from '../connectors/ibge.js';
import { CELL_INDEX_FILE, SENSORS, cellOf, dayNumber, fromPolyconic, isoDay, type CellIndex, type IndexCell, type Sensor } from '../core/cell-index.js';
import type { FirmsSensorCode } from '../core/types.js';
import { isMain } from '../core/entry.js';
import { logger } from '../core/logger.js';
import { historyStatus } from '../core/history-status.js';

const STREAMS: Record<Sensor, { sp: FirmsSensorCode; nrt: FirmsSensorCode; archive: boolean; defaultFirst: string }> = {
  MODIS: { sp: 'MODIS_SP', nrt: 'MODIS_NRT', archive: true, defaultFirst: '2000-11-01' },
  SNPP: { sp: 'VIIRS_SNPP_SP', nrt: 'VIIRS_SNPP_NRT', archive: true, defaultFirst: '2012-01-20' },
  NOAA20: { sp: 'VIIRS_NOAA20_SP', nrt: 'VIIRS_NOAA20_NRT', archive: true, defaultFirst: '2018-04-01' },
  NOAA21: { sp: 'VIIRS_NOAA21_SP', nrt: 'VIIRS_NOAA21_NRT', archive: false, defaultFirst: '2024-01-17' },
};

/** Compact rows: [lon, lat, day, fireType(−1 = none), nrt(0|1)] of nominal/high detections in the Goiás box. */
type Row = [number, number, number, number, number];
interface YearFile { fetchedAt: string; complete: boolean; rows: Row[] }

const WINDOW_DAYS = 5;        // the FIRMS area API serves 1–5 days per request
const AREA_CONCURRENCY = 4;   // keeps the run inside 5 000 requests per 10 minutes per MAP_KEY
const DAY = 86_400_000;

function parseArgs(argv: string[]): { from: number } {
  const get = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const from = Number(get('from') ?? 2001);
  if (!Number.isInteger(from) || from < 2000 || from > 2100) throw new Error('Invalid --from');
  return { from };
}

/** Windows of one sensor-year, each tagged with the stream that serves it (SP up to spMax, NRT after). */
function windowsOf(year: number, first: number, last: number, spMax: number | null, nrt: boolean): Array<{ date: string; stream: 'sp' | 'nrt' }> {
  const out: Array<{ date: string; stream: 'sp' | 'nrt' }> = [];
  const y0 = Math.max(first, Date.UTC(year, 0, 1) / DAY), y1 = Math.min(last, Date.UTC(year, 11, 31) / DAY);
  for (let d = y0; d <= y1; d += WINDOW_DAYS) {
    const stream = spMax === null || d <= spMax ? 'sp' : 'nrt';
    if (stream === 'nrt' && !nrt) continue;
    out.push({ date: isoDay(d), stream });
  }
  return out;
}

async function fetchWindows(sensor: Sensor, year: number, windows: Array<{ date: string; stream: 'sp' | 'nrt' }>): Promise<Row[]> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < windows.length) {
      const w = windows[next++]!;
      const code = w.stream === 'sp' ? STREAMS[sensor].sp : STREAMS[sensor].nrt;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        for await (const r of firmsConnector.fetch({ mode: 'area_api', sensor: code, bbox: config.bbox, dayRange: WINDOW_DAYS, date: w.date }, ctrl.signal)) {
          if (r.confidenceNorm < 1) continue; // nominal or high, like fire.hotspot_cell_day
          if (r.acqDate.slice(0, 4) !== String(year)) continue;
          const key = `${r.longitude},${r.latitude},${r.acqDate},${r.acqTime}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push([r.longitude, r.latitude, dayNumber(r.acqDate), r.fireType ?? -1, w.stream === 'nrt' ? 1 : 0]);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: AREA_CONCURRENCY }, worker));
  return rows;
}

async function fetchArchive(sensor: Sensor, year: number): Promise<Row[]> {
  const code = STREAMS[sensor].sp as 'MODIS_SP' | 'VIIRS_SNPP_SP' | 'VIIRS_NOAA20_SP';
  const query: FirmsQuery = { mode: 'country_archive', sensor: code, year, bbox: config.bbox };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20 * 60 * 1000);
  const rows: Row[] = [];
  try {
    for await (const r of firmsConnector.fetch(query, ctrl.signal)) {
      if (r.confidenceNorm < 1) continue;
      rows.push([r.longitude, r.latitude, dayNumber(r.acqDate), r.fireType ?? -1, 0]);
    }
  } finally {
    clearTimeout(timer);
  }
  return rows;
}

async function loadYear(sensor: Sensor, year: number, range: { first: number; last: number; spMax: number | null; nrt: boolean }): Promise<YearFile | null> {
  const dir = path.join(config.dataDir, 'firms_years');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sensor}_${year}_goias.json`);
  const legacy = path.join(dir, `${STREAMS[sensor].sp}_${year}_goias.json`); // files written by the previous version
  for (const f of [file, legacy]) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(raw)) return { fetchedAt: '', complete: true, rows: (raw as number[][]).map((r) => [r[0]!, r[1]!, r[2]!, r[3] ?? -1, 0]) };
      const yf = raw as YearFile;
      const fresh = Date.now() - Date.parse(yf.fetchedAt) < 6 * 3_600_000;
      if (yf.complete || fresh) return yf;
    } catch { /* refetch */ }
  }
  const yearEnd = Date.UTC(year, 11, 31) / DAY;
  const complete = range.spMax !== null && yearEnd <= range.spMax;
  let rows: Row[] | null = null;
  if (config.FIRMS_MAP_KEY) {
    try {
      rows = await fetchWindows(sensor, year, windowsOf(year, range.first, range.last, range.spMax, range.nrt));
    } catch (err) {
      logger.warn({ sensor, year, err: err instanceof Error ? err.message : String(err) }, 'area API failed; trying the yearly archive');
    }
  }
  if (!rows && STREAMS[sensor].archive && complete) rows = await fetchArchive(sensor, year);
  if (!rows) return null;
  const yf: YearFile = { fetchedAt: new Date().toISOString(), complete, rows };
  fs.writeFileSync(file, JSON.stringify(yf));
  logger.info({ sensor, year, rows: rows.length, complete }, 'FIRMS year cached (Goiás box)');
  return yf;
}

/** Day ranges per sensor from FIRMS data_availability (SP max, NRT max); defaults when it cannot be read. */
async function sensorRanges(fromYear: number): Promise<Record<Sensor, { first: number; last: number; spMax: number | null; nrt: boolean } | null>> {
  let avail: FirmsAvailability | null = null;
  if (config.FIRMS_MAP_KEY) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try { avail = await fetchFirmsAvailability(ctrl.signal); } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'FIRMS data_availability unavailable; using default ranges');
    } finally { clearTimeout(timer); }
  }
  const today = Math.floor(Date.now() / DAY);
  const out = {} as Record<Sensor, { first: number; last: number; spMax: number | null; nrt: boolean } | null>;
  for (const s of SENSORS) {
    const sp = avail?.get(STREAMS[s].sp), nrt = avail?.get(STREAMS[s].nrt);
    const firstIso = sp?.min ?? nrt?.min ?? STREAMS[s].defaultFirst;
    const first = Math.max(dayNumber(firstIso), Date.UTC(fromYear, 0, 1) / DAY);
    const spMax = sp ? dayNumber(sp.max) : avail ? null : Date.UTC(2025, 11, 31) / DAY;
    const nrtMax = nrt ? dayNumber(nrt.max) : null;
    const last = Math.min(today - 1, Math.max(spMax ?? -1, nrtMax ?? -1));
    out[s] = last >= first ? { first, last, spMax, nrt: nrtMax !== null } : null;
  }
  return out;
}

interface Acc { gx: number; gy: number; ibge: string; days: [Set<number>, Set<number>, Set<number>, Set<number>]; typed: number; staticTyped: number }

export async function runBuildCellIndex(from = 2001): Promise<void> {
  const munis = [...(await ibgeConnector.loadMunicipalities('52')).values()];
  const muniOfCell = new Map<string, string | null>();
  const findMuni = (lon: number, lat: number): string | null => {
    for (const m of munis) if (pointInMunicipality(lat, lon, m)) return m.ibgeCode;
    return null;
  };

  const ranges = await sensorRanges(from);
  const plan: Array<[Sensor, number]> = [];
  for (const s of SENSORS) {
    const r = ranges[s];
    if (!r) continue;
    for (let y = new Date(r.first * DAY).getUTCFullYear(); y <= new Date(r.last * DAY).getUTCFullYear(); y++) plan.push([s, y]);
  }
  historyStatus.total = plan.length;
  historyStatus.done = 0;

  const acc = new Map<string, Acc>();
  const loaded: Record<Sensor, { first: number | null; last: number | null; nrtFrom: number | null }> = {
    MODIS: { first: null, last: null, nrtFrom: null }, SNPP: { first: null, last: null, nrtFrom: null },
    NOAA20: { first: null, last: null, nrtFrom: null }, NOAA21: { first: null, last: null, nrtFrom: null },
  };
  for (const [sensor, year] of plan) {
    historyStatus.done++;
    const r = ranges[sensor]!;
    let yf: YearFile | null = null;
    try {
      yf = await loadYear(sensor, year, r);
    } catch (err) {
      logger.warn({ sensor, year, err: err instanceof Error ? err.message : String(err) }, 'year skipped');
    }
    if (!yf) continue;
    const L = loaded[sensor];
    const y0 = Math.max(r.first, Date.UTC(year, 0, 1) / DAY), y1 = Math.min(r.last, Date.UTC(year, 11, 31) / DAY);
    L.first = L.first === null ? y0 : Math.min(L.first, y0);
    L.last = L.last === null ? y1 : Math.max(L.last, y1);
    const si = SENSORS.indexOf(sensor);
    for (const [lon, lat, day, type, nrt] of yf.rows) {
      if (nrt && (L.nrtFrom === null || day < L.nrtFrom)) L.nrtFrom = day;
      const [gx, gy] = cellOf(lon, lat);
      const key = `${gx}:${gy}`;
      let a = acc.get(key);
      if (!a) {
        let ibge = muniOfCell.get(key);
        if (ibge === undefined) {
          const [clon, clat] = fromPolyconic((gx + 0.5) * 1000, (gy + 0.5) * 1000);
          ibge = findMuni(clon, clat);
          muniOfCell.set(key, ibge);
        }
        if (!ibge) continue;
        a = { gx, gy, ibge, days: [new Set(), new Set(), new Set(), new Set()], typed: 0, staticTyped: 0 };
        acc.set(key, a);
      }
      a.days[si]!.add(day);
      if (type >= 0) { a.typed++; if (type === 2) a.staticTyped++; }
    }
  }

  // Static sources: FIRMS type 2 in most detections, or fire in ≥ 8 distinct months of a year in ≥ 3 years.
  let removed = 0;
  for (const [key, a] of acc) {
    const monthsByYear = new Map<number, Set<number>>();
    for (const set of a.days) for (const d of set) {
      const dt = new Date(d * DAY);
      const y = dt.getUTCFullYear();
      if (!monthsByYear.has(y)) monthsByYear.set(y, new Set());
      monthsByYear.get(y)!.add(dt.getUTCMonth());
    }
    const yearRound = [...monthsByYear.values()].filter((s) => s.size >= 8).length >= 3;
    const typedStatic = a.typed > 0 && a.staticTyped / a.typed > 0.5;
    if (yearRound || typedStatic) { acc.delete(key); removed++; }
  }

  const cells: IndexCell[] = [...acc.values()].map((a) => [
    a.gx, a.gy, a.ibge, ...a.days.map((s) => [...s].sort((p, q) => p - q)),
  ] as IndexCell);
  if (!cells.length) throw new Error('No FIRMS detection loaded for Goiás; index not written');
  const index: CellIndex = {
    version: 2,
    builtAt: new Date().toISOString(),
    source: config.FIRMS_MAP_KEY
      ? 'NASA FIRMS area API (Goiás box; SP, then NRT) with yearly archive fallback: MODIS, VIIRS S-NPP, NOAA-20, NOAA-21'
      : 'NASA FIRMS yearly country archives (Brazil, SP): MODIS, VIIRS S-NPP, NOAA-20',
    sensors: loaded,
    staticCellsRemoved: removed,
    cells,
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, CELL_INDEX_FILE), JSON.stringify(index));
  logger.info({ cells: cells.length, staticCellsRemoved: removed, sensors: loaded }, 'job:build-cell-index completed');
}

if (isMain(import.meta.url)) {
  const { from } = parseArgs(process.argv.slice(2));
  runBuildCellIndex(from).catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'job:build-cell-index failed');
    process.exit(1);
  });
}
