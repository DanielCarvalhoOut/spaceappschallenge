/**
 * Per-cell FIRMS index for Goiás, used when PostGIS is offline (built by job:build-cell-index from the same
 * FIRMS yearly country archives as job:ingest-firms-history). Nothing here is synthetic.
 *
 * Grid: 1 km cells in SIRGAS 2000 / Brazil Polyconic (EPSG:5880, GRS80, lon0 −54°, FE 5,000,000, FN 10,000,000),
 * the same projection and indexing as fire.cell_key() in schema.sql.
 * Values are harmonized through the satellite chain (buildChain): MODIS before S-NPP, S-NPP while it observes,
 * NOAA-20 / NOAA-21 after its end (2 Nov 2026) or during its outages, all on the S-NPP scale.
 * "Years burned" uses that same rule, so a cell never counts a year it would not show for the month.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from './logger.js';

const A = 6378137.0;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const E4 = E2 * E2;
const E6 = E4 * E2;
const LON0 = (-54 * Math.PI) / 180;
const FE = 5_000_000;
const FN = 10_000_000;
const DEG = Math.PI / 180;

function meridianArc(phi: number): number {
  return (
    A *
    ((1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256) * phi -
      ((3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024) * Math.sin(2 * phi) +
      ((15 * E4) / 256 + (45 * E6) / 1024) * Math.sin(4 * phi) -
      ((35 * E6) / 3072) * Math.sin(6 * phi))
  );
}

/** EPSG:5880 forward projection (ellipsoidal American Polyconic, Snyder 1987). Returns metres [x, y]. */
export function toPolyconic(lon: number, lat: number): [number, number] {
  const phi = lat * DEG;
  const dl = lon * DEG - LON0;
  if (Math.abs(phi) < 1e-12) return [FE + A * dl, FN];
  const sinPhi = Math.sin(phi);
  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const e = dl * sinPhi;
  const cot = 1 / Math.tan(phi);
  return [FE + n * cot * Math.sin(e), FN + meridianArc(phi) + n * cot * (1 - Math.cos(e))];
}

/** Inverse by Newton iteration on the forward projection (enough to place a cell centre to < 1 mm). */
export function fromPolyconic(x: number, y: number): [number, number] {
  let lon = -54 + (x - FE) / 111_320 / Math.cos(-15 * DEG);
  let lat = (y - FN) / 110_574;
  for (let i = 0; i < 8; i++) {
    const [fx, fy] = toPolyconic(lon, lat);
    const h = 1e-6;
    const [ax, ay] = toPolyconic(lon + h, lat);
    const [bx, by] = toPolyconic(lon, lat + h);
    const j11 = (ax - fx) / h, j21 = (ay - fy) / h, j12 = (bx - fx) / h, j22 = (by - fy) / h;
    const det = j11 * j22 - j12 * j21;
    const dx = x - fx, dy = y - fy;
    lon += (j22 * dx - j12 * dy) / det;
    lat += (-j21 * dx + j11 * dy) / det;
    if (Math.abs(dx) + Math.abs(dy) < 1e-4) break;
  }
  return [lon, lat];
}

/** 1 km grid indices of a point (same floor() as fire.cell_key). */
export function cellOf(lon: number, lat: number, sizeM = 1000): [number, number] {
  const [x, y] = toPolyconic(lon, lat);
  return [Math.floor(x / sizeM), Math.floor(y / sizeM)];
}

/** Days since 1970-01-01 (UTC) for a YYYY-MM-DD string. */
export function dayNumber(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
}

/* ---------------- index file ---------------- */

/** Sensors of the harmonized chain. S-NPP is the reference scale ("cell-days equivalent to VIIRS S-NPP"). */
export const SENSORS = ['MODIS', 'SNPP', 'NOAA20', 'NOAA21'] as const;
export type Sensor = (typeof SENSORS)[number];

/** One cell: [gx, gy, ibgeCode, modisDays[], snppDays[], noaa20Days[], noaa21Days[]] (days since 1970, sorted, unique). */
export type IndexCell = [number, number, string, number[], number[], number[], number[]];

const SensorRange = z.object({
  first: z.number().int().nullable(),   // first day loaded
  last: z.number().int().nullable(),    // last day loaded
  nrtFrom: z.number().int().nullable(), // first day that came from near-real-time (provisional) data
});
const DayList = z.array(z.number().int());
const IndexSchemaV2 = z.object({
  version: z.literal(2),
  builtAt: z.string(),
  source: z.string(),
  sensors: z.object({ MODIS: SensorRange, SNPP: SensorRange, NOAA20: SensorRange, NOAA21: SensorRange }),
  staticCellsRemoved: z.number().int().min(0),
  cells: z.array(z.tuple([z.number().int(), z.number().int(), z.string(), DayList, DayList, DayList, DayList])),
});
/** Version 1 (MODIS + S-NPP only) is still read, so an index built before this change keeps working. */
const IndexSchemaV1 = z.object({
  version: z.literal(1),
  builtAt: z.string(),
  source: z.string(),
  yearsLoaded: z.object({ MODIS: z.array(z.number().int()), VIIRS: z.array(z.number().int()) }),
  staticCellsRemoved: z.number().int().min(0),
  cells: z.array(z.tuple([z.number().int(), z.number().int(), z.string(), DayList, DayList])),
});
export type CellIndex = z.infer<typeof IndexSchemaV2>;

export const CELL_INDEX_FILE = 'firms_goias_cells.json';

function upgradeV1(v1: z.infer<typeof IndexSchemaV1>): CellIndex {
  const range = (years: number[]): { first: number | null; last: number | null; nrtFrom: null } =>
    years.length
      ? { first: Date.UTC(Math.min(...years), 0, 1) / 86_400_000, last: Date.UTC(Math.max(...years), 11, 31) / 86_400_000, nrtFrom: null }
      : { first: null, last: null, nrtFrom: null };
  return {
    version: 2,
    builtAt: v1.builtAt,
    source: v1.source,
    sensors: { MODIS: range(v1.yearsLoaded.MODIS), SNPP: range(v1.yearsLoaded.VIIRS), NOAA20: range([]), NOAA21: range([]) },
    staticCellsRemoved: v1.staticCellsRemoved,
    cells: v1.cells.map((c) => [c[0], c[1], c[2], c[3], c[4], [], []] as IndexCell),
  };
}

let cached: { mtimeMs: number; index: CellIndex } | null = null;

/** Loads the index from data/ (re-read when the file changes). Returns null when it was never built. */
export function loadCellIndex(): CellIndex | null {
  const file = path.join(config.dataDir, CELL_INDEX_FILE);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.index;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v2 = IndexSchemaV2.safeParse(raw);
    const index = v2.success ? v2.data : (() => {
      const v1 = IndexSchemaV1.safeParse(raw);
      if (!v1.success) throw new Error(v2.error.message.slice(0, 300));
      return upgradeV1(v1.data);
    })();
    cached = { mtimeMs: st.mtimeMs, index };
    return index;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'cell index could not be read; ignoring it');
    return null;
  }
}

/* ---------------- harmonization chain ---------------- */

const DAY = 86_400_000;
const dateOf = (d: number): Date => new Date(d * DAY);
export const isoDay = (d: number): string => dateOf(d).toISOString().slice(0, 10);

/** Days a sensor did not observe Goiás although another VIIRS saw fire there (outage), or outside its loaded range. */
function observedDays(index: CellIndex, counts: Record<Sensor, Map<number, number>>, s: Sensor, from: number, to: number): Set<number> {
  const r = index.sensors[s];
  const out = new Set<number>();
  if (r.first === null || r.last === null) return out;
  const others = (['SNPP', 'NOAA20', 'NOAA21'] as Sensor[]).filter((o) => o !== s);
  for (let d = Math.max(from, r.first); d <= Math.min(to, r.last); d++) {
    const own = counts[s].get(d) ?? 0;
    const maxOther = Math.max(0, ...others.map((o) => counts[o].get(d) ?? 0));
    // MODIS sees fewer fires; it is called "out" only when S-NPP saw a lot.
    const outage = own === 0 && (s === 'MODIS' ? (counts.SNPP.get(d) ?? 0) >= 20 : maxOther >= 5);
    if (!outage) out.add(d);
  }
  return out;
}

export interface LinkValidation {
  link: 'MODIS→SNPP' | 'NOAA20→SNPP' | 'NOAA21→SNPP';
  calibrationPeriod: string;
  testPeriod: string;
  nMonths: number;
  wapePct: number | null;
  mapePct: number | null;
  pearsonR: number | null;
  biasPct: number | null;
  monthlyFactors: (number | null)[];
}

export interface Chain {
  first: number;                        // first day of the harmonized series
  last: number;                         // last observed day
  /** Sensor used per day (index = day − first): 0 none, 1 MODIS, 2 S-NPP, 3 NOAA-20, 4 NOAA-21. */
  sensorOn: Int8Array;
  /** Factor to the S-NPP scale per sensor and calendar month (S-NPP = 1). */
  factor: Record<Sensor, number[]>;
  /** First day whose value came from near-real-time (provisional) data, or null. */
  provisionalFrom: number | null;
  links: LinkValidation[];
  /** Calendar month (0–11) per day from 1970 up to `last` (fast lookup instead of Date objects). */
  monthOf: Int8Array;
}

const SENSOR_CODE: Record<Sensor, number> = { MODIS: 1, SNPP: 2, NOAA20: 3, NOAA21: 4 };
const CODE_SENSOR: (Sensor | null)[] = [null, 'MODIS', 'SNPP', 'NOAA20', 'NOAA21'];
const SHRINK_K = 30;

function stateCounts(index: CellIndex): Record<Sensor, Map<number, number>> {
  const counts = { MODIS: new Map<number, number>(), SNPP: new Map<number, number>(), NOAA20: new Map<number, number>(), NOAA21: new Map<number, number>() };
  for (const c of index.cells) {
    SENSORS.forEach((s, i) => { for (const d of c[3 + i] as number[]) counts[s].set(d, (counts[s].get(d) ?? 0) + 1); });
  }
  return counts;
}

/**
 * Monthly factor target ÷ source over the days both observed, between two years (inclusive); months without overlap
 * fall back to the all-months ratio, and every month is shrunk toward it: w = Σsource / (Σsource + 30).
 */
function monthlyFactor(
  counts: Record<Sensor, Map<number, number>>, both: (d: number) => boolean,
  source: Sensor, from: number, to: number
): number[] | null {
  const ss = new Array<number>(12).fill(0), st = new Array<number>(12).fill(0);
  const d0 = Date.UTC(from, 0, 1) / DAY, d1 = Date.UTC(to, 11, 31) / DAY;
  for (let d = d0; d <= d1; d++) {
    if (!both(d)) continue;
    const m = dateOf(d).getUTCMonth();
    ss[m] = (ss[m] ?? 0) + (counts[source].get(d) ?? 0);
    st[m] = (st[m] ?? 0) + (counts.SNPP.get(d) ?? 0);
  }
  const S = ss.reduce((a, b) => a + b, 0), T = st.reduce((a, b) => a + b, 0);
  if (S <= 0) return null;
  const pooled = T / S;
  return ss.map((sm, i) => {
    if (sm <= 0) return pooled;
    const w = sm / (sm + SHRINK_K);
    return w * (st[i]! / sm) + (1 - w) * pooled;
  });
}

function linkValidation(
  link: LinkValidation['link'], counts: Record<Sensor, Map<number, number>>, both: (d: number) => boolean,
  source: Sensor, cal: [number, number], test: [number, number]
): LinkValidation | null {
  const f = monthlyFactor(counts, both, source, cal[0], cal[1]);
  if (!f) return null;
  const pred: number[] = [], act: number[] = [];
  for (let y = test[0]; y <= test[1]; y++) {
    for (let m = 0; m < 12; m++) {
      let ps = 0, as = 0, n = 0;
      const d0 = Date.UTC(y, m, 1) / DAY, d1 = Date.UTC(y, m + 1, 1) / DAY;
      for (let d = d0; d < d1; d++) {
        if (!both(d)) continue;
        ps += (counts[source].get(d) ?? 0) * f[m]!;
        as += counts.SNPP.get(d) ?? 0;
        n++;
      }
      if (n >= 15) { pred.push(ps); act.push(as); }
    }
  }
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const sumA = act.reduce((a, b) => a + b, 0), sumP = pred.reduce((a, b) => a + b, 0);
  const abs = act.reduce((a, v, i) => a + Math.abs(pred[i]! - v), 0);
  const mape = act.map((v, i) => (v >= 10 ? Math.abs(pred[i]! - v) / v : null)).filter((x): x is number => x !== null);
  let r: number | null = null;
  const n = act.length;
  if (n >= 3) {
    const ma = sumA / n, mp = sumP / n;
    let cov = 0, va = 0, vp = 0;
    for (let i = 0; i < n; i++) { cov += (act[i]! - ma) * (pred[i]! - mp); va += (act[i]! - ma) ** 2; vp += (pred[i]! - mp) ** 2; }
    r = va > 0 && vp > 0 ? Math.round((cov / Math.sqrt(va * vp)) * 1000) / 1000 : null;
  }
  return {
    link,
    calibrationPeriod: `${cal[0]}-${cal[1]}`,
    testPeriod: `${test[0]}-${test[1]}`,
    nMonths: n,
    wapePct: sumA > 0 ? r1((abs / sumA) * 100) : null,
    mapePct: mape.length ? r1((mape.reduce((a, b) => a + b, 0) / mape.length) * 100) : null,
    pearsonR: r,
    biasPct: sumA > 0 ? r1(((sumP - sumA) / sumA) * 100) : null,
    monthlyFactors: f.map((x) => Math.round(x * 1000) / 1000),
  };
}

const chainCache = new WeakMap<CellIndex, Chain>();

/**
 * The harmonized chain: MODIS before S-NPP; S-NPP while it observes; NOAA-20 (then NOAA-21) when S-NPP is out or
 * ended (2 Nov 2026), each brought to the S-NPP scale by a monthly factor measured on the days both observed.
 */
export function buildChain(index: CellIndex): Chain {
  const hit = chainCache.get(index);
  if (hit) return hit;
  const counts = stateCounts(index);
  const firsts = SENSORS.map((s) => index.sensors[s].first).filter((x): x is number => x !== null);
  const lasts = SENSORS.map((s) => index.sensors[s].last).filter((x): x is number => x !== null);
  const first = firsts.length ? Math.min(...firsts) : 0;
  const last = lasts.length ? Math.max(...lasts) : -1;
  const obs = {} as Record<Sensor, Set<number>>;
  for (const s of SENSORS) obs[s] = observedDays(index, counts, s, first, last);
  const both = (a: Sensor) => (d: number): boolean => obs[a].has(d) && obs.SNPP.has(d);

  const lastYear = last >= 0 ? dateOf(last).getUTCFullYear() : 2025;
  const ones = new Array<number>(12).fill(1);
  const factor: Record<Sensor, number[]> = {
    MODIS: monthlyFactor(counts, both('MODIS'), 'MODIS', 2012, Math.min(2025, lastYear)) ?? ones,
    SNPP: ones,
    NOAA20: monthlyFactor(counts, both('NOAA20'), 'NOAA20', 2018, lastYear) ?? ones,
    NOAA21: monthlyFactor(counts, both('NOAA21'), 'NOAA21', 2023, lastYear) ?? ones,
  };

  const sensorOn = new Int8Array(Math.max(0, last - first + 1));
  const snppFirst = index.sensors.SNPP.first ?? Number.POSITIVE_INFINITY;
  let provisionalFrom: number | null = null;
  for (let d = first; d <= last; d++) {
    let s: Sensor | null = null;
    if (d < snppFirst) s = obs.MODIS.has(d) ? 'MODIS' : null;
    else if (obs.SNPP.has(d)) s = 'SNPP';
    else if (obs.NOAA20.has(d) && factor.NOAA20 !== ones) s = 'NOAA20';
    else if (obs.NOAA21.has(d) && factor.NOAA21 !== ones) s = 'NOAA21';
    else if (obs.MODIS.has(d)) s = 'MODIS';
    sensorOn[d - first] = s ? SENSOR_CODE[s] : 0;
    const nrt = s ? index.sensors[s].nrtFrom : null;
    if (s && nrt !== null && d >= nrt && provisionalFrom === null) provisionalFrom = d;
  }

  const links = [
    linkValidation('MODIS→SNPP', counts, both('MODIS'), 'MODIS', [2012, 2019], [2020, 2025]),
    linkValidation('NOAA20→SNPP', counts, both('NOAA20'), 'NOAA20', [2018, 2023], [2024, 2025]),
    linkValidation('NOAA21→SNPP', counts, both('NOAA21'), 'NOAA21', [2023, 2025], [2026, 2026]),
  ].filter((x): x is LinkValidation => x !== null);

  const monthOf = new Int8Array(Math.max(0, last + 1));
  for (let d = 0; d <= last; d++) monthOf[d] = dateOf(d).getUTCMonth();
  const chain: Chain = { first, last, sensorOn, factor, provisionalFrom, links, monthOf };
  chainCache.set(index, chain);
  return chain;
}

/** Harmonized contributions of one cell: cb(day, weight) for every day where the sensor in use detected it. */
export function forEachContribution(cell: IndexCell, chain: Chain, cb: (day: number, weight: number) => void): void {
  for (let i = 0; i < 4; i++) {
    const sensor = SENSORS[i]!;
    const code = SENSOR_CODE[sensor];
    const f = chain.factor[sensor];
    for (const d of cell[3 + i] as number[]) {
      const k = d - chain.first;
      if (k < 0 || k >= chain.sensorOn.length || chain.sensorOn[k] !== code) continue;
      cb(d, f[chain.monthOf[d]!]!);
    }
  }
}

export const sensorOnDay = (chain: Chain, d: number): Sensor | null => {
  const k = d - chain.first;
  return k < 0 || k >= chain.sensorOn.length ? null : CODE_SENSOR[chain.sensorOn[k]!] ?? null;
};

/* ---------------- series ---------------- */

export interface MonthRow {
  year: number;
  month: number;
  modis: number;            // raw cell-days per sensor (for the comparison chart)
  viirs: number | null;     // S-NPP
  noaa20: number | null;
  harmonized: number | null; // null when more than 10 days of the month had no sensor
  daysMissing: number;
  provisional: boolean;     // month contains near-real-time days
  partial: boolean;         // month not finished (current month)
}

/** Daily harmonized values of a set of cells, with null on days no sensor observed. */
export function dailySeries(index: CellIndex, keep: (c: IndexCell) => boolean): { first: number; values: Array<number | null> } {
  const chain = buildChain(index);
  const values: Array<number | null> = Array.from({ length: chain.sensorOn.length }, (_, k) => (chain.sensorOn[k] ? 0 : null));
  for (const c of index.cells) {
    if (!keep(c)) continue;
    forEachContribution(c, chain, (d, w) => { const k = d - chain.first; values[k] = (values[k] ?? 0) + w; });
  }
  return { first: chain.first, values };
}

export interface DayRow { date: string; harmonized: number | null; sensor: Sensor | null; provisional: boolean; cells: number }

/**
 * One calendar month of an area, day by day: harmonized cell-days, the satellite that served the day,
 * whether the day is near-real-time (provisional) and how many distinct 1 km cells burned. Days after the last
 * observed day are left out; days no satellite observed come back with harmonized = null.
 */
export function dailyOfMonth(index: CellIndex, keep: (c: IndexCell) => boolean, year: number, month: number): DayRow[] {
  const chain = buildChain(index);
  const d0 = Date.UTC(year, month - 1, 1) / DAY, d1 = Math.min(Date.UTC(year, month, 1) / DAY - 1, chain.last);
  if (d1 < d0) return [];
  const sum = new Float64Array(d1 - d0 + 1), cells = new Int32Array(d1 - d0 + 1);
  for (const c of index.cells) {
    if (!keep(c)) continue;
    const seen = new Set<number>();
    forEachContribution(c, chain, (d, w) => {
      if (d < d0 || d > d1) return;
      sum[d - d0]! += w;
      if (!seen.has(d)) { seen.add(d); cells[d - d0]!++; }
    });
  }
  const out: DayRow[] = [];
  for (let d = d0; d <= d1; d++) {
    const sensor = sensorOnDay(chain, d);
    out.push({
      date: isoDay(d), sensor,
      harmonized: sensor ? Math.round(sum[d - d0]! * 10) / 10 : null,
      provisional: chain.provisionalFrom !== null && d >= chain.provisionalFrom,
      cells: cells[d - d0]!,
    });
  }
  return out;
}

interface AreaAcc { daily: Float64Array; raw: Map<string, { m: number; v: number; n: number }> }

function newAcc(chain: Chain): AreaAcc { return { daily: new Float64Array(chain.sensorOn.length), raw: new Map() }; }

function addCell(acc: AreaAcc, c: IndexCell, chain: Chain): void {
  forEachContribution(c, chain, (d, w) => { acc.daily[d - chain.first]! += w; });
  ([[c[3], 'm'], [c[4], 'v'], [c[5], 'n']] as const).forEach(([days, k]) => {
    for (const d of days) {
      const dt = dateOf(d);
      const key = `${dt.getUTCFullYear()}-${dt.getUTCMonth() + 1}`;
      const cur = acc.raw.get(key) ?? { m: 0, v: 0, n: 0 };
      cur[k]++;
      acc.raw.set(key, cur);
    }
  });
}

/** Monthly rows from a set of cells (map, calendar, CSV, circle). Months after the last observed day are left out. */
export function monthlyRows(index: CellIndex, keep: (c: IndexCell) => boolean): MonthRow[] {
  const chain = buildChain(index);
  if (chain.last < chain.first) return [];
  const acc = newAcc(chain);
  for (const c of index.cells) if (keep(c)) addCell(acc, c, chain);
  return rowsFromAcc(index, chain, acc);
}

/** Monthly rows of every municipality in one pass over the index. */
export function monthlyRowsByMunicipality(index: CellIndex): Map<string, MonthRow[]> {
  const chain = buildChain(index);
  const accs = new Map<string, AreaAcc>();
  for (const c of index.cells) {
    let a = accs.get(c[2]);
    if (!a) { a = newAcc(chain); accs.set(c[2], a); }
    addCell(a, c, chain);
  }
  const out = new Map<string, MonthRow[]>();
  for (const [ibge, a] of accs) out.set(ibge, rowsFromAcc(index, chain, a));
  return out;
}

/** Rows of a municipality without any detection: zeros on observed days, same months as the others. */
export function emptyRows(index: CellIndex): MonthRow[] {
  const chain = buildChain(index);
  return chain.last < chain.first ? [] : rowsFromAcc(index, chain, newAcc(chain));
}

function rowsFromAcc(index: CellIndex, chain: Chain, acc: AreaAcc): MonthRow[] {
  const raw = acc.raw;
  const daily = { values: Array.from(acc.daily, (v, k) => (chain.sensorOn[k] ? v : null)) };
  const y0 = dateOf(chain.first).getUTCFullYear(), y1 = dateOf(chain.last).getUTCFullYear();
  const lastMonthKey = dateOf(chain.last).getUTCFullYear() * 12 + dateOf(chain.last).getUTCMonth();
  const rows: MonthRow[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let m = 0; m < 12; m++) {
      if (y * 12 + m > lastMonthKey) break;
      const d0 = Date.UTC(y, m, 1) / DAY, d1 = Date.UTC(y, m + 1, 1) / DAY;
      let sum = 0, missing = 0, provisional = false;
      for (let d = d0; d < d1; d++) {
        if (d > chain.last) { missing++; continue; }
        const v = d < chain.first ? null : daily.values[d - chain.first];
        if (v === null || v === undefined) missing++;
        else sum += v;
        if (chain.provisionalFrom !== null && d >= chain.provisionalFrom) provisional = true;
      }
      const r = raw.get(`${y}-${m + 1}`) ?? { m: 0, v: 0, n: 0 };
      const partial = d1 - 1 > chain.last;
      rows.push({
        year: y,
        month: m + 1,
        modis: r.m,
        viirs: (index.sensors.SNPP.first ?? Infinity) <= d1 ? r.v : null,
        noaa20: (index.sensors.NOAA20.first ?? Infinity) <= d1 ? r.n : null,
        harmonized: missing > 10 && !partial ? null : Math.round(sum * 10) / 10,
        daysMissing: missing,
        provisional,
        partial,
      });
    }
  }
  return rows;
}

/** Anomaly (σ) of each month against the same month in 2002–2024 (never against the year being judged). */
export function withAnomaly<T extends { year: number; month: number; harmonized: number | null; partial?: boolean }>(rows: T[]): Array<T & { anomalyZ: number | null }> {
  const out = rows.map((r) => ({ ...r, anomalyZ: null as number | null }));
  for (let m = 1; m <= 12; m++) {
    const base = out.filter((x) => x.month === m && x.year >= 2002 && x.year <= 2024 && x.harmonized !== null).map((x) => x.harmonized as number);
    if (base.length < 2) continue;
    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (base.length - 1));
    for (const x of out) {
      if (x.month === m && x.harmonized !== null && !x.partial) x.anomalyZ = sd > 0 ? Math.round(((x.harmonized - mean) / sd) * 100) / 100 : null;
    }
  }
  return out;
}

export const inCircle = (lon: number, lat: number, radiusKm: number): ((c: IndexCell) => boolean) => {
  const [cx, cy] = toPolyconic(lon, lat);
  const r = radiusKm * 1000;
  return (c) => Math.hypot((c[0] + 0.5) * 1000 - cx, (c[1] + 0.5) * 1000 - cy) <= r;
};

/* ---------------- cells of an area ---------------- */

export interface AreaCellsResult {
  yearsObserved: number;
  total: number;
  /** [lon, lat, cellDays, yearsBurned, lastYear | null] */
  cells: Array<[number, number, number, number, number | null]>;
}

/** Years with a harmonized contribution of a cell, inside [from, to]. */
function cellYearsOf(c: IndexCell, chain: Chain, from = 0, to = 9999): Set<number> {
  const years = new Set<number>();
  forEachContribution(c, chain, (d) => { const y = dateOf(d).getUTCFullYear(); if (y >= from && y <= to) years.add(y); });
  return years;
}

function yearsObservedOf(chain: Chain, from = 0, to = 9999): number {
  const ys = new Set<number>();
  for (let k = 0; k < chain.sensorOn.length; k++) if (chain.sensorOn[k]) { const y = dateOf(chain.first + k).getUTCFullYear(); if (y >= from && y <= to) ys.add(y); }
  return ys.size;
}

/**
 * Cells of a municipality (ibge) or of a circle (centre within the radius), for one month, at 1/2/5 km.
 * Coarser cells add up their 1 km cell-days, like fire.cell_key_coarsen in SQL.
 */
export function areaCellsFromIndex(
  index: CellIndex,
  q: { ibge?: string; lon?: number; lat?: number; radiusKm?: number; year: number; month: number; resM: 1000 | 2000 | 5000 },
  /** Municipality outline, so every grid cell of the area is returned (cell-days 0 where there was no fire that month). */
  muni?: { bbox: [number, number, number, number]; inside: (lon: number, lat: number) => boolean }
): AreaCellsResult {
  const chain = buildChain(index);
  const from = Date.UTC(q.year, q.month - 1, 1) / DAY;
  const to = Date.UTC(q.year, q.month, 1) / DAY;
  const ratio = q.resM / 1000;
  const inArea: (c: IndexCell) => boolean = q.ibge ? ((code) => (c: IndexCell) => c[2] === code)(q.ibge) : inCircle(q.lon ?? 0, q.lat ?? 0, q.radiusKm ?? 0);

  const agg = new Map<string, { gx: number; gy: number; cd: number; years: Set<number> }>();
  for (const c of index.cells) {
    if (!inArea(c)) continue;
    const years = cellYearsOf(c, chain);
    if (!years.size) continue;
    let cd = 0;
    forEachContribution(c, chain, (d, w) => { if (d >= from && d < to) cd += w; });
    const gx = Math.floor(c[0] / ratio), gy = Math.floor(c[1] / ratio);
    const key = `${gx}:${gy}`;
    const cur = agg.get(key);
    if (cur) { cur.cd += cd; for (const y of years) cur.years.add(y); } else agg.set(key, { gx, gy, cd, years });
  }

  // Full grid of the area: cells without fire in the month are returned too, with 0.
  const grid = new Map<string, { gx: number; gy: number }>();
  let gx0: number, gx1: number, gy0: number, gy1: number;
  let keep: (gx: number, gy: number) => boolean;
  if (q.ibge && muni) {
    const [w, s, e, n] = muni.bbox;
    const corners = [toPolyconic(w, s), toPolyconic(w, n), toPolyconic(e, s), toPolyconic(e, n)];
    gx0 = Math.floor(Math.min(...corners.map((c) => c[0])) / q.resM); gx1 = Math.floor(Math.max(...corners.map((c) => c[0])) / q.resM);
    gy0 = Math.floor(Math.min(...corners.map((c) => c[1])) / q.resM); gy1 = Math.floor(Math.max(...corners.map((c) => c[1])) / q.resM);
    keep = (gx, gy) => { const [lo, la] = fromPolyconic((gx + 0.5) * q.resM, (gy + 0.5) * q.resM); return muni.inside(lo, la); };
  } else if (!q.ibge) {
    const [cx, cy] = toPolyconic(q.lon ?? 0, q.lat ?? 0);
    const r = (q.radiusKm ?? 0) * 1000;
    gx0 = Math.floor((cx - r) / q.resM); gx1 = Math.floor((cx + r) / q.resM);
    gy0 = Math.floor((cy - r) / q.resM); gy1 = Math.floor((cy + r) / q.resM);
    keep = (gx, gy) => Math.hypot((gx + 0.5) * q.resM - cx, (gy + 0.5) * q.resM - cy) <= r;
  } else {
    gx0 = 1; gx1 = 0; gy0 = 1; gy1 = 0; keep = () => false;
  }
  if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) <= 400_000) {
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const key = `${gx}:${gy}`;
      if (!agg.has(key) && keep(gx, gy)) grid.set(key, { gx, gy });
    }
  }

  let total = 0;
  const cells: AreaCellsResult['cells'] = [];
  for (const g of grid.values()) {
    const [lon, lat] = fromPolyconic((g.gx + 0.5) * q.resM, (g.gy + 0.5) * q.resM);
    cells.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, 0, 0, null]);
  }
  for (const a of agg.values()) {
    const [lon, lat] = fromPolyconic((a.gx + 0.5) * q.resM, (a.gy + 0.5) * q.resM);
    const cd = Math.round(a.cd * 100) / 100;
    total += cd;
    cells.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, cd, a.years.size, Math.max(...a.years)]);
  }
  cells.sort((p, r) => r[2] - p[2] || r[3] - p[3]);
  return { yearsObserved: yearsObservedOf(chain), total: Math.round(total * 10) / 10, cells: cells.slice(0, 20000) };
}

/**
 * Focos-raiz (same rule as fire.cell_recurrence at 1 km): years burned per cell, with and without the 3×3
 * neighbourhood, last year and the month with most cell-days. cells: [lon, lat, yearsNb, years, lastYear, peakMonth].
 */
export function recurrenceFromIndex(
  index: CellIndex,
  q: { west: number; south: number; east: number; north: number; from: number; to: number; limit: number }
): { yearsObserved: number; cells: number[][] } {
  const chain = buildChain(index);
  const byKey = new Map<string, { c: IndexCell; years: Set<number> }>();
  for (const c of index.cells) {
    const years = cellYearsOf(c, chain, q.from, q.to);
    if (years.size) byKey.set(`${c[0]}:${c[1]}`, { c, years });
  }
  const out: number[][] = [];
  for (const { c, years } of byKey.values()) {
    const [lon, lat] = fromPolyconic((c[0] + 0.5) * 1000, (c[1] + 0.5) * 1000);
    if (lon < q.west || lon > q.east || lat < q.south || lat > q.north) continue;
    const nb = new Set(years);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      if (!i && !j) continue;
      const o = byKey.get(`${c[0] + i}:${c[1] + j}`);
      if (o) for (const y of o.years) nb.add(y);
    }
    const months = new Array<number>(12).fill(0);
    forEachContribution(c, chain, (d, w) => { months[dateOf(d).getUTCMonth()]! += w; });
    const peak = months.indexOf(Math.max(...months)) + 1;
    out.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, nb.size, years.size, Math.max(...years), peak]);
  }
  out.sort((a, b) => (b[2]! - a[2]!) || (b[3]! - a[3]!));
  return { yearsObserved: yearsObservedOf(chain, q.from, q.to), cells: out.slice(0, q.limit) };
}
