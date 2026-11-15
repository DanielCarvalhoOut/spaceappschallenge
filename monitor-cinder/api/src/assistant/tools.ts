/**
 * Read-only tools of the assistant. Each one returns a small aggregate (≈2 KB at most) with n, base period and source,
 * built from the same in-memory calendars and forecast the API serves. Nothing here writes or calls the LLM.
 * Outside Goiás or without data the answer is `{ noData: true }`: never an extrapolation.
 */
import { ONI_THRESHOLD, ONI_URL, type EnsoPhase } from '../connectors/oni.js';
import { nasaPowerConnector } from '../connectors/nasa-power.js';
import { quantile } from '../core/forecast.js';
import { getForecast, getForecastContext, readForecastValidation, seriesMonth, seriesPattern } from '../db/forecast-service.js';
import { store } from '../db/store.js';
import { compareIntervention, loadInterventions, type Intervention } from './interventions.js';

export const BASE_FROM = 2002;
export const BASE_TO = 2024;
export const STALE_HOURS = 24;
export const MAX_WINDOW_MONTHS = 6;
export const RANKING_TOP = 5;
export const SMALL_N = 5;
const FIRMS_SOURCE = 'NASA FIRMS (MODIS + VIIRS S-NPP), harmonized series';
/** Peak month of a municipality in the active series (September when unknown). */
export const peakMonthOf = (ibge: string): number => seriesPattern(ibge)?.season.peakMonth ?? 9;
const UNIT = 'harmonized cell-days (1 km)';

export type ToolName = 'data_status' | 'historical_stats' | 'forecast' | 'enso' | 'interventions' | 'mobilization' | 'burn_context';
export interface ToolResult {
  name: ToolName;
  result: Record<string, unknown>;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const mean = (a: readonly number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const noData = (reason: string): Record<string, unknown> => ({ noData: true, reason });

/** Harmonized value of a municipality, or of the whole state when ibge = '52' (sum of the municipalities). */
function valueOf(ibge: string, y: number, m: number): number | null {
  const ctx = getForecastContext();
  if (y < ctx.input.firstYear || y > ctx.input.lastYear) return null;
  if (ibge === '52') {
    let s = 0;
    for (const bucket of ctx.input.series.values()) s += bucket.get(`${y}-${m}`) ?? 0;
    return s;
  }
  const bucket = ctx.input.series.get(ibge);
  return bucket ? (bucket.get(`${y}-${m}`) ?? 0) : null;
}

const placeName = (ibge: string): string | null => (ibge === '52' ? 'Goiás' : (store.getMunicipality(ibge)?.name ?? null));

/* ---------------- 0. data status (freshness) ---------------- */

export function dataStatus(now: Date): ToolResult {
  const ctx = getForecastContext();
  const staleDays = ctx.dataThrough ? Math.floor((now.getTime() - Date.parse(`${ctx.dataThrough}T23:59:59Z`)) / 86_400_000) : null;
  return {
    name: 'data_status',
    result: {
      dataKind: ctx.dataKind,
      source: ctx.source,
      firstYear: ctx.input.firstYear,
      lastYear: ctx.input.lastYear,
      dataThrough: ctx.dataThrough,
      staleDays,
      staleThresholdHours: STALE_HOURS,
      stale: staleDays === null ? null : staleDays * 24 > STALE_HOURS,
    },
  };
}

/* ---------------- 1. historical statistics ---------------- */

export function historicalStats(ibge: string, year?: number, month?: number): ToolResult {
  const name = store.getMunicipality(ibge)?.name;
  const pattern = seriesPattern(ibge);
  if (!name || !pattern) return { name: 'historical_stats', result: noData('municipality not in Goiás or without data') };
  const m = month ?? pattern.season.peakMonth ?? 9;
  const y = year ?? getForecastContext().input.lastYear;
  const sm = seriesMonth(ibge, y, m);
  const base = sm?.base ?? [];
  const row = sm && sm.value !== null ? { harmonized: sm.value, anomalyZ: sm.z } : null;
  return {
    name: 'historical_stats',
    result: {
      municipality: name,
      ibge,
      unit: UNIT,
      basePeriod: `${BASE_FROM}-${BASE_TO}`,
      n: BASE_TO - BASE_FROM + 1,
      monthlyMean: pattern.months.map((x) => x.mean),
      season: { months: pattern.season.months, coveredPct: pattern.season.coveredPct, peakMonth: pattern.season.peakMonth },
      month: { month: m, mean: r1(mean(base)), p10: r1(quantile(base, 0.1)), p50: r1(quantile(base, 0.5)), p90: r1(quantile(base, 0.9)), n: base.length },
      anomaly: row ? { year: y, month: m, value: r1(row.harmonized), z: row.anomalyZ, n: base.length, basePeriod: `${BASE_FROM}-${BASE_TO}` } : null,
      source: FIRMS_SOURCE,
    },
  };
}

/* ---------------- 2. forecast for a window ---------------- */

function validationBrief(): Record<string, unknown> | null {
  const v = readForecastValidation();
  if (!v) return null;
  return {
    trainPeriod: `${v.trainPeriod.from}-${v.trainPeriod.to}`,
    testPeriod: `${v.testPeriod.from}-${v.testPeriod.to}`,
    nTest: v.nTest,
    maeModel: v.mae.model,
    maeClimatology: v.mae.climatology,
    maePersistence: v.mae.persistence,
    maeClimatologyMedian: v.maeClimatologyMedian,
    skillVsClimatologyPct: v.skillVsClimatologyPct,
    brierModel: v.exceedance.brier.model,
    brierClimatology: v.exceedance.brier.climatology,
    coverageP10P90Pct: v.coverageP10P90Pct.model,
    official: v.official,
    probabilityOfficial: v.exceedance.official,
  };
}

export function forecastWindow(ibge: string, year: number, month: number, months = 1): ToolResult {
  const name = store.getMunicipality(ibge)?.name;
  if (!name) return { name: 'forecast', result: noData('municipality not in Goiás') };
  const out: Record<string, unknown>[] = [];
  const flags = new Set<string>();
  let prob: Record<string, unknown> | null = null;
  const count = Math.max(1, Math.min(MAX_WINDOW_MONTHS, months));
  for (let i = 0; i < count; i++) {
    const y = year + Math.floor((month - 1 + i) / 12);
    const m = ((month - 1 + i) % 12) + 1;
    const f = getForecast(ibge, y, m)?.forecast;
    if (!f) continue;
    out.push({ year: y, month: m, method: f.method, value: f.value, p10: f.p10, p90: f.p90, probAboveP90Pct: f.probAboveP90Pct, p90Threshold: f.p90Threshold, observed: f.observed });
    for (const fl of f.flags) flags.add(fl);
    prob ??= {
      method: f.probMethod,
      n: f.probN,
      thresholdPeriod: f.thresholdPeriod,
      thresholdN: f.thresholdN,
      source: f.probMethod === 'climatology' ? `share of previous years above the P90 (${FIRMS_SOURCE})` : 'model calibrated on training years',
    };
  }
  const validation = validationBrief();
  if (!out.length || !validation) return { name: 'forecast', result: noData('forecast not available for this place and window (run job:forecast)') };
  return {
    name: 'forecast',
    result: { municipality: name, ibge, unit: UNIT, months: out, probability: prob, validation, flags: [...flags], source: FIRMS_SOURCE },
  };
}

/* ---------------- 3. ENSO: hotspots by phase ---------------- */

export function ensoComparison(ibge: string, month: number): ToolResult {
  const ctx = getForecastContext();
  const name = placeName(ibge);
  if (!name) return { name: 'enso', result: noData('place not in Goiás') };
  if (!ctx.oniRecords.length) return { name: 'enso', result: noData('ONI not loaded (run job:forecast with network access to NOAA CPC)') };
  const byMonth = new Map(ctx.oniRecords.map((r) => [`${r.year}-${r.month}`, r]));
  const groups: Record<EnsoPhase, number[]> = { el_nino: [], la_nina: [], neutral: [] };
  for (let y = ctx.input.firstYear; y <= ctx.input.lastYear; y++) {
    const v = valueOf(ibge, y, month);
    const oni = byMonth.get(`${y}-${month}`);
    if (v === null || !oni) continue;
    groups[oni.phase].push(v);
  }
  const phases = (Object.keys(groups) as EnsoPhase[]).map((p) => ({
    phase: p,
    n: groups[p].length,
    mean: r1(mean(groups[p])),
    median: r1(quantile(groups[p], 0.5)),
    smallSample: groups[p].length < SMALL_N,
  }));
  const last = ctx.oniRecords[ctx.oniRecords.length - 1]!;
  return {
    name: 'enso',
    result: {
      place: name,
      ibge,
      month,
      unit: UNIT,
      basePeriod: `${ctx.input.firstYear}-${ctx.input.lastYear}`,
      phases,
      smallSampleBelow: SMALL_N,
      thresholdOni: ONI_THRESHOLD,
      latest: { season: last.season, year: last.year, anom: last.anom, phase: last.phase },
      source: `NOAA CPC ONI (${ONI_URL}) + ${FIRMS_SOURCE}`,
      note: 'association only: phase of the same month, no cause attributed',
    },
  };
}

/* ---------------- 4. declared interventions ---------------- */

export function interventionsFor(ibge: string, registry: readonly Intervention[] = loadInterventions()): ToolResult {
  const name = store.getMunicipality(ibge)?.name;
  if (!name) return { name: 'interventions', result: noData('municipality not in Goiás') };
  const ctx = getForecastContext();
  const items = registry.filter((i) => i.ibge === ibge).slice(0, 3);
  const validation = readForecastValidation();
  return {
    name: 'interventions',
    result: {
      municipality: name,
      ibge,
      unit: UNIT,
      count: items.length,
      items: items.map((i) => ({
        date: i.date,
        type: i.type,
        source: i.source,
        registeredBy: i.registeredBy,
        comparison: compareIntervention(i, {
          lastYear: ctx.input.lastYear,
          firstYear: ctx.input.firstYear,
          value: (y, m) => valueOf(ibge, y, m),
          forecast: (y, m) => (validation ? (getForecast(ibge, y, m)?.forecast.value ?? null) : null),
        }),
      })),
      note: 'declared by third parties; before/after is an association, not an effect estimate',
      source: `intervention registry + ${FIRMS_SOURCE}`,
    },
  };
}

/* ---------------- 5. mobilization ranking ---------------- */

export function mobilizationRanking(year: number, month: number): ToolResult {
  const validation = validationBrief();
  if (!validation) return { name: 'mobilization', result: noData('forecast not available (run job:forecast)') };
  const rows: { ibge: string; name: string; prob: number; value: number; thr: number; n: number; method: string }[] = [];
  for (const [ibge, muni] of store.getMunicipalities()) {
    const f = getForecast(ibge, year, month)?.forecast;
    if (!f) continue;
    rows.push({ ibge, name: muni.name, prob: f.probAboveP90Pct, value: f.value, thr: f.p90Threshold, n: f.probN, method: f.probMethod });
  }
  if (!rows.length) return { name: 'mobilization', result: noData('no forecast for this month') };
  // Highest probability first; ties broken by how close the forecast is to the municipality's own P90.
  rows.sort((a, b) => b.prob - a.prob || b.value / Math.max(1, b.thr) - a.value / Math.max(1, a.thr));
  const first = rows[0]!;
  return {
    name: 'mobilization',
    result: {
      year,
      month,
      unit: UNIT,
      top: RANKING_TOP,
      municipalitiesRanked: rows.length,
      ranking: rows.slice(0, RANKING_TOP).map((r) => ({ ibge: r.ibge, name: r.name, probAboveP90Pct: r.prob, value: r.value, p90Threshold: r.thr })),
      probability: {
        method: first.method,
        n: first.n,
        source: first.method === 'climatology' ? `share of previous years above the P90 (${FIRMS_SOURCE})` : 'model calibrated on training years',
      },
      validation,
      source: FIRMS_SOURCE,
    },
  };
}

/* ---------------- 6. context for a controlled-burn question ---------------- */

const powerCache = new Map<string, Record<string, unknown> | null>();

/** Mean wind and humidity of the same month in the last loaded year, from NASA POWER (real call, short timeout). */
async function powerMonth(ibge: string, year: number, month: number): Promise<Record<string, unknown> | null> {
  const key = `${ibge}:${year}:${month}`;
  if (powerCache.has(key)) return powerCache.get(key) ?? null;
  const muni = store.getMunicipality(ibge);
  if (!muni) return null;
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let out: Record<string, unknown> | null = null;
  try {
    const days = await nasaPowerConnector.fetchRange(muni.centroidLat, muni.centroidLon, `${year}${mm}01`, `${year}${mm}${lastDay}`, 8000);
    const ws = days.map((d) => d.ws10mMs).filter((v): v is number => v !== null);
    const rh = days.map((d) => d.rh2mPct).filter((v): v is number => v !== null);
    if (ws.length && rh.length) {
      out = { year, month, windMeanMs: r1(mean(ws)), humidityMeanPct: r1(mean(rh)), nDays: Math.min(ws.length, rh.length), source: 'NASA POWER daily (WS10M, RH2M), municipality centroid' };
    }
  } catch {
    out = null; // POWER offline or slow: the answer says "no data", never a made-up value
  }
  powerCache.set(key, out);
  return out;
}

export async function burnContext(ibge: string, year: number, month: number, opts: { fetchPower?: boolean } = {}): Promise<ToolResult> {
  const ctx = getForecastContext();
  const name = store.getMunicipality(ibge)?.name;
  if (!name) return { name: 'burn_context', result: noData('municipality not in Goiás') };
  const pattern = seriesPattern(ibge);
  if (!pattern) return { name: 'burn_context', result: noData('no series for this municipality') };
  const f = getForecast(ibge, year, month)?.forecast ?? null;
  const neighbors = (ctx.input.neighbors.get(ibge) ?? []).map((n) => {
    const nf = getForecast(n, year, month)?.forecast;
    return { name: store.getMunicipality(n)?.name ?? n, value: nf?.value ?? null, p90Threshold: nf?.p90Threshold ?? null };
  });
  const last = ctx.oniRecords[ctx.oniRecords.length - 1];
  const power = opts.fetchPower === false ? null : await powerMonth(ibge, ctx.input.lastYear, month);
  return {
    name: 'burn_context',
    result: {
      municipality: name,
      ibge,
      unit: UNIT,
      season: { months: pattern.season.months, peakMonth: pattern.season.peakMonth, basePeriod: `${BASE_FROM}-${BASE_TO}`, n: BASE_TO - BASE_FROM + 1 },
      forecast: f ? { year, month, method: f.method, value: f.value, p10: f.p10, p90: f.p90, probAboveP90Pct: f.probAboveP90Pct, p90Threshold: f.p90Threshold, probN: f.probN, probMethod: f.probMethod } : null,
      validation: validationBrief(),
      neighbors,
      enso: last ? { season: last.season, year: last.year, anom: last.anom, phase: last.phase, source: 'NOAA CPC ONI' } : null,
      power,
      landUse: null,
      landUseNote: 'MCD12Q1 not loaded for all municipalities: no verified land-use data',
      law: 'Lei 14.944/2024',
      source: FIRMS_SOURCE,
    },
  };
}
