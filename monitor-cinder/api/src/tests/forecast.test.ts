import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensoPhase, ONI_THRESHOLD, parseOniText } from '../connectors/oni.js';
import {
  featureRow,
  forecastOne,
  nearestNeighbors,
  quantile,
  validateForecast,
  type ForecastInput,
  type ValidateOptions,
} from '../core/forecast.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Deterministic toy series (no randomness from the clock): 12 municipalities, 2001–2025. */
function toyInput(mutateTestYears = false): ForecastInput {
  const season = [1, 1, 1, 2, 4, 7, 11, 19, 22, 12, 6, 3];
  const series = new Map<string, Map<string, number>>();
  const points: { ibge: string; lat: number; lon: number }[] = [];
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 12; i++) {
    const ibge = String(5200000 + i);
    points.push({ ibge, lat: -15 - i * 0.2, lon: -49 - (i % 3) * 0.3 });
    const bucket = new Map<string, number>();
    for (let y = 2001; y <= 2025; y++) {
      const yearLevel = 0.7 + rnd() * 0.6;
      for (let m = 1; m <= 12; m++) {
        let v = Math.round((i + 1) * season[m - 1]! * yearLevel * (0.8 + rnd() * 0.4));
        if (mutateTestYears && y >= 2020) v = v * 5 + 100;
        bucket.set(`${y}-${m}`, v);
      }
    }
    series.set(ibge, bucket);
  }
  const oni = new Map<string, number>();
  for (let y = 2000; y <= 2025; y++) for (let m = 1; m <= 12; m++) oni.set(`${y}-${m}`, Math.sin(y + m / 12));
  return { series, firstYear: 2001, lastYear: 2025, neighbors: nearestNeighbors(points, 3), oni };
}

const OPTS: ValidateOptions = {
  trainTo: 2019,
  testFrom: 2020,
  testTo: 2025,
  neighborsK: 3,
  dataKind: 'synthetic',
  viirsYears: [],
  factorYears: [],
  source: 'toy',
  oniSource: 'toy',
};

describe('forecast baselines', () => {
  const input = toyInput();

  it('climatology is the mean of the same month in the previous years; persistence is the previous year', () => {
    const row = featureRow(input, '5200003', 2010, 9)!;
    const s = input.series.get('5200003')!;
    const past: number[] = [];
    for (let y = 2001; y < 2010; y++) past.push(s.get(`${y}-9`)!);
    expect(row.climN).toBe(9);
    expect(row.climatology).toBeCloseTo(past.reduce((a, b) => a + b, 0) / past.length, 9);
    expect(row.persistence).toBe(s.get('2009-9'));
    expect(row.climP10).toBeCloseTo(quantile(past, 0.1), 9);
  });

  it('has no features without two previous years', () => {
    expect(featureRow(input, '5200003', 2002, 9)).toBeNull();
    expect(featureRow(input, '9999999', 2010, 9)).toBeNull();
  });
});

describe('temporal validation', () => {
  it('reports both baselines and never trains on test years', () => {
    const v = validateForecast(toyInput(), OPTS);
    expect(v.trainPeriod).toEqual({ from: 2003, to: 2019, dataFrom: 2001 });
    expect(v.testPeriod).toEqual({ from: 2020, to: 2025 });
    expect(v.nTrain).toBe(12 * 12 * 17);
    expect(v.nTest).toBe(12 * 12 * 6);
    for (const key of ['model', 'climatology', 'persistence'] as const) {
      expect(v.mae[key]).toBeGreaterThan(0);
      expect(v.exceedance.brier[key]).toBeGreaterThanOrEqual(0);
    }
    expect(['model', 'climatology']).toContain(v.official);
  });

  it('the fitted model does not change when the test years change (no leakage)', () => {
    const a = validateForecast(toyInput(false), OPTS).model;
    const b = validateForecast(toyInput(true), OPTS).model;
    expect(b.coef).toEqual(a.coef);
    expect(b.intercept).toBe(a.intercept);
    expect(b.residualPercentiles).toEqual(a.residualPercentiles);
  });

  it('refuses a test period that overlaps the training period', () => {
    expect(() => validateForecast(toyInput(), { ...OPTS, testFrom: 2019 })).toThrow();
  });
});

describe('one forecast', () => {
  const input = toyInput();
  const v = validateForecast(input, OPTS);

  it('returns value inside P10–P90, a probability and the threshold n', () => {
    const f = forecastOne(input, v, '5200005', 2026, 9)!;
    expect(f.p10).toBeLessThanOrEqual(f.value);
    expect(f.value).toBeLessThanOrEqual(f.p90);
    expect(f.probAboveP90Pct).toBeGreaterThanOrEqual(0);
    expect(f.probAboveP90Pct).toBeLessThanOrEqual(100);
    expect(f.thresholdN).toBe(19);
    expect(f.observed).toBeNull();
  });

  it('falls back to climatology two years past the data and returns null outside the series', () => {
    const far = forecastOne(input, v, '5200005', 2027, 9)!;
    expect(far.method).toBe('climatology');
    expect(forecastOne(input, v, '3550308', 2026, 9)).toBeNull();
  });
});

describe('ONI connector (fixture cut from the real NOAA file)', () => {
  const text = fs.readFileSync(path.join(here, 'fixtures', 'oni.sample.txt'), 'utf8');
  const records = parseOniText(text);

  it('parses every valid row and skips the header and malformed rows', () => {
    const valid = text.split(/\r?\n/).filter((l) => /^\s*[A-Z]{3}\s+\d{4}\s+-?\d+\.\d+\s+-?\d+\.\d+\s*$/.test(l));
    expect(records.length).toBe(valid.length);
    expect(records.length).toBe(48);
    expect(records.every((r) => r.month >= 1 && r.month <= 12)).toBe(true);
  });

  it('classifies the phase from the anomaly in the file', () => {
    for (const r of records) {
      const expected = r.anom >= ONI_THRESHOLD ? 'el_nino' : r.anom <= -ONI_THRESHOLD ? 'la_nina' : 'neutral';
      expect(r.phase).toBe(expected);
    }
    expect(new Set(records.map((r) => r.phase)).size).toBeGreaterThan(1);
    expect(ensoPhase(0)).toBe('neutral');
  });

  it('maps the season to its centre month (DJF → January)', () => {
    const djf = records.find((r) => r.season === 'DJF')!;
    const ndj = records.find((r) => r.season === 'NDJ')!;
    expect(djf.month).toBe(1);
    expect(ndj.month).toBe(12);
  });
});
