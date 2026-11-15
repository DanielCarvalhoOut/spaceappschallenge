import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lonLatToScan, readFdc, scanStartOf, scanToLonLat, type GoesProjection, type GoesScan } from '../connectors/goes-fdc.js';
import { confirmAlerts, emptyState, kmBetween, newWatch, persistentPixels, updateAlerts } from '../core/goes-watch.js';

// GOES-19 (GOES-East) fixed-grid constants, as in the FDCF goes_imager_projection attributes.
const P: GoesProjection = { h: 35786023 + 6378137, req: 6378137, rpol: 6356752.31414, lon0: -75.2 };
const GOIANIA: [number, number] = [-49.25, -16.68];
const GOIAS_BOX: [number, number, number, number] = [-53.3, -19.55, -45.85, -12.35];

/** Writes a small NetCDF-4/HDF5 file shaped like FDCF: packed x/y, Mask, Power, projection attributes. */
async function syntheticFdc(file: string, fires: Array<{ lon: number; lat: number; mask: number; power: number }>): Promise<void> {
  const h5 = (await import('h5wasm/node')).default as unknown as {
    ready: Promise<unknown>;
    File: new (f: string, m: string) => {
      create_dataset(o: { name: string; data: ArrayLike<number> | number; shape: number[]; dtype: string }): void;
      get(n: string): { create_attribute(n: string, v: number | string, s: null, d: string | null): void };
      create_attribute(n: string, v: string): void;
      close(): void;
    };
  };
  await h5.ready;
  const xs = 5.6e-5, ys = -5.6e-5;
  // grid that starts a little west/north of Goiás (row 0 = north edge), like a window of the full disk
  const [xw] = lonLatToScan(-54.5, -16, P), [, yn] = lonLatToScan(-49, -11.5, P);
  const nx = 600, ny = 600, xo = xw, yo = yn;
  const x = Int16Array.from({ length: nx }, (_, i) => i), y = Int16Array.from({ length: ny }, (_, i) => i);
  const mask = new Int16Array(nx * ny).fill(40); // 40 = processed, no fire
  const power = new Float32Array(nx * ny).fill(-1);
  for (const f of fires) {
    const [sx, sy] = lonLatToScan(f.lon, f.lat, P);
    const c = Math.round((sx - xo) / xs), r = Math.round((sy - yo) / ys);
    if (c < 0 || c >= nx || r < 0 || r >= ny) continue;
    mask[r * nx + c] = f.mask; power[r * nx + c] = f.power;
  }
  const f = new h5.File(file, 'w');
  f.create_dataset({ name: 'x', data: x, shape: [nx], dtype: '<h' });
  f.get('x').create_attribute('scale_factor', xs, null, '<f'); f.get('x').create_attribute('add_offset', xo, null, '<f');
  f.create_dataset({ name: 'y', data: y, shape: [ny], dtype: '<h' });
  f.get('y').create_attribute('scale_factor', ys, null, '<f'); f.get('y').create_attribute('add_offset', yo, null, '<f');
  f.create_dataset({ name: 'Mask', data: mask, shape: [ny, nx], dtype: '<h' });
  f.create_dataset({ name: 'Power', data: power, shape: [ny, nx], dtype: '<f' });
  f.create_dataset({ name: 'goes_imager_projection', data: new Int32Array([-2147483647]), shape: [], dtype: '<i' });
  const p = f.get('goes_imager_projection');
  p.create_attribute('perspective_point_height', 35786023, null, '<d');
  p.create_attribute('semi_major_axis', 6378137, null, '<d');
  p.create_attribute('semi_minor_axis', 6356752.31414, null, '<d');
  p.create_attribute('longitude_of_projection_origin', -75.2, null, '<d');
  f.create_attribute('time_coverage_start', '2026-11-14T15:00:21.0Z');
  f.close();
}

const scan = (t: string, pts: Array<[number, number]>): GoesScan => ({
  key: `k${t}`, scanStart: t, detections: pts.map(([lon, lat]) => ({ lon, lat, mask: 10, frpMw: 20 })),
});

describe('GOES-19 fire product (early notice for watched areas)', () => {
  it('converts lat/lon to the GOES fixed grid and back to within a few metres', () => {
    for (const [lon, lat] of [GOIANIA, [-49.15, -13.44], [-50.93, -17.8], [-47.51, -14.13]] as Array<[number, number]>) {
      const [x, y] = lonLatToScan(lon, lat, P);
      const back = scanToLonLat(x, y, P)!;
      expect(kmBetween(lon, lat, back[0], back[1])).toBeLessThan(0.01);
    }
    expect(scanToLonLat(0.2, 0.2, P)).toBeNull(); // off the Earth disk
  });

  it('reads the scan time from the NOAA file name', () => {
    expect(scanStartOf('ABI-L2-FDCF/2026/318/15/OR_ABI-L2-FDCF-M6_G19_s20263181500210_e20263181509518_c20263181510013.nc'))
      .toBe('2026-11-14T15:00:21Z');
    expect(scanStartOf('../../etc/passwd')).toBeNull();
  });

  it('reads only confident fire pixels inside Goiás from an FDCF-shaped NetCDF file', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fdc-')), 'scan.nc');
    await syntheticFdc(file, [
      { lon: GOIANIA[0], lat: GOIANIA[1], mask: 10, power: 35.5 },   // processed fire, Goiânia → kept
      { lon: -49.15, lat: -13.44, mask: 31, power: 80 },             // saturated (temporally filtered), Porangatu → kept
      { lon: -48.0, lat: -15.0, mask: 15, power: 5 },                // low probability → dropped
      { lon: -54.2, lat: -15.0, mask: 10, power: 9 },                // Mato Grosso, outside the box → dropped
    ]);
    const r = await readFdc(file, GOIAS_BOX);
    expect(r.scanStart).toBe('2026-11-14T15:00:21.0Z');
    expect(r.detections).toHaveLength(2);
    const g = r.detections.find((d) => kmBetween(d.lon, d.lat, GOIANIA[0], GOIANIA[1]) < 3);
    expect(g?.mask).toBe(10);
    expect(g?.frpMw).toBe(35.5);
    expect(r.detections.some((d) => kmBetween(d.lon, d.lat, -49.15, -13.44) < 3)).toBe(true);
  });

  it('keeps a pixel only when it persists in 2 of the last 3 scans', () => {
    const scans = [
      scan('2026-11-14T15:00:21Z', [[-49.25, -16.68]]),
      scan('2026-11-14T15:10:21Z', [[-49.25, -16.68], [-50.0, -15.0]]),
      scan('2026-11-14T15:20:21Z', [[-49.251, -16.681], [-48.0, -14.0]]), // same pixel (≤ 2 km) + a one-off
    ];
    const p = persistentPixels(scans);
    expect(p).toHaveLength(1);
    expect(p[0]!.scansSeen).toBe(3);
    expect(p[0]!.firstSeen).toBe('2026-11-14T15:00:21Z');
  });

  it('opens one alert per watched area with historical context, then VIIRS confirms or not', () => {
    const s = emptyState();
    const near = newWatch({ lon: -49.3, lat: -16.7, radiusKm: 20 }, 'Goiânia 20 km');
    const far = newWatch({ lon: -47.5, lat: -14.1, radiusKm: 20 }, 'Alto Paraíso');
    s.watches.push(near, far);
    s.scans = [scan('2026-11-14T15:00:21Z', [GOIANIA]), scan('2026-11-14T15:10:21Z', [GOIANIA])];
    const ctx = { municipality: 'Goiânia', ibge: '5208707', yearsWithFire: 4, yearsObserved: 25, anomalyZ: 1.8, monthCellDays: 12 };
    const deps = {
      inArea: (a: { lon?: number; lat?: number; radiusKm?: number }, lon: number, lat: number) =>
        a.lon !== undefined && kmBetween(a.lon, a.lat!, lon, lat) <= a.radiusKm!,
      context: () => ctx,
    };
    const fresh = updateAlerts(s, deps as Parameters<typeof updateAlerts>[1]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.watchId).toBe(near.id);
    expect(fresh[0]!.context.yearsWithFire).toBe(4);
    // the same pixel in the next scan refreshes the alert instead of opening another
    s.scans.push(scan('2026-11-14T15:20:21Z', [GOIANIA]));
    expect(updateAlerts(s, deps as Parameters<typeof updateAlerts>[1])).toHaveLength(0);
    expect(s.alerts[0]!.scansSeen).toBe(3);
    // VIIRS: too early (< 3 h) → still persistent; a NOAA-20 point 1 km away the same day → confirmed
    expect(confirmAlerts(s, [], new Date('2026-11-14T16:00:00Z'))).toBe(0);
    expect(confirmAlerts(s, [{ lon: -49.26, lat: -16.68, date: '2026-11-14' }], new Date('2026-11-14T19:00:00Z'))).toBe(1);
    expect(s.alerts[0]!.status).toBe('confirmed');
  });

  it('marks an alert not confirmed when no VIIRS detection comes within 30 h', () => {
    const s = emptyState();
    const w = newWatch({ lon: -49.3, lat: -16.7, radiusKm: 20 }, 'x');
    s.watches.push(w);
    s.scans = [scan('2026-11-14T15:00:21Z', [GOIANIA]), scan('2026-11-14T15:10:21Z', [GOIANIA])];
    updateAlerts(s, { inArea: () => true, context: () => ({ municipality: null, ibge: null, yearsWithFire: null, yearsObserved: null, anomalyZ: null, monthCellDays: null }) });
    expect(confirmAlerts(s, [{ lon: -40, lat: -10, date: '2026-11-14' }], new Date('2026-11-15T22:00:00Z'))).toBe(1);
    expect(s.alerts[0]!.status).toBe('not_confirmed');
  });
});
