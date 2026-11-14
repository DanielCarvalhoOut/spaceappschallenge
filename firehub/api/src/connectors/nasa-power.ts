import { z } from 'zod';
import { logger } from '../core/logger.js';
import type { NasaPowerDailyRecord, SourceConnector } from '../core/types.js';

export interface NasaPowerQuery {
  latitude: number;
  longitude: number;
  startDate: string; // YYYYMMDD
  endDate: string; // YYYYMMDD
}

const PowerDailyResponseSchema = z.object({
  properties: z.object({
    parameter: z.object({
      T2M_MAX: z.record(z.string(), z.number()).optional(),
      RH2M: z.record(z.string(), z.number()).optional(),
      PRECTOTCORR: z.record(z.string(), z.number()).optional(),
      WS10M: z.record(z.string(), z.number()).optional(),
      WD10M: z.record(z.string(), z.number()).optional(),
    }),
  }),
});

function cleanPowerValue(val: number | undefined, minValid: number, maxValid: number): number | null {
  if (val === undefined || !Number.isFinite(val) || val <= -900) return null;
  if (val < minValid || val > maxValid) return null;
  return Math.round(val * 100) / 100;
}

/**
 * Builds the NASA POWER Daily Point URL:
 * GET https://power.larc.nasa.gov/api/temporal/daily/point
 * Essential variables: T2M_MAX, RH2M, PRECTOTCORR, WS10M, WD10M
 */
export function buildNasaPowerDailyUrl(query: NasaPowerQuery): string {
  const params = new URLSearchParams({
    parameters: 'T2M_MAX,RH2M,PRECTOTCORR,WS10M,WD10M',
    community: 'AG',
    longitude: query.longitude.toFixed(4),
    latitude: query.latitude.toFixed(4),
    start: query.startDate.replace(/-/g, ''),
    end: query.endDate.replace(/-/g, ''),
    format: 'JSON',
  });
  return `https://power.larc.nasa.gov/api/temporal/daily/point?${params.toString()}`;
}

export function parseNasaPowerDailyJson(payload: unknown): NasaPowerDailyRecord[] {
  const parsed = PowerDailyResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid NASA POWER response schema: ${parsed.error.message}`);
  }
  const p = parsed.data.properties.parameter;
  const dateKeys = new Set<string>([
    ...Object.keys(p.T2M_MAX ?? {}),
    ...Object.keys(p.RH2M ?? {}),
    ...Object.keys(p.PRECTOTCORR ?? {}),
    ...Object.keys(p.WS10M ?? {}),
    ...Object.keys(p.WD10M ?? {}),
  ]);

  const sortedKeys = [...dateKeys].filter((k) => /^\d{8}$/.test(k)).sort();
  const out: NasaPowerDailyRecord[] = [];

  for (const k of sortedKeys) {
    const date = `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
    out.push({
      date,
      t2mMaxC: cleanPowerValue(p.T2M_MAX?.[k], -50, 65),
      rh2mPct: cleanPowerValue(p.RH2M?.[k], 0, 100),
      prectotcorrMm: cleanPowerValue(p.PRECTOTCORR?.[k], 0, 1000),
      ws10mMs: cleanPowerValue(p.WS10M?.[k], 0, 80),
      wd10mDeg: cleanPowerValue(p.WD10M?.[k], 0, 360),
    });
  }

  return out;
}

export class NasaPowerConnector implements SourceConnector<NasaPowerQuery, NasaPowerDailyRecord> {
  public readonly id = 'nasa_power' as const;
  public readonly license = 'NASA Langley Research Center (LaRC) POWER Project (MERRA-2 / GEOS)';

  public async *fetch(query: NasaPowerQuery, signal: AbortSignal): AsyncIterable<NasaPowerDailyRecord> {
    const url = buildNasaPowerDailyUrl(query);
    logger.info({ source: this.id, lat: query.latitude, lon: query.longitude, start: query.startDate, end: query.endDate }, 'Fetching NASA POWER daily climate data');

    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': 'FireHub-MonitorCinder/1.0 (NASA Space Apps 2026 Goiania)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`NASA POWER HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    const records = parseNasaPowerDailyJson(json);
    for (const r of records) {
      yield r;
    }
  }

  public async fetchRange(
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string,
    timeoutMs = 10000
  ): Promise<NasaPowerDailyRecord[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const out: NasaPowerDailyRecord[] = [];
    try {
      for await (const rec of this.fetch({ latitude, longitude, startDate, endDate }, ctrl.signal)) {
        out.push(rec);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const nasaPowerConnector = new NasaPowerConnector();
