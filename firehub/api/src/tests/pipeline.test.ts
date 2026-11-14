import { describe, expect, it } from 'vitest';
import { buildFirmsAreaUrl, parseFirmsCsv } from '../connectors/firms.js';
import { buildNasaPowerDailyUrl, parseNasaPowerDailyJson } from '../connectors/nasa-power.js';
import {
  analyzeRootFires,
  clusterHotspotsDbscan,
  computeFirePredictability,
  estimateResourcesByFrp,
  normalizeConfidence,
} from '../core/analytics.js';
import { redactSecrets } from '../core/logger.js';
import { sanitizeCsvCell } from '../modules/routes.js';

describe('A. Harmonização MODIS + VIIRS & Escala de Recursos (DBSCAN/H3 + FRP)', () => {
  it('builds FIRMS Area REST API URL and redacts MAP_KEY in logs', () => {
    const fakeKey = '0123456789abcdef0123456789abcdef';
    const url = buildFirmsAreaUrl(fakeKey, 'VIIRS_NOAA20_NRT', [-53.25, -19.5, -45.9, -12.39], 3);
    expect(url).toBe(
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv/0123456789abcdef0123456789abcdef/VIIRS_NOAA20_NRT/-53.25,-19.5,-45.9,-12.39/3'
    );
    const redacted = redactSecrets(url);
    expect(redacted).not.toContain(fakeKey);
    expect(redacted).toContain('[REDACTED_MAP_KEY]');
  });

  it('normalizes MODIS (1 km) and VIIRS (375 m) CSV records and deduplicates same fire via spatial DBSCAN', () => {
    const modisCsv = [
      'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type',
      '-16.68000,-49.25000,335.2,1.0,1.0,2024-09-10,1640,Aqua,MODIS,82,61.03,301.1,42.5,D,0',
    ].join('\n');

    const viirsNoaa20Csv = [
      'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
      '-16.68080,-49.25090,348.4,0.38,0.38,2024-09-10,1705,N20,VIIRS,h,2.0NRT,298.5,19.8,D',
      '-16.67920,-49.24910,341.0,0.39,0.38,2024-09-10,1705,N20,VIIRS,n,2.0NRT,296.0,15.2,D',
      // Low confidence pixel -> filtered out from active clustering
      '-15.90000,-48.10000,308.0,0.40,0.40,2024-09-10,0510,N20,VIIRS,l,2.0NRT,289.0,1.1,N',
    ].join('\n');

    const modisRecords = parseFirmsCsv(modisCsv, 'MODIS_SP');
    const viirsRecords = parseFirmsCsv(viirsNoaa20Csv, 'VIIRS_NOAA20_NRT');
    expect(modisRecords).toHaveLength(1);
    expect(viirsRecords).toHaveLength(3);
    expect(normalizeConfidence('MODIS', '82')).toBe(2);
    expect(normalizeConfidence('VIIRS', 'h')).toBe(2);
    expect(normalizeConfidence('VIIRS', 'l')).toBe(0);

    // Combine 1 MODIS (1 km) + 2 nominal/high VIIRS (375 m) detections of the SAME fire (~150 m apart)
    const combined = [...modisRecords, ...viirsRecords];
    const clusters = clusterHotspotsDbscan(combined, 1000);

    // Must merge all 3 nominal/high detections into 1 single deduplicated fire cluster!
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.detectionsCount).toBe(3);
    expect(cluster.modisPixels).toBe(1);
    expect(cluster.viirsPixels).toBe(2);
    expect(cluster.deduplicatedCount).toBe(2);
    expect(cluster.maxFrpMw).toBe(42.5);
    expect(cluster.sumFrpMw).toBeCloseTo(77.5, 1);
    expect(cluster.h3LikeIndex).toMatch(/^88[0-9a-f]+fff$/);
  });

  it('estimates tactical resource scale (brigadistas, water, trucks, aircraft) from FRP (MW)', () => {
    const lowScale = estimateResourcesByFrp(2, 5, 11.0, 14.0);
    expect(lowScale.intensityClass).toBe('low');
    expect(lowScale.brigadistas).toBeGreaterThanOrEqual(4);
    expect(lowScale.aircraftSupport).toBe(0);

    const extremeScale = estimateResourcesByFrp(45, 110, 42.0, 185.0);
    expect(extremeScale.intensityClass).toBe('extreme');
    expect(extremeScale.totalFrpMw).toBeGreaterThan(1500);
    expect(extremeScale.brigadistas).toBeGreaterThan(80);
    expect(extremeScale.waterLiters).toBeGreaterThan(500000);
    expect(extremeScale.waterTrucks).toBeGreaterThan(50);
    expect(extremeScale.aircraftSupport).toBeGreaterThanOrEqual(1);
  });
});

describe('B. Calendário de Focos Raízes & Histórico (2000–Presente)', () => {
  it('identifies recurring seasonal root fires (Aug/Sep) and separates them from climatic anomalies', () => {
    const syntheticSeries: Array<{
      year: number;
      month: number;
      harmonized: number;
      anomalyZ: number;
    }> = [];

    for (let y = 2001; y <= 2025; y++) {
      for (let m = 1; m <= 12; m++) {
        // Consistent high agricultural/border burning every August & September (anthropogenic root fire)
        const isAugSep = m === 8 || m === 9;
        const isDroughtSpikeYear = y === 2010 || y === 2024;
        const harmonized = isAugSep ? (isDroughtSpikeYear ? 190 : 110) : 4;
        const anomalyZ = isAugSep && isDroughtSpikeYear ? 2.1 : 0.2;
        syntheticSeries.push({ year: y, month: m, harmonized, anomalyZ });
      }
    }

    const summary = analyzeRootFires(syntheticSeries, 2001, 2025);
    expect(summary.rootMonths).toContain(8);
    expect(summary.rootMonths).toContain(9);
    expect(summary.anthropogenicSharePct).toBeGreaterThan(60);
    expect(summary.climaticAnomalyYears).toEqual([2010, 2024]);
    const sepProfile = summary.months.find((x) => x.month === 9)!;
    expect(sepProfile.recurrencePct).toBe(100);
    expect(sepProfile.isRootMonth).toBe(true);
    expect(sepProfile.regime).toBe('anthropogenic_root');
  });
});

describe('C. Clima e Previsibilidade de Ocorrência (NASA POWER Daily Point)', () => {
  it('parses NASA POWER daily parameters (T2M_MAX, RH2M, PRECTOTCORR, WS10M, WD10M) and computes ignition risk + propagation vector', () => {
    const url = buildNasaPowerDailyUrl({
      latitude: -16.68,
      longitude: -49.25,
      startDate: '20240901',
      endDate: '20240905',
    });
    expect(url).toContain('https://power.larc.nasa.gov/api/temporal/daily/point');
    expect(url).toContain('parameters=T2M_MAX%2CRH2M%2CPRECTOTCORR%2CWS10M%2CWD10M');

    const mockPayload = {
      properties: {
        parameter: {
          T2M_MAX: { '20240901': 37.4, '20240902': 38.6, '20240903': 39.1 },
          RH2M: { '20240901': 22.0, '20240902': 19.5, '20240903': 18.0 },
          PRECTOTCORR: { '20240901': 0.0, '20240902': 0.0, '20240903': 0.0 },
          WS10M: { '20240901': 4.8, '20240902': 5.2, '20240903': 5.6 },
          // Wind blowing FROM East (90 deg) -> Fire propagates TOWARD West (270 deg)
          WD10M: { '20240901': 88.0, '20240902': 90.0, '20240903': 92.0 },
        },
      },
    };

    const daily = parseNasaPowerDailyJson(mockPayload);
    expect(daily).toHaveLength(3);
    const report = computeFirePredictability(daily, 90, 45);
    expect(report.ignitionRiskScore).toBeGreaterThanOrEqual(70);
    expect(['high', 'extreme']).toContain(report.ignitionRiskClass);
    expect(report.weatherSummary.windFromCardinal).toBe('E');
    // Downwind propagation azimuth = (90 + 180) % 360 = 270° (W)
    expect(report.propagation.azimuthDeg).toBe(270);
    expect(report.propagation.cardinal).toBe('W');
    expect(report.propagation.spreadRateKmh).toBeGreaterThan(1.0);
  });

  it('prevents CSV formula injection on export', () => {
    expect(sanitizeCsvCell('=CMD()')).toBe('"\'=CMD()"');
    expect(sanitizeCsvCell('+SUM(A1:A2)')).toBe('"\'+SUM(A1:A2)"');
    expect(sanitizeCsvCell('Goiânia')).toBe('Goiânia');
  });
});
