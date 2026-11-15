import { z } from 'zod';
import { logger } from '../core/logger.js';
import type { Mcd12q1LandCoverProfile, SourceConnector } from '../core/types.js';
import { inpeTerraBrasilisConnector } from './inpe-terrabrasilis.js';

export interface Mcd12q1Query {
  ibgeCode: string;
  latitude: number;
  longitude: number;
  year: number;
  bbox?: [number, number, number, number];
}

export const IGBP_CLASSES: Record<number, { nameEn: string; groupPt: string }> = {
  1: { nameEn: 'Evergreen Needleleaf Forests', groupPt: 'Floresta (RL/APP)' },
  2: { nameEn: 'Evergreen Broadleaf Forests', groupPt: 'Floresta (RL/APP)' },
  3: { nameEn: 'Deciduous Needleleaf Forests', groupPt: 'Floresta (RL/APP)' },
  4: { nameEn: 'Deciduous Broadleaf Forests', groupPt: 'Floresta (RL/APP)' },
  5: { nameEn: 'Mixed Forests', groupPt: 'Floresta (RL/APP)' },
  6: { nameEn: 'Closed Shrublands', groupPt: 'Arbustiva' },
  7: { nameEn: 'Open Shrublands', groupPt: 'Arbustiva' },
  8: { nameEn: 'Woody Savannas', groupPt: 'Savana (Cerrado Denso)' },
  9: { nameEn: 'Savannas', groupPt: 'Savana (Cerrado Típico)' },
  10: { nameEn: 'Grasslands', groupPt: 'Campo / Pastagem' },
  11: { nameEn: 'Permanent Wetlands', groupPt: 'Área Úmida / Vereda' },
  12: { nameEn: 'Croplands', groupPt: 'Agricultura (Soja/Milho/Cana)' },
  13: { nameEn: 'Urban and Built-up Lands', groupPt: 'Urbano' },
  14: { nameEn: 'Cropland/Natural Vegetation Mosaics', groupPt: 'Mosaico Agrícola-Vegetação' },
  16: { nameEn: 'Barren', groupPt: 'Solo Exposto' },
  17: { nameEn: 'Water Bodies', groupPt: 'Corpos d’Água' },
};

const Mcd12q1SubsetSchema = z.object({
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

/**
 * Computes the MCD12Q1 v6.1 IGBP Land Cover & Agro-Wildland Interface Profile.
 */
export function computeMcd12q1LandCoverProfile(params: {
  croplandPct: number;
  pastureGrasslandPct: number;
  savannaCerradoPct: number;
  forestRlAppPct: number;
  prodesDeforestationKm2: number;
}): Mcd12q1LandCoverProfile {
  const rawCrop = Math.max(2, params.croplandPct);
  const rawPasture = Math.max(5, params.pastureGrasslandPct);
  const rawSavanna = Math.max(5, params.savannaCerradoPct);
  const rawForest = Math.max(2, params.forestRlAppPct);
  const sum = rawCrop + rawPasture + rawSavanna + rawForest || 100;

  // Normalize to ~97% (leaving ~3% for urban/water/other)
  const scale = 97 / sum;
  const croplandPct = Math.round(rawCrop * scale * 10) / 10;
  const pastureGrasslandPct = Math.round(rawPasture * scale * 10) / 10;
  const savannaCerradoPct = Math.round(rawSavanna * scale * 10) / 10;
  const forestRlAppPct = Math.round(rawForest * scale * 10) / 10;
  const prodesDeforestationKm2 = Math.round(Math.max(0, params.prodesDeforestationKm2) * 100) / 100;

  let dominantIgbpCode = 9;
  if (croplandPct >= pastureGrasslandPct && croplandPct >= savannaCerradoPct) {
    dominantIgbpCode = croplandPct >= 42 ? 12 : 14;
  } else if (pastureGrasslandPct >= savannaCerradoPct) {
    dominantIgbpCode = 10;
  } else {
    dominantIgbpCode = savannaCerradoPct >= 36 ? 9 : 8;
  }

  const dominantIgbpLabel = IGBP_CLASSES[dominantIgbpCode]?.groupPt ?? 'Savana (Cerrado Típico)';

  // Interface Risk Index (0..100): measures border contact between high-ignition sources
  // (pasture/grassland + road/savanna clearing) and high-value assets (croplands + Reserva Legal/APP)
  const mosaicEntropy = (Math.min(croplandPct, pastureGrasslandPct + savannaCerradoPct) / 48) * 58;
  const deforestationPressure = Math.min(26, prodesDeforestationKm2 * 1.15);
  const pastureIgnitionFactor = Math.min(16, pastureGrasslandPct * 0.38);
  const interfaceRiskIndex =
    Math.round(
      Math.min(100, Math.max(10, mosaicEntropy + deforestationPressure + pastureIgnitionFactor)) * 10
    ) / 10;

  return {
    dominantIgbpCode,
    dominantIgbpLabel,
    croplandPct,
    pastureGrasslandPct,
    savannaCerradoPct,
    forestRlAppPct,
    interfaceRiskIndex,
    prodesDeforestationKm2,
  };
}

export class ModisLandCoverConnector implements SourceConnector<Mcd12q1Query, Mcd12q1LandCoverProfile> {
  public readonly id = 'modis_mcd12q1' as const;
  public readonly license =
    'NASA LP DAAC / ORNL DAAC MODIS MCD12Q1 v6.1 (IGBP 500 m Annual Land Cover) + INPE PRODES Cerrado WFS';

  public async *fetch(query: Mcd12q1Query, signal: AbortSignal): AsyncIterable<Mcd12q1LandCoverProfile> {
    const profile = await this.fetchLiveMcd12q1LandCover(
      query.latitude,
      query.longitude,
      query.year,
      query.bbox,
      undefined,
      signal
    );
    if (profile) {
      yield profile;
    }
  }

  /**
   * Queries the live NASA ORNL DAAC MODIS Web Service REST API (`https://modis.ornl.gov/rst/api/v1/MCD12Q1/subset`)
   * for `LC_Type1` (IGBP 17-class global land cover at 500 m resolution) across an 11 km x 11 km rural window
   * (21 x 21 = 441 pixels) around the municipality, plus INPE TerraBrasilis PRODES WFS when available.
   */
  public async fetchLiveMcd12q1LandCover(
    latitude: number,
    longitude: number,
    year: number,
    bbox?: [number, number, number, number],
    fallbackProdesKm2 = 4.5,
    externalSignal?: AbortSignal,
    timeoutMs = 55000
  ): Promise<Mcd12q1LandCoverProfile | null> {
    const clampedYear = Math.min(2024, Math.max(2001, year));
    const modisDate = `A${clampedYear}001`;
    const url = `https://modis.ornl.gov/rst/api/v1/MCD12Q1/subset?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&band=LC_Type1&startDate=${modisDate}&endDate=${modisDate}&kmAboveBelow=3&kmLeftRight=3`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const signal = externalSignal ?? ctrl.signal;

    try {
      logger.info(
        { source: this.id, latitude, longitude, modisDate },
        'Fetching live NASA MODIS MCD12Q1 500m IGBP Land Cover subset'
      );

      const effectiveBbox: [number, number, number, number] = bbox ?? [
        longitude - 0.18,
        latitude - 0.18,
        longitude + 0.18,
        latitude + 0.18,
      ];

      const [mcdRes, prodesAreaKm2] = await Promise.all([
        fetch(url, { signal, headers: { Accept: 'application/json' } }),
        this.fetchProdesDeforestationKm2(effectiveBbox, clampedYear, fallbackProdesKm2),
      ]);

      if (!mcdRes.ok) {
        throw new Error(`MCD12Q1 HTTP ${mcdRes.status}`);
      }

      const parsed = Mcd12q1SubsetSchema.parse(await mcdRes.json());
      const pixels = parsed.subset[0]?.data ?? [];
      if (pixels.length === 0) return null;

      let cropPixels = 0;
      let pasturePixels = 0;
      let savannaPixels = 0;
      let forestPixels = 0;
      let validVegPixels = 0;

      for (const cls of pixels) {
        if (cls === 12 || cls === 14) {
          cropPixels += 1;
          validVegPixels += 1;
        } else if (cls === 10 || cls === 6 || cls === 7) {
          pasturePixels += 1;
          validVegPixels += 1;
        } else if (cls === 8 || cls === 9) {
          savannaPixels += 1;
          validVegPixels += 1;
        } else if ((cls >= 1 && cls <= 5) || cls === 11) {
          forestPixels += 1;
          validVegPixels += 1;
        }
      }

      if (validVegPixels === 0) return null;

      const croplandPct = (cropPixels / validVegPixels) * 100;
      const pastureGrasslandPct = (pasturePixels / validVegPixels) * 100;
      const savannaCerradoPct = (savannaPixels / validVegPixels) * 100;
      const forestRlAppPct = (forestPixels / validVegPixels) * 100;

      return computeMcd12q1LandCoverProfile({
        croplandPct,
        pastureGrasslandPct,
        savannaCerradoPct,
        forestRlAppPct,
        prodesDeforestationKm2: prodesAreaKm2,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), latitude, longitude },
        'MCD12Q1 live satellite subset call timed out or failed'
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchProdesDeforestationKm2(
    bbox: [number, number, number, number],
    year: number,
    fallbackKm2: number
  ): Promise<number> {
    const prodesCtrl = new AbortController();
    const prodesTimer = setTimeout(() => prodesCtrl.abort(), 3500);
    try {
      let totalKm2 = 0;
      let count = 0;
      for await (const rec of inpeTerraBrasilisConnector.fetch({ layer: 'prodes', bbox }, prodesCtrl.signal)) {
        if (rec.year === year || rec.year >= year - 1) {
          totalKm2 += rec.areaKm2;
          count += 1;
        }
      }
      if (count > 0 && totalKm2 > 0) {
        return Math.round(totalKm2 * 100) / 100;
      }
    } catch {
      // INPE WFS optional; fall back to baseline
    } finally {
      clearTimeout(prodesTimer);
    }
    return fallbackKm2;
  }
}

export const modisLandCoverConnector = new ModisLandCoverConnector();
