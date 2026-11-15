import { z } from 'zod';

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
    | 'nasa_power';
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

export interface NasaPowerDailyRecord {
  date: string; // YYYY-MM-DD
  t2mMaxC: number | null;
  rh2mPct: number | null;
  prectotcorrMm: number | null;
  ws10mMs: number | null;
  wd10mDeg: number | null;
}
