/**
 * NOAA CPC Oceanic Niño Index (ONI) — ENSO context for the forecast and the assistant. Context only, never a cause.
 *
 * Source (no key): https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
 * Format: one row per overlapping 3-month season: `SEAS YR TOTAL ANOM` (e.g. DJF = Dec–Feb, year of the centre month).
 *
 * Phase used here, per centre month: El Niño when ANOM >= +0.5, La Niña when ANOM <= -0.5, neutral otherwise.
 * (CPC's official episodes also require 5 consecutive seasons; this monthly threshold is a documented simplification.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import type { SourceConnector } from '../core/types.js';

export const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt';
export const ONI_CACHE_FILE = 'oni.json';
export const ONI_THRESHOLD = 0.5;

export type EnsoPhase = 'el_nino' | 'la_nina' | 'neutral';

const SEASONS = ['DJF', 'JFM', 'FMA', 'MAM', 'AMJ', 'MJJ', 'JJA', 'JAS', 'ASO', 'SON', 'OND', 'NDJ'] as const;

const OniRowSchema = z.object({
  season: z.enum(SEASONS),
  year: z.coerce.number().int().min(1950).max(2100),
  total: z.coerce.number().min(-5).max(45),
  anom: z.coerce.number().min(-5).max(5),
});

export interface OniRecord {
  /** Year and month (1–12) of the centre month of the 3-month season. */
  year: number;
  month: number;
  season: (typeof SEASONS)[number];
  anom: number;
  phase: EnsoPhase;
}

const OniCacheSchema = z.object({
  fetchedAt: z.string(),
  source: z.literal(ONI_URL),
  records: z.array(
    z.object({
      year: z.number().int(),
      month: z.number().int().min(1).max(12),
      season: z.enum(SEASONS),
      anom: z.number(),
      phase: z.enum(['el_nino', 'la_nina', 'neutral']),
    })
  ),
});
export type OniCache = z.infer<typeof OniCacheSchema>;

export function ensoPhase(anom: number): EnsoPhase {
  return anom >= ONI_THRESHOLD ? 'el_nino' : anom <= -ONI_THRESHOLD ? 'la_nina' : 'neutral';
}

/** Parses the CPC text file. Header and malformed rows are skipped, never thrown. */
export function parseOniText(text: string): OniRecord[] {
  const out: OniRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length !== 4) continue;
    const row = OniRowSchema.safeParse({ season: cols[0], year: cols[1], total: cols[2], anom: cols[3] });
    if (!row.success) continue;
    out.push({
      year: row.data.year,
      month: SEASONS.indexOf(row.data.season) + 1,
      season: row.data.season,
      anom: row.data.anom,
      phase: ensoPhase(row.data.anom),
    });
  }
  return out;
}

export class OniConnector implements SourceConnector<Record<string, never>, OniRecord> {
  public readonly id = 'noaa_oni' as const;
  public readonly license = 'NOAA Climate Prediction Center — public domain (Oceanic Niño Index, ERSSTv5)';

  public async *fetch(_query: Record<string, never>, signal: AbortSignal): AsyncIterable<OniRecord> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(ONI_URL, {
          signal,
          headers: { 'User-Agent': 'MonitorCinder/1.0 (NASA Space Apps 2026 Goiania)', Accept: 'text/plain' },
        });
        if (!res.ok) {
          if (res.status < 500 && res.status !== 429) throw new Error(`Non-retryable HTTP ${res.status}`);
          throw new Error(`HTTP ${res.status}`);
        }
        const records = parseOniText(await res.text());
        if (records.length < 12) throw new Error('Non-retryable: ONI file has fewer than 12 valid rows');
        for (const r of records) yield r;
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt === 3 || lastErr.message.startsWith('Non-retryable')) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }
    throw lastErr ?? new Error('ONI request failed');
  }

  /** Downloads the series and writes data/oni.json. Returns the cache written. */
  public async refreshCache(timeoutMs = 30_000): Promise<OniCache> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const records: OniRecord[] = [];
    try {
      for await (const r of this.fetch({}, ctrl.signal)) records.push(r);
    } finally {
      clearTimeout(timer);
    }
    const cache: OniCache = { fetchedAt: new Date().toISOString(), source: ONI_URL, records };
    fs.writeFileSync(path.join(config.dataDir, ONI_CACHE_FILE), JSON.stringify(cache));
    logger.info({ source: this.id, rows: records.length }, 'ONI cached');
    return cache;
  }
}

export const oniConnector = new OniConnector();

/** Reads data/oni.json (written by job:forecast). Null when it was never downloaded or is invalid. */
export function loadOniCache(): OniCache | null {
  try {
    const parsed = OniCacheSchema.safeParse(JSON.parse(fs.readFileSync(path.join(config.dataDir, ONI_CACHE_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** "YYYY-M" → record, for lookups by centre month. */
export function oniByMonth(records: readonly OniRecord[]): Map<string, OniRecord> {
  return new Map(records.map((r) => [`${r.year}-${r.month}`, r]));
}
