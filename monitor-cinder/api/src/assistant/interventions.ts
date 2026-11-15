/**
 * Declared interventions (firebreaks, brigades, prescribed burns, campaigns…) registered by a person, with a source.
 * In PostGIS they live in fire.intervention (db/schema_intervencao.sql). Without the database the API reads the
 * registry file seed/interventions.json (same fields). The registry starts empty: nothing here is invented.
 *
 * The comparison is descriptive: same seasonal window (May–Oct) before and after, and the forecast of the first season
 * after the date as the expected level. It is reported as an association, never as the effect of the intervention.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { logger } from '../core/logger.js';

export const InterventionSchema = z.object({
  ibge: z.string().regex(/^52\d{5}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.string().min(2).max(80),
  source: z.string().min(3).max(300),
  registeredBy: z.string().min(2).max(120),
});
export type Intervention = z.infer<typeof InterventionSchema>;

export const SEASON_FROM = 5;
export const SEASON_TO = 10;
export const BEFORE_YEARS = 3;

const here = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_FILE = path.resolve(here, '../../seed/interventions.json');

export function parseInterventions(raw: unknown): Intervention[] {
  const parsed = z.array(InterventionSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function loadInterventions(file = REGISTRY_FILE): Intervention[] {
  try {
    return parseInterventions(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'intervention registry not readable; treating it as empty');
    return [];
  }
}

export interface ComparisonDeps {
  firstYear: number;
  lastYear: number;
  value: (year: number, month: number) => number | null;
  forecast: (year: number, month: number) => number | null;
}

function seasonTotal(get: (y: number, m: number) => number | null, year: number): number | null {
  let s = 0;
  for (let m = SEASON_FROM; m <= SEASON_TO; m++) {
    const v = get(year, m);
    if (v === null) return null;
    s += v;
  }
  return Math.round(s * 10) / 10;
}

export function compareIntervention(i: Intervention, d: ComparisonDeps): Record<string, unknown> {
  const year = Number(i.date.slice(0, 4));
  const month = Number(i.date.slice(5, 7));
  // First dry season that starts after the intervention date.
  const firstAfter = month < SEASON_FROM ? year : year + 1;
  const before: number[] = [];
  for (let y = firstAfter - BEFORE_YEARS; y < firstAfter; y++) {
    if (y === year && month >= SEASON_FROM) continue; // the season in which the intervention happened is neither before nor after
    const t = y >= d.firstYear ? seasonTotal(d.value, y) : null;
    if (t !== null) before.push(t);
  }
  const after: number[] = [];
  for (let y = firstAfter; y <= d.lastYear; y++) {
    const t = seasonTotal(d.value, y);
    if (t !== null) after.push(t);
  }
  const avg = (a: number[]): number | null => (a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : null);
  return {
    window: `months ${SEASON_FROM}-${SEASON_TO}`,
    beforeMean: avg(before),
    beforeN: before.length,
    afterMean: avg(after),
    afterN: after.length,
    firstSeasonAfter: firstAfter <= d.lastYear ? firstAfter : null,
    firstSeasonObserved: firstAfter <= d.lastYear ? seasonTotal(d.value, firstAfter) : null,
    firstSeasonForecast: firstAfter <= d.lastYear ? seasonTotal(d.forecast, firstAfter) : null,
  };
}
