/**
 * Harmonization error from the real FIRMS cell index (same protocol as fire.validate_harmonization in PostGIS):
 * monthly VIIRS ÷ MODIS factor calibrated on 2012–2019, applied to MODIS in 2020–2025 and compared with the actual
 * VIIRS S-NPP cell-days. State: WAPE, MAPE (months with ≥ 10), Pearson r, bias. Municipalities: factor shrunk toward
 * the state's (w = MODIS / (MODIS + 30)), WAPE where the test period has ≥ 50 cell-days; median and p90.
 */
import { monthlyCountsByMunicipality, type CellIndex } from './cell-index.js';

export interface IndexValidation {
  computedAt: string;
  source: 'firms_index';
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

const CAL = [2012, 2019] as const;
const TEST = [2020, 2025] as const;
const K = 30;
const r1 = (v: number): number => Math.round(v * 10) / 10;

function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function computeIndexValidation(index: CellIndex): IndexValidation {
  const byMuni = monthlyCountsByMunicipality(index);
  const viirsYears = new Set(index.yearsLoaded.VIIRS);
  const modisYears = new Set(index.yearsLoaded.MODIS);
  const both = (y: number): boolean => viirsYears.has(y) && modisYears.has(y);

  // State totals per year-month
  const state = new Map<string, { m: number; v: number }>();
  for (const months of byMuni.values()) {
    for (const [k, c] of months) {
      const cur = state.get(k) ?? { m: 0, v: 0 };
      cur.m += c.modis; cur.v += c.viirs;
      state.set(k, cur);
    }
  }
  const get = (map: Map<string, { m: number; v: number }> | Map<string, { modis: number; viirs: number }>, y: number, m: number): { m: number; v: number } => {
    const c = map.get(`${y}-${m}`) as { m?: number; v?: number; modis?: number; viirs?: number } | undefined;
    return { m: c?.m ?? c?.modis ?? 0, v: c?.v ?? c?.viirs ?? 0 };
  };

  const ufFactor: (number | null)[] = [];
  for (let m = 1; m <= 12; m++) {
    let sm = 0, sv = 0;
    for (let y = CAL[0]; y <= CAL[1]; y++) if (both(y)) { const c = get(state, y, m); sm += c.m; sv += c.v; }
    ufFactor.push(sm > 0 ? sv / sm : null);
  }

  const pred: number[] = [], act: number[] = [];
  for (let y = TEST[0]; y <= TEST[1]; y++) {
    if (!both(y)) continue;
    for (let m = 1; m <= 12; m++) {
      const f = ufFactor[m - 1];
      if (f === null || f === undefined) continue;
      const c = get(state, y, m);
      pred.push(c.m * f); act.push(c.v);
    }
  }
  const sumA = act.reduce((a, b) => a + b, 0), sumP = pred.reduce((a, b) => a + b, 0);
  const sumAbs = act.reduce((a, v, i) => a + Math.abs(pred[i]! - v), 0);
  const mapeTerms = act.map((v, i) => (v >= 10 ? Math.abs(pred[i]! - v) / v : null)).filter((x): x is number => x !== null);
  const n = act.length;
  let r: number | null = null;
  if (n >= 3) {
    const ma = sumA / n, mp = sumP / n;
    let cov = 0, va = 0, vp = 0;
    for (let i = 0; i < n; i++) { cov += (act[i]! - ma) * (pred[i]! - mp); va += (act[i]! - ma) ** 2; vp += (pred[i]! - mp) ** 2; }
    r = va > 0 && vp > 0 ? Math.round((cov / Math.sqrt(va * vp)) * 1000) / 1000 : null;
  }

  const muniWape: number[] = [];
  for (const months of byMuni.values()) {
    let pa = 0, aa = 0, abs = 0;
    for (let m = 1; m <= 12; m++) {
      const uf = ufFactor[m - 1];
      if (uf === null || uf === undefined) continue;
      let sm = 0, sv = 0;
      for (let y = CAL[0]; y <= CAL[1]; y++) if (both(y)) { const c = get(months, y, m); sm += c.m; sv += c.v; }
      const w = sm / (sm + K);
      const f = sm > 0 ? w * (sv / sm) + (1 - w) * uf : uf;
      for (let y = TEST[0]; y <= TEST[1]; y++) {
        if (!both(y)) continue;
        const c = get(months, y, m);
        const p = c.m * f;
        pa += p; aa += c.v; abs += Math.abs(p - c.v);
      }
    }
    if (aa >= 50) muniWape.push((abs / aa) * 100);
  }
  muniWape.sort((a, b) => a - b);
  const med = quantile(muniWape, 0.5), p90 = quantile(muniWape, 0.9);

  return {
    computedAt: new Date().toISOString(),
    source: 'firms_index',
    calibrationPeriod: `${CAL[0]}-${CAL[1]}`,
    testPeriod: `${TEST[0]}-${TEST[1]}`,
    method: 'monthly_ratio (VIIRS S-NPP ÷ MODIS cell-days, 1 km grid, static sources removed)',
    mapePct: mapeTerms.length ? r1((mapeTerms.reduce((a, b) => a + b, 0) / mapeTerms.length) * 100) : null,
    wapePct: sumA > 0 ? r1((sumAbs / sumA) * 100) : null,
    pearsonR: r,
    biasPct: sumA > 0 ? r1(((sumP - sumA) / sumA) * 100) : null,
    nMonths: n,
    municipalities: { n: muniWape.length, medianWapePct: med === null ? null : r1(med), p90WapePct: p90 === null ? null : r1(p90) },
    monthlyRatioFactors: ufFactor.map((f) => (f === null ? null : Math.round(f * 1000) / 1000)),
  };
}
