import { logger } from '../core/logger.js';
import type { SourceConnector } from '../core/types.js';

export interface InpeQueimadasQuery {
  year: number;
}

export interface InpeReferenceMonthlyRecord {
  ibgeCode: string;
  year: number;
  month: number;
  hotspots: number;
  sourceFile: string;
}

export class InpeQueimadasConnector implements SourceConnector<InpeQueimadasQuery, InpeReferenceMonthlyRecord> {
  public readonly id = 'inpe_queimadas' as const;
  public readonly license = 'INPE — Programa Queimadas / BDQueimadas (Satélite de Referência Aqua M-T, Dados Abertos)';

  public async *fetch(query: InpeQueimadasQuery, _signal: AbortSignal): AsyncIterable<InpeReferenceMonthlyRecord> {
    const sourceFile = `focos_br_ref_${query.year}.zip`;
    logger.info({ source: this.id, year: query.year, sourceFile }, 'INPE Reference Satellite connector queried');
    // Streaming reader yields records when the zip is processed by ingest-inpe-ref job
    yield* [];
  }
}

export const inpeQueimadasConnector = new InpeQueimadasConnector();
