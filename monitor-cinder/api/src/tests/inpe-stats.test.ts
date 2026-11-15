import { describe, expect, it } from 'vitest';
import { inpeStateMonthly } from '../connectors/inpe-stats.js';

describe('INPE state statistics (external validation only)', () => {
  it('sums every biome row of the state and ignores other states and null months', () => {
    const raw = {
      meta: { snapshot: '20261115T040001', data_limite: '2026-11-14' },
      historico_mensal: [
        { ano: 2024, estado: { id_estado: 52 }, meses: { '8': 100, '9': 300, '10': null } },
        { ano: 2024, estado: { id_estado: 52 }, meses: { '8': 20, '9': 11 } },
        { ano: 2024, estado: { id_estado: 51 }, meses: { '8': 999 } },
      ],
    };
    const r = inpeStateMonthly(raw, 52);
    expect(r.rows).toEqual([{ year: 2024, month: 8, focos: 120 }, { year: 2024, month: 9, focos: 311 }]);
    expect(r.dataLimite).toBe('2026-11-14');
  });
  it('rejects a payload that is not INPE statistics', () => {
    expect(() => inpeStateMonthly({ foo: 1 }, 52)).toThrow();
  });
});
