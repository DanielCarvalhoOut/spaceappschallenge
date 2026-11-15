/**
 * Harmonization error from the real FIRMS cell index, one entry per link of the satellite chain
 * (MODIS→S-NPP calibrated 2012–2019 / tested 2020–2025; NOAA-20→S-NPP 2018–2023 / 2024–2025; NOAA-21→S-NPP
 * 2023–2025 / 2026). The top-level fields repeat the MODIS link (the one the challenge asks about), plus the
 * municipal spread of its error (WAPE where the test period has ≥ 50 cell-days; median and p90).
 */
import { buildChain, monthlyRowsByMunicipality, type CellIndex, type LinkValidation } from './cell-index.js';

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
  links: LinkValidation[];
}

function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function computeIndexValidation(index: CellIndex): IndexValidation {
  const chain = buildChain(index);
  const modis = chain.links.find((l) => l.link === 'MODIS→SNPP') ?? null;
  const f = modis?.monthlyFactors ?? [];

  const wapes: number[] = [];
  for (const rows of monthlyRowsByMunicipality(index).values()) {
    let abs = 0, act = 0;
    for (const r of rows) {
      if (r.year < 2020 || r.year > 2025 || r.viirs === null) continue;
      const fm = f[r.month - 1];
      if (fm === null || fm === undefined) continue;
      abs += Math.abs(r.modis * fm - r.viirs);
      act += r.viirs;
    }
    if (act >= 50) wapes.push((abs / act) * 100);
  }
  wapes.sort((a, b) => a - b);
  const r1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);
  return {
    computedAt: new Date().toISOString(),
    source: 'firms_index',
    calibrationPeriod: modis?.calibrationPeriod ?? '2012-2019',
    testPeriod: modis?.testPeriod ?? '2020-2025',
    method: 'monthly_ratio chain to the VIIRS S-NPP scale (cell-days, 1 km grid, static sources removed)',
    mapePct: modis?.mapePct ?? null,
    wapePct: modis?.wapePct ?? null,
    pearsonR: modis?.pearsonR ?? null,
    biasPct: modis?.biasPct ?? null,
    nMonths: modis?.nMonths ?? 0,
    municipalities: { n: wapes.length, medianWapePct: r1(quantile(wapes, 0.5)), p90WapePct: r1(quantile(wapes, 0.9)) },
    monthlyRatioFactors: modis?.monthlyFactors ?? [],
    links: chain.links,
  };
}
