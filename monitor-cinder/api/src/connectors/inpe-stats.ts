import { z } from 'zod';
import { logger } from '../core/logger.js';

/**
 * INPE Programa Queimadas — monthly hotspot counts per state from the reference satellite
 * (AQUA_M-T, MODIS afternoon pass, since 2002-07-04). Used ONLY as external validation of the FIRMS series,
 * never as an input to the harmonization or the anomaly.
 * Source page: https://data.inpe.br/queimadas/estatisticas/?tipo=estados&item=goias
 */
export const INPE_STATS_URL = 'https://data.inpe.br/queimadas/estatisticas/media/estatistica/paises/brasil.json';

const Month = z.number().int().min(0).max(1_000_000).nullable();
const InpeCountry = z.object({
  meta: z.object({ snapshot: z.string().max(40), data_limite: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  historico_mensal: z.array(z.object({
    ano: z.number().int().min(1990).max(2100),
    estado: z.object({ id_estado: z.number().int() }),
    meses: z.record(z.string().regex(/^(1[0-2]|[1-9])$/), Month),
  })).max(100_000),
});

export interface InpeReference {
  source: string;
  url: string;
  snapshot: string;
  dataLimite: string;
  uf: string;
  rows: Array<{ year: number; month: number; focos: number }>;
}

/** Sums every biome row of the state (a hotspot counts once per state in INPE's monthly table). */
export function inpeStateMonthly(raw: unknown, uf: number): InpeReference {
  const j = InpeCountry.parse(raw);
  const m = new Map<number, number>();
  for (const r of j.historico_mensal) {
    if (r.estado.id_estado !== uf) continue;
    for (const [k, v] of Object.entries(r.meses)) {
      if (v === null) continue;
      const key = r.ano * 100 + Number(k);
      m.set(key, (m.get(key) ?? 0) + v);
    }
  }
  const rows = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, focos]) => ({ year: Math.floor(k / 100), month: k % 100, focos }));
  return {
    source: 'INPE Programa Queimadas, monthly hotspots per state, reference satellite (AQUA_M-T since 2002-07-04)',
    url: INPE_STATS_URL, snapshot: j.meta.snapshot, dataLimite: j.meta.data_limite, uf: String(uf), rows,
  };
}

export async function fetchInpeStateMonthly(uf: number, signal: AbortSignal): Promise<InpeReference> {
  logger.info({ source: 'inpe_queimadas', url: INPE_STATS_URL }, 'Fetching INPE state statistics');
  const res = await fetch(INPE_STATS_URL, { signal, headers: { 'User-Agent': 'MonitorCinder/1.0 (NASA Space Apps 2026 Goiania)', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`INPE statistics HTTP ${res.status}`);
  return inpeStateMonthly(await res.json(), uf);
}

export const InpeReferenceSchema = z.object({
  source: z.string(), url: z.string().url(), snapshot: z.string(), dataLimite: z.string(), uf: z.string(),
  rows: z.array(z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), focos: z.number().int().min(0) })),
});
