/**
 * Glue between the in-memory calendars (store), the ONI cache and the pure forecast functions.
 * Read-only: nothing here writes, except job:forecast which calls writeForecastValidation().
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { loadOniCache, ONI_URL, type OniRecord } from '../connectors/oni.js';
import { buildChain, loadCellIndex } from '../core/cell-index.js';
import {
  forecastOne,
  ForecastValidationSchema,
  nearestNeighbors,
  validateForecast,
  type ForecastInput,
  type ForecastOutput,
  type ForecastValidation,
} from '../core/forecast.js';
import { logger } from '../core/logger.js';
import { hasHistory } from './history.js';
import { getPool } from './pool.js';
import { store } from './store.js';

export const NEIGHBORS_K = 5;
export const FORECAST_FILE = 'forecast_validation.json';
export const TRAIN_TO = 2019;
export const TEST_FROM = 2020;
export const TEST_TO = 2025;

export interface ForecastContext {
  input: ForecastInput;
  /** 'firms_db' = fire.calendar_monthly in PostGIS; 'firms_index' = in-memory FIRMS cell index (satellite chain);
   *  'synthetic' = demo; 'none' = no series loaded yet. */
  dataKind: 'firms_db' | 'firms_index' | 'synthetic' | 'none';
  viirsYears: number[];
  factorYears: number[];
  source: string;
  /** Last day with a detection in the loaded FIRMS index (YYYY-MM-DD); null for synthetic data. */
  dataThrough: string | null;
  oniRecords: OniRecord[];
  oniFetchedAt: string | null;
}

let ctxCache: ForecastContext | null = null;

/** Builds (once) the forecast input from the calendars served by the API. Call after store.init(). */
export function getForecastContext(): ForecastContext {
  if (ctxCache) return ctxCache;
  const munis = store.getMunicipalities();
  const series = new Map<string, Map<string, number>>();
  let firstYear = 9999;
  let lastYear = 0;
  for (const ibge of munis.keys()) {
    const bucket = new Map<string, number>();
    for (const r of store.getCalendar(ibge)) {
      if (r.year < 2001) continue; // MODIS starts in Nov/2000: the first full year is 2001
      if (r.harmonized === null) continue; // month without a sensor for > 10 days: no value, not a zero
      bucket.set(`${r.year}-${r.month}`, r.harmonized);
      if (r.year < firstYear) firstYear = r.year;
      if (r.year > lastYear) lastYear = r.year;
    }
    series.set(ibge, bucket);
  }
  const neighbors = nearestNeighbors(
    [...munis.values()].map((m) => ({ ibge: m.ibgeCode, lat: m.centroidLat, lon: m.centroidLon })),
    NEIGHBORS_K
  );
  const oniCache = loadOniCache();
  const oniRecords = oniCache?.records ?? [];
  const oni = new Map<string, number>(oniRecords.map((r) => [`${r.year}-${r.month}`, r.anom]));

  const dataKind = store.getCalendarKind();
  const index = dataKind === 'firms_index' ? loadCellIndex() : null;
  // satellite chain (main since 15/11): VIIRS S-NPP from its first day, NOAA-20/21 linked to the S-NPP scale
  const chain = index ? buildChain(index) : null;
  const yearOf = (d: number): number => new Date(d * 86_400_000).getUTCFullYear();
  const snppFirst = index?.sensors.SNPP.first ?? null;
  const viirsYears: number[] = [];
  if (chain && snppFirst !== null) for (let y = Math.max(2012, yearOf(snppFirst)); y <= yearOf(chain.last); y++) viirsYears.push(y);
  const maxDay = chain ? chain.last : 0;
  ctxCache = {
    input: { series, firstYear, lastYear, neighbors, oni },
    dataKind,
    viirsYears,
    factorYears: viirsYears,
    source: index ? index.source : 'synthetic demo series (not FIRMS): do not use these numbers outside a demo',
    dataThrough: maxDay ? new Date(maxDay * 86_400_000).toISOString().slice(0, 10) : null,
    oniRecords,
    oniFetchedAt: oniCache?.fetchedAt ?? null,
  };
  return ctxCache;
}

export function resetForecastCache(): void {
  ctxCache = null;
  validationCache = null;
}

/**
 * Chooses the series the forecast and the assistant read, once, at start-up (call after store.init()):
 *   1. PostGIS (fire.calendar_monthly, the same table the calendar routes serve) when the history is built AND both
 *      sensors are loaded. A MODIS-only database is not a harmonized series, so it is not used.
 *   2. otherwise the in-memory series (FIRMS cell index, or the synthetic demo).
 * Read-only: three fixed queries, no per-municipality query. CINDER_SERIES=memory skips the database.
 */
export async function primeForecastContext(): Promise<ForecastContext> {
  ctxCache = null;
  const memory = getForecastContext();
  if (process.env.CINDER_SERIES === 'memory' || !(await hasHistory())) return memory;
  try {
    const pool = getPool();
    const loaded = await pool.query<{ instrument: string; year: number }>('SELECT instrument, year FROM fire.loaded_year ORDER BY 1, 2');
    const modisYears = loaded.rows.filter((r) => r.instrument === 'MODIS').map((r) => Number(r.year));
    const viirsYears = loaded.rows.filter((r) => r.instrument === 'VIIRS').map((r) => Number(r.year));
    if (!modisYears.length || !viirsYears.length) {
      logger.warn({ modisYears: modisYears.length, viirsYears: viirsYears.length }, 'PostGIS history has only one sensor: not a harmonized series; using the in-memory series');
      return memory;
    }
    const rows = await pool.query<{ ibge: string; year: number; month: number; v: number }>(
      `SELECT r.ibge_code AS ibge, c.year, c.month, c.harmonized_count::float8 AS v
         FROM fire.calendar_monthly c JOIN fire.region r ON r.id = c.region_id
        WHERE r.kind = 'municipio' AND c.method = $1 AND c.year >= $2`,
      ['monthly_ratio', 2001]
    );
    const series = new Map<string, Map<string, number>>();
    let firstYear = 9999;
    let lastYear = 0;
    for (const r of rows.rows) {
      const y = Number(r.year);
      let bucket = series.get(r.ibge);
      if (!bucket) {
        bucket = new Map();
        series.set(r.ibge, bucket);
      }
      bucket.set(`${y}-${Number(r.month)}`, Number(r.v));
      if (y < firstYear) firstYear = y;
      if (y > lastYear) lastYear = y;
    }
    if (series.size < 2) return memory;
    const through = await pool.query<{ d: string | null }>(`SELECT max(acq_ts)::date::text AS d FROM fire.hotspot`);
    ctxCache = {
      ...memory,
      input: { ...memory.input, series, firstYear, lastYear },
      dataKind: 'firms_db',
      viirsYears,
      factorYears: viirsYears.filter((y) => modisYears.includes(y)),
      source: 'NASA FIRMS yearly country archives (Brazil) in PostGIS: fire.calendar_monthly, method monthly_ratio',
      dataThrough: through.rows[0]?.d ?? null,
    };
    logger.info({ municipalities: series.size, firstYear, lastYear, viirsYears: viirsYears.length }, 'forecast series loaded from PostGIS');
    return ctxCache;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'PostGIS series not readable; using the in-memory series');
    ctxCache = memory;
    return memory;
  }
}

const BASE_FROM = 2002;
const BASE_TO = 2024;

/** Seasonal pattern of a municipality from the active series (same rule as the /pattern route: base 2002–2024). */
export function seriesPattern(ibge: string): { months: { month: number; mean: number; sharePct: number }[]; season: { months: number[]; coveredPct: number; peakMonth: number | null } } | null {
  const bucket = getForecastContext().input.series.get(ibge);
  if (!bucket) return null;
  const sums = new Array<number>(12).fill(0);
  for (let y = BASE_FROM; y <= BASE_TO; y++) for (let m = 1; m <= 12; m++) sums[m - 1]! += bucket.get(`${y}-${m}`) ?? 0;
  const total = sums.reduce((a, b) => a + b, 0) || 1;
  const years = BASE_TO - BASE_FROM + 1;
  const months = sums.map((s, i) => ({ month: i + 1, mean: Math.round((s / years) * 10) / 10, sharePct: Math.round((s / total) * 1000) / 10 }));
  const sorted = [...months].sort((a, b) => b.sharePct - a.sharePct);
  const picked: number[] = [];
  let acc = 0;
  for (const m of sorted) {
    if (acc >= 80) break;
    picked.push(m.month);
    acc += m.sharePct;
  }
  return { months, season: { months: picked.sort((a, b) => a - b), coveredPct: Math.round(acc * 10) / 10, peakMonth: sorted[0]?.month ?? null } };
}

/** Same-month values of the base period and the z-score of one month against them (null when there is no spread). */
export function seriesMonth(ibge: string, year: number, month: number): { base: number[]; value: number | null; z: number | null } | null {
  const ctx = getForecastContext();
  const bucket = ctx.input.series.get(ibge);
  if (!bucket) return null;
  const base: number[] = [];
  for (let y = Math.max(BASE_FROM, ctx.input.firstYear); y <= Math.min(BASE_TO, ctx.input.lastYear); y++) base.push(bucket.get(`${y}-${month}`) ?? 0);
  const value = year >= ctx.input.firstYear && year <= ctx.input.lastYear ? (bucket.get(`${year}-${month}`) ?? 0) : null;
  let z: number | null = null;
  if (value !== null && base.length >= 2) {
    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (base.length - 1));
    z = sd > 0 ? Math.round(((value - mean) / sd) * 100) / 100 : null;
  }
  return { base, value, z };
}

/** Runs the temporal validation and writes out/forecast_validation.json. Used by job:forecast only. */
export function writeForecastValidation(): ForecastValidation {
  const ctx = getForecastContext();
  if (ctx.dataKind === 'none') throw new Error('No harmonized series loaded: start the API data store first');
  const dataKind = ctx.dataKind;
  const notes = [
    'Forecast of hotspot occurrence per municipality and month, not of fire behaviour (speed, direction, reach).',
    'Predictors are statistical associations; no cause is attributed.',
    'Coefficients are fitted only on target years <= trainTo. Lagged observations of earlier years feed the features of a test month, as they would in operation.',
    'Climatology baseline = mean of the same month over all previous years; persistence = same month of the previous year.',
    'P10-P90 of the model = quantiles of the training residuals (log scale) by level of the forecast.',
  ];
  if (ctx.dataKind === 'synthetic') notes.unshift('SYNTHETIC SERIES: FIRMS history not loaded. These metrics describe the demo generator, not real fire data.');
  const missingViirs: number[] = [];
  for (let y = 2012; y <= ctx.input.lastYear; y++) if (!ctx.viirsYears.includes(y)) missingViirs.push(y);
  if (ctx.dataKind === 'firms_index') {
    notes.push('Series read from the FIRMS cell index (satellite chain): MODIS, VIIRS S-NPP, NOAA-20 and NOAA-21 on the S-NPP scale with monthly factors validated on held-out years.');
  }
  if (ctx.dataKind === 'firms_db') {
    notes.push('Series read from PostGIS (fire.calendar_monthly): VIIRS S-NPP cell-days from 2012, MODIS x municipal monthly factor with shrinkage before.');
  }
  if (ctx.dataKind === 'firms_db' && missingViirs.length) {
    notes.push(
      `VIIRS S-NPP yearly archive not loaded for ${missingViirs.join(', ')}: those years use MODIS x monthly factor (factor calibrated on ${ctx.factorYears.join(', ')}).`
    );
  }
  const v = validateForecast(ctx.input, {
    trainTo: TRAIN_TO,
    testFrom: TEST_FROM,
    testTo: TEST_TO,
    neighborsK: NEIGHBORS_K,
    dataKind,
    viirsYears: ctx.viirsYears,
    factorYears: ctx.factorYears,
    source: ctx.source,
    oniSource: ctx.oniRecords.length ? ONI_URL : 'not loaded (feature set to 0)',
    notes,
  });
  fs.writeFileSync(path.join(config.outDir, FORECAST_FILE), JSON.stringify(v, null, 2));
  validationCache = null;
  return v;
}

let validationCache: { mtimeMs: number; v: ForecastValidation } | null = null;

/** Reads out/forecast_validation.json (zod). Null when job:forecast has not run or the file is invalid. */
export function readForecastValidation(): ForecastValidation | null {
  const file = path.join(config.outDir, FORECAST_FILE);
  try {
    const st = fs.statSync(file);
    if (validationCache && validationCache.mtimeMs === st.mtimeMs) return validationCache.v;
    const parsed = ForecastValidationSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) {
      logger.warn({ err: parsed.error.message.slice(0, 300) }, 'forecast_validation.json is invalid; ignoring it');
      return null;
    }
    validationCache = { mtimeMs: st.mtimeMs, v: parsed.data };
    return parsed.data;
  } catch {
    return null;
  }
}

/** Forecast for one municipality-month. Null when there is no validation artifact or no data for the place. */
export function getForecast(ibge: string, year: number, month: number): { forecast: ForecastOutput; validation: ForecastValidation } | null {
  const validation = readForecastValidation();
  if (!validation) return null;
  const ctx = getForecastContext();
  // The artifact must describe the series being served; otherwise its metrics would be quoted for other data.
  if (validation.dataKind !== ctx.dataKind) return null;
  const forecast = forecastOne(ctx.input, validation, ibge, year, month);
  return forecast ? { forecast, validation } : null;
}
