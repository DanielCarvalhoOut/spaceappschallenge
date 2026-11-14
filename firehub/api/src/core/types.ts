import { z } from 'zod';
import type { MlPropensityPrediction } from './ml-propensity.js';

export const IbgeCodeSchema = z.string().regex(/^\d{7}$/, 'IBGE municipality code must be 7 digits');
export const YearSchema = z.coerce.number().int().min(2000).max(2100);
export const MonthSchema = z.coerce.number().int().min(1).max(12);

export const FirmsSensorSchema = z.enum([
  'MODIS_NRT',
  'MODIS_SP',
  'VIIRS_SNPP_NRT',
  'VIIRS_SNPP_SP',
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA20_SP',
  'VIIRS_NOAA21_NRT',
  'VIIRS_NOAA21_SP',
  'LANDSAT_NRT',
]);

export type FirmsSensorCode = z.infer<typeof FirmsSensorSchema>;

export interface SourceConnector<TQuery, TRecord> {
  readonly id: 'firms' | 'ibge' | 'inpe_queimadas' | 'inpe_terrabrasilis' | 'embrapa_satveg' | 'nasa_power';
  readonly license: string;
  fetch(query: TQuery, signal: AbortSignal): AsyncIterable<TRecord>;
}

export interface FirmsHotspotRecord {
  sensor: FirmsSensorCode;
  instrument: 'MODIS' | 'VIIRS' | 'OLI';
  pixelM: 1000 | 375 | 30;
  latitude: number;
  longitude: number;
  brightnessK: number | null;
  brightness2K: number | null;
  scan: number | null;
  track: number | null;
  acqDate: string; // YYYY-MM-DD
  acqTime: string; // HHMM
  acqIsoUtc: string;
  satellite: string;
  confidenceRaw: string;
  confidenceNorm: 0 | 1 | 2;
  frpMw: number;
  daynight: 'D' | 'N';
  processing: 'NRT' | 'SP';
  /** FIRMS "type" column (yearly archives): 0 vegetation fire, 2 static land source. Absent in NRT. */
  fireType?: number | null;
}

export interface ClusteredFireEvent {
  clusterId: number;
  day: string;
  centroidLat: number;
  centroidLon: number;
  cellKey: string;
  h3LikeIndex: string;
  detectionsCount: number;
  modisPixels: number;
  viirsPixels: number;
  landsatPixels: number;
  deduplicatedCount: number;
  sensors: string[];
  maxFrpMw: number;
  sumFrpMw: number;
  meanFrpMw: number;
  maxBrightnessK: number | null;
  maxConfidence: 0 | 1 | 2;
}

export interface ResourceScalingEstimate {
  intensityClass: 'low' | 'moderate' | 'high' | 'extreme';
  activeClusters: number;
  rawDetections: number;
  deduplicatedRatioPct: number;
  meanFrpMw: number;
  maxFrpMw: number;
  totalFrpMw: number;
  brigadistas: number;
  squads: number;
  waterLiters: number;
  waterTrucks: number;
  manualKits: number;
  aircraftSupport: number;
}

export interface RootFireMonthProfile {
  month: number;
  yearsObserved: number;
  yearsWithFire: number;
  recurrencePct: number;
  meanHarmonized: number;
  sdHarmonized: number;
  cvRatio: number;
  isRootMonth: boolean;
  regime: 'anthropogenic_root' | 'root_with_climate_spikes' | 'climatic_anomaly_driven' | 'low_activity';
}

export interface RootFireSummary {
  persistenceScorePct: number;
  dominantRegime: 'anthropogenic_root' | 'root_with_climate_spikes' | 'climatic_anomaly_driven' | 'low_activity';
  rootMonths: number[];
  criticalWeeksLabel: string;
  anthropogenicSharePct: number;
  climaticAnomalyYears: number[];
  months: RootFireMonthProfile[];
}

export interface NasaPowerDailyRecord {
  date: string; // YYYY-MM-DD
  t2mMaxC: number | null;
  rh2mPct: number | null;
  prectotcorrMm: number | null;
  ws10mMs: number | null;
  wd10mDeg: number | null;
}

export interface FirePredictabilityReport {
  ignitionRiskScore: number; // 0..100
  ignitionRiskClass: 'low' | 'moderate' | 'high' | 'extreme';
  consecutiveDryDays: number;
  vaporPressureDeficitHpa: number;
  weatherSummary: {
    t2mMaxC: number;
    rh2mPct: number;
    prectotcorrMm: number;
    ws10mMs: number;
    wd10mDeg: number;
    windFromCardinal: string;
  };
  propagation: {
    azimuthDeg: number; // Direction toward which the fire spreads = (WD10M + 180) % 360
    cardinal: string;
    spreadRateKmh: number;
    spreadRateMMin: number;
    reachRadius6hKm: number;
  };
  mlPropensity?: MlPropensityPrediction;
  dailySeries: NasaPowerDailyRecord[];
}
