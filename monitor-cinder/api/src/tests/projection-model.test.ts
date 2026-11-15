import { describe, expect, it } from 'vitest';
import { crps, fitModel, hindcast, projectFrom, simulate, type DailyInput } from '../core/projection-model.js';

const DAY = 86_400_000;

/** Test series drawn from a known seasonal negative-binomial process with memory (only to check the estimator). */
function knownProcess(): { input: DailyInput; beta: number[] } {
  const beta = [-1.2, -0.9, -1.6, 0.3, 0.2, 0.25, 0.25, 0.2];
  const first = Date.UTC(2001, 0, 1) / DAY, last = Date.UTC(2026, 10, 10) / DAY;
  const seedInput: DailyInput = { first, values: new Array<number | null>(30).fill(1) };
  const model = { beta, theta: 2, trainedUntil: first, nTrain: 0 };
  const paths = simulate(model, seedInput, first + 29, last - first - 29, 1, 7);
  const values: Array<number | null> = [...new Array<number>(30).fill(1), ...Array.from(paths[0]!)];
  for (let d = Date.UTC(2015, 3, 1) / DAY; d < Date.UTC(2015, 3, 12) / DAY; d++) values[d - first] = null; // an outage
  return { input: { first, values }, beta };
}

describe('projection model (daily negative binomial, simulated horizons)', () => {
  it('CRPS of an ensemble equals the absolute error for a single member and rewards sharp, centred ensembles', () => {
    expect(crps([5], 3)).toBe(2);
    expect(crps([2, 3, 4], 3)).toBeLessThan(crps([0, 3, 6], 3));
  });

  it('recovers the season and memory of a known process', () => {
    const { input, beta } = knownProcess();
    const m = fitModel(input, Date.UTC(2025, 11, 31) / DAY)!;
    expect(m).not.toBeNull();
    expect(m.beta[2]!).toBeLessThan(-1);          // strong annual cycle (cos term), as in the process
    expect(Math.abs(m.beta[2]! - beta[2]!)).toBeLessThan(0.5);
    expect(m.theta).toBeGreaterThan(0.5);
    expect(m.theta).toBeLessThan(8);
  });

  it('hindcast beats the climatological reference on a process with memory, with honest P10–P90 coverage', () => {
    const { input } = knownProcess();
    const h = hindcast(input, { paths: 120, twicePerMonth: false })!;
    expect(h.horizons.month.n).toBeGreaterThan(100);
    expect(h.horizons.fortnight.skillPct!).toBeGreaterThan(0);
    expect(h.horizons.month.coveragePct!).toBeGreaterThan(60);
    expect(h.horizons.month.coveragePct!).toBeLessThan(95);
  }, 60_000);

  it('projects from the last observed day: 15 daily probabilities, months that add up, no number without a band', () => {
    const { input } = knownProcess();
    const p = projectFrom(input, 300)!;
    expect(p.asOf).toBe('2026-11-10');
    expect(p.daily).toHaveLength(15);
    expect(p.daily[0]!.date).toBe('2026-11-11');
    expect(p.months[0]).toMatchObject({ year: 2026, month: 11, partial: true });
    for (const m of p.months) expect(m.p10).toBeLessThanOrEqual(m.p90);
    expect(p.semester.p50).toBeGreaterThan(p.fortnight.p50);
  });
});
