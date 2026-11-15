/**
 * Opt-in area watch ("monitor this area"): early notice from GOES-19 every 10 minutes, kept only when the same
 * pixel shows up in at least 2 of the last 3 scans (~20–30 min), put in context with our harmonized FIRMS history,
 * and confirmed or not by the next VIIRS overpass (FIRMS NRT). Stored in data/goes_watch.json.
 *
 * Wording: "fire detected", "above / within the historical pattern". Never "risk" or "forecast".
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GoesDetection, GoesScan } from '../connectors/goes-fdc.js';

export const PIXEL_DEG = 0.02;          // ≈ 2 km, the GOES pixel over Goiás (alert id)
export const MATCH_KM = 2.5;            // same pixel across scans
export const PERSIST_WINDOW = 3;        // last N scans
export const PERSIST_MIN = 2;           // seen in at least this many of them
export const CONFIRM_KM = 2;            // VIIRS detection within this distance confirms
export const MAX_WATCHES = 200;

const WatchSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  area: z.union([
    z.object({ ibge: z.string().regex(/^52(\d{5})?$/) }), // '52' = the whole state of Goiás
    z.object({ lon: z.number(), lat: z.number(), radiusKm: z.number().min(5).max(300) }),
  ]),
  label: z.string().max(80),
});
export type Watch = z.infer<typeof WatchSchema>;
export type WatchArea = Watch['area'];

const ContextSchema = z.object({
  municipality: z.string().nullable(),
  ibge: z.string().nullable(),
  yearsWithFire: z.number().int().nullable(),   // years with fire within 3 km in this calendar month
  yearsObserved: z.number().int().nullable(),
  anomalyZ: z.number().nullable(),              // municipality, current month (days 1..D)
  monthCellDays: z.number().nullable(),
});
export type AlertContext = z.infer<typeof ContextSchema>;

const AlertSchema = z.object({
  id: z.string(),
  watchId: z.string().uuid(),
  lon: z.number(),
  lat: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  scansSeen: z.number().int(),
  frpMw: z.number().nullable(),
  status: z.enum(['persistent', 'confirmed', 'not_confirmed']),
  checkedAt: z.string().nullable(),
  context: ContextSchema,
});
export type Alert = z.infer<typeof AlertSchema>;

const ScanSchema = z.object({
  key: z.string(),
  scanStart: z.string(),
  detections: z.array(z.object({ lon: z.number(), lat: z.number(), mask: z.number(), frpMw: z.number().nullable() })),
});
const StateSchema = z.object({
  version: z.literal(1),
  watches: z.array(WatchSchema),
  alerts: z.array(AlertSchema),
  scans: z.array(ScanSchema),
  lastRun: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type WatchState = z.infer<typeof StateSchema>;

export const emptyState = (): WatchState => ({ version: 1, watches: [], alerts: [], scans: [], lastRun: null, lastError: null });

export function loadState(file: string): WatchState {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : emptyState();
  } catch {
    return emptyState();
  }
}
export function saveState(file: string, s: WatchState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
}

export function newWatch(area: WatchArea, label: string, now = new Date()): Watch {
  return WatchSchema.parse({ id: crypto.randomUUID(), createdAt: now.toISOString(), area, label: label.slice(0, 80) });
}

const pixelKey = (d: { lon: number; lat: number }): string => `${Math.round(d.lon / PIXEL_DEG)}:${Math.round(d.lat / PIXEL_DEG)}`;

export function kmBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Pixels of the newest scan that also appear in at least `min` of the last `window` scans (persistence).
 * A pixel seen once is dropped: it removes most single-scan false alarms of the geostationary product.
 */
export function persistentPixels(scans: GoesScan[], window = PERSIST_WINDOW, min = PERSIST_MIN):
  Array<GoesDetection & { scansSeen: number; firstSeen: string; lastSeen: string }> {
  const recent = [...scans].sort((a, b) => a.scanStart.localeCompare(b.scanStart)).slice(-window);
  const latest = recent[recent.length - 1];
  if (!latest) return [];
  const out: Array<GoesDetection & { scansSeen: number; firstSeen: string; lastSeen: string }> = [];
  for (const d of latest.detections) {
    // the same GOES pixel (≈ 2 km): any detection within MATCH_KM in a scan counts for that scan
    if (out.some((o) => kmBetween(o.lon, o.lat, d.lon, d.lat) <= MATCH_KM)) continue;
    const hits = recent.filter((s) => s.detections.some((x) => kmBetween(x.lon, x.lat, d.lon, d.lat) <= MATCH_KM));
    if (hits.length < min) continue;
    out.push({ ...d, scansSeen: hits.length, firstSeen: hits[0]!.scanStart, lastSeen: latest.scanStart });
  }
  return out;
}

export interface WatchDeps {
  /** Is this point inside the watched area? */
  inArea: (area: WatchArea, lon: number, lat: number) => boolean;
  /** Historical context from the harmonized FIRMS series for a point and month. */
  context: (lon: number, lat: number, month: number) => AlertContext;
}

/**
 * One step after a new scan: opens an alert per watched area and persistent pixel, or refreshes it.
 * An alert is unique per watch and GOES pixel; it is refreshed (lastSeen, scansSeen, FRP) while the pixel persists.
 */
export function updateAlerts(state: WatchState, deps: WatchDeps): Alert[] {
  const fresh: Alert[] = [];
  const pix = persistentPixels(state.scans);
  for (const w of state.watches) {
    for (const p of pix) {
      if (!deps.inArea(w.area, p.lon, p.lat)) continue;
      // the same fire keeps its alert while it persists: same watch, same pixel (≤ MATCH_KM), seen in the last hour
      const cur = state.alerts.find((a) => a.watchId === w.id && kmBetween(a.lon, a.lat, p.lon, p.lat) <= MATCH_KM
        && Date.parse(p.lastSeen) - Date.parse(a.lastSeen) <= 3_600_000);
      const id = `${w.id}:${pixelKey(p)}:${p.firstSeen}`;
      if (cur) {
        if (cur.lastSeen < p.lastSeen) cur.lastSeen = p.lastSeen;
        cur.scansSeen = Math.max(cur.scansSeen, p.scansSeen);
        if (p.frpMw !== null) cur.frpMw = Math.max(cur.frpMw ?? 0, p.frpMw);
        continue;
      }
      const month = Number(p.firstSeen.slice(5, 7)) || 1;
      const alert = AlertSchema.parse({
        id, watchId: w.id, lon: p.lon, lat: p.lat, firstSeen: p.firstSeen, lastSeen: p.lastSeen, scansSeen: p.scansSeen,
        frpMw: p.frpMw, status: 'persistent', checkedAt: null, context: deps.context(p.lon, p.lat, month),
      });
      state.alerts.push(alert);
      fresh.push(alert);
    }
  }
  // keep the store small: alerts of the last 7 days, at most 2000
  const cutoff = Date.now() - 7 * 86_400_000;
  state.alerts = state.alerts.filter((a) => Date.parse(a.lastSeen) >= cutoff).slice(-2000);
  return fresh;
}

/**
 * VIIRS confirmation: alerts older than `minAgeH` (an overpass and FIRMS latency) and younger than 30 h are checked
 * against VIIRS NRT detections; a detection within CONFIRM_KM on the same or next day confirms.
 * After 30 h without one, the alert is marked not confirmed.
 */
export function confirmAlerts(state: WatchState, viirs: Array<{ lon: number; lat: number; date: string }>, now = new Date(), minAgeH = 3): number {
  let changed = 0;
  for (const a of state.alerts) {
    if (a.status !== 'persistent') continue;
    const ageH = (now.getTime() - Date.parse(a.firstSeen)) / 3_600_000;
    if (ageH < minAgeH) continue;
    const day0 = a.firstSeen.slice(0, 10);
    const day1 = new Date(Date.parse(day0) + 86_400_000).toISOString().slice(0, 10);
    const hit = viirs.some((v) => (v.date === day0 || v.date === day1) && kmBetween(a.lon, a.lat, v.lon, v.lat) <= CONFIRM_KM);
    if (hit) { a.status = 'confirmed'; a.checkedAt = now.toISOString(); changed++; }
    else if (ageH >= 30) { a.status = 'not_confirmed'; a.checkedAt = now.toISOString(); changed++; }
  }
  return changed;
}
