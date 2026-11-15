/**
 * NOAA GOES-19 (GOES-East) ABI L2 Fire/Hot Spot Characterization, full disk (ABI-L2-FDCF), every 10 minutes.
 * Public NOAA open data on AWS (no key): https://noaa-goes19.s3.amazonaws.com/ABI-L2-FDCF/YYYY/DDD/HH/*.nc
 *
 * Used ONLY for the opt-in "watch this area" early notice. Never enters the harmonized MODIS/VIIRS series, the
 * anomaly or the projection (different sensor, 2 km pixel, short record).
 *
 * File: NetCDF-4 (HDF5). Mask (int16, y×x), Power (MW), x/y fixed-grid scan angles (int16 packed with
 * scale_factor/add_offset, radians) and goes_imager_projection attributes. Only the Goiás window is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

export const GOES_BUCKET_URL = 'https://noaa-goes19.s3.amazonaws.com';
const PRODUCT = 'ABI-L2-FDCF';
/** NOAA: users with a low tolerance for false alarms should keep "processed" and "saturated" (10, 11, 30, 31). */
export const CONFIDENT_MASKS: ReadonlySet<number> = new Set([10, 11, 30, 31]);

const KEY_RE = /^ABI-L2-FDCF\/\d{4}\/\d{3}\/\d{2}\/OR_ABI-L2-FDCF-M\d_G19_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d_e\d{14}_c\d{14}\.nc$/;
const KeySchema = z.string().regex(KEY_RE);

export interface GoesProjection { h: number; req: number; rpol: number; lon0: number }
export interface GoesDetection { lon: number; lat: number; mask: number; frpMw: number | null }
export interface GoesScan { key: string; scanStart: string; detections: GoesDetection[] }

const DEG = Math.PI / 180;

/** lat/lon (degrees) → fixed-grid scan angles x, y (radians). GOES-R PUG vol. 3, §4.2.8. */
export function lonLatToScan(lon: number, lat: number, p: GoesProjection): [number, number] {
  const phi = lat * DEG, lam = lon * DEG;
  const e2 = (p.req * p.req - p.rpol * p.rpol) / (p.req * p.req);
  const phic = Math.atan(((p.rpol * p.rpol) / (p.req * p.req)) * Math.tan(phi));
  const rc = p.rpol / Math.sqrt(1 - e2 * Math.cos(phic) ** 2);
  const sx = p.h - rc * Math.cos(phic) * Math.cos(lam - p.lon0 * DEG);
  const sy = -rc * Math.cos(phic) * Math.sin(lam - p.lon0 * DEG);
  const sz = rc * Math.sin(phic);
  return [Math.asin(-sy / Math.sqrt(sx * sx + sy * sy + sz * sz)), Math.atan(sz / sx)];
}

/** Fixed-grid scan angles x, y (radians) → lon/lat (degrees); null off the Earth disk. */
export function scanToLonLat(x: number, y: number, p: GoesProjection): [number, number] | null {
  const k = (p.req * p.req) / (p.rpol * p.rpol);
  const a = Math.sin(x) ** 2 + Math.cos(x) ** 2 * (Math.cos(y) ** 2 + k * Math.sin(y) ** 2);
  const b = -2 * p.h * Math.cos(x) * Math.cos(y);
  const c = p.h * p.h - p.req * p.req;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const rs = (-b - Math.sqrt(disc)) / (2 * a);
  const sx = rs * Math.cos(x) * Math.cos(y), sy = -rs * Math.sin(x), sz = rs * Math.cos(x) * Math.sin(y);
  const lat = Math.atan(k * (sz / Math.sqrt((p.h - sx) ** 2 + sy * sy))) / DEG;
  const lon = p.lon0 - Math.atan(sy / (p.h - sx)) / DEG;
  return [lon, lat];
}

/** Scan start (UTC ISO) from a FDCF key, e.g. s20263181500210 → 2026-11-14T15:00:21Z. */
export function scanStartOf(key: string): string | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const [, y, doy, hh, mm, ss] = m;
  const d = new Date(Date.UTC(Number(y), 0, 1) + (Number(doy) - 1) * 86_400_000);
  d.setUTCHours(Number(hh), Number(mm), Number(ss));
  return d.toISOString().replace('.000Z', 'Z');
}

/** Keys of one UTC hour, ascending (S3 ListObjectsV2, XML). */
export async function listHour(date: Date, signal?: AbortSignal): Promise<string[]> {
  const y = date.getUTCFullYear();
  const doy = Math.floor((Date.UTC(y, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
  const prefix = `${PRODUCT}/${y}/${String(doy).padStart(3, '0')}/${String(date.getUTCHours()).padStart(2, '0')}/`;
  const res = await fetch(`${GOES_BUCKET_URL}/?list-type=2&prefix=${encodeURIComponent(prefix)}`, { signal });
  if (!res.ok) throw new Error(`GOES listing HTTP ${res.status}`);
  const xml = await res.text();
  const keys: string[] = [];
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const k = KeySchema.safeParse(m[1]);
    if (k.success) keys.push(k.data);
  }
  return keys.sort();
}

/** The newest FDCF keys (up to `n`), looking back over the last 3 hours. */
export async function latestKeys(n = 3, now = new Date(), signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for (let h = 0; h < 3 && out.length < n; h++) {
    const keys = await listHour(new Date(now.getTime() - h * 3_600_000), signal);
    out.unshift(...keys);
  }
  return out.slice(-n);
}

const num = (v: unknown): number | null => {
  const x = Array.isArray(v) || ArrayBuffer.isView(v) ? (v as ArrayLike<number>)[0] : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'bigint' ? Number(x) : null;
};

interface H5Attr { value: unknown }
interface H5Dataset { shape: number[] | null; attrs: Record<string, H5Attr>; slice(ranges: Array<[number, number]>): unknown; value: unknown }
interface H5File { get(name: string): unknown; attrs: Record<string, H5Attr>; close(): void }
interface H5Module { ready: Promise<unknown>; File: new (filename: string, mode: string) => H5File }

let h5: H5Module | null = null;
async function h5lib(): Promise<H5Module> {
  if (!h5) {
    const mod = (await import('h5wasm/node')) as unknown as { default: H5Module };
    h5 = mod.default;
    await h5.ready;
  }
  return h5;
}
const ds = (f: H5File, name: string): H5Dataset => {
  const d = f.get(name) as H5Dataset | null;
  if (!d || !d.attrs) throw new Error(`FDCF file has no ${name}`);
  return d;
};
const attr = (d: { attrs: Record<string, H5Attr> }, name: string): number | null => (d.attrs[name] ? num(d.attrs[name]!.value) : null);

/**
 * Fire pixels of one FDCF file inside a lon/lat box (confident masks only by default), with FRP.
 * `inside` keeps only points inside the area of interest (e.g. a Goiás municipality).
 */
export async function readFdc(
  file: string,
  bbox: [number, number, number, number],
  opts: { masks?: ReadonlySet<number>; inside?: (lon: number, lat: number) => boolean } = {}
): Promise<{ scanStart: string | null; detections: GoesDetection[] }> {
  const lib = await h5lib();
  const f = new lib.File(file, 'r');
  try {
    const projVar = ds(f, 'goes_imager_projection');
    const hp = attr(projVar, 'perspective_point_height'), req = attr(projVar, 'semi_major_axis'), rpol = attr(projVar, 'semi_minor_axis');
    const lon0 = attr(projVar, 'longitude_of_projection_origin');
    if (hp === null || req === null || rpol === null || lon0 === null) throw new Error('FDCF projection attributes missing');
    const p: GoesProjection = { h: hp + req, req, rpol, lon0 };
    const xv = ds(f, 'x'), yv = ds(f, 'y'), mask = ds(f, 'Mask');
    const xs = attr(xv, 'scale_factor') ?? 1, xo = attr(xv, 'add_offset') ?? 0;
    const ys = attr(yv, 'scale_factor') ?? 1, yo = attr(yv, 'add_offset') ?? 0;
    const [ny, nx] = mask.shape ?? [0, 0];
    if (!ny || !nx) throw new Error('FDCF Mask has no shape');
    // Index window of the box (x grows eastward, y grows northward; row 0 is the north edge).
    const corners = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]].map(([lo, la]) => lonLatToScan(lo!, la!, p));
    const col = (x: number): number => Math.round((x - xo) / xs), row = (y: number): number => Math.round((y - yo) / ys);
    const cs = corners.map(([x]) => col(x!)), rs = corners.map(([, y]) => row(y!));
    const c0 = Math.max(0, Math.min(...cs) - 1), c1 = Math.min(nx, Math.max(...cs) + 2);
    const r0 = Math.max(0, Math.min(...rs) - 1), r1 = Math.min(ny, Math.max(...rs) + 2);
    if (c1 <= c0 || r1 <= r0) return { scanStart: null, detections: [] };
    const w = c1 - c0;
    const m = mask.slice([[r0, r1], [c0, c1]]) as ArrayLike<number>;
    let power: ArrayLike<number> | null = null;
    try { power = ds(f, 'Power').slice([[r0, r1], [c0, c1]]) as ArrayLike<number>; } catch { power = null; }
    const keep = opts.masks ?? CONFIDENT_MASKS;
    const detections: GoesDetection[] = [];
    for (let i = 0; i < m.length; i++) {
      const code = Number(m[i]);
      if (!keep.has(code)) continue;
      const r = r0 + Math.floor(i / w), c = c0 + (i % w);
      const ll = scanToLonLat(c * xs + xo, r * ys + yo, p);
      if (!ll) continue;
      const [lon, lat] = ll;
      if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      if (opts.inside && !opts.inside(lon, lat)) continue;
      const fr = power ? Number(power[i]) : NaN;
      detections.push({ lon: Math.round(lon * 1e4) / 1e4, lat: Math.round(lat * 1e4) / 1e4, mask: code, frpMw: Number.isFinite(fr) && fr > 0 ? Math.round(fr * 10) / 10 : null });
    }
    const tcs = f.attrs['time_coverage_start'];
    const scanStart = tcs && typeof tcs.value === 'string' ? tcs.value : null;
    return { scanStart, detections };
  } finally {
    f.close();
  }
}

/** Download one FDCF file (≈2 MB) to data/goes/, read the Goiás window, delete the file. */
export async function fetchScan(
  key: string,
  bbox: [number, number, number, number],
  inside?: (lon: number, lat: number) => boolean,
  signal?: AbortSignal
): Promise<GoesScan> {
  if (!KeySchema.safeParse(key).success) throw new Error('Invalid GOES key');
  const dir = path.join(config.dataDir, 'goes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(key));
  const res = await fetch(`${GOES_BUCKET_URL}/${key}`, { signal });
  if (!res.ok) throw new Error(`GOES file HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf.length > 30_000_000) throw new Error(`GOES file has an unexpected size (${buf.length} bytes)`);
  fs.writeFileSync(file, buf);
  try {
    const r = await readFdc(file, bbox, { inside });
    return { key, scanStart: r.scanStart ?? scanStartOf(key) ?? '', detections: r.detections };
  } finally {
    try { fs.unlinkSync(file); } catch (err) { logger.warn({ err: String(err) }, 'could not delete GOES temp file'); }
  }
}
