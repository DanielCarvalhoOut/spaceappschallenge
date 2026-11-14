/**
 * PostGIS-backed history repository (real FIRMS data).
 *
 * Every query is parameterized; inputs are validated by the routes (zod) before reaching here.
 * The API connects with the read-only role (fire_api_ro): it can query, never rebuild.
 * Numbers returned here come from fire.* SQL functions defined in Tema_08_MODIS_VIIRS/db/schema_projecao.sql.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { getPool, isPostgresAvailable } from './pool.js';

export type HistorySource = 'harmonized1k' | 'viirs500';
export type ProjectionMethod = 'all' | 'recent10' | 'analog5';

export interface HistoryRow {
  year: number;
  month: number;
  modis: number | null;
  viirs: number | null;
  harmonized: number | null;
  anomalyZ: number | null;
  daysMissing: number;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

let historyCache: { at: number; ok: boolean } | null = null;

/** True when the database is reachable and the state calendar was built from real FIRMS data. */
export async function hasHistory(): Promise<boolean> {
  const now = Date.now();
  if (historyCache && now - historyCache.at < 60_000) return historyCache.ok;
  let ok = false;
  try {
    if (await isPostgresAvailable()) {
      const res = await getPool().query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM fire.calendar_monthly c JOIN fire.region r ON r.id = c.region_id
           WHERE r.kind = 'uf' AND c.method = 'monthly_ratio') AS ok`
      );
      ok = res.rows[0]?.ok === true;
    }
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'history check failed');
    ok = false;
  }
  historyCache = { at: now, ok };
  return ok;
}

export function resetHistoryCache(): void {
  historyCache = null;
}

export async function regionIdByIbge(ibge: string): Promise<{ id: number; name: string; areaKm2: number } | null> {
  const kind = ibge.length === 2 ? 'uf' : 'municipio';
  const res = await getPool().query(
    'SELECT id, name, area_km2 FROM fire.region WHERE kind = $1 AND ibge_code = $2',
    [kind, ibge]
  );
  const r = res.rows[0];
  return r ? { id: Number(r.id), name: String(r.name), areaKm2: Number(r.area_km2) } : null;
}

export async function calendar(regionId: number): Promise<HistoryRow[]> {
  const res = await getPool().query(
    `SELECT year, month, modis_count, viirs_count, harmonized_count, anomaly_z, days_missing
       FROM fire.calendar_monthly
      WHERE region_id = $1 AND method = 'monthly_ratio'
      ORDER BY year, month`,
    [regionId]
  );
  return res.rows.map((r) => ({
    year: Number(r.year),
    month: Number(r.month),
    modis: num(r.modis_count),
    viirs: num(r.viirs_count),
    harmonized: num(r.harmonized_count),
    anomalyZ: num(r.anomaly_z),
    daysMissing: Number(r.days_missing) || 0,
  }));
}

/** One query for all municipalities (no N+1). density = harmonized cell-days per 1,000 km². */
export async function mapValues(
  year: number,
  month: number,
  metric: 'anomaly' | 'count' | 'density'
): Promise<Record<string, number | null>> {
  const res = await getPool().query(
    `SELECT r.ibge_code,
            CASE $3::text
              WHEN 'anomaly' THEN c.anomaly_z
              WHEN 'count'   THEN c.harmonized_count
              ELSE round(1000 * c.harmonized_count / nullif(r.area_km2, 0), 2)
            END AS v
       FROM fire.region r
       LEFT JOIN fire.calendar_monthly c
              ON c.region_id = r.id AND c.method = 'monthly_ratio' AND c.year = $1 AND c.month = $2
      WHERE r.kind = 'municipio'`,
    [year, month, metric]
  );
  const out: Record<string, number | null> = {};
  for (const r of res.rows) out[String(r.ibge_code)] = num(r.v);
  return out;
}

export async function pattern(regionId: number): Promise<{
  months: { month: number; mean: number | null; sharePct: number | null }[];
  season: { months: number[]; coveredPct: number | null; peakMonth: number | null };
}> {
  const pool = getPool();
  const [p, s] = await Promise.all([
    pool.query(`SELECT month, mean_count, share_pct FROM fire.seasonal_pattern($1, 'monthly_ratio', 2002::smallint, 2024::smallint) ORDER BY month`, [regionId]),
    pool.query(`SELECT months, covered_pct, peak_month FROM fire.fire_season($1, 'monthly_ratio', 2002::smallint, 2024::smallint)`, [regionId]),
  ]);
  const season = s.rows[0];
  return {
    months: p.rows.map((r) => ({ month: Number(r.month), mean: num(r.mean_count), sharePct: num(r.share_pct) })),
    season: {
      months: Array.isArray(season?.months) ? season.months.map(Number) : [],
      coveredPct: num(season?.covered_pct),
      peakMonth: num(season?.peak_month),
    },
  };
}

export interface ProjectionResult {
  year: number;
  month: number;
  method: ProjectionMethod;
  range: { p10: number | null; p50: number | null; p90: number | null; nYears: number; shrinkWeight: number | null } | null;
  analog: { p10: number | null; p50: number | null; p90: number | null; years: number[] } | null;
  observed: number | null;
  hindcast: ProjectionValidation | null;
}

export async function projection(regionId: number, year: number, month: number): Promise<ProjectionResult> {
  const validation = readProjectionValidation();
  const method: ProjectionMethod =
    validation?.chosenMethod === 'recent10' ? 'recent10' : 'all';
  const pool = getPool();
  const [r, a, o] = await Promise.all([
    pool.query(`SELECT p10, p50, p90, n_years, shrink_weight FROM fire.expected_range($1, $2::smallint, $3::smallint, $4)`, [regionId, year, month, method]),
    pool.query(`SELECT p10, p50, p90, analog_years FROM fire.analog_range($1, $2::smallint, $3::smallint)`, [regionId, year, month]),
    pool.query(`SELECT harmonized_count FROM fire.calendar_monthly WHERE region_id = $1 AND method = 'monthly_ratio' AND year = $2 AND month = $3`, [regionId, year, month]),
  ]);
  const rr = r.rows[0];
  const ar = a.rows[0];
  return {
    year,
    month,
    method,
    range: rr ? { p10: num(rr.p10), p50: num(rr.p50), p90: num(rr.p90), nYears: Number(rr.n_years), shrinkWeight: num(rr.shrink_weight) } : null,
    // analogs are shown only when the hindcast proved they beat the plain range
    analog: ar && validation?.analogBeatsRange
      ? { p10: num(ar.p10), p50: num(ar.p50), p90: num(ar.p90), years: (ar.analog_years as unknown[]).map(Number) }
      : null,
    observed: num(o.rows[0]?.harmonized_count),
    hindcast: validation,
  };
}

export interface CircleResult {
  lon: number;
  lat: number;
  radiusKm: number;
  source: HistorySource;
  areaKm2: number | null;
  areaInStateKm2: number | null;
  pctInState: number | null;
  rows: HistoryRow[];
  municipalities: { ibge: string; name: string; pctOfMunicipality: number; pctOfCircle: number }[];
}

export async function circle(lon: number, lat: number, radiusKm: number, source: HistorySource): Promise<CircleResult> {
  const pool = getPool();
  const [info, hist, munis] = await Promise.all([
    pool.query('SELECT area_km2, area_in_state_km2, pct_in_state FROM fire.circle_info($1, $2, $3)', [lon, lat, radiusKm]),
    pool.query('SELECT year, month, modis, viirs, harmonized, anomaly_z FROM fire.circle_history($1, $2, $3, $4)', [lon, lat, radiusKm, source]),
    pool.query(
      `WITH c AS (SELECT ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 5880), $3 * 1000, 64) AS g)
       SELECT r.ibge_code, r.name,
              round((100 * ST_Area(ST_Intersection(ST_Transform(r.geom, 5880), c.g)) / ST_Area(ST_Transform(r.geom, 5880)))::numeric, 1) AS pct_muni,
              round((100 * ST_Area(ST_Intersection(ST_Transform(r.geom, 5880), c.g)) / ST_Area(c.g))::numeric, 1) AS pct_circle
         FROM fire.region r, c
        WHERE r.kind = 'municipio' AND ST_Intersects(ST_Transform(r.geom, 5880), c.g)
        ORDER BY pct_circle DESC
        LIMIT 200`,
      [lon, lat, radiusKm]
    ),
  ]);
  const i = info.rows[0];
  return {
    lon,
    lat,
    radiusKm,
    source,
    areaKm2: num(i?.area_km2),
    areaInStateKm2: num(i?.area_in_state_km2),
    pctInState: num(i?.pct_in_state),
    rows: hist.rows.map((r) => ({
      year: Number(r.year),
      month: Number(r.month),
      modis: num(r.modis),
      viirs: num(r.viirs),
      harmonized: num(r.harmonized),
      anomalyZ: num(r.anomaly_z),
      daysMissing: 0,
    })),
    municipalities: munis.rows.map((r) => ({
      ibge: String(r.ibge_code),
      name: String(r.name),
      pctOfMunicipality: Number(r.pct_muni),
      pctOfCircle: Number(r.pct_circle),
    })),
  };
}

export interface RecurrenceQuery {
  west: number;
  south: number;
  east: number;
  north: number;
  from: number;
  to: number;
  month: number | null;
  source: HistorySource;
  resM: 500 | 1000 | 2000 | 5000 | 10000;
  limit: number;
}

/** Compact columnar payload: [lon, lat, yearsBurnedWithNeighbours, yearsBurned, lastYear, peakMonth] per cell. */
export async function recurrence(q: RecurrenceQuery): Promise<{ yearsObserved: number; cells: number[][] }> {
  const res = await getPool().query(
    `SELECT lon, lat, years_burned, years_burned_nb, years_observed, last_year, peak_month
       FROM fire.cell_recurrence($1, $2, $3, $4, $5::smallint, $6::smallint, $7::smallint, $8, $9, $10)`,
    [q.west, q.south, q.east, q.north, q.from, q.to, q.month, q.source, q.resM, q.limit]
  );
  const yearsObserved = res.rows[0] ? Number(res.rows[0].years_observed) : q.to - q.from + 1;
  return {
    yearsObserved,
    cells: res.rows.map((r) => [
      Math.round(Number(r.lon) * 1e5) / 1e5,
      Math.round(Number(r.lat) * 1e5) / 1e5,
      Number(r.years_burned_nb),
      Number(r.years_burned),
      Number(r.last_year),
      Number(r.peak_month),
    ]),
  };
}

export interface AreaCellsQuery {
  regionId: number | null;
  lon: number | null;
  lat: number | null;
  radiusKm: number | null;
  year: number;
  month: number;
  resM: 1000 | 2000 | 5000;
}

/**
 * Grid cells inside a municipality (cells assigned to it by centre) or inside a circle, with the month's
 * harmonized cell-days and how many years each cell burned. The cells add up to the area's monthly value.
 * cells: [lon, lat, cellDays, yearsBurned, lastYear]
 */
export async function areaCells(q: AreaCellsQuery): Promise<{ yearsObserved: number; total: number; cells: number[][] }> {
  const res = await getPool().query(
    `SELECT c.lon, c.lat, c.cell_days, c.years_burned, c.last_year,
            (SELECT count(DISTINCT l.year) FROM fire.loaded_year l) AS years_observed
       FROM fire.area_cells($1, $2, $3, $4, $5::smallint, $6::smallint, $7) c`,
    [q.regionId, q.lon, q.lat, q.radiusKm, q.year, q.month, q.resM]
  );
  let total = 0;
  const cells = res.rows.map((r) => {
    const cd = num(r.cell_days) ?? 0;
    total += cd;
    return [
      Math.round(Number(r.lon) * 1e5) / 1e5,
      Math.round(Number(r.lat) * 1e5) / 1e5,
      cd,
      Number(r.years_burned),
      Number(r.last_year),
    ];
  });
  return {
    yearsObserved: res.rows[0] ? Number(res.rows[0].years_observed) : 0,
    total: Math.round(total * 10) / 10,
    cells,
  };
}

/* ---------------- validation artifacts (written by job:build-history, never hand-typed) ---------------- */

export interface HarmonizationValidation {
  computedAt: string;
  source: 'firms_db';
  calibrationPeriod: string;
  testPeriod: string;
  method: string;
  mapePct: number | null;
  wapePct: number | null;
  pearsonR: number | null;
  biasPct: number | null;
  nMonths: number;
  municipalities: { n: number; medianWapePct: number | null; p90WapePct: number | null };
  monthlyRatioFactors: (number | null)[];
}

export interface ProjectionValidation {
  computedAt: string;
  period: string;
  methods: {
    method: ProjectionMethod;
    nMonths: number;
    coveragePct: number | null;
    meanWidth: number | null;
    maeP50: number | null;
    maePersistence: number | null;
    skillPct: number | null;
  }[];
  chosenMethod: ProjectionMethod;
  analogBeatsRange: boolean;
  recurrence: {
    testYear: number;
    windowYears: number;
    minYears: number;
    hitPct: number | null;
    areaSharePct: number | null;
    lift: number | null;
  } | null;
}

function readJson<T>(file: string, guard: (v: unknown) => v is T): T | null {
  try {
    const full = path.join(config.outDir, file);
    if (!fs.existsSync(full)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(full, 'utf8'));
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isComputed = (v: unknown): v is { computedAt: string } =>
  typeof v === 'object' && v !== null && typeof (v as { computedAt?: unknown }).computedAt === 'string';

export function readHarmonizationValidation(): HarmonizationValidation | null {
  return readJson('validation.json', (v): v is HarmonizationValidation => isComputed(v) && (v as { source?: unknown }).source === 'firms_db');
}

export function readProjectionValidation(): ProjectionValidation | null {
  return readJson('projection_validation.json', (v): v is ProjectionValidation => isComputed(v) && Array.isArray((v as { methods?: unknown }).methods));
}
