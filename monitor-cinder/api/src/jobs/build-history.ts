/**
 * job:build-history — from loaded FIRMS hotspots to every number the app and the pitch use.
 *
 *  1. 1 km grid (MODIS + VIIRS) and 500 m VIIRS grid          → REFRESH MATERIALIZED VIEW
 *  2. static heat sources (industry, mills)                   → fire.build_static_cells()
 *  3. cell → region and monthly counts                        → fire.build_region_counts()
 *  4. harmonization ERROR on held-out data                    → calibrate 2012–2019, test 2020–2025 (out/validation.json)
 *  5. harmonization factors for the app (all overlap years)   → fire.compute_harmonization()
 *  6. harmonized calendars + baseline/anomaly                 → fire.build_calendar()
 *  7. projection hindcast (rolling origin) and focos-raiz hit → out/projection_validation.json
 *
 * Nothing here is hand-typed: if a step has no data, the corresponding number is null.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import type { HarmonizationValidation, ProjectionMethod, ProjectionValidation } from '../db/history.js';
import { getPool } from '../db/pool.js';
import { isMain } from '../core/entry.js';

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)) * 10) / 10;
}

export async function runBuildHistory(): Promise<{ validation: HarmonizationValidation; projection: ProjectionValidation }> {
  const pool = getPool();
  const step = async (name: string, sql: string, params: unknown[] = []) => {
    const t0 = Date.now();
    const res = await pool.query(sql, params);
    logger.info({ step: name, ms: Date.now() - t0 }, 'build-history step');
    return res;
  };

  await step('grid 1 km', 'REFRESH MATERIALIZED VIEW fire.hotspot_cell_day');
  await step('grid 500 m (VIIRS)', 'REFRESH MATERIALIZED VIEW fire.viirs_cell500_day');
  await step('static sources', 'SELECT fire.build_static_cells()');
  await step('region counts', 'SELECT fire.build_region_counts()');

  const uf = await pool.query<{ id: string }>(`SELECT fire.uf_region_id() AS id`);
  const ufId = n(uf.rows[0]?.id);
  if (ufId === null) throw new Error('State region not loaded: run job:db-load-regions first');

  // 4. Error of the harmonization on data NOT used to calibrate it
  const v = (await step('validate state', 'SELECT * FROM fire.validate_harmonization($1)', [ufId])).rows[0] ?? {};
  const muniWape = (
    await step(
      'validate municipalities',
      `SELECT v.wape_pct FROM fire.region r, LATERAL fire.validate_harmonization(r.id) v
        WHERE r.kind = 'municipio' AND v.sum_actual >= 50`
    )
  ).rows
    .map((r) => n(r.wape_pct))
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);

  // 5–6. Factors for the app use every overlap year; then calendars and anomaly baselines
  await step('factors', `SELECT fire.compute_harmonization(id) FROM fire.region WHERE kind IN ('uf', 'municipio')`);
  await step('calendars', `SELECT fire.build_calendar(id) FROM fire.region WHERE kind IN ('uf', 'municipio')`);
  const factors = (
    await pool.query(
      `SELECT m, (SELECT factor FROM fire.harmonization_factor WHERE region_id = $1 AND method = 'monthly_ratio' AND month = m) AS f
         FROM generate_series(1, 12) m ORDER BY m`,
      [ufId]
    )
  ).rows.map((r) => (n(r.f) === null ? null : Math.round(Number(r.f) * 1000) / 1000));

  const validation: HarmonizationValidation = {
    computedAt: new Date().toISOString(),
    source: 'firms_db',
    calibrationPeriod: '2012-2019',
    testPeriod: '2020-2025',
    method: 'monthly_ratio on 1 km cell-days (VIIRS S-NPP ÷ MODIS), shrinkage k=30 toward the state; static sources excluded',
    mapePct: n(v.mape_pct),
    wapePct: n(v.wape_pct),
    pearsonR: n(v.pearson_r),
    biasPct: n(v.bias_pct),
    nMonths: n(v.n_months) ?? 0,
    municipalities: { n: muniWape.length, medianWapePct: quantile(muniWape, 0.5), p90WapePct: quantile(muniWape, 0.9) },
    monthlyRatioFactors: factors,
  };

  // 7. Projection hindcast (state) and focos-raiz hit rate on the last full year
  const methods: ProjectionMethod[] = ['all', 'recent10', 'analog5'];
  const hind = [];
  for (const m of methods) {
    const r = (await step(`hindcast ${m}`, 'SELECT * FROM fire.hindcast_projection($1, $2)', [ufId, m])).rows[0] ?? {};
    hind.push({
      method: m,
      nMonths: n(r.n_months) ?? 0,
      coveragePct: n(r.coverage_p10_p90_pct),
      meanWidth: n(r.mean_width),
      maeP50: n(r.mae_p50),
      maePersistence: n(r.mae_persistence),
      skillPct: n(r.skill_pct),
    });
  }
  // Choice rule: among the plain ranges, prefer calibrated coverage (70–90% for an 80% band), then lower MAE.
  const plain = hind.filter((h) => h.method !== 'analog5' && h.nMonths > 0);
  const calibrated = plain.filter((h) => h.coveragePct !== null && h.coveragePct >= 70 && h.coveragePct <= 90);
  const pool2 = calibrated.length ? calibrated : plain;
  pool2.sort((a, b) => (a.maeP50 ?? Infinity) - (b.maeP50 ?? Infinity));
  const chosen = (pool2[0]?.method ?? 'all') as ProjectionMethod;
  const best = hind.find((h) => h.method === chosen);
  const analog = hind.find((h) => h.method === 'analog5');
  const analogBeatsRange =
    !!best && !!analog && analog.maeP50 !== null && best.maeP50 !== null && analog.maeP50 < best.maeP50 &&
    analog.coveragePct !== null && analog.coveragePct >= 70;

  const lastYear = n((await pool.query(`SELECT max(year) AS y FROM fire.loaded_year`)).rows[0]?.y);
  let recurrence: ProjectionValidation['recurrence'] = null;
  if (lastYear !== null && lastYear >= 2012) {
    const r = (await step('focos-raiz hit rate', 'SELECT * FROM fire.recurrence_hit_rate($1::smallint, 10::smallint, 5::smallint)', [lastYear])).rows[0] ?? {};
    recurrence = { testYear: lastYear, windowYears: 10, minYears: 5, hitPct: n(r.hit_pct), areaSharePct: n(r.area_share_pct), lift: n(r.lift) };
  }

  const projection: ProjectionValidation = {
    computedAt: new Date().toISOString(),
    period: '2015-2025',
    methods: hind,
    chosenMethod: chosen,
    analogBeatsRange,
    recurrence,
  };

  fs.mkdirSync(config.outDir, { recursive: true });
  fs.writeFileSync(path.join(config.outDir, 'validation.json'), JSON.stringify(validation, null, 2), 'utf8');
  fs.writeFileSync(path.join(config.outDir, 'projection_validation.json'), JSON.stringify(projection, null, 2), 'utf8');
  logger.info({ validation, projection }, 'job:build-history completed → out/validation.json, out/projection_validation.json');
  return { validation, projection };
}

if (isMain(import.meta.url)) {
  runBuildHistory()
    .then(() => getPool().end())
    .catch((err) => {
      logger.error({ err: String(err) }, 'job:build-history failed');
      process.exit(1);
    });
}
