/**
 * Opt-in area watch: the user turns it on for a municipality or a circle; the API checks GOES-19 every 10 minutes,
 * keeps pixels seen in 2 of the last 3 scans, adds the historical context and later confirms with VIIRS.
 * No account: the browser keeps the watch id (a random UUID) and polls its alerts.
 */
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pointInMunicipality } from '../connectors/ibge.js';
import { firmsConnector } from '../connectors/firms.js';
import { fetchScan, latestKeys } from '../connectors/goes-fdc.js';
import {
  MAX_WATCHES, confirmAlerts, kmBetween, loadState, newWatch, persistentPixels, saveState, updateAlerts,
  type WatchArea, type WatchState,
} from '../core/goes-watch.js';
import { logger } from '../core/logger.js';
import { store } from '../db/store.js';

// GOES_WATCH_FILE lets tests use a temporary file instead of the real state
const STATE_FILE = (): string => process.env.GOES_WATCH_FILE || path.join(config.dataDir, 'goes_watch.json');
const GOIAS_BOX: [number, number, number, number] = [-53.3, -19.55, -45.85, -12.35];
const SCAN_EVERY_MS = 10 * 60_000;
const CONFIRM_EVERY_MS = 60 * 60_000;

let state: WatchState | null = null;
type CycleResult = { newScans: number; newAlerts: number; confirmed: number };
let inFlight: Promise<CycleResult> | null = null;
let lastConfirm = 0;
const st = (): WatchState => (state ??= loadState(STATE_FILE()));

function inArea(area: WatchArea, lon: number, lat: number): boolean {
  if ('ibge' in area) {
    if (area.ibge === '52') return true; // whole state: the scans are already cut to Goiás municipalities
    const m = store.getMunicipality(area.ibge);
    return !!m && pointInMunicipality(lat, lon, m);
  }
  return kmBetween(area.lon, area.lat, lon, lat) <= area.radiusKm;
}

/** One cycle: new GOES scans → persistence → alerts; at most hourly, VIIRS confirmation. Never throws. */
export function runWatchCycle(now = new Date()): Promise<CycleResult> {
  // a cycle already running (background or another "check now") is awaited instead of returning zeros at once
  inFlight ??= cycle(now).finally(() => { inFlight = null; });
  return inFlight;
}

async function cycle(now: Date): Promise<CycleResult> {
  const s = st();
  let newScans = 0, newAlerts = 0, confirmed = 0;
  try {
    const keys = await latestKeys(3, now);
    for (const key of keys) {
      if (s.scans.some((x) => x.key === key)) continue;
      const scan = await fetchScan(key, GOIAS_BOX, (lon, lat) => store.municipalityAt(lon, lat) !== null);
      s.scans.push(scan);
      newScans++;
    }
    s.scans = s.scans.sort((a, b) => a.scanStart.localeCompare(b.scanStart)).slice(-6);
    newAlerts = updateAlerts(s, { inArea, context: (lon, lat, month) => store.alertContext(lon, lat, month) }).length;
    if (config.FIRMS_MAP_KEY && now.getTime() - lastConfirm >= CONFIRM_EVERY_MS && s.alerts.some((a) => a.status === 'persistent')) {
      lastConfirm = now.getTime();
      // 3 days back covers alerts up to 30 h old (their day and the next one)
      const pts = await firmsConnector.fetchMultiSensorArea(GOIAS_BOX, 3, ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']);
      confirmed = confirmAlerts(s, pts.map((p) => ({ lon: p.longitude, lat: p.latitude, date: p.acqDate })), now);
    }
    s.lastRun = now.toISOString();
    s.lastError = null;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message.slice(0, 200) : 'GOES check failed';
    logger.warn({ err: s.lastError }, 'GOES watch cycle failed');
  } finally {
    try { saveState(STATE_FILE(), s); } catch (err) { logger.warn({ err: String(err) }, 'could not save goes_watch.json'); }
  }
  return { newScans, newAlerts, confirmed };
}

/** Background loop: runs only while at least one watch is active. */
export function startGoesWatcher(): void {
  if (process.env.GOES_WATCH === 'off') return;
  const tick = (): void => { if (st().watches.length) void runWatchCycle(); };
  setTimeout(tick, 15_000);
  setInterval(tick, SCAN_EVERY_MS).unref();
}

function problem(reply: FastifyReply, status: number, title: string, detail: string) {
  return reply.code(status).header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type: 'about:blank', title, status, detail });
}

const AreaBody = z.union([
  z.object({ ibge: z.string().regex(/^52(\d{5})?$/), label: z.string().max(80).default('') }).strict(), // '52' = whole state
  z.object({
    lon: z.number().min(GOIAS_BOX[0]).max(GOIAS_BOX[2]), lat: z.number().min(GOIAS_BOX[1]).max(GOIAS_BOX[3]),
    radiusKm: z.number().min(5).max(300), label: z.string().max(80).default(''),
  }).strict(),
]);
const IdParam = z.object({ id: z.string().uuid() });

function feed(s: WatchState) {
  const last = s.scans[s.scans.length - 1];
  return {
    source: 'NOAA GOES-19 ABI L2 Fire/Hot Spot (FDCF), every 10 min; confirmation: NASA FIRMS VIIRS NRT',
    lastRun: s.lastRun, lastScan: last ? last.scanStart : null, lastError: s.lastError,
    detectionsInGoias: last ? last.detections.length : null,
    persistentInGoias: persistentPixels(s.scans).length,
    activeWatches: s.watches.length,
  };
}

export async function registerWatchRoutes(app: FastifyInstance): Promise<void> {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/watch', strict, async (req, reply) => {
    const b = AreaBody.safeParse(req.body);
    if (!b.success) return problem(reply, 400, 'Invalid area', b.error.message);
    const s = st();
    if (s.watches.length >= MAX_WATCHES) return problem(reply, 429, 'Too many watches', `At most ${MAX_WATCHES} areas can be watched.`);
    const { label, ...area } = b.data;
    if ('ibge' in area && area.ibge !== '52' && !store.getMunicipality(area.ibge)) return problem(reply, 404, 'Region not found', `IBGE ${area.ibge}`);
    const w = newWatch(area as WatchArea, label);
    s.watches.push(w);
    saveState(STATE_FILE(), s);
    if (s.watches.length === 1) void runWatchCycle();
    return reply.code(201).send({ watch: w, feed: feed(s) });
  });

  app.delete('/api/watch/:id', strict, async (req, reply) => {
    const p = IdParam.safeParse(req.params);
    if (!p.success) return problem(reply, 400, 'Invalid id', p.error.message);
    const s = st();
    const before = s.watches.length;
    s.watches = s.watches.filter((w) => w.id !== p.data.id);
    s.alerts = s.alerts.filter((a) => a.watchId !== p.data.id);
    if (s.watches.length === before) return problem(reply, 404, 'Watch not found', 'Unknown watch id');
    saveState(STATE_FILE(), s);
    return reply.code(204).send();
  });

  app.get('/api/watch/:id/alerts', async (req, reply) => {
    const p = IdParam.safeParse(req.params);
    if (!p.success) return problem(reply, 400, 'Invalid id', p.error.message);
    const s = st();
    const w = s.watches.find((x) => x.id === p.data.id);
    if (!w) return problem(reply, 404, 'Watch not found', 'Unknown watch id');
    const alerts = s.alerts.filter((a) => a.watchId === w.id).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 50);
    reply.header('Cache-Control', 'no-store');
    return { watch: w, feed: feed(s), alerts };
  });

  app.get('/api/goes/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return feed(st());
  });

  // "Check now" for a demo: at most twice a minute.
  app.post('/api/goes/run', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => {
    const r = await runWatchCycle();
    return { ...r, feed: feed(st()) };
  });
}

/** For tests: replace the in-memory state. */
export function __setWatchState(s: WatchState): void { state = s; }
