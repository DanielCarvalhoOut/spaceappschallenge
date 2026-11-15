/**
 * job:validate — proves the numbers two ways and writes the evidence to out/:
 *
 * Internal (out/internal_checks.json, out/projection_validation.json)
 *   1. Each satellite link of the chain, out of sample (MODIS→S-NPP, NOAA-20→S-NPP, NOAA-21→S-NPP).
 *   2. Bookkeeping: the 246 municipalities add up to the state, month by month.
 *   3. Projection: daily model fitted ≤ 2014, band calibrated on 2015–2020, scored on 2021–2025.
 *
 * External (out/external_validation.json) — INPE Programa Queimadas, reference satellite (AQUA, MODIS afternoon):
 *   an independent processing chain (INPE's own detections, state attribution and counting).
 *   - monthly and annual agreement (Pearson on log1p, Spearman on years), 2003 to the last complete month;
 *   - anomaly agreement: same sign of the monthly z-score when INPE marks an unusual month (|z| ≥ 1);
 *   - 2026, when the series already runs on NOAA-20/21 (S-NPP ended): ratio to INPE vs the same months in 2013–2025.
 * INPE is validation, never an input: nothing here changes the harmonized series.
 *
 * Usage: tsx src/jobs/validate.ts [--inpe=path/to/snapshot.json]   (without --inpe it downloads INPE's JSON)
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { isMain } from '../core/entry.js';
import { buildChain, dailySeries, loadCellIndex, monthlyRows, monthlyRowsByMunicipality, withAnomaly, isoDay } from '../core/cell-index.js';
import { hindcast, projectFrom } from '../core/projection-model.js';
import { fetchInpeStateMonthly, InpeReferenceSchema, type InpeReference } from '../connectors/inpe-stats.js';

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function pearson(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i]! - ma) * (b[i]! - mb); saa += (a[i]! - ma) ** 2; sbb += (b[i]! - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
const ranks = (a: number[]): number[] => {
  const idx = a.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const r = new Array<number>(a.length);
  idx.forEach(([, i], k) => { r[i] = k + 1; });
  return r;
};
const spearman = (a: number[], b: number[]): number => pearson(ranks(a), ranks(b));
const median = (xs: number[]): number => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** z-score of each month against the same calendar month in 2003–2024. */
function zScores(rows: Array<{ year: number; month: number; v: number }>): Map<number, number> {
  const out = new Map<number, number>();
  for (let m = 1; m <= 12; m++) {
    const base = rows.filter((r) => r.month === m && r.year >= 2003 && r.year <= 2024).map((r) => r.v);
    if (base.length < 5) continue;
    const mu = base.reduce((s, x) => s + x, 0) / base.length;
    const sd = Math.sqrt(base.reduce((s, x) => s + (x - mu) ** 2, 0) / (base.length - 1));
    if (sd <= 0) continue;
    for (const r of rows) if (r.month === m) out.set(r.year * 100 + m, (r.v - mu) / sd);
  }
  return out;
}

export async function runValidate(inpePath?: string): Promise<void> {
  const index = loadCellIndex();
  if (!index) throw new Error('No FIRMS index: run the API once (it builds data/firms_goias_cells.json) or job:build-cell-index');
  const chain = buildChain(index);
  fs.mkdirSync(config.outDir, { recursive: true });
  const write = (name: string, obj: unknown): void => fs.writeFileSync(path.join(config.outDir, name), JSON.stringify(obj, null, 2));

  /* ---------------- internal ---------------- */
  const state = monthlyRows(index, () => true);
  const byMuni = monthlyRowsByMunicipality(index);
  let maxDiff = 0, months = 0;
  for (const s of state) {
    if (s.harmonized === null) continue;
    let sum = 0;
    for (const rows of byMuni.values()) { const r = rows.find((x) => x.year === s.year && x.month === s.month); sum += r?.harmonized ?? 0; }
    maxDiff = Math.max(maxDiff, Math.abs(sum - s.harmonized)); months++;
  }
  const input = dailySeries(index, () => true);
  const hc = hindcast(input, { paths: 200, twicePerMonth: true });
  const widen = hc ? { fortnight: hc.horizons.fortnight.widen, month: hc.horizons.month.widen, semester: hc.horizons.semester.widen } : undefined;
  const projection = projectFrom(input, 500, widen);
  const internal = {
    computedAt: new Date().toISOString(), source: 'firms_index', indexBuiltAt: index.builtAt,
    lastObservedDay: isoDay(chain.last), provisionalFrom: chain.provisionalFrom === null ? null : isoDay(chain.provisionalFrom),
    links: chain.links,
    // each municipal month is rounded to 0.1 cell-day, so the sum may differ from the state by at most 0.05 per municipality
    bookkeeping: { municipalities: byMuni.size, months, maxAbsDiffCellDays: r3(maxDiff), roundingBoundCellDays: r3(0.05 * byMuni.size), passed: maxDiff <= 0.05 * byMuni.size + 1e-9 },
    projection: hc,
  };
  write('internal_checks.json', internal);
  if (hc && projection) write('projection_validation.json', { computedAt: internal.computedAt, source: 'firms_index', region: 'Goiás (UF 52)', model: projection.model, hindcast: hc });

  /* ---------------- external: INPE reference satellite ---------------- */
  let inpe: InpeReference;
  if (inpePath) inpe = InpeReferenceSchema.parse(JSON.parse(fs.readFileSync(inpePath, 'utf8')));
  else {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60_000);
    try { inpe = await fetchInpeStateMonthly(52, ctrl.signal); } finally { clearTimeout(t); }
  }
  write('inpe_goias_reference.json', inpe);
  const inpeOf = new Map(inpe.rows.map((r) => [r.year * 100 + r.month, r.focos]));
  // complete months only: from 2003 (first full AQUA year) to the month before both series end
  const lastInpe = new Date(`${inpe.dataLimite}T00:00:00Z`), lastOurs = new Date(chain.last * 86_400_000);
  const endKey = Math.min(lastInpe.getUTCFullYear() * 100 + lastInpe.getUTCMonth() + 1, lastOurs.getUTCFullYear() * 100 + lastOurs.getUTCMonth() + 1); // exclusive (current, partial month)
  const pairs = state.filter((r) => r.year >= 2003 && r.year * 100 + r.month < endKey && r.harmonized !== null && inpeOf.has(r.year * 100 + r.month))
    .map((r) => ({ year: r.year, month: r.month, inpe: inpeOf.get(r.year * 100 + r.month)!, harm: r.harmonized!, modis: r.modis }));
  const lg = (xs: number[]): number[] => xs.map((x) => Math.log1p(x));
  const upTo2025 = pairs.filter((p) => p.year <= 2025);
  const years = [...new Set(upTo2025.map((p) => p.year))].filter((y) => upTo2025.filter((p) => p.year === y).length === 12);
  const annual = (k: 'inpe' | 'harm' | 'modis'): number[] => years.map((y) => upTo2025.filter((p) => p.year === y).reduce((s, p) => s + p[k], 0));
  const zI = zScores(pairs.map((p) => ({ year: p.year, month: p.month, v: p.inpe })));
  const zH = zScores(pairs.map((p) => ({ year: p.year, month: p.month, v: p.harm })));
  const unusual = pairs.filter((p) => Math.abs(zI.get(p.year * 100 + p.month) ?? 0) >= 1 && zH.has(p.year * 100 + p.month));
  const sameSign = unusual.filter((p) => Math.sign(zI.get(p.year * 100 + p.month)!) === Math.sign(zH.get(p.year * 100 + p.month)!)).length;
  const zPairs = pairs.filter((p) => zI.has(p.year * 100 + p.month) && zH.has(p.year * 100 + p.month));
  // 2026 runs on NOAA-20/21 after S-NPP: is its ratio to INPE the same as in earlier years for that month?
  const check2026 = pairs.filter((p) => p.year === 2026).map((p) => {
    const ref = pairs.filter((q) => q.month === p.month && q.year >= 2013 && q.year <= 2025 && q.inpe >= 20).map((q) => q.harm / q.inpe);
    const ratio = p.inpe > 0 ? p.harm / p.inpe : null;
    const lo = ref.length ? Math.min(...ref) : null, hi = ref.length ? Math.max(...ref) : null;
    return { month: p.month, inpeFocos: p.inpe, harmonizedCellDays: r1(p.harm), ratio: ratio === null ? null : r3(ratio),
      ratioMedian2013_2025: ref.length ? r3(median(ref)) : null, ratioRange2013_2025: lo === null ? null : [r3(lo), r3(hi!)],
      insideHistoricalRange: ratio !== null && lo !== null && ratio >= lo && ratio <= hi! };
  });
  const external = {
    computedAt: new Date().toISOString(), reference: { source: inpe.source, url: inpe.url, snapshot: inpe.snapshot, dataLimite: inpe.dataLimite },
    note: 'INPE counts AQUA afternoon detections (focos); Monitor Cinder counts harmonized 1 km cell-days on the VIIRS S-NPP scale. Units differ by design, so agreement is measured by correlation, ranking and anomaly sign, not by equality.',
    period: `${pairs[0] ? `${pairs[0].year}-${String(pairs[0].month).padStart(2, '0')}` : '–'} to ${pairs.length ? `${pairs[pairs.length - 1]!.year}-${String(pairs[pairs.length - 1]!.month).padStart(2, '0')}` : '–'}`,
    monthly: { n: pairs.length, pearsonLogHarmonized: r3(pearson(lg(pairs.map((p) => p.inpe)), lg(pairs.map((p) => p.harm)))), pearsonLogModisRaw: r3(pearson(lg(pairs.map((p) => p.inpe)), lg(pairs.map((p) => p.modis)))) },
    annual: { years: years.length, pearsonHarmonized: r3(pearson(annual('inpe'), annual('harm'))), spearmanHarmonized: r3(spearman(annual('inpe'), annual('harm'))), pearsonModisRaw: r3(pearson(annual('inpe'), annual('modis'))) },
    anomaly: { pearsonZ: r3(pearson(zPairs.map((p) => zI.get(p.year * 100 + p.month)!), zPairs.map((p) => zH.get(p.year * 100 + p.month)!))), unusualMonthsInpe: unusual.length, sameSign, sameSignPct: unusual.length ? r1((sameSign / unusual.length) * 100) : null },
    year2026: check2026,
  };
  write('external_validation.json', external);
  logger.info({ internal: internal.bookkeeping, external: { monthly: external.monthly, annual: external.annual, anomaly: external.anomaly } }, 'job:validate written to out/');
}

if (isMain(import.meta.url)) {
  const arg = process.argv.find((a) => a.startsWith('--inpe='))?.split('=')[1];
  runValidate(arg).catch((err) => { logger.error({ err: err instanceof Error ? err.message : String(err) }, 'job:validate failed'); process.exit(1); });
}
