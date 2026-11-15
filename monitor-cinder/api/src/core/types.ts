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
  readonly id:
    | 'firms'
    | 'ibge'
    | 'inpe_queimadas'
    | 'inpe_terrabrasilis'
    | 'embrapa_satveg'
    | 'nasa_power'
    | 'modis_mcd12q1'
    | 'noaa_oni';
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

/**
 * MOD13Q1 / MYD13Q1 (250 m, 16-day composite via Embrapa SATVeg / LP DAAC)
 * Biomass, Crop Vigor & Dry Fuel Curing Profile
 */
export interface Mod13q1BiomassProfile {
  ndviMean: number; // 0..1 current period NDVI
  eviMean: number; // 0..1 current period EVI
  ndviWetPeak: number; // 0..1 wet-season peak green biomass
  ndviAnomalyPct: number; // % deviation vs municipal historical baseline
  curingRatePct: number; // 0..100 % of wet-season biomass converted into dry fuel
  fuelLoadTonsHa: number; // estimated dry combustible biomass (t/ha)
  cropVigorClass: 'high_vigor' | 'normal' | 'water_stress' | 'severe_senescence';
}

/**
 * MCD12Q1 v6.1 (500 m, Annual IGBP Land Cover + INPE PRODES/DETER)
 * Land Use Exposure & Agro-Wildland Interface Profile
 */
export interface Mcd12q1LandCoverProfile {
  dominantIgbpCode: number; // 1..17 (e.g. 8 Woody Savannas, 9 Savannas, 10 Grasslands, 12 Croplands, 14 Mosaic)
  dominantIgbpLabel: string;
  croplandPct: number; // IGBP 12 + 14: Agricultura & Mosaico Agrícola (%)
  pastureGrasslandPct: number; // IGBP 10: Campo / Pastagem (%)
  savannaCerradoPct: number; // IGBP 8 + 9: Savana / Cerrado Nativo (%)
  forestRlAppPct: number; // IGBP 1..5: Floresta / Reserva Legal & APP (%)
  interfaceRiskIndex: number; // 0..100 border contact index between flammable pasture/savanna and crops/RL
  prodesDeforestationKm2: number; // Annual PRODES Cerrado deforestation (km²)
}

/**
 * B2B Vertical 1: Subscrição de Seguro Agrícola / Rural (Agro-Insurance Underwriting)
 */
export interface AgroInsuranceUnderwriting {
  agroInsuranceScore: number; // 0..100 composite actuarial risk score (higher = higher risk)
  insurabilityScore: number; // 0..1000 positive underwriting safety index
  underwritingRating: 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'CCC';
  riskTier: 'low' | 'moderate' | 'high' | 'extreme';
  pureRiskRatePct: number; // Technical pure risk rate (% p.a. of sum insured)
  recommendedLoadingPct: number; // Surcharge (+) or discount (-) over base tariff (%)
  suggestedDeductiblePct: number; // Recommended policy deductible (%)
  underwritingDecision:
    | 'auto_approve'
    | 'approve_with_firebreak_covenant'
    | 'manual_inspection_required'
    | 'decline_or_reinsurance';
}

/**
 * B2B Vertical 2: Análise de Risco Financeiro & Perda Esperada de Safra/Biomassa
 */
export interface FinancialRiskAnalysis {
  expectedAnnualLossPct: number; // EAL (% of exposed agricultural production value)
  probableMaximumLossP95Pct: number; // PML 95% extreme drought/wind tail loss (%)
  valueAtRiskBrlPerHa: number; // Estimated Value-at-Risk (R$/ha)
  burnSeverityPotential: 'low' | 'moderate' | 'high' | 'catastrophic';
}

/**
 * B2B Vertical 3: Priorização de Roçada de Faixas de Servidão / Linhas de Transmissão
 */
export interface TransmissionLineRowPriority {
  rowClearingPriorityScore: number; // 0..100 operational priority score
  priorityTier: 'routine' | 'scheduled_30d' | 'urgent_7d' | 'immediate_dispatch';
  smokeOutageRiskClass: 'low' | 'moderate' | 'high' | 'extreme';
  recommendedBufferWidthM: number; // Recommended vegetation clearing width (m)
}

/**
 * B2B Vertical 4: Auditoria de Crédito Rural & Compliance Socioambiental (BACEN Sicor / PROAGRO)
 */
export interface RuralCreditAuditReport {
  complianceScore: number; // 0..100 (100 = best compliance, low recurring anthropogenic fire)
  creditAuditStatus: 'compliant' | 'attention_seasonal_burn' | 'non_compliant_high_recurrence';
  anthropogenicBurnFlag: boolean;
  rlAppExposurePct: number; // % of Reserva Legal / APP exposed to recurring fire fronts
}

/**
 * Unified 4-Source B2B SaaS Intelligence Report:
 * Fogo (FIRMS) + Clima (NASA POWER) + Biomassa/Safra (MOD13Q1) + Uso do Solo (MCD12Q1)
 */
export interface AgroB2BRiskReport {
  pillars: {
    firmsFireScore: number; // 0..100 (weight 30%)
    powerClimateScore: number; // 0..100 (weight 25%)
    mod13q1BiomassScore: number; // 0..100 (weight 25%)
    mcd12q1LandUseScore: number; // 0..100 (weight 20%)
  };
  mod13q1: Mod13q1BiomassProfile;
  mcd12q1: Mcd12q1LandCoverProfile;
  insurance: AgroInsuranceUnderwriting;
  financialRisk: FinancialRiskAnalysis;
  transmissionLine: TransmissionLineRowPriority;
  creditAudit: RuralCreditAuditReport;
}
