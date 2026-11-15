/**
 * Forecast of harmonized hotspot cell-days per municipality and month.
 *
 * What it is: occurrence of hotspots per area and month. What it is NOT: fire behaviour (speed, direction, reach).
 * No cause is attributed: ONI and the neighbours are predictors, i.e. statistical association only.
 *
 * Features (only the ones confirmed in CONFERENCIA.md): seasonality, hotspot lags, neighbours' hotspots, ONI.
 * Baselines: climatology (mean of the same month in all previous years) and persistence (same month, previous year).
 * Temporal validation: coefficients fitted on target years <= trainTo, tested on later years, never shuffled.
 * If the model does not beat the climatology on MAE, the climatology is the official forecast.
 *
 * Pure functions: no I/O here. job:forecast writes out/forecast_validation.json; forecast-service.ts serves it.
 */
import { z } from 'zod';

export const FEATURE_NAMES = [
  'climLog',
  'lag12Log',
  'lag24Log',
  'prevYearTotalLog',
  'neighborsLag12Log',
  'oniLag3',
  'oniLag3xClim',
  'sinMonth',
  'cosMonth',
] as const;

export const ONI_LAG_MONTHS = 3;
export const RIDGE_LAMBDA = 1;
export const EXCEED_QUANTILE = 0.9;
const CALIBRATION_EDGES = [0, 0.05, 0.15, 0.3, 0.5, 1.0000001] as const;

export interface ForecastInput {
  /** ibge → "YYYY-M" → harmonized cell-days. A month missing inside [firstYear, lastYear] counts as 0. */
  series: Map<string, Map<string, number>>;
  firstYear: number;
  lastYear: number;
  /** ibge → nearest municipalities (by centroid). */
  neighbors: Map<string, string[]>;
  /** "YYYY-M" (centre month) → ONI anomaly. */
  oni: Map<string, number>;
}

const k = (y: number, m: number): string => `${y}-${m}`;
const mean = (a: readonly number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const round = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;

/** Linear-interpolated quantile (type 7). Empty input → 0. */
export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function observed(input: ForecastInput, ibge: string, y: number, m: number): number | null {
  const s = input.series.get(ibge);
  if (!s || y < input.firstYear || y > input.lastYear) return null;
  return s.get(k(y, m)) ?? 0;
}

/** Same-month values of every year before `y` (the climatology sample). */
export function pastSameMonth(input: ForecastInput, ibge: string, y: number, m: number): number[] {
  const out: number[] = [];
  for (let yy = input.firstYear; yy < y && yy <= input.lastYear; yy++) {
    const v = observed(input, ibge, yy, m);
    if (v !== null) out.push(v);
  }
  return out;
}

export interface FeatureRow {
  ibge: string;
  year: number;
  month: number;
  x: number[];
  /** Baselines, in cell-days. */
  climatology: number;
  climP10: number;
  climP90: number;
  climN: number;
  persistence: number;
  oniMissing: boolean;
  past: number[];
}

/**
 * Features of one target month, using only information from before the target year (FIRMS) and ONI lagged 3 months.
 * Null when the municipality has fewer than 2 previous years or the previous two years are not loaded.
 */
export function featureRow(input: ForecastInput, ibge: string, y: number, m: number): FeatureRow | null {
  const past = pastSameMonth(input, ibge, y, m);
  const lag12 = observed(input, ibge, y - 1, m);
  const lag24 = observed(input, ibge, y - 2, m);
  if (past.length < 2 || lag12 === null || lag24 === null) return null;

  const climLog = mean(past.map((v) => Math.log1p(v)));
  let prevTotal = 0;
  for (let mm = 1; mm <= 12; mm++) prevTotal += observed(input, ibge, y - 1, mm) ?? 0;
  const nb: number[] = [];
  for (const n of input.neighbors.get(ibge) ?? []) {
    const v = observed(input, n, y - 1, m);
    if (v !== null) nb.push(Math.log1p(v));
  }
  const oniMonth = m - ONI_LAG_MONTHS;
  const oniVal = input.oni.get(oniMonth >= 1 ? k(y, oniMonth) : k(y - 1, oniMonth + 12));
  const oni = oniVal ?? 0;
  const ang = (2 * Math.PI * (m - 1)) / 12;

  return {
    ibge,
    year: y,
    month: m,
    x: [
      climLog,
      Math.log1p(lag12),
      Math.log1p(lag24),
      Math.log1p(prevTotal),
      nb.length ? mean(nb) : Math.log1p(lag12),
      oni,
      oni * climLog,
      Math.sin(ang),
      Math.cos(ang),
    ],
    climatology: mean(past),
    climP10: quantile(past, 0.1),
    climP90: quantile(past, 0.9),
    climN: past.length,
    persistence: lag12,
    oniMissing: oniVal === undefined,
    past,
  };
}

/* ---------------- model ---------------- */

export const ForecastModelSchema = z.object({
  type: z.literal('ridge-log1p'),
  lambda: z.number(),
  features: z.array(z.string()),
  mean: z.array(z.number()),
  std: z.array(z.number()),
  coef: z.array(z.number()),
  intercept: z.number(),
  /** Cuts of the predicted log level that split the residuals into low / mid / high strata. */
  strataCuts: z.tuple([z.number(), z.number()]),
  /** Percentiles 1..99 of the training residuals (log scale), per stratum. */
  residualPercentiles: z.tuple([z.array(z.number()).length(99), z.array(z.number()).length(99), z.array(z.number()).length(99)]),
});
export type ForecastModel = z.infer<typeof ForecastModelSchema>;

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const piv = m[c]![c]!;
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / piv;
      if (f === 0) continue;
      for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

function rawPredict(model: Pick<ForecastModel, 'mean' | 'std' | 'coef' | 'intercept'>, x: readonly number[]): number {
  let p = model.intercept;
  for (let j = 0; j < x.length; j++) p += model.coef[j]! * ((x[j]! - model.mean[j]!) / model.std[j]!);
  return p;
}

const stratumOf = (cuts: readonly [number, number], predLog: number): 0 | 1 | 2 => (predLog < cuts[0] ? 0 : predLog < cuts[1] ? 1 : 2);

/** Ridge regression on standardized features, target log1p(cell-days). */
export function trainModel(rows: readonly { x: number[]; target: number }[]): ForecastModel {
  const p = FEATURE_NAMES.length;
  if (rows.length < p * 10) throw new Error(`Not enough training rows (${rows.length})`);
  const mu = new Array<number>(p).fill(0);
  const sd = new Array<number>(p).fill(0);
  for (const r of rows) for (let j = 0; j < p; j++) mu[j]! += r.x[j]! / rows.length;
  for (const r of rows) for (let j = 0; j < p; j++) sd[j]! += (r.x[j]! - mu[j]!) ** 2 / rows.length;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]!) || 1;

  const t = rows.map((r) => Math.log1p(r.target));
  const tMean = mean(t);
  const xtx = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty = new Array<number>(p).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const z = rows[i]!.x.map((v, j) => (v - mu[j]!) / sd[j]!);
    for (let a = 0; a < p; a++) {
      xty[a]! += z[a]! * (t[i]! - tMean);
      for (let b = a; b < p; b++) xtx[a]![b]! += z[a]! * z[b]!;
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) xtx[a]![b] = xtx[b]![a]!;
    xtx[a]![a]! += RIDGE_LAMBDA;
  }
  const coef = solve(xtx, xty);
  const base = { mean: mu, std: sd, coef, intercept: tMean };

  const preds = rows.map((r) => rawPredict(base, r.x));
  const cuts: [number, number] = [quantile(preds, 1 / 3), quantile(preds, 2 / 3)];
  const res: [number[], number[], number[]] = [[], [], []];
  preds.forEach((pr, i) => res[stratumOf(cuts, pr)].push(t[i]! - pr));
  const pct = (a: number[]): number[] => Array.from({ length: 99 }, (_, i) => round(quantile(a, (i + 1) / 100), 4));

  return {
    type: 'ridge-log1p',
    lambda: RIDGE_LAMBDA,
    features: [...FEATURE_NAMES],
    mean: mu.map((v) => round(v, 6)),
    std: sd.map((v) => round(v, 6)),
    coef: coef.map((v) => round(v, 6)),
    intercept: round(tMean, 6),
    strataCuts: [round(cuts[0], 6), round(cuts[1], 6)],
    residualPercentiles: [pct(res[0]), pct(res[1]), pct(res[2])],
  };
}

export interface ModelPrediction {
  value: number;
  p10: number;
  p90: number;
  /** Forecast on the log1p scale (input of the exceedance calibrator). */
  predLog: number;
}

export function predictWithModel(model: ForecastModel, x: readonly number[]): ModelPrediction {
  const predLog = rawPredict(model, x);
  const pct = model.residualPercentiles[stratumOf(model.strataCuts, predLog)];
  const back = (v: number): number => Math.max(0, Math.expm1(v));
  return { value: back(predLog), p10: back(predLog + pct[9]!), p90: back(predLog + pct[89]!), predLog };
}

/* ---------------- probability of a month above its P90 ---------------- */

export const ExceedCalibratorSchema = z.object({
  /** Upper edges of the margin bins (margin = forecast − climatology of that municipality-month, log1p scale). */
  cuts: z.array(z.number()),
  /** Share of training months above the threshold in each bin, made non-decreasing (isotonic). */
  rates: z.array(z.number().min(0).max(1)),
  n: z.array(z.number().int()),
});
export type ExceedCalibrator = z.infer<typeof ExceedCalibratorSchema>;

const CALIBRATOR_BINS = 20;

/**
 * Empirical, monotone map from the forecast margin to the frequency of "month above P90", learned on training rows
 * only. The margin is how far the model is above the municipality's own climatology for that month: every series has
 * the same share of months above its own P90, so only the departure from its normal carries signal. Counts are
 * zero-inflated, so reading the probability off the log residuals would overstate it.
 */
export function fitExceedCalibrator(rows: readonly { margin: number; event: 0 | 1 }[]): ExceedCalibrator {
  const margins = rows.map((r) => r.margin);
  const cuts = [...new Set(Array.from({ length: CALIBRATOR_BINS - 1 }, (_, i) => round(quantile(margins, (i + 1) / CALIBRATOR_BINS), 6)))];
  const n = new Array<number>(cuts.length + 1).fill(0);
  const hit = new Array<number>(cuts.length + 1).fill(0);
  for (const r of rows) {
    const b = binOf(cuts, r.margin);
    n[b]!++;
    hit[b]! += r.event;
  }
  // Pool adjacent violators: the rate never decreases as the margin grows.
  const blocks: { hit: number; n: number; size: number }[] = [];
  for (let i = 0; i < n.length; i++) {
    blocks.push({ hit: hit[i]!, n: n[i]!, size: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.n > 0 && b.n > 0 && a.hit / a.n <= b.hit / b.n) break;
      blocks.splice(blocks.length - 2, 2, { hit: a.hit + b.hit, n: a.n + b.n, size: a.size + b.size });
    }
  }
  const rates: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.size; i++) rates.push(b.n ? round(b.hit / b.n, 4) : 0);
  return { cuts, rates, n };
}

function binOf(cuts: readonly number[], margin: number): number {
  let b = 0;
  while (b < cuts.length && margin > cuts[b]!) b++;
  return b;
}

/** margin = model forecast − climatology of the same municipality-month, on the log1p scale (featureRow.x[0]). */
export function exceedProbability(cal: ExceedCalibrator, margin: number): number {
  return cal.rates[binOf(cal.cuts, margin)] ?? 0;
}

/** P90 of the same month over the training years: the "month above P90" threshold, with its n. */
export function exceedThreshold(input: ForecastInput, ibge: string, m: number, trainTo: number): { threshold: number; n: number } {
  const vals: number[] = [];
  for (let y = input.firstYear; y <= Math.min(trainTo, input.lastYear); y++) {
    const v = observed(input, ibge, y, m);
    if (v !== null) vals.push(v);
  }
  return { threshold: quantile(vals, EXCEED_QUANTILE), n: vals.length };
}

/* ---------------- validation ---------------- */

const TripleSchema = z.object({ model: z.number(), climatology: z.number(), persistence: z.number() });

export const ForecastValidationSchema = z.object({
  computedAt: z.string(),
  dataKind: z.enum(['firms_index', 'firms_db', 'synthetic']),
  series: z.object({
    firstYear: z.number().int(),
    lastYear: z.number().int(),
    municipalities: z.number().int(),
    unit: z.string(),
    viirsYears: z.array(z.number().int()),
    factorYears: z.array(z.number().int()),
    source: z.string(),
  }),
  trainPeriod: z.object({ from: z.number().int(), to: z.number().int(), dataFrom: z.number().int() }),
  testPeriod: z.object({ from: z.number().int(), to: z.number().int() }),
  nTrain: z.number().int(),
  nTest: z.number().int(),
  features: z.array(z.string()),
  neighborsK: z.number().int(),
  oni: z.object({ source: z.string(), lagMonths: z.number().int(), lastMonth: z.string().nullable(), missingInTestPct: z.number() }),
  mae: TripleSchema,
  maeDrySeason: TripleSchema,
  /** Stricter reference: median of the same month in previous years (the mean is penalised by skewed counts). */
  maeClimatologyMedian: z.number(),
  skillVsClimatologyPct: z.number(),
  exceedance: z.object({
    definition: z.string(),
    baseRateTestPct: z.number(),
    brier: TripleSchema,
    calibration: z.array(z.object({ bin: z.string(), n: z.number().int(), meanPredictedPct: z.number(), observedPct: z.number() })),
    calibrationMaxGapPct: z.number(),
    /** Same check for the climatological frequency (share of previous years above the threshold). */
    calibrationClimatology: z.array(z.object({ bin: z.string(), n: z.number().int(), meanPredictedPct: z.number(), observedPct: z.number() })),
    /** Which probability is served: the model's only if its Brier score beats the climatological frequency. */
    official: z.enum(['model', 'climatology']),
    calibrator: ExceedCalibratorSchema,
  }),
  coverageP10P90Pct: z.object({ model: z.number(), climatology: z.number() }),
  official: z.enum(['model', 'climatology']),
  officialReason: z.string(),
  model: ForecastModelSchema,
  notes: z.array(z.string()),
});
export type ForecastValidation = z.infer<typeof ForecastValidationSchema>;

export interface ValidateOptions {
  trainTo: number;
  testFrom: number;
  testTo: number;
  neighborsK: number;
  dataKind: ForecastValidation['dataKind'];
  viirsYears: number[];
  factorYears: number[];
  source: string;
  oniSource: string;
  notes?: string[];
}

export function validateForecast(input: ForecastInput, o: ValidateOptions): ForecastValidation {
  if (o.testFrom <= o.trainTo) throw new Error('Test period must start after the training period');
  const ibges = [...input.series.keys()];
  const trainFrom = input.firstYear + 2;

  const train: { x: number[]; target: number; ibge: string; month: number }[] = [];
  let trainMaxYear = 0;
  for (const ibge of ibges) {
    for (let y = trainFrom; y <= o.trainTo; y++) {
      for (let m = 1; m <= 12; m++) {
        const row = featureRow(input, ibge, y, m);
        const obs = observed(input, ibge, y, m);
        if (!row || obs === null) continue;
        train.push({ x: row.x, target: obs, ibge, month: m });
        if (y > trainMaxYear) trainMaxYear = y;
      }
    }
  }
  if (trainMaxYear > o.trainTo) throw new Error('Training rows leaked past trainTo');
  const model = trainModel(train);

  // Threshold of "month above P90" per municipality-month, from the training years only.
  const thresholds = new Map<string, number>();
  for (const ibge of ibges) for (let m = 1; m <= 12; m++) thresholds.set(`${ibge}:${m}`, exceedThreshold(input, ibge, m, o.trainTo).threshold);
  const calibrator = fitExceedCalibrator(
    train.map((r) => {
      const t = thresholds.get(`${r.ibge}:${r.month}`)!;
      return { margin: predictWithModel(model, r.x).predLog - r.x[0]!, event: r.target > t ? 1 : 0 };
    })
  );

  const abs = { model: 0, climatology: 0, persistence: 0 };
  const absDry = { model: 0, climatology: 0, persistence: 0 };
  const brier = { model: 0, climatology: 0, persistence: 0 };
  const cover = { model: 0, climatology: 0 };
  const bins = CALIBRATION_EDGES.slice(0, -1).map(() => ({ n: 0, pred: 0, hit: 0 }));
  const binsClim = CALIBRATION_EDGES.slice(0, -1).map(() => ({ n: 0, pred: 0, hit: 0 }));
  let n = 0;
  let nDry = 0;
  let events = 0;
  let oniMissing = 0;
  let absMedian = 0;

  for (const ibge of ibges) {
    for (let y = o.testFrom; y <= Math.min(o.testTo, input.lastYear); y++) {
      for (let m = 1; m <= 12; m++) {
        const row = featureRow(input, ibge, y, m);
        const obs = observed(input, ibge, y, m);
        if (!row || obs === null) continue;
        const pm = predictWithModel(model, row.x);
        const t = thresholds.get(`${ibge}:${m}`)!;
        const event = obs > t ? 1 : 0;
        const pModel = exceedProbability(calibrator, pm.predLog - row.x[0]!);
        const pClim = row.past.filter((v) => v > t).length / row.past.length;
        const pPers = row.persistence > t ? 1 : 0;

        n++;
        events += event;
        if (row.oniMissing) oniMissing++;
        abs.model += Math.abs(pm.value - obs);
        abs.climatology += Math.abs(row.climatology - obs);
        abs.persistence += Math.abs(row.persistence - obs);
        absMedian += Math.abs(quantile(row.past, 0.5) - obs);
        if (m >= 5 && m <= 10) {
          nDry++;
          absDry.model += Math.abs(pm.value - obs);
          absDry.climatology += Math.abs(row.climatology - obs);
          absDry.persistence += Math.abs(row.persistence - obs);
        }
        brier.model += (pModel - event) ** 2;
        brier.climatology += (pClim - event) ** 2;
        brier.persistence += (pPers - event) ** 2;
        if (obs >= pm.p10 && obs <= pm.p90) cover.model++;
        if (obs >= row.climP10 && obs <= row.climP90) cover.climatology++;
        const b = CALIBRATION_EDGES.findIndex((e, i) => pModel >= e && pModel < CALIBRATION_EDGES[i + 1]!);
        const bin = bins[b];
        if (bin) {
          bin.n++;
          bin.pred += pModel;
          bin.hit += event;
        }
        const binC = binsClim[CALIBRATION_EDGES.findIndex((e, i) => pClim >= e && pClim < CALIBRATION_EDGES[i + 1]!)];
        if (binC) {
          binC.n++;
          binC.pred += pClim;
          binC.hit += event;
        }
      }
    }
  }
  if (!n) throw new Error('No test rows: is the test period loaded?');

  const mae = { model: round(abs.model / n, 3), climatology: round(abs.climatology / n, 3), persistence: round(abs.persistence / n, 3) };
  const toCalibration = (src: typeof bins) => src
    .map((b, i) => ({
      bin: `${Math.round(CALIBRATION_EDGES[i]! * 100)}-${Math.round(Math.min(1, CALIBRATION_EDGES[i + 1]!) * 100)}%`,
      n: b.n,
      meanPredictedPct: b.n ? round((b.pred / b.n) * 100, 1) : 0,
      observedPct: b.n ? round((b.hit / b.n) * 100, 1) : 0,
    }))
    .filter((b) => b.n > 0);
  const calibration = toCalibration(bins);
  const maeClimatologyMedian = round(absMedian / n, 3);
  // Official only if the model beats the climatology both as the mean (the baseline) and as the median (stricter).
  const official: 'model' | 'climatology' = mae.model < Math.min(mae.climatology, maeClimatologyMedian) ? 'model' : 'climatology';
  const brierOut = { model: round(brier.model / n, 4), climatology: round(brier.climatology / n, 4), persistence: round(brier.persistence / n, 4) };
  const oniKeys = [...input.oni.keys()];
  const lastOni = oniKeys.length
    ? oniKeys.reduce((a, b) => {
        const [ay, am] = a.split('-').map(Number);
        const [by, bm] = b.split('-').map(Number);
        return by! * 12 + bm! > ay! * 12 + am! ? b : a;
      })
    : null;

  return {
    computedAt: new Date().toISOString(),
    dataKind: o.dataKind,
    series: {
      firstYear: input.firstYear,
      lastYear: input.lastYear,
      municipalities: ibges.length,
      unit: 'harmonized hotspot cell-days (1 km) per municipality and month',
      viirsYears: o.viirsYears,
      factorYears: o.factorYears,
      source: o.source,
    },
    trainPeriod: { from: trainFrom, to: trainMaxYear, dataFrom: input.firstYear },
    testPeriod: { from: o.testFrom, to: Math.min(o.testTo, input.lastYear) },
    nTrain: train.length,
    nTest: n,
    features: [...FEATURE_NAMES],
    neighborsK: o.neighborsK,
    oni: { source: o.oniSource, lagMonths: ONI_LAG_MONTHS, lastMonth: lastOni, missingInTestPct: round((oniMissing / n) * 100, 1) },
    mae,
    maeDrySeason: {
      model: round(absDry.model / Math.max(1, nDry), 3),
      climatology: round(absDry.climatology / Math.max(1, nDry), 3),
      persistence: round(absDry.persistence / Math.max(1, nDry), 3),
    },
    maeClimatologyMedian,
    skillVsClimatologyPct: round((1 - mae.model / mae.climatology) * 100, 1),
    exceedance: {
      definition: `month above the P90 of the same month in ${input.firstYear}-${o.trainTo} for that municipality`,
      baseRateTestPct: round((events / n) * 100, 1),
      brier: brierOut,
      calibration,
      calibrationMaxGapPct: round(Math.max(...calibration.map((c) => Math.abs(c.meanPredictedPct - c.observedPct))), 1),
      calibrationClimatology: toCalibration(binsClim),
      official: official === 'model' && brierOut.model < brierOut.climatology ? 'model' : 'climatology',
      calibrator,
    },
    coverageP10P90Pct: { model: round((cover.model / n) * 100, 1), climatology: round((cover.climatology / n) * 100, 1) },
    official,
    officialReason:
      official === 'model'
        ? `model MAE ${mae.model} < climatology MAE ${mae.climatology} (mean) and ${maeClimatologyMedian} (median) on ${o.testFrom}-${Math.min(o.testTo, input.lastYear)}`
        : `model MAE ${mae.model} did not beat climatology MAE ${mae.climatology} (mean) / ${maeClimatologyMedian} (median) on ${o.testFrom}-${Math.min(o.testTo, input.lastYear)}: climatology is the official forecast`,
    model,
    notes: o.notes ?? [],
  };
}

/* ---------------- one forecast ---------------- */

export interface ForecastOutput {
  ibge: string;
  year: number;
  month: number;
  method: 'model' | 'climatology';
  value: number;
  p10: number;
  p90: number;
  probAboveP90Pct: number;
  /** 'model' = calibrated on training years; 'climatology' = share of previous years above the threshold. */
  probMethod: 'model' | 'climatology';
  probN: number;
  p90Threshold: number;
  thresholdN: number;
  thresholdPeriod: string;
  climatology: { mean: number; p10: number; p90: number; n: number; period: string };
  persistence: number | null;
  observed: number | null;
  flags: string[];
}

/**
 * Forecast of one municipality-month. Uses the official method of the validation; falls back to the climatology when
 * the model cannot be fed (target more than one year past the last loaded year). Null = no data for that place/month.
 */
export function forecastOne(input: ForecastInput, v: ForecastValidation, ibge: string, y: number, m: number): ForecastOutput | null {
  if (!input.series.has(ibge)) return null;
  const past = pastSameMonth(input, ibge, y, m);
  if (past.length < 2) return null;
  const { threshold, n: thresholdN } = exceedThreshold(input, ibge, m, v.trainPeriod.to);
  const flags: string[] = [];
  const row = featureRow(input, ibge, y, m);

  let method: 'model' | 'climatology' = v.official;
  const climProb = past.filter((x) => x > threshold).length / past.length;
  if (method === 'model' && !row) {
    method = 'climatology';
    flags.push('model_not_applicable_beyond_one_year_after_last_loaded_year');
  }
  let value: number;
  let p10: number;
  let p90: number;
  let prob: number;
  if (method === 'model' && row) {
    const pm = predictWithModel(v.model, row.x);
    value = pm.value;
    p10 = pm.p10;
    p90 = pm.p90;
    prob = v.exceedance.official === 'model' ? exceedProbability(v.exceedance.calibrator, pm.predLog - row.x[0]!) : climProb;
    if (row.oniMissing) flags.push('oni_not_available_for_this_month_assumed_neutral');
  } else {
    value = mean(past);
    p10 = quantile(past, 0.1);
    p90 = quantile(past, 0.9);
    prob = climProb;
  }
  return {
    ibge,
    year: y,
    month: m,
    method,
    value: round(value),
    p10: round(Math.min(p10, value)),
    p90: round(Math.max(p90, value)),
    probAboveP90Pct: round(prob * 100, 0),
    probMethod: method === 'model' && v.exceedance.official === 'model' ? 'model' : 'climatology',
    probN: method === 'model' && v.exceedance.official === 'model' ? v.nTrain : past.length,
    p90Threshold: round(threshold),
    thresholdN,
    thresholdPeriod: `${input.firstYear}-${v.trainPeriod.to}`,
    climatology: {
      mean: round(mean(past)),
      p10: round(quantile(past, 0.1)),
      p90: round(quantile(past, 0.9)),
      n: past.length,
      period: `${input.firstYear}-${Math.min(y - 1, input.lastYear)}`,
    },
    persistence: observed(input, ibge, y - 1, m),
    observed: observed(input, ibge, y, m),
    flags,
  };
}

/** k nearest municipalities by centroid (equirectangular distance is enough inside one state). */
export function nearestNeighbors(points: readonly { ibge: string; lat: number; lon: number }[], kNearest: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of points) {
    const cos = Math.cos((a.lat * Math.PI) / 180);
    const d = points
      .filter((b) => b.ibge !== a.ibge)
      .map((b) => ({ ibge: b.ibge, d: ((b.lon - a.lon) * cos) ** 2 + (b.lat - a.lat) ** 2 }))
      .sort((p, q) => p.d - q.d)
      .slice(0, kNearest)
      .map((b) => b.ibge);
    out.set(a.ibge, d);
  }
  return out;
}
