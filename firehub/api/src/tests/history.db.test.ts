/**
 * End-to-end test of the real-data path: FIRMS CSV (official column layout) → parser → PostGIS → build-history
 * → computed validation → API routes. Runs only when TEST_DATABASE_URL points to a disposable database:
 *
 *   TEST_DATABASE_URL=postgresql://firehub:firehub@127.0.0.1:5432/fh_test npx vitest run src/tests/history.db.test.ts
 *
 * Data is SYNTHETIC with a known answer: VIIRS sees ~3x more fire cells than MODIS, fire season Aug–Sep,
 * 50 fixed sites burn most years (focos-raiz) and one static heat source (type = 2) burns all year.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB = process.env.TEST_DATABASE_URL;
const suite = DB ? describe : describe.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(here, '../../../../Tema_08_MODIS_VIIRS/db');
const SCHEMAS = ['schema.sql', 'schema_firehub.sql', 'schema_contexto.sql', 'schema_operacional.sql', 'schema_projecao.sql'];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEASON = [0.01, 0.01, 0.015, 0.02, 0.04, 0.07, 0.12, 0.25, 0.3, 0.12, 0.04, 0.015];
const MODIS_HEADER = 'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type';
const VIIRS_HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type';

/** Builds one yearly CSV per sensor in the FIRMS archive layout. */
function syntheticYear(year: number, r: () => number, roots: [number, number][]): { modis: string; viirs: string | null } {
  const level = 0.8 + r() * 0.6;
  const modis = [MODIS_HEADER];
  const viirs = [VIIRS_HEADER];
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let m = 1; m <= 12; m++) {
    const n = Math.max(1, Math.round(220 * level * SEASON[m - 1]! * (0.7 + r() * 0.6)));
    for (let e = 0; e < n; e++) {
      const day = `${year}-${pad(m)}-${pad(1 + Math.floor(r() * 27))}`;
      const root = r() < 0.4 ? roots[Math.floor(r() * roots.length)]! : null;
      const lon = root ? root[0] : -53.0 + r() * 6.8;
      const lat = root ? root[1] : -19.2 + r() * 6.5;
      if (r() < 0.35) {
        modis.push(`${(lat + (r() - 0.5) * 0.004).toFixed(5)},${(lon + (r() - 0.5) * 0.004).toFixed(5)},330.0,1.0,1.0,${day},1640,Aqua,MODIS,75,6.1NRT,300.0,20.0,D,0`);
      }
      if (year >= 2012 && r() < 0.95) {
        const k = 1 + Math.floor(r() * 3);
        for (let p = 0; p < k; p++) {
          viirs.push(`${(lat + (r() - 0.5) * 0.006).toFixed(5)},${(lon + (r() - 0.5) * 0.006).toFixed(5)},340.0,0.4,0.4,${day},${1710 + p},N,VIIRS,n,2.0NRT,295.0,6.0,D,0`);
        }
      }
    }
  }
  if (year >= 2012) {
    // static heat source (industry): every 3rd day, flagged by FIRMS as type 2
    for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 3)) {
      const day = d.toISOString().slice(0, 10);
      modis.push(`-17.50000,-50.50000,350.0,1.0,1.0,${day},1300,Aqua,MODIS,90,6.1NRT,305.0,30.0,D,2`);
      viirs.push(`-17.50000,-50.50000,350.0,0.4,0.4,${day},1300,N,VIIRS,h,2.0NRT,300.0,30.0,D,2`);
    }
  }
  return { modis: modis.join('\n'), viirs: year >= 2012 ? viirs.join('\n') : null };
}

suite('real-data path: FIRMS CSV → PostGIS → validation → API', () => {
  let app: FastifyInstance;
  let outDir: string;
  let history: typeof import('../db/history.js');
  let build: Awaited<ReturnType<typeof import('../jobs/build-history.js')['runBuildHistory']>>;
  let getPool: typeof import('../db/pool.js')['getPool'];

  beforeAll(async () => {
    process.env.DATABASE_URL = DB!;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firehub-out-'));
    process.env.FIREHUB_OUT_DIR = outDir;

    ({ getPool } = await import('../db/pool.js'));
    const pool = getPool();
    await pool.query('DROP SCHEMA IF EXISTS fire CASCADE');
    for (const f of SCHEMAS) {
      const sql = fs.readFileSync(path.join(DB_DIR, f), 'utf8').split('\n').filter((l) => !l.startsWith('\\')).join('\n');
      await pool.query(sql);
    }
    await pool.query(`
      INSERT INTO fire.region (kind, ibge_code, name, geom) VALUES
       ('uf', '52', 'Goiás (test box)', ST_Multi(ST_MakeEnvelope(-53.25, -19.50, -45.90, -12.39, 4326))),
       ('municipio', '5200001', 'NW', ST_Multi(ST_MakeEnvelope(-53.25, -15.945, -49.575, -12.39, 4326))),
       ('municipio', '5200002', 'NE', ST_Multi(ST_MakeEnvelope(-49.575, -15.945, -45.90, -12.39, 4326))),
       ('municipio', '5200003', 'SW', ST_Multi(ST_MakeEnvelope(-53.25, -19.50, -49.575, -15.945, 4326))),
       ('municipio', '5200004', 'SE', ST_Multi(ST_MakeEnvelope(-49.575, -19.50, -45.90, -15.945, 4326)))`);

    const { parseFirmsCsv } = await import('../connectors/firms.js');
    const { storeYear } = await import('../jobs/ingest-firms-history.js');
    const r = rng(42);
    const roots: [number, number][] = Array.from({ length: 50 }, () => [-53.0 + r() * 6.8, -19.2 + r() * 6.5]);
    const bbox: [number, number, number, number] = [-53.25, -19.5, -45.9, -12.39];
    for (let y = 2001; y <= 2025; y++) {
      const csv = syntheticYear(y, r, roots);
      await storeYear('MODIS_SP', y, `https://firms.modaps.eosdis.nasa.gov/data/country/modis/${y}/modis_${y}_Brazil.csv`, parseFirmsCsv(csv.modis, 'MODIS_SP', bbox));
      if (csv.viirs) {
        await storeYear('VIIRS_SNPP_SP', y, `https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/${y}/viirs-snpp_${y}_Brazil.csv`, parseFirmsCsv(csv.viirs, 'VIIRS_SNPP_SP', bbox));
      }
    }

    const { runBuildHistory } = await import('../jobs/build-history.js');
    build = await runBuildHistory();
    history = await import('../db/history.js');
    history.resetHistoryCache();
    const { registerHistoryRoutes } = await import('../modules/history-routes.js');
    app = Fastify();
    await registerHistoryRoutes(app);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await getPool?.().end();
  });

  it('ingests idempotently: re-storing a year adds no rows', async () => {
    const { storeYear } = await import('../jobs/ingest-firms-history.js');
    const { parseFirmsCsv } = await import('../connectors/firms.js');
    const before = await getPool().query('SELECT count(*)::int AS n FROM fire.hotspot');
    const csv = syntheticYear(2020, rng(7), [[-50, -16]]);
    await storeYear('MODIS_SP', 2020, 'https://firms.modaps.eosdis.nasa.gov/data/country/modis/2020/modis_2020_Brazil.csv', parseFirmsCsv(csv.modis, 'MODIS_SP'));
    await storeYear('MODIS_SP', 2020, 'https://firms.modaps.eosdis.nasa.gov/data/country/modis/2020/modis_2020_Brazil.csv', parseFirmsCsv(csv.modis, 'MODIS_SP'));
    const after = await getPool().query('SELECT count(*)::int AS n FROM fire.hotspot');
    const once = parseFirmsCsv(csv.modis, 'MODIS_SP').length;
    expect(after.rows[0].n - before.rows[0].n).toBeLessThanOrEqual(once);
  });

  it('keeps the normalization: confidence 0/1/2 and FIRMS type 2 flagged as static source', async () => {
    const c = await getPool().query(`SELECT DISTINCT confidence_norm FROM fire.hotspot ORDER BY 1`);
    expect(c.rows.map((x) => x.confidence_norm)).toEqual(expect.arrayContaining([1]));
    const s = await getPool().query(
      `SELECT reason FROM fire.static_cell WHERE cell_key = fire.cell_key(ST_SetSRID(ST_MakePoint(-50.5, -17.5), 4326))`
    );
    expect(s.rowCount).toBe(1);
  });

  it('computes (not types) the harmonization error on held-out years', () => {
    const v = build.validation;
    expect(v.source).toBe('firms_db');
    expect(v.nMonths).toBe(72); // 2020–2025 × 12
    expect(v.wapePct).not.toBeNull();
    expect(v.wapePct!).toBeLessThan(35);
    expect(v.pearsonR!).toBeGreaterThan(0.85);
    expect(v.monthlyRatioFactors.filter((f) => f !== null)).toHaveLength(12);
    const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'validation.json'), 'utf8'));
    expect(onDisk.wapePct).toBe(v.wapePct);
  });

  it('hindcasts the projection and measures focos-raiz', () => {
    const p = build.projection;
    expect(p.methods.map((m) => m.method)).toEqual(['all', 'recent10', 'analog5']);
    expect(['all', 'recent10']).toContain(p.chosenMethod);
    const chosen = p.methods.find((m) => m.method === p.chosenMethod)!;
    expect(chosen.nMonths).toBe(132);
    expect(chosen.coveragePct!).toBeGreaterThan(55);
    expect(p.recurrence?.lift ?? 0).toBeGreaterThan(5);
  });

  it('builds the harmonized calendar: VIIRS from 2012, MODIS × factor before', async () => {
    const id = (await history.regionIdByIbge('52'))!.id;
    const rows = await history.calendar(id);
    expect(rows).toHaveLength(300);
    expect(rows.filter((x) => x.year < 2012).every((x) => x.viirs === null)).toBe(true);
    expect(rows.filter((x) => x.year >= 2012).every((x) => x.harmonized === x.viirs)).toBe(true);
    const values = await history.mapValues(2024, 9, 'density');
    expect(Object.keys(values).sort()).toEqual(['5200001', '5200002', '5200003', '5200004']);
  });

  it('GET /api/validation returns computed numbers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/validation' });
    expect(res.statusCode).toBe(200);
    expect(res.json().harmonization.source).toBe('firms_db');
  });

  it('GET /api/projection gives a range for the state and a shrunk range for a small area', async () => {
    const st = await app.inject({ method: 'GET', url: '/api/projection?ibge=52&year=2025&month=9' });
    expect(st.statusCode).toBe(200);
    expect(st.json().range.p10).toBeLessThanOrEqual(st.json().range.p90);
    const mu = await app.inject({ method: 'GET', url: '/api/projection?ibge=5200001&year=2025&month=9' });
    expect(mu.statusCode).toBe(200);
    expect(mu.json().range.shrinkWeight).toBeLessThan(1);
    expect((await app.inject({ method: 'GET', url: '/api/projection?ibge=99&year=2025&month=9' })).statusCode).toBe(400);
  });

  it('GET /api/area/history counts only what is inside the circle', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/area/history?lon=-49.25&lat=-16.68&radiusKm=50' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toHaveLength(300);
    expect(body.pctInState).toBe(100);
    const inside = await getPool().query(
      `SELECT count(*)::int AS n FROM fire.hotspot_cell_day d
        WHERE d.instrument = 'VIIRS' AND d.day BETWEEN '2020-01-01' AND '2020-12-31'
          AND ST_DWithin(ST_Transform(d.geom, 5880), ST_Transform(ST_SetSRID(ST_MakePoint(-49.25, -16.68), 4326), 5880), 50000)`
    );
    const sum2020 = body.rows.filter((x: { year: number }) => x.year === 2020).reduce((a: number, x: { harmonized: number }) => a + x.harmonized, 0);
    expect(sum2020).toBe(inside.rows[0].n);
    expect((await app.inject({ method: 'GET', url: '/api/area/history?lon=-49.25&lat=-16.68&radiusKm=3' })).statusCode).toBe(400);
    const fine = await app.inject({ method: 'GET', url: '/api/area/history?lon=-49.25&lat=-16.68&radiusKm=3&source=viirs500' });
    expect(fine.statusCode).toBe(200);
    expect(fine.json().rows.every((x: { year: number }) => x.year >= 2012)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/area/history?lon=-60&lat=-16.68&radiusKm=20' })).statusCode).toBe(400);
  });

  it('GET /api/layers/recurrence validates and returns compact cells', async () => {
    const box = 'west=-53.25&south=-19.5&east=-45.9&north=-12.39';
    const res = await app.inject({ method: 'GET', url: `/api/layers/recurrence?${box}&res=10000` });
    expect(res.statusCode).toBe(200);
    expect(res.json().cells.length).toBeGreaterThan(0);
    expect(res.json().cells[0]).toHaveLength(6);
    expect((await app.inject({ method: 'GET', url: `/api/layers/recurrence?${box}&res=500` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/layers/recurrence?${box}&res=500&source=viirs500` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/layers/recurrence?${box}&source=x%27;DROP%20TABLE%20fire.hotspot;--` })).statusCode).toBe(400);
  });

  it('GET /api/layers/cells: the cells inside a municipality add up to its monthly harmonized value', async () => {
    const id = (await history.regionIdByIbge('5200001'))!.id;
    const rows = await history.calendar(id);
    const months = rows.filter((r) => (r.harmonized ?? 0) > 0).sort((a, b) => (b.harmonized ?? 0) - (a.harmonized ?? 0));
    const picks = [months.find((r) => r.year < 2012), months.find((r) => r.year >= 2012)].filter((r) => r !== undefined);
    expect(picks.length).toBe(2);
    for (const r of picks) {
      const res = await app.inject({ method: 'GET', url: `/api/layers/cells?ibge=5200001&year=${r.year}&month=${r.month}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { total: number; cells: number[][]; yearsObserved: number };
      expect(Math.abs(body.total - (r.harmonized ?? 0))).toBeLessThan(0.2);
      expect(body.cells.every((c) => c.length === 5 && (c[0] ?? 0) >= -53.25 && (c[0] ?? 0) <= -49.575)).toBe(true);
      expect(body.yearsObserved).toBeGreaterThan(20);
    }
    const circ = await app.inject({ method: 'GET', url: '/api/layers/cells?lon=-49.25&lat=-16.68&radiusKm=50&year=2020&month=9&res=2000' });
    expect(circ.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/layers/cells?ibge=5200001&lon=-49&lat=-16&radiusKm=20&year=2020&month=9' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/layers/cells?lon=-49.25&lat=-16.68&radiusKm=3&year=2020&month=9' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/layers/cells?ibge=5200001&year=2020&month=9&res=500' })).statusCode).toBe(400);
  });
});
