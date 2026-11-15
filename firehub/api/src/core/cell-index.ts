/**
 * Per-cell FIRMS index for Goiás, used when PostGIS is offline (built by job:build-cell-index from the same
 * FIRMS yearly country archives as job:ingest-firms-history). Nothing here is synthetic.
 *
 * Grid: 1 km cells in SIRGAS 2000 / Brazil Polyconic (EPSG:5880, GRS80, lon0 −54°, FE 5,000,000, FN 10,000,000),
 * the same projection and indexing as fire.cell_key() in schema.sql.
 * Month value (cell-days): VIIRS S-NPP days from 2012 on; MODIS days × the state's monthly factor before 2012.
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

/** One cell: [gx, gy, ibgeCode, modisDays[], viirsDays[]] (days since 1970, sorted, deduplicated). */
export type IndexCell = [number, number, string, number[], number[]];

const IndexSchema = z.object({
  version: z.literal(1),
  builtAt: z.string(),
  source: z.string(),
  yearsLoaded: z.object({ MODIS: z.array(z.number().int()), VIIRS: z.array(z.number().int()) }),
  monthlyFactors: z.array(z.number().positive().nullable()).length(12),
  staticCellsRemoved: z.number().int().min(0),
  cells: z.array(z.tuple([z.number().int(), z.number().int(), z.string(), z.array(z.number().int()), z.array(z.number().int())])),
});
export type CellIndex = z.infer<typeof IndexSchema>;

export const CELL_INDEX_FILE = 'firms_goias_cells.json';

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
    const parsed = IndexSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) {
      logger.warn({ err: parsed.error.message.slice(0, 300) }, 'cell index file is invalid; ignoring it');
      return null;
    }
    cached = { mtimeMs: st.mtimeMs, index: parsed.data };
    return parsed.data;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'cell index could not be read');
    return null;
  }
}

/* ---------------- query ---------------- */

export interface AreaCellsResult {
  yearsObserved: number;
  total: number;
  /** [lon, lat, cellDays, yearsBurned, lastYear | null] */
  cells: Array<[number, number, number, number, number | null]>;
}

const yearOfDay = (d: number): number => new Date(d * 86_400_000).getUTCFullYear();

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
  const from = Date.UTC(q.year, q.month - 1, 1) / 86_400_000;
  const to = Date.UTC(q.year, q.month, 1) / 86_400_000;
  const factor = index.monthlyFactors[q.month - 1] ?? 1;
  const useViirs = q.year >= 2012;
  const ratio = q.resM / 1000;

  let inArea: (c: IndexCell) => boolean;
  if (q.ibge) {
    const code = q.ibge;
    inArea = (c) => c[2] === code;
  } else {
    const [cx, cy] = toPolyconic(q.lon ?? 0, q.lat ?? 0);
    const r = (q.radiusKm ?? 0) * 1000;
    inArea = (c) => Math.hypot((c[0] + 0.5) * 1000 - cx, (c[1] + 0.5) * 1000 - cy) <= r;
  }

  const agg = new Map<string, { gx: number; gy: number; cd: number; years: Set<number> }>();
  for (const c of index.cells) {
    if (!inArea(c)) continue;
    // Same rule for the month value and for "years burned": VIIRS from 2012, MODIS before.
    const years = new Set<number>();
    for (const d of c[3]) { const y = yearOfDay(d); if (y < 2012) years.add(y); }
    for (const d of c[4]) { const y = yearOfDay(d); if (y >= 2012) years.add(y); }
    if (!years.size) continue;
    const days = useViirs ? c[4] : c[3];
    let n = 0;
    for (const d of days) if (d >= from && d < to) n++;
    const cd = useViirs ? n : n * factor;
    const gx = Math.floor(c[0] / ratio), gy = Math.floor(c[1] / ratio);
    const key = `${gx}:${gy}`;
    const cur = agg.get(key);
    if (cur) {
      cur.cd += cd;
      for (const y of years) cur.years.add(y);
    } else {
      agg.set(key, { gx, gy, cd, years });
    }
  }

  // Full grid of the area: cells without fire in the month are returned too, with 0 (the map paints them white).
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
  const yearsObserved = new Set([...index.yearsLoaded.MODIS.filter((y) => y < 2012), ...index.yearsLoaded.VIIRS.filter((y) => y >= 2012)]).size;
  return { yearsObserved, total: Math.round(total * 10) / 10, cells: cells.slice(0, 20000) };
}
