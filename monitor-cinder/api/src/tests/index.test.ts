import { describe, expect, it } from 'vitest';
import { cellOf, circleSeriesFromIndex, dayNumber, recurrenceFromIndex, type CellIndex, type IndexCell } from '../core/cell-index.js';
import { computeIndexValidation } from '../core/index-validation.js';

// Known-answer fixture: two cells in Goiânia's area; MODIS sees 1 day per month where VIIRS sees 3 (factor 3).
function fixture(): CellIndex {
  const [gx, gy] = cellOf(-49.25, -16.68);
  const a: IndexCell = [gx, gy, '5208707', [], []];
  const b: IndexCell = [gx + 40, gy, '5208707', [], []]; // 40 km east
  for (let y = 2005; y <= 2025; y++) {
    for (const m of [8, 9]) {
      const d = (dd: number): number => dayNumber(`${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
      a[3].push(d(10));
      if (y >= 2012) a[4].push(d(10), d(11), d(12));
      if (y % 2 === 0) { b[3].push(d(5)); if (y >= 2012) b[4].push(d(5), d(6), d(7)); }
    }
  }
  return {
    version: 1, builtAt: '2026-11-15T00:00:00Z', source: 'test',
    yearsLoaded: { MODIS: Array.from({ length: 21 }, (_, i) => 2005 + i), VIIRS: Array.from({ length: 14 }, (_, i) => 2012 + i) },
    monthlyFactors: [null, null, null, null, null, null, null, 3, 3, null, null, null],
    staticCellsRemoved: 0,
    cells: [a, b],
  };
}

describe('FIRMS cell index (no PostGIS)', () => {
  it('validation reproduces the known factor: zero error when VIIRS = 3 × MODIS', () => {
    const v = computeIndexValidation(fixture());
    expect(v.source).toBe('firms_index');
    expect(v.monthlyRatioFactors[7]).toBe(3);
    expect(v.wapePct).toBe(0);
    expect(v.biasPct).toBe(0);
    expect(v.nMonths).toBe(12); // 2020–2025 × Aug, Sep
  });

  it('circle series counts only the cells inside the radius and harmonizes MODIS before 2012', () => {
    const idx = fixture();
    const small = circleSeriesFromIndex(idx, -49.25, -16.68, 10);
    const big = circleSeriesFromIndex(idx, -49.25, -16.68, 60);
    const at = (rows: typeof small, y: number, m: number) => rows.find((r) => r.year === y && r.month === m)!;
    expect(at(small, 2008, 8)).toMatchObject({ modis: 1, viirs: null, harmonized: 3 });
    expect(at(big, 2008, 8)).toMatchObject({ modis: 2, harmonized: 6 });
    expect(at(small, 2020, 9)).toMatchObject({ viirs: 3, harmonized: 3 });
    expect(at(small, 2020, 1).harmonized).toBe(0);
  });

  it('recurrence counts years burned per cell, with the 3×3 neighbourhood', () => {
    const out = recurrenceFromIndex(fixture(), { west: -54, south: -20, east: -45, north: -12, from: 2005, to: 2025, limit: 10 });
    expect(out.yearsObserved).toBe(21);
    expect(out.cells[0]![3]).toBe(21);          // cell a burned every year
    expect(out.cells[1]![3]).toBe(10);          // cell b only in even years (2006–2024)
    expect(out.cells[0]![5]).toBe(8);           // peak month August (tie broken by the first month)
  });
});
