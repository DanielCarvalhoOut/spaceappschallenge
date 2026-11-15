/**
 * Projection with a validated uncertainty band — one daily model for every horizon.
 *
 * Model: negative binomial count regression (log link) on the daily harmonized cell-days of an area:
 *   log μ_t = β0 + β1 sin ω_t + β2 cos ω_t + β3 sin 2ω_t + β4 cos 2ω_t      (season; ω = 2π · day-of-year / 365.25)
 *           + β5 log1p(y_{t−1}) + β6 log1p(mean y_{t−7..t−1}) + β7 log1p(mean y_{t−30..t−1})   (memory)
 * (count-regression family used for fire occurrence on 1 km-day cells, e.g. Preisler et al. 2004).
 * β by Poisson IRLS (quasi-likelihood), dispersion θ by moments: Var = μ + μ²/θ.
 *
 * Horizons come from simulating N daily paths forward (gamma–Poisson draws, each day feeding the next day's memory)
 * and summing them: next days (probability of any fire), 15 days, calendar months, 183 days. Sums of the same paths
 * keep the horizons coherent (the days add up to the month).
 *
 * Validation (hindcast): coefficients fitted on data up to 2014, origins on the 1st (and 16th) of each month in
 * 2015–2025. The band is calibrated on the 2015–2020 origins (smallest widening on the log1p scale that puts 80 % of
 * the observations inside P10–P90) and then scored only on the 2021–2025 origins, which neither the coefficients nor
 * the calibration saw: CRPS skill vs the climatological reference (the same calendar window in every earlier year)
 * for sums, Brier skill for next-day fire, and P10–P90 coverage. A horizon is published only when its skill is > 0.
 */

const DAY = 86_400_000;
const FEATURES = ['intercept', 'sin1', 'cos1', 'sin2', 'cos2', 'log1p_lag1', 'log1p_mean7', 'log1p_mean30'] as const;
const P = FEATURES.length;

export interface DailyInput { first: number; values: Array<number | null> } // day numbers since 1970

export interface FittedModel { beta: number[]; theta: number; trainedUntil: number; nTrain: number }

const doyOf = (d: number): number => {
  const dt = new Date(d * DAY);
  return (Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - Date.UTC(dt.getUTCFullYear(), 0, 1)) / DAY;
};

/** Lag summaries from a values getter (null = not observed). Missing days are skipped in the means. */
function lags(get: (d: number) => number | null, t: number): [number, number, number] | null {
  let s7 = 0, n7 = 0, s30 = 0, n30 = 0;
  for (let k = 1; k <= 30; k++) {
    const v = get(t - k);
    if (v === null) continue;
    s30 += v; n30++;
    if (k <= 7) { s7 += v; n7++; }
  }
  if (n30 < 10) return null;
  const m30 = s30 / n30, m7 = n7 ? s7 / n7 : m30;
  const y1 = get(t - 1);
  return [y1 === null ? m7 : y1, m7, m30];
}

function features(t: number, l: [number, number, number]): number[] {
  const w = (2 * Math.PI * doyOf(t)) / 365.25;
  return [1, Math.sin(w), Math.cos(w), Math.sin(2 * w), Math.cos(2 * w), Math.log1p(l[0]), Math.log1p(l[1]), Math.log1p(l[2])];
}

/** Solves A x = b (P×P, symmetric positive definite after the ridge) by Gaussian elimination with pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]!;
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / piv;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

/** Fits β (Poisson IRLS) and θ on the observed days up to `until` (inclusive). */
export function fitModel(input: DailyInput, until: number): FittedModel | null {
  const get = (d: number): number | null => { const k = d - input.first; return k < 0 || k >= input.values.length ? null : input.values[k] ?? null; };
  const X: number[][] = [], y: number[] = [];
  const last = Math.min(until, input.first + input.values.length - 1);
  for (let t = input.first + 30; t <= last; t++) {
    const v = get(t);
    if (v === null) continue;
    const l = lags(get, t);
    if (!l) continue;
    X.push(features(t, l)); y.push(v);
  }
  if (y.length < 365) return null;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  let beta = new Array<number>(P).fill(0);
  beta[0] = Math.log(Math.max(meanY, 1e-3));
  for (let it = 0; it < 30; it++) {
    const A = Array.from({ length: P }, () => new Array<number>(P).fill(0));
    const b = new Array<number>(P).fill(0);
    for (let i = 0; i < y.length; i++) {
      const xi = X[i]!;
      let eta = 0; for (let j = 0; j < P; j++) eta += xi[j]! * beta[j]!;
      eta = Math.max(-20, Math.min(12, eta));
      const mu = Math.exp(eta);
      const z = eta + (y[i]! - mu) / mu;
      for (let j = 0; j < P; j++) {
        b[j]! += mu * xi[j]! * z;
        for (let k = j; k < P; k++) A[j]![k]! += mu * xi[j]! * xi[k]!;
      }
    }
    for (let j = 0; j < P; j++) { A[j]![j]! += 1e-6; for (let k = 0; k < j; k++) A[j]![k] = A[k]![j]!; }
    const next = solve(A, b);
    const delta = Math.max(...next.map((v, j) => Math.abs(v - beta[j]!)));
    beta = next;
    if (delta < 1e-7) break;
  }
  let sMu2 = 0, sExcess = 0;
  for (let i = 0; i < y.length; i++) {
    let eta = 0; for (let j = 0; j < P; j++) eta += X[i]![j]! * beta[j]!;
    const mu = Math.exp(Math.max(-20, Math.min(12, eta)));
    sMu2 += mu * mu; sExcess += (y[i]! - mu) ** 2 - mu;
  }
  const theta = sExcess > 0 ? Math.max(0.05, Math.min(1000, sMu2 / sExcess)) : 1000;
  return { beta, theta, trainedUntil: last, nTrain: y.length };
}

/* ---------------- simulation ---------------- */

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Gamma(shape k, scale 1) — Marsaglia & Tsang. */
function gamma(k: number, r: () => number): number {
  if (k < 1) return gamma(k + 1, r) * Math.pow(r(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = normal(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function poisson(lambda: number, r: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(r)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

/** N daily paths of length H starting the day after `origin`, conditioned on the observed values up to `origin`. */
export function simulate(model: FittedModel, input: DailyInput, origin: number, H: number, N: number, seed = 20261115): Float64Array[] {
  const r = mulberry32(seed);
  const hist: Array<number | null> = [];
  for (let k = 30; k >= 1; k--) {
    const d = origin + 1 - k, i = d - input.first;
    hist.push(i < 0 || i >= input.values.length ? null : input.values[i] ?? null);
  }
  const paths: Float64Array[] = [];
  for (let n = 0; n < N; n++) {
    const window = hist.slice(); // last 30 days (oldest first)
    const path = new Float64Array(H);
    for (let h = 0; h < H; h++) {
      const t = origin + 1 + h;
      const get = (d: number): number | null => window[window.length - (t - d)] ?? null;
      const l = lags(get, t) ?? [0, 0, 0];
      const x = features(t, l);
      let eta = 0; for (let j = 0; j < P; j++) eta += x[j]! * model.beta[j]!;
      const mu = Math.exp(Math.max(-20, Math.min(12, eta)));
      const lam = model.theta >= 1000 ? mu : gamma(model.theta, r) * (mu / model.theta);
      const v = poisson(lam, r);
      path[h] = v;
      window.push(v); window.shift();
    }
    paths.push(path);
  }
  return paths;
}

/* ---------------- scores ---------------- */

const quantile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};
/** CRPS of an ensemble: mean|X − y| − ½ mean|X − X'| (Gneiting & Raftery 2007). */
export function crps(ensemble: number[], y: number): number {
  const xs = ensemble.slice().sort((a, b) => a - b), n = xs.length;
  if (!n) return Number.NaN;
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) { a += Math.abs(xs[i]! - y); b += (2 * i - n + 1) * xs[i]!; }
  return a / n - b / (n * n);
}

/** Sum of the observed values in [from, to] (inclusive), or null when more than 20 % of the days are missing. */
function windowSum(input: DailyInput, from: number, to: number): number | null {
  let s = 0, miss = 0;
  for (let d = from; d <= to; d++) {
    const i = d - input.first;
    const v = i < 0 || i >= input.values.length ? null : input.values[i] ?? null;
    if (v === null) miss++; else s += v;
  }
  return miss > 0.2 * (to - from + 1) ? null : s;
}

/** Same calendar window in every earlier year (2002 or later) with data: the climatological reference ensemble. */
function climatology(input: DailyInput, from: number, to: number): number[] {
  const f = new Date(from * DAY), out: number[] = [];
  for (let y = 2002; y < f.getUTCFullYear(); y++) {
    const shift = Date.UTC(y, f.getUTCMonth(), f.getUTCDate()) / DAY - from;
    const s = windowSum(input, from + shift, to + shift);
    if (s !== null) out.push(s);
  }
  return out;
}

const band = (xs: number[]): { p10: number; p50: number; p90: number } => {
  const s = xs.slice().sort((a, b) => a - b);
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  return { p10: r1(quantile(s, 0.1)), p50: r1(quantile(s, 0.5)), p90: r1(quantile(s, 0.9)) };
};

/* ---------------- hindcast ---------------- */

export interface HorizonSkill {
  n: number;                    // test cases (origins in 2021–2025)
  skillPct: number | null;      // CRPS skill vs climatology on the test origins, with the calibrated band
  coveragePct: number | null;   // share of test cases inside the calibrated P10–P90 (target 80 %)
  rawCoveragePct: number | null;// same, before calibration (the model's own spread)
  widen: number;                // band calibration factor on the log1p scale (1 = none), fitted on 2015–2020 origins
  published: boolean;
}
export interface Hindcast {
  period: string;
  trainedUntil: string;
  calibrationPeriod: string;
  testPeriod: string;
  horizons: { day1: HorizonSkill; fortnight: HorizonSkill; month: HorizonSkill; semester: HorizonSkill };
}
export type Widen = { fortnight: number; month: number; semester: number };

const HORIZON_DAYS = { fortnight: 15, month: 30, semester: 183 } as const;
const CAL_LAST_YEAR = 2020; // band calibration on origins 2015–2020, scoring on 2021–2025
const WIDEN_GRID = Array.from({ length: 41 }, (_, i) => 1 + i * 0.1); // 1.0 … 5.0
const TARGET_COVERAGE = 0.8;

/**
 * Calibrated ensemble: each member moved away from the median by `k` on the log1p scale. k = 1 is the raw model.
 * Keeps the median, keeps members ≥ 0 and widens both tails in proportion to the model's own spread.
 */
export function widenEnsemble(ens: number[], k: number): number[] {
  if (k === 1) return ens;
  const lm = Math.log1p(quantile(ens.slice().sort((a, b) => a - b), 0.5));
  return ens.map((x) => Math.max(0, Math.expm1(lm + k * (Math.log1p(Math.max(0, x)) - lm))));
}

export function hindcast(input: DailyInput, opts: { paths: number; twicePerMonth: boolean }): Hindcast | null {
  const until = Date.UTC(2014, 11, 31) / DAY;
  const model = fitModel(input, until);
  if (!model) return null;
  const lastDay = input.first + input.values.length - 1;
  type Case = { year: number; ens: number[]; clim: number[]; obs: number };
  const cases: Record<keyof typeof HORIZON_DAYS, Case[]> = { fortnight: [], month: [], semester: [] };
  let bsM = 0, bsC = 0, nB = 0;
  for (let y = 2015; y <= 2025; y++) {
    for (let mo = 0; mo < 12; mo++) {
      for (const dom of opts.twicePerMonth ? [1, 16] : [1]) {
        const origin = Date.UTC(y, mo, dom) / DAY - 1; // forecast starts on day `dom`
        if (origin + HORIZON_DAYS.semester > lastDay) continue;
        const paths = simulate(model, input, origin, HORIZON_DAYS.semester, opts.paths, origin);
        for (const [k, H] of Object.entries(HORIZON_DAYS) as Array<[keyof typeof HORIZON_DAYS, number]>) {
          const obs = windowSum(input, origin + 1, origin + H);
          const clim = climatology(input, origin + 1, origin + H);
          if (obs === null || clim.length < 5) continue;
          const ens = paths.map((p) => { let s = 0; for (let h = 0; h < H; h++) s += p[h]!; return s; });
          cases[k].push({ year: y, ens, clim, obs });
        }
        // next day: probability of any fire vs the climatological frequency (same day ±3 in earlier years); test years only
        const yObs = input.values[origin + 1 - input.first];
        if (y > CAL_LAST_YEAR && yObs !== null && yObs !== undefined) {
          const pM = paths.filter((p) => p[0]! > 0).length / paths.length;
          let hit = 0, tot = 0;
          const o = new Date((origin + 1) * DAY);
          for (let yy = 2002; yy < o.getUTCFullYear(); yy++) {
            const c = Date.UTC(yy, o.getUTCMonth(), o.getUTCDate()) / DAY;
            for (let k = -3; k <= 3; k++) {
              const v = input.values[c + k - input.first];
              if (v === null || v === undefined) continue;
              tot++; if (v > 0) hit++;
            }
          }
          if (tot >= 20) {
            const pC = hit / tot, e = yObs > 0 ? 1 : 0;
            bsM += (pM - e) ** 2; bsC += (pC - e) ** 2; nB++;
          }
        }
      }
    }
  }
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const coverage = (cs: Case[], k: number): number => {
    if (!cs.length) return Number.NaN;
    let inside = 0;
    for (const c of cs) { const b = band(widenEnsemble(c.ens, k)); if (c.obs >= b.p10 && c.obs <= b.p90) inside++; }
    return inside / cs.length;
  };
  const score = (cs: Case[]): HorizonSkill => {
    const cal = cs.filter((c) => c.year <= CAL_LAST_YEAR), test = cs.filter((c) => c.year > CAL_LAST_YEAR);
    // smallest widening that reaches the target coverage on the calibration origins (never fitted on the test years)
    const widen = cal.length ? (WIDEN_GRID.find((k) => coverage(cal, k) >= TARGET_COVERAGE) ?? WIDEN_GRID[WIDEN_GRID.length - 1]!) : 1;
    let m = 0, c = 0;
    for (const t of test) { m += crps(widenEnsemble(t.ens, widen), t.obs); c += crps(t.clim, t.obs); }
    const skill = test.length && c > 0 ? r1((1 - m / c) * 100) : null;
    return {
      n: test.length, skillPct: skill,
      coveragePct: test.length ? r1(coverage(test, widen) * 100) : null,
      rawCoveragePct: test.length ? r1(coverage(test, 1) * 100) : null,
      widen: r1(widen * 10) / 10, published: skill !== null && skill > 0,
    };
  };
  const day1Skill = nB && bsC > 0 ? r1((1 - bsM / bsC) * 100) : null;
  return {
    period: '2015–2025',
    trainedUntil: new Date(model.trainedUntil * DAY).toISOString().slice(0, 10),
    calibrationPeriod: `2015–${CAL_LAST_YEAR}`,
    testPeriod: `${CAL_LAST_YEAR + 1}–2025`,
    horizons: {
      day1: { n: nB, skillPct: day1Skill, coveragePct: null, rawCoveragePct: null, widen: 1, published: day1Skill !== null && day1Skill > 0 },
      fortnight: score(cases.fortnight),
      month: score(cases.month),
      semester: score(cases.semester),
    },
  };
}

/* ---------------- projection from today ---------------- */

export interface Projection {
  asOf: string;
  unit: string;
  model: { family: string; features: readonly string[]; theta: number; trainedUntil: string; nTrain: number };
  daily: Array<{ date: string; pAnyPct: number; p50: number; p90: number }>;
  fortnight: { from: string; to: string; p10: number; p50: number; p90: number; climatology: { p10: number; p50: number; p90: number } | null };
  months: Array<{ year: number; month: number; observedSoFar: number; p10: number; p50: number; p90: number; partial: boolean; climatology: { p10: number; p50: number; p90: number } | null }>;
  semester: { from: string; to: string; p10: number; p50: number; p90: number; climatology: { p10: number; p50: number; p90: number } | null };
}

export function projectFrom(input: DailyInput, paths = 500, widen: Widen = { fortnight: 1, month: 1, semester: 1 }): Projection | null {
  const lastDay = input.first + input.values.length - 1;
  let origin = lastDay;
  while (origin > input.first && (input.values[origin - input.first] ?? null) === null) origin--;
  const model = fitModel(input, origin);
  if (!model) return null;
  const H = 183;
  const sims = simulate(model, input, origin, H, paths);
  const iso = (d: number): string => new Date(d * DAY).toISOString().slice(0, 10);
  const r1 = (v: number): number => Math.round(v * 10) / 10;

  const daily = Array.from({ length: 15 }, (_, h) => {
    const xs = sims.map((p) => p[h]!).sort((a, b) => a - b);
    return { date: iso(origin + 1 + h), pAnyPct: r1((xs.filter((v) => v > 0).length / xs.length) * 100), p50: r1(quantile(xs, 0.5)), p90: r1(quantile(xs, 0.9)) };
  });
  const sumH = (h0: number, h1: number): number[] => sims.map((p) => { let s = 0; for (let h = h0; h <= h1; h++) s += p[h]!; return s; });
  const climBand = (from: number, to: number): { p10: number; p50: number; p90: number } | null => {
    const c = climatology(input, from, to);
    return c.length >= 5 ? band(c) : null;
  };

  const months: Projection['months'] = [];
  const o = new Date((origin + 1) * DAY);
  for (let k = 0; k < 6; k++) {
    const y = o.getUTCFullYear() + Math.floor((o.getUTCMonth() + k) / 12), m = (o.getUTCMonth() + k) % 12;
    const d0 = Date.UTC(y, m, 1) / DAY, d1 = Date.UTC(y, m + 1, 1) / DAY - 1;
    const h0 = Math.max(0, d0 - origin - 1), h1 = Math.min(H - 1, d1 - origin - 1);
    if (h1 < h0) continue;
    const observed = k === 0 ? windowSum({ first: input.first, values: input.values }, d0, origin) ?? 0 : 0;
    // remaining days widened by the month calibration, then the days already observed added back
    const b = band(widenEnsemble(sumH(h0, h1), widen.month).map((v) => v + observed));
    months.push({ year: y, month: m + 1, observedSoFar: r1(observed), ...b, partial: k === 0 && d0 <= origin, climatology: climBand(d0, d1) });
  }
  return {
    asOf: iso(origin),
    unit: 'cell-days (VIIRS S-NPP scale)',
    model: { family: 'negative binomial, log link (Poisson IRLS + moment dispersion)', features: FEATURES, theta: r1(model.theta), trainedUntil: iso(model.trainedUntil), nTrain: model.nTrain },
    daily,
    fortnight: { from: iso(origin + 1), to: iso(origin + 15), ...band(widenEnsemble(sumH(0, 14), widen.fortnight)), climatology: climBand(origin + 1, origin + 15) },
    months,
    semester: { from: iso(origin + 1), to: iso(origin + H), ...band(widenEnsemble(sumH(0, H - 1), widen.semester)), climatology: climBand(origin + 1, origin + H) },
  };
}
