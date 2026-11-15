/**
 * End to end: municipality, whole-state and circle watches against the real IBGE boundaries and the real
 * FIRMS index. Only the satellite is simulated (three GOES-19 scans, 10 min apart).
 * Skips when the local data files are not present.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import type { GoesDetection, GoesScan } from '../connectors/goes-fdc.js';

const GOIANIA = { lon: -49.2650, lat: -16.6800 };   // Goiânia (5208707)
const RIO_VERDE = { lon: -50.9280, lat: -17.7920 }; // Rio Verde (5218805)
const BRASILIA = { lon: -47.8800, lat: -15.7900 };  // Distrito Federal: inside the box, outside Goiás
const ONCE = { lon: -48.9500, lat: -16.3300 };      // Anápolis, seen in only one scan (glint)

const KEYS = [0, 1, 2].map((i) => `ABI-L2-FDCF/2026/319/15/OR_ABI-L2-FDCF-M6_G19_s20263191${i}00210_e20263191${i}09519_c20263191${i}10002.nc`);
let published = 0;

vi.mock('../connectors/goes-fdc.js', () => ({
  latestKeys: async () => KEYS.slice(0, published),
  fetchScan: async (key: string, _box: unknown, inside?: (lon: number, lat: number) => boolean): Promise<GoesScan> => {
    const i = KEYS.indexOf(key);
    const fires = [GOIANIA, RIO_VERDE, BRASILIA, ...(i === 1 ? [ONCE] : [])];
    const detections: GoesDetection[] = fires
      .filter((f) => !inside || inside(f.lon, f.lat))
      .map((f) => ({ lon: f.lon + i * 0.003, lat: f.lat, mask: 10, frpMw: 40 + i }));
    return { key, scanStart: `2026-11-15T15:${i}0:21Z`, detections };
  },
}));
vi.mock('../connectors/firms.js', () => ({ firmsConnector: { fetchMultiSensorArea: async () => [] } }));

const hasData = fs.existsSync(path.join(config.dataDir, 'firms_goias_cells.json')) && fs.existsSync(path.join(config.dataDir, 'ibge_uf_52.json'));

interface AlertOut { lon: number; lat: number; status: string; scansSeen: number; context: { municipality: string | null; ibge: string | null; yearsObserved: number | null } }

describe.skipIf(!hasData)('notices end to end: municipality, state and circle', () => {
  let app: FastifyInstance;
  const ids: Record<string, string> = {};
  const alertsOf = async (k: string): Promise<AlertOut[]> =>
    ((await app.inject({ method: 'GET', url: `/api/watch/${ids[k]}/alerts` })).json() as { alerts: AlertOut[] }).alerts;

  beforeAll(async () => {
    process.env.GOES_WATCH = 'off';
    process.env.GOES_WATCH_FILE = path.join(os.tmpdir(), `goes_watch_e2e_${process.pid}.json`);
    fs.rmSync(process.env.GOES_WATCH_FILE, { force: true });
    const { store } = await import('../db/store.js');
    await store.init();
    const { registerWatchRoutes, runWatchCycle } = await import('../modules/watch-routes.js');
    app = Fastify();
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
    await registerWatchRoutes(app);
    const areas: Record<string, object> = {
      goiania: { ibge: '5208707', label: 'Goiânia' },
      rioVerde: { ibge: '5218805', label: 'Rio Verde' },
      estado: { ibge: '52', label: 'Goiás' },
      circulo: { lon: -49.25, lat: -16.68, radiusKm: 20, label: 'Círculo Goiânia' },
    };
    for (const [k, body] of Object.entries(areas)) {
      const r = await app.inject({ method: 'POST', url: '/api/watch', payload: body });
      expect(r.statusCode).toBe(201);
      ids[k] = (r.json() as { watch: { id: string } }).watch.id;
    }
    // first scan alone: nothing yet (needs 2 of 3)
    published = 1; await runWatchCycle(new Date('2026-11-15T15:11:00Z'));
    expect(await alertsOf('estado')).toEqual([]);
    published = 2; await runWatchCycle(new Date('2026-11-15T15:21:00Z'));
    published = 3; await runWatchCycle(new Date('2026-11-15T15:31:00Z'));
  });

  it('municipality watch: only the fire inside Goiânia', async () => {
    const a = await alertsOf('goiania');
    expect(a).toHaveLength(1);
    expect(a[0]!.context.municipality).toBe('Goiânia');
    expect(a[0]!.scansSeen).toBe(3);
    expect(a[0]!.status).toBe('persistent');
    expect(a[0]!.context.yearsObserved).toBeGreaterThan(20); // historical context from the FIRMS series
  });

  it('another municipality watch: only the fire inside Rio Verde', async () => {
    const a = await alertsOf('rioVerde');
    expect(a.map((x) => x.context.municipality)).toEqual(['Rio Verde']);
  });

  it('whole-state watch: every persistent fire in Goiás, not the Distrito Federal, not a one-scan glint', async () => {
    const names = (await alertsOf('estado')).map((x) => x.context.municipality).sort();
    expect(names).toEqual(['Goiânia', 'Rio Verde']);
  });

  it('circle watch: only what is inside the circle', async () => {
    const a = await alertsOf('circulo');
    expect(a.map((x) => x.context.ibge)).toEqual(['5208707']);
  });

  it('one alert per fire: running again does not duplicate', async () => {
    const { runWatchCycle } = await import('../modules/watch-routes.js');
    await runWatchCycle(new Date('2026-11-15T15:41:00Z'));
    expect(await alertsOf('estado')).toHaveLength(2);
  });
});
