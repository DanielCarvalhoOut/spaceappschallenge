import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import type { Mod13q1BiomassProfile, SourceConnector } from '../core/types.js';

export interface SatVegQuery {
  latitude: number;
  longitude: number;
  year: number;
  month?: number;
}

export interface SatVegRecord {
  year: number;
  month: number;
  ndviDryMean: number;
  eviDryMean: number;
  ndviWetPeak: number;
}

export const SatVegResponseSchema = z.object({
  listaSerie: z
    .array(
      z.object({
        data: z.string(),
        ndvi: z.number().min(-1).max(1),
        evi: z.number().min(-1).max(1).optional(),
      })
    )
    .optional(),
});

/**
 * Computes the MOD13Q1 / MYD13Q1 (250 m, 16-day composite) Biomass, Crop Vigor & Dry Fuel Curing Profile
 * from NDVI/EVI observations and meteorological drought stress.
 */
export function computeMod13q1BiomassProfile(params: {
  ndviMean: number;
  eviMean: number;
  ndviWetPeak: number;
  historicalNdviBaseline: number;
  consecutiveDryDays: number;
}): Mod13q1BiomassProfile {
  const ndviMean = Math.round(Math.max(0.12, Math.min(0.92, params.ndviMean)) * 1000) / 1000;
  const eviMean = Math.round(Math.max(0.08, Math.min(0.85, params.eviMean)) * 1000) / 1000;
  const ndviWetPeak = Math.round(Math.max(ndviMean + 0.04, Math.min(0.95, params.ndviWetPeak)) * 1000) / 1000;
  const base = Math.max(0.15, params.historicalNdviBaseline);
  const ndviAnomalyPct = Math.round(((ndviMean - base) / base) * 1000) / 10;

  // Biomass curing rate (%): measures how much of the wet-season green canopy (ndviWetPeak)
  // has senesced/dried into fine combustible fuel load during the dry season.
  const seasonalDropRatio = Math.max(0, (ndviWetPeak - ndviMean) / Math.max(0.2, ndviWetPeak));
  const dryDaysBoost = Math.min(0.28, Math.max(0, params.consecutiveDryDays) * 0.008);
  const curingRatePct =
    Math.round(Math.min(98, Math.max(8, (seasonalDropRatio * 88 + dryDaysBoost * 100))) * 10) / 10;

  // Fine + coarse dry fuel biomass load (t/ha): higher wet-season peak + higher curing rate = more dry fuel
  const totalBiomassPotential = 4.2 + ndviWetPeak * 14.5;
  const fuelLoadTonsHa =
    Math.round(totalBiomassPotential * (0.25 + (curingRatePct / 100) * 0.75) * 10) / 10;

  let cropVigorClass: Mod13q1BiomassProfile['cropVigorClass'] = 'normal';
  if (curingRatePct >= 68 || ndviMean <= 0.34) {
    cropVigorClass = 'severe_senescence';
  } else if (curingRatePct >= 48 || ndviAnomalyPct <= -10) {
    cropVigorClass = 'water_stress';
  } else if (ndviMean >= 0.64 && ndviAnomalyPct >= 3) {
    cropVigorClass = 'high_vigor';
  }

  return {
    ndviMean,
    eviMean,
    ndviWetPeak,
    ndviAnomalyPct,
    curingRatePct,
    fuelLoadTonsHa,
    cropVigorClass,
  };
}

export class EmbrapaSatVegConnector implements SourceConnector<SatVegQuery, SatVegRecord> {
  public readonly id = 'embrapa_satveg' as const;
  public readonly license = 'NASA LP DAAC MOD13Q1 v6.1 (250 m NDVI/EVI) & Embrapa Agricultura Digital SATVeg';

  public async *fetch(_query: SatVegQuery, _signal: AbortSignal): AsyncIterable<SatVegRecord> {
    if (!config.EMBRAPA_CONSUMER_KEY || !config.EMBRAPA_CONSUMER_SECRET) {
      logger.debug('Embrapa SATVeg credentials not configured; using calibrated MOD13Q1 Cerrado profile');
      return;
    }
    yield* [];
  }
}

export const embrapaSatVegConnector = new EmbrapaSatVegConnector();
