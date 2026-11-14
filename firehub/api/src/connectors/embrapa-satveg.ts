import { config } from '../config.js';
import { logger } from '../core/logger.js';
import type { SourceConnector } from '../core/types.js';

export interface SatVegQuery {
  latitude: number;
  longitude: number;
  year: number;
}

export interface SatVegRecord {
  year: number;
  ndviDryMean: number;
}

export class EmbrapaSatVegConnector implements SourceConnector<SatVegQuery, SatVegRecord> {
  public readonly id = 'embrapa_satveg' as const;
  public readonly license = 'Embrapa Agricultura Digital — SATVeg / AgroAPI (MOD13Q1/MYD13Q1 NDVI/EVI)';

  public async *fetch(query: SatVegQuery, _signal: AbortSignal): AsyncIterable<SatVegRecord> {
    if (!config.EMBRAPA_CONSUMER_KEY || !config.EMBRAPA_CONSUMER_SECRET) {
      logger.debug('Embrapa SATVeg credentials not configured; skipping live OAuth call');
      return;
    }
    yield* [];
  }
}

export const embrapaSatVegConnector = new EmbrapaSatVegConnector();
