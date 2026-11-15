import { describe, expect, it } from 'vitest';
import { buildFirmsAreaUrl, normalizeConfidence, parseFirmsCsv } from '../connectors/firms.js';
import { buildNasaPowerDailyUrl, parseNasaPowerDailyJson } from '../connectors/nasa-power.js';
import { redactSecrets } from '../core/logger.js';
import { sanitizeCsvCell } from '../modules/routes.js';

describe('FIRMS connector', () => {
  it('builds the FIRMS area URL and redacts the MAP_KEY in logs', () => {
    const fakeKey = '0123456789abcdef0123456789abcdef';
    const url = buildFirmsAreaUrl(fakeKey, 'VIIRS_NOAA20_NRT', [-53.25, -19.5, -45.9, -12.39], 3);
    expect(url).toBe(
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/0123456789abcdef0123456789abcdef/VIIRS_NOAA20_NRT/-53.25,-19.5,-45.9,-12.39/3'
    );
    const redacted = redactSecrets(url);
    expect(redacted).not.toContain(fakeKey);
    expect(redacted).toContain('[REDACTED_MAP_KEY]');
  });

  it('parses MODIS (1 km) and VIIRS (375 m) CSV rows and normalizes confidence to low / nominal / high', () => {
    const modisCsv = [
      'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type',
      '-16.68000,-49.25000,335.2,1.0,1.0,2024-09-10,1640,Aqua,MODIS,82,61.03,301.1,42.5,D,0',
    ].join('\n');
    const viirsCsv = [
      'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
      '-16.68080,-49.25090,348.4,0.38,0.38,2024-09-10,1705,N20,VIIRS,h,2.0NRT,298.5,19.8,D',
      '-16.67920,-49.24910,341.0,0.39,0.38,2024-09-10,1705,N20,VIIRS,n,2.0NRT,296.0,15.2,D',
      '-15.90000,-48.10000,308.0,0.40,0.40,2024-09-10,0510,N20,VIIRS,l,2.0NRT,289.0,1.1,N',
    ].join('\n');
    expect(parseFirmsCsv(modisCsv, 'MODIS_SP')).toHaveLength(1);
    expect(parseFirmsCsv(viirsCsv, 'VIIRS_NOAA20_NRT')).toHaveLength(3);
    expect(normalizeConfidence('MODIS', '82')).toBe(2);
    expect(normalizeConfidence('MODIS', '50')).toBe(1);
    expect(normalizeConfidence('VIIRS', 'h')).toBe(2);
    expect(normalizeConfidence('VIIRS', 'n')).toBe(1);
    expect(normalizeConfidence('VIIRS', 'l')).toBe(0);
  });
});

describe('NASA POWER connector (context only)', () => {
  it('builds the daily point URL and parses the parameters, dropping fill values', () => {
    const url = buildNasaPowerDailyUrl({ latitude: -16.68, longitude: -49.25, startDate: '20240901', endDate: '20240903' });
    expect(url).toContain('https://power.larc.nasa.gov/api/temporal/daily/point');
    expect(url).toContain('parameters=T2M_MAX%2CRH2M%2CPRECTOTCORR%2CWS10M%2CWD10M');
    const daily = parseNasaPowerDailyJson({
      properties: {
        parameter: {
          T2M_MAX: { '20240901': 37.4, '20240902': 38.6, '20240903': -999 },
          RH2M: { '20240901': 22.0, '20240902': 19.5, '20240903': 18.0 },
          PRECTOTCORR: { '20240901': 0.0, '20240902': 0.0, '20240903': 0.0 },
          WS10M: { '20240901': 4.8, '20240902': 5.2, '20240903': 5.6 },
          WD10M: { '20240901': 88.0, '20240902': 90.0, '20240903': 92.0 },
        },
      },
    });
    expect(daily).toHaveLength(3);
    expect(daily[0]?.t2mMaxC).toBe(37.4);
    expect(daily[2]?.t2mMaxC).toBeNull();
  });
});

describe('CSV export', () => {
  it('prevents CSV formula injection', () => {
    expect(sanitizeCsvCell('=CMD()')).toBe('"\'=CMD()"');
    expect(sanitizeCsvCell('+SUM(A1:A2)')).toBe('"\'+SUM(A1:A2)"');
    expect(sanitizeCsvCell('Goiânia')).toBe('Goiânia');
  });
});
