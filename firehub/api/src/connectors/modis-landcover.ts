import type { Mcd12q1LandCoverProfile, SourceConnector } from '../core/types.js';

export interface Mcd12q1Query {
  ibgeCode: string;
  latitude: number;
  longitude: number;
  year: number;
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
  const mosaicEntropy =
    (Math.min(croplandPct, pastureGrasslandPct + savannaCerradoPct) / 48) * 58;
  const deforestationPressure = Math.min(26, prodesDeforestationKm2 * 1.15);
  const pastureIgnitionFactor = Math.min(16, pastureGrasslandPct * 0.38);
  const interfaceRiskIndex =
    Math.round(Math.min(100, Math.max(10, mosaicEntropy + deforestationPressure + pastureIgnitionFactor)) * 10) / 10;

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
  public readonly license = 'NASA LP DAAC MODIS MCD12Q1 v6.1 (IGBP 500 m Annual Land Cover)';

  public async *fetch(_query: Mcd12q1Query, _signal: AbortSignal): AsyncIterable<Mcd12q1LandCoverProfile> {
    yield* [];
  }
}

export const modisLandCoverConnector = new ModisLandCoverConnector();
