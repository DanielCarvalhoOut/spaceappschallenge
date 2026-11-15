/**
 * Glue between the in-memory calendars (store), the ONI cache and the pure forecast functions.
 * Read-only: nothing here writes, except job:forecast which calls writeForecastValidation().
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { loadOniCache, ONI_URL, type OniRecord } from '../connectors/oni.js';
import { loadCellIndex } from '../core/cell-index.js';
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
import { store } from './store.js';

export const NEIGHBORS_K = 5;
export const FORECAST_FILE = 'forecast_validation.json';
export const TRAIN_TO = 2019;
export const TEST_FROM = 2020;
export const TEST_TO = 2025;

export interface ForecastContext {
  input: ForecastInput;
  dataKind: 'firms_index' | 'synthetic';
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
  let maxDay = 0;
  if (index) {
    for (const c of index.cells) {
      const lm = c[3][c[3].length - 1] ?? 0;
      const lv = c[4][c[4].length - 1] ?? 0;
      if (lm > maxDay) maxDay = lm;
      if (lv > maxDay) maxDay = lv;
    }
  }
  const viirsYears = index ? index.yearsLoaded.VIIRS.filter((y) => y >= 2012) : [];
  ctxCache = {
    input: { series, firstYear, lastYear, neighbors, oni },
    dataKind,
    viirsYears,
    factorYears: index?.factorYears ?? viirsYears,
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

/** Runs the temporal validation and writes out/forecast_validation.json. Used by job:forecast only. */
export function writeForecastValidation(): ForecastValidation {
  const ctx = getForecastContext();
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
  if (ctx.dataKind === 'firms_index' && missingViirs.length) {
    notes.push(
      `VIIRS S-NPP yearly archive not loaded for ${missingViirs.join(', ')}: those years use MODIS x monthly factor (factor calibrated on ${ctx.factorYears.join(', ')}).`
    );
  }
  const v = validateForecast(ctx.input, {
    trainTo: TRAIN_TO,
    testFrom: TEST_FROM,
    testTo: TEST_TO,
    neighborsK: NEIGHBORS_K,
    dataKind: ctx.dataKind,
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
