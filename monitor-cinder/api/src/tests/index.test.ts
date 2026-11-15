import { describe, expect, it } from 'vitest';
import { buildChain, fireCellsOfMonth, partialWindow, withPartialAnomaly, cellDetections, cellOf, dailyOfMonth, fromPolyconic, dayNumber, inCircle, monthlyRows, recurrenceFromIndex, withAnomaly, type CellIndex, type IndexCell } from '../core/cell-index.js';
import { computeIndexValidation } from '../core/index-validation.js';

/**
 * Known-answer fixture for the satellite chain. In Aug and Sep of every year:
 * MODIS sees 1 day, S-NPP 3 days (factor 3) and NOAA-20 6 days (factor 0.5 to the S-NPP scale).
 * S-NPP ends on 2026-08-31; NOAA-20 data from 2026-09-01 is near-real-time (provisional). Last day: 2026-11-10.
 */
function fixture(): CellIndex {
  const [gx, gy] = cellOf(-49.25, -16.68);
  const a: IndexCell = [gx, gy, '5208707', [], [], [], []];
  const b: IndexCell = [gx + 40, gy, '5208707', [], [], [], []]; // 40 km east, even years only
  const day = (y: number, m: number, d: number): number => dayNumber(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  for (let y = 2005; y <= 2026; y++) {
    for (const m of [8, 9]) {
      for (const [cell, base, every] of [[a, 10, 1], [b, 3, 2]] as const) {
        if (y % every) continue;
        cell[3].push(day(y, m, base));
        if (y >= 2012 && (y < 2026 || m === 8)) cell[4].push(day(y, m, base), day(y, m, base + 1), day(y, m, base + 2));
        if (y >= 2018) for (let k = 0; k < 6; k++) cell[5].push(day(y, m, base + k));
      }
    }
  }
  return {
    version: 2, builtAt: '2026-11-15T00:00:00Z', source: 'test',
    sensors: {
      MODIS: { first: dayNumber('2005-01-01'), last: dayNumber('2026-11-10'), nrtFrom: null },
      SNPP: { first: dayNumber('2012-01-20'), last: dayNumber('2026-08-31'), nrtFrom: null },
      NOAA20: { first: dayNumber('2018-01-01'), last: dayNumber('2026-11-10'), nrtFrom: dayNumber('2026-09-01') },
      NOAA21: { first: null, last: null, nrtFrom: null },
    },
    staticCellsRemoved: 0,
    cells: [a, b],
  };
}

const at = <T extends { year: number; month: number }>(rows: T[], y: number, m: number): T | undefined => rows.find((r) => r.year === y && r.month === m);

describe('satellite chain (FIRMS index, no PostGIS)', () => {
  it('measures each link: MODIS→S-NPP factor 3 and NOAA-20→S-NPP factor 0.5, with zero error on the test years', () => {
    const chain = buildChain(fixture());
    expect(chain.factor.MODIS[7]).toBeCloseTo(3, 6);
    expect(chain.factor.NOAA20[8]).toBeCloseTo(0.5, 6);
    const v = computeIndexValidation(fixture());
    expect(v.wapePct).toBe(0);
    const n20 = v.links.find((l) => l.link === 'NOAA20→SNPP')!;
    expect(n20.testPeriod).toBe('2024-2025');
    expect(n20.wapePct).toBe(0);
  });

  it('keeps one scale across the switch: MODIS before 2012, S-NPP until it ends, NOAA-20 after', () => {
    const rows = withAnomaly(monthlyRows(fixture(), () => true));
    expect(at(rows, 2008, 8)?.harmonized).toBe(6);   // (1 + 1) MODIS days × 3
    expect(at(rows, 2015, 9)?.harmonized).toBe(3);   // odd year: only cell a, S-NPP 3 days
    expect(at(rows, 2026, 8)?.harmonized).toBe(6);   // S-NPP still on
    expect(at(rows, 2026, 9)?.harmonized).toBe(6);   // NOAA-20: 12 days × 0.5
    expect(at(rows, 2026, 9)?.provisional).toBe(true);
    expect(at(rows, 2026, 8)?.provisional).toBe(false);
    expect(at(rows, 2026, 11)?.partial).toBe(true);
    expect(at(rows, 2026, 11)?.anomalyZ).toBeNull(); // unfinished month is not judged
    expect(at(rows, 2026, 12)).toBeUndefined();      // the future is not a zero
  });

  it('circle and recurrence use the same chain', () => {
    const idx = fixture();
    const small = monthlyRows(idx, inCircle(-49.25, -16.68, 10));
    expect(at(small, 2008, 8)?.harmonized).toBe(3);
    expect(at(small, 2026, 9)?.harmonized).toBe(3);
    const out = recurrenceFromIndex(idx, { west: -54, south: -20, east: -45, north: -12, from: 2005, to: 2026, limit: 10 });
    expect(out.yearsObserved).toBe(22);
    expect(out.cells[0]![3]).toBe(22);   // cell a burned every year
    expect(out.cells[1]![3]).toBe(11);   // cell b: even years 2006–2026
  });

  it('the daily calendar adds up to the month and names the satellite of each day', () => {
    const idx = fixture();
    for (const [y, m] of [[2015, 8], [2026, 9]] as const) {
      const days = dailyOfMonth(idx, () => true, y, m);
      const month = monthlyRows(idx, () => true).find((r) => r.year === y && r.month === m)!;
      const sum = days.reduce((a, d) => a + (d.harmonized ?? 0), 0);
      expect(Math.abs(sum - (month.harmonized ?? 0))).toBeLessThan(0.05 * days.length + 1e-9);
    }
    const sep26 = dailyOfMonth(idx, () => true, 2026, 9);
    expect(sep26.every((d) => d.provisional)).toBe(true);
    expect(sep26.some((d) => d.sensor === 'NOAA20')).toBe(true);
    expect(dailyOfMonth(idx, () => true, 2026, 11)).toHaveLength(10); // stops at the last observed day
    expect(dailyOfMonth(idx, () => true, 2026, 12)).toHaveLength(0);
  });

  it('lists the real detection days (and satellite) behind one map cell', () => {
    const idx = fixture();
    const c = idx.cells.find((x) => (x[5] as number[]).length > 0)!; // a cell NOAA-20 saw
    const d = (c[5] as number[])[0]!;
    const date = new Date(d * 86_400_000);
    const [lon, lat] = fromPolyconic((c[0] + 0.5) * 1000, (c[1] + 0.5) * 1000);
    const r = cellDetections(idx, lon, lat, 1000, date.getUTCFullYear(), date.getUTCMonth() + 1);
    expect(r.cells1km).toBe(1);
    expect(r.days.some((x) => x.sensor === 'NOAA20' && x.date === date.toISOString().slice(0, 10))).toBe(true);
  });

  it('exports the fire cells of a month: every detection day and satellite, harmonized cell-days on the S-NPP scale', () => {
    const idx = fixture();
    const rows = fireCellsOfMonth(idx, () => true, 2024, 9); // even year: both cells burned
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.detections.some((d) => d.date === '2024-09-10'))!;
    expect(a.ibge).toBe('5208707');
    // S-NPP was in use: 3 S-NPP days count (factor 1); the MODIS and NOAA-20 detections are listed but not added
    expect(a.cellDays).toBe(3);
    expect(a.detections.filter((d) => d.sensor === 'SNPP')).toHaveLength(3);
    expect(a.detections.filter((d) => d.sensor === 'NOAA20')).toHaveLength(6);
    expect(a.detections.filter((d) => d.sensor === 'MODIS')).toHaveLength(1);
    expect(fireCellsOfMonth(idx, () => true, 2024, 7)).toHaveLength(0);
    // after S-NPP ended, NOAA-20 days are marked provisional
    expect(fireCellsOfMonth(idx, () => true, 2026, 9)[0]!.detections.every((d) => d.sensor !== 'NOAA20' || d.provisional)).toBe(true);
  });

  it('judges the month in progress against the same days of earlier years', () => {
    const idx = fixture();
    const pw = partialWindow(idx, () => 'all');
    expect(pw).not.toBeNull();
    expect(pw!.lastDom).toBe(10); // fixture ends 2026-11-10
    const rows = withPartialAnomaly(withAnomaly(monthlyRows(idx, () => true)), pw, pw!.sums.get('all'));
    const nov = rows.find((r) => r.year === 2026 && r.month === 11)!;
    expect(nov.partial).toBe(true);
    expect(nov.partialDays).toBe(10);
    expect(nov.anomalyZ === null || Number.isFinite(nov.anomalyZ)).toBe(true);
    // a complete month keeps the whole-month anomaly
    expect(rows.find((r) => r.year === 2015 && r.month === 8)!.partialDays).toBeUndefined();
  });
});
