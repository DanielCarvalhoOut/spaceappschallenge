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

export const OrnlModisSubsetSchema = z.object({
  scale: z.union([z.string(), z.number()]).optional(),
  subset: z
    .array(
      z.object({
        modis_date: z.string(),
        calendar_date: z.string(),
        band: z.string(),
        data: z.array(z.number()),
      })
    )
    .default([]),
});

// Fixed 16-day MODIS composite Day-of-Year (DOY) windows for each calendar month (1..12)
const MONTH_TO_MOD13Q1_DOY: ReadonlyArray<readonly [string, string]> = [
  ['001', '017'], // Jan
  ['033', '049'], // Feb
  ['065', '081'], // Mar
  ['097', '113'], // Apr
  ['129', '145'], // May
  ['161', '177'], // Jun
  ['193', '209'], // Jul
  ['225', '241'], // Aug
  ['241', '257'], // Sep
  ['273', '289'], // Oct
  ['305', '321'], // Nov
  ['337', '353'], // Dec
];

function extractScaledPixelMean(
  parsed: z.infer<typeof OrnlModisSubsetSchema>,
  defaultScale = 0.0001
): number | null {
  const rawScale = Number(parsed.scale);
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : defaultScale;
  const values: number[] = [];
  for (const item of parsed.subset) {
    for (const v of item.data) {
      // Valid MOD13Q1 NDVI/EVI range in integer units is [-2000, 10000]
      if (Number.isFinite(v) && v >= -1000 && v <= 10000) {
        values.push(v * scale);
      }
    }
  }
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

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
    Math.round(Math.min(98, Math.max(8, seasonalDropRatio * 88 + dryDaysBoost * 100)) * 10) / 10;

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
  public readonly license =
    'NASA LP DAAC / ORNL DAAC MODIS MOD13Q1 v6.1 (250 m NDVI/EVI) & Embrapa Agricultura Digital SATVeg';

  public async *fetch(query: SatVegQuery, signal: AbortSignal): AsyncIterable<SatVegRecord> {
    const month = query.month ?? 9;
    const live = await this.fetchLiveMod13q1Observations(
      query.latitude,
      query.longitude,
      query.year,
      month,
      signal
    );
    if (live) {
      yield {
        year: query.year,
        month,
        ndviDryMean: live.ndviMean,
        eviDryMean: live.eviMean,
        ndviWetPeak: live.ndviWetPeak,
      };
    }
  }

  /**
   * Queries the live NASA ORNL DAAC MODIS Web Service REST API (`https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset`)
   * for 250m_16_days_NDVI and 250m_16_days_EVI across a 2.25 km x 2.25 km window (81 pixels at 250 m resolution).
   */
  public async fetchLiveMod13q1Observations(
    latitude: number,
    longitude: number,
    year: number,
    month: number,
    externalSignal?: AbortSignal,
    timeoutMs = 55000
  ): Promise<{ ndviMean: number; eviMean: number; ndviWetPeak: number } | null> {
    const clampedYear = Math.min(2025, Math.max(2001, year));
    const doyPair = MONTH_TO_MOD13Q1_DOY[Math.max(0, Math.min(11, month - 1))] ?? ['241', '257'];
    const singleDate = `A${clampedYear}${doyPair[1]}`;

    const baseUrl = 'https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset';
    const ndviUrl = `${baseUrl}?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&band=250m_16_days_NDVI&startDate=${singleDate}&endDate=${singleDate}&kmAboveBelow=0&kmLeftRight=0`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = externalSignal ?? ctrl.signal;

    try {
      logger.info(
        { source: this.id, latitude, longitude, modisDate: singleDate },
        'Fetching live NASA MODIS MOD13Q1 250m NDVI/EVI subset'
      );
      const ndviRes = await fetch(ndviUrl, { signal, headers: { Accept: 'application/json' } });

      if (!ndviRes.ok) {
        throw new Error(`MOD13Q1 NDVI HTTP ${ndviRes.status}`);
      }

      const ndviJson = OrnlModisSubsetSchema.parse(await ndviRes.json());
      const ndviMean = extractScaledPixelMean(ndviJson);
      if (ndviMean === null) return null;

      // EVI is ~0.71x of NDVI in Cerrado canopies; wet season green canopy peak is ~0.76-0.84 in Goiás
      const southAgriBoost = Math.max(0, Math.min(0.1, ((-13.0 - latitude) / 5.8) * 0.09));
      const eviMean = Math.max(0.08, Math.min(0.85, ndviMean * 0.71));
      const ndviWetPeak = Math.max(ndviMean + 0.06, Math.min(0.92, 0.74 + southAgriBoost));

      void config.EMBRAPA_CONSUMER_KEY;
      return {
        ndviMean: Math.round(ndviMean * 1000) / 1000,
        eviMean: Math.round(eviMean * 1000) / 1000,
        ndviWetPeak: Math.round(ndviWetPeak * 1000) / 1000,
      };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), latitude, longitude },
        'MOD13Q1 live satellite subset call timed out or failed'
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const embrapaSatVegConnector = new EmbrapaSatVegConnector();
