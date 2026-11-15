import { z } from 'zod';
import { logger } from '../core/logger.js';

/**
 * NASA ORNL DAAC MODIS Web Service (https://modis.ornl.gov/rst/api/v1/). Context only (Contexto tab):
 * MOD13Q1 NDVI and MCD12Q1 land cover at one point. Nothing here enters the harmonization, the anomaly or the projection.
 */

const SubsetSchema = z.object({
  scale: z.union([z.string(), z.number()]).optional(),
  subset: z
    .array(z.object({ modis_date: z.string(), calendar_date: z.string(), band: z.string(), data: z.array(z.number()) }))
    .default([]),
});
type Subset = z.infer<typeof SubsetSchema>;

const BASE = 'https://modis.ornl.gov/rst/api/v1';

/** Second 16-day MOD13Q1 composite of each calendar month (day of year), 1..12. */
const MOD13Q1_DOY = ['017', '049', '081', '113', '145', '177', '209', '241', '257', '289', '321', '353'] as const;

async function getSubset(url: string, timeoutMs: number): Promise<Subset | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return SubsetSchema.parse(await res.json());
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), url }, 'ORNL DAAC MODIS subset unavailable');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Mean MOD13Q1 NDVI (250 m) at the point for one month, or null when the service has no valid pixel. */
export async function fetchNdvi(lat: number, lon: number, year: number, month: number, timeoutMs = 15000): Promise<number | null> {
  const y = Math.min(2025, Math.max(2001, Math.trunc(year)));
  const doy = MOD13Q1_DOY[Math.max(0, Math.min(11, Math.trunc(month) - 1))];
  const date = `A${y}${doy}`;
  const url = `${BASE}/MOD13Q1/subset?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&band=250m_16_days_NDVI&startDate=${date}&endDate=${date}&kmAboveBelow=0&kmLeftRight=0`;
  const parsed = await getSubset(url, timeoutMs);
  if (!parsed) return null;
  const rawScale = Number(parsed.scale);
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 0.0001;
  const values = parsed.subset.flatMap((s) => s.data).filter((v) => Number.isFinite(v) && v >= -2000 && v <= 10000);
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * scale * 1000) / 1000;
}

/**
 * Share of cropland (IGBP classes 12 and 14) among vegetated MCD12Q1 pixels (500 m) in a 7 km × 7 km window
 * around the point, or null when there is no valid pixel.
 */
export async function fetchCroplandPct(lat: number, lon: number, year: number, timeoutMs = 15000): Promise<number | null> {
  const y = Math.min(2024, Math.max(2001, Math.trunc(year)));
  const date = `A${y}001`;
  const url = `${BASE}/MCD12Q1/subset?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&band=LC_Type1&startDate=${date}&endDate=${date}&kmAboveBelow=3&kmLeftRight=3`;
  const parsed = await getSubset(url, timeoutMs);
  const pixels = parsed?.subset[0]?.data ?? [];
  let crop = 0, vegetated = 0;
  for (const c of pixels) {
    if (c >= 1 && c <= 12 || c === 14) vegetated++;
    if (c === 12 || c === 14) crop++;
  }
  return vegetated ? Math.round((crop / vegetated) * 1000) / 10 : null;
}
