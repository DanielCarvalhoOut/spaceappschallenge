import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Locality } from '../connectors/ibge-localities.js';
import { ibgeConnector, pointInMunicipality, type IbgeMunicipalityRecord } from '../connectors/ibge.js';
import { fetchCroplandPct, fetchNdvi } from '../connectors/ornl-modis.js';
import { nasaPowerConnector } from '../connectors/nasa-power.js';
import { logger } from '../core/logger.js';
import { buildChain, cellDetections, dailyOfMonth, partialWindow, withPartialAnomaly, dailySeries, emptyRows, inCircle, loadCellIndex, monthlyRows, monthlyRowsByMunicipality, recurrenceFromIndex, toPolyconic, fromPolyconic, withAnomaly, type CellIndex, type DayRow } from '../core/cell-index.js';
import { computeIndexValidation } from '../core/index-validation.js';
import { hindcast, projectFrom, type Hindcast, type Projection } from '../core/projection-model.js';

export interface CalendarRow {
  year: number;
  month: number;
  modis: number | null;
  viirs: number | null;     // VIIRS S-NPP
  noaa20?: number | null;   // VIIRS NOAA-20 (raw, for the comparison chart)
  harmonized: number | null; // cell-days on the S-NPP scale; null when > 10 days had no sensor
  anomalyZ: number | null;
  daysMissing: number;
  provisional?: boolean;    // near-real-time days in the month
  partial?: boolean;        // current month, not finished
  partialDays?: number;     // month in progress: anomaly of days 1..N vs the same days of earlier years
  meanFrpMw?: number;
  maxFrpMw?: number;
}

export interface ValidationMetrics {
  calibrationPeriod: string;
  testPeriod: string;
  method: string;
  mapePct: number;
  pearsonR: number;
  biasPct: number;
  monthlyRatioFactors: number[];
}

export interface InpeCheckSummary {
  period: string;
  meanRatioInpeToFirmsModis: number;
  pearsonR: number;
  yearsChecked: number;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createRng(seed: number): () => number {
  let st = seed | 0;
  return () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Monthly seasonality profile for Cerrado in Goiás (Nov 2000 – Present)
const CERRADO_SEASON = [0.011, 0.009, 0.013, 0.021, 0.044, 0.076, 0.122, 0.212, 0.251, 0.138, 0.064, 0.039];
// Calibrated VIIRS (375m) to MODIS (1km) cell-day ratio by month for Goiás Cerrado
class CinderDataStore {
  private municipalities = new Map<string, IbgeMunicipalityRecord>();
  private calendars = new Map<string, CalendarRow[]>();
  private index: CellIndex | null = null;
  private initialized = false;

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.municipalities = await ibgeConnector.loadMunicipalities('52');
    this.buildAllCalendars();
    this.initialized = true;
    logger.info(
      {
        municipalities: this.municipalities.size,
        history: this.calendarKind,
      },
      'Monitor Cinder data store initialized'
    );
  }

  public getMunicipalities(): Map<string, IbgeMunicipalityRecord> {
    return this.municipalities;
  }

  public getMunicipality(ibge: string): IbgeMunicipalityRecord | undefined {
    return this.municipalities.get(ibge);
  }

  /** Harmonization error computed from the real FIRMS index (2012–2019 calibration, 2020–2025 test), or null. */
  public ensureValidationArtifacts(): ReturnType<typeof computeIndexValidation> | null {
    return this.index ? computeIndexValidation(this.index) : null;
  }

  private calendarKind: 'firms_index' | 'none' = 'none';

  /** 'firms_index' when the calendars come from the real FIRMS cell index (job:build-cell-index), else 'none'. */
  public getCalendarKind(): 'firms_index' | 'none' {
    return this.calendarKind;
  }

  /**
   * Real calendars from the FIRMS cell index: harmonized = VIIRS S-NPP cell-days from 2012, MODIS cell-days × the
   * state's monthly factor before. Same numbers as the sum of /api/layers/cells for the municipality.
   * The index carries no FRP, so meanFrpMw/maxFrpMw are 0 here.
   */
  private buildCalendarsFromIndex(index: CellIndex): void {
    const byMuni = monthlyRowsByMunicipality(index);
    const empty = emptyRows(index);
    // month in progress: days 1..D against the same days of earlier years (one pass for all municipalities)
    const pw = partialWindow(index, (c) => c[2]);
    for (const ibge of this.municipalities.keys()) {
      this.calendars.set(ibge, withPartialAnomaly(withAnomaly(byMuni.get(ibge) ?? empty), pw, pw?.sums.get(ibge)));
    }
    this.calendarKind = 'firms_index';
    const chain = buildChain(index);
    logger.info({ municipalities: this.calendars.size, links: chain.links.map((l) => `${l.link} WAPE ${l.wapePct}%`) }, 'calendars built from the real FIRMS cell index (satellite chain)');
  }

  /** Calendars only from the real FIRMS cell index; without it there are none (data routes answer 503). */
  private buildAllCalendars(): void {
    this.calendars.clear();
    this.index = loadCellIndex();
    if (!this.index) {
      this.calendarKind = 'none';
      return;
    }
    this.buildCalendarsFromIndex(this.index);
    const v = computeIndexValidation(this.index);
    try {
      fs.mkdirSync(config.outDir, { recursive: true });
      fs.writeFileSync(path.join(config.outDir, 'validation.json'), JSON.stringify(v, null, 2));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not write out/validation.json');
    }
  }

  /** Called after the background FIRMS load finishes. */
  public reloadFromIndex(): void {
    this.buildAllCalendars();
  }

  public getIndex(): CellIndex | null {
    return this.index;
  }

  public getCalendar(ibge: string): CalendarRow[] {
    return this.calendars.get(ibge) ?? [];
  }

  public getMapValues(
    year: number,
    month: number,
    metric: 'anomaly' | 'count' | 'density' | 'typical'
  ): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    if (metric === 'typical') {
      // Historical pattern of the calendar month: median of the same month in every complete earlier year (2002+).
      for (const [ibge, rows] of this.calendars.entries()) {
        const xs = rows.filter((r) => r.month === month && r.year >= 2002 && r.year < year && !r.partial && r.harmonized !== null)
          .map((r) => r.harmonized as number).sort((a, b) => a - b);
        out[ibge] = xs.length >= 5 ? Math.round((xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2) * 10) / 10 : null;
      }
      return out;
    }
    for (const [ibge, rows] of this.calendars.entries()) {
      const idx = rows.findIndex((r) => r.year === year && r.month === month);
      const row = idx >= 0 ? rows[idx]! : undefined;
      if (!row) {
        out[ibge] = null;
        continue;
      }
      if (metric === 'count') {
        out[ibge] = row.harmonized;
      } else if (metric === 'anomaly') {
        out[ibge] = row.anomalyZ;
      } else if (metric === 'density') {
        const areaKm2 = this.getMunicipalityAreaKm2(ibge);
        out[ibge] = areaKm2 > 0 && row.harmonized !== null ? Math.round(((1000 * row.harmonized) / areaKm2) * 10) / 10 : null;
      }
    }
    return out;
  }

  public getPattern(ibge: string): {
    months: Array<{ month: number; mean: number; sharePct: number }>;
    season: { months: number[]; coveredPct: number; peakMonth: number | null };
  } {
    const rows = (this.calendars.get(ibge) ?? []).filter((x) => x.year >= 2002 && x.year <= 2024);
    const sums = new Array<number>(12).fill(0);
    for (const r of rows) if (r.harmonized !== null && !r.partial) sums[r.month - 1]! += r.harmonized;
    const total = sums.reduce((a, b) => a + b, 0) || 1;
    const years = 2024 - 2002 + 1;
    const months = sums.map((s, i) => ({
      month: i + 1,
      mean: Math.round((s / years) * 10) / 10,
      sharePct: Math.round((s / total) * 1000) / 10,
    }));

    const sorted = [...months].sort((a, b) => b.sharePct - a.sharePct);
    const picked: number[] = [];
    let acc = 0;
    for (const m of sorted) {
      if (acc >= 80) break;
      picked.push(m.month);
      acc += m.sharePct;
    }
    return {
      months,
      season: {
        months: picked.sort((a, b) => a - b),
        coveredPct: Math.round(acc * 10) / 10,
        peakMonth: sorted[0]?.month ?? null,
      },
    };
  }

  public async getContextItems(
    ibge: string,
    year: number
  ): Promise<Array<{ key: string; label: string; value: number | null; unit: string; source: string }>> {
    const muni = this.municipalities.get(ibge);
    if (!muni) return [];
    const lat = muni.centroidLat, lon = muni.centroidLon;
    const y = Math.min(2025, Math.max(2001, year));
    const items: Array<{ key: string; label: string; value: number | null; unit: string; source: string }> = [];
    const r1 = (v: number): number => Math.round(v * 10) / 10;
    const mean = (xs: Array<number | null>): number | null => {
      const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };

    const [power, ndvi, land] = await Promise.allSettled([
      nasaPowerConnector.fetchRange(lat, lon, `${y}0601`, `${y}0930`, 15000),
      fetchNdvi(lat, lon, y, 9),
      fetchCroplandPct(lat, lon, y),
    ]);

    if (power.status === 'fulfilled' && power.value.length) {
      const d = power.value;
      const t = mean(d.map((x) => x.t2mMaxC)), rh = mean(d.map((x) => x.rh2mPct)), ws = mean(d.map((x) => x.ws10mMs));
      const rain = d.reduce((a, x) => a + (typeof x.prectotcorrMm === 'number' && x.prectotcorrMm >= 0 ? x.prectotcorrMm : 0), 0);
      const src = 'NASA POWER · Daily Point (MERRA-2), Jun–Sep';
      if (t !== null) items.push({ key: 'nasa_power.t2m_max_dry_c', label: 'Max temperature (T2M_MAX)', value: r1(t), unit: '°C', source: src });
      if (rh !== null) items.push({ key: 'nasa_power.rh2m_dry_pct', label: 'Relative humidity (RH2M)', value: r1(rh), unit: '%', source: src });
      items.push({ key: 'nasa_power.precip_dry_mm', label: 'Precipitation (PRECTOTCORR)', value: r1(rain), unit: 'mm', source: src });
      if (ws !== null) items.push({ key: 'nasa_power.ws10m_dry_mean', label: 'Wind speed at 10 m (WS10M)', value: r1(ws), unit: 'm/s', source: src });
    }
    if (ndvi.status === 'fulfilled' && ndvi.value !== null) {
      items.push({ key: 'modis_mod13q1.ndvi_sep', label: 'NDVI, September (MOD13Q1)', value: ndvi.value, unit: '', source: 'NASA ORNL DAAC · MOD13Q1 250 m' });
    }
    if (land.status === 'fulfilled' && land.value !== null) {
      items.push({ key: 'modis_mcd12q1.cropland_pct', label: 'Cropland share (MCD12Q1 IGBP)', value: land.value, unit: '%', source: 'NASA ORNL DAAC · MCD12Q1 500 m' });
    }
    return items;
  }

  public getMunicipalityAreaKm2(ibge: string): number {
    const muni = this.municipalities.get(ibge);
    if (!muni) return 1000;
    const [w, s, e, n] = muni.bbox;
    const midLatRad = (((s + n) / 2) * Math.PI) / 180;
    const widthKm = Math.max(2, (e - w) * 111.32 * Math.cos(midLatRad));
    const heightKm = Math.max(2, (n - s) * 110.57);
    return Math.max(25, Math.round(widthKm * heightKm * 0.56 * 10) / 10);
  }

  /**
   * Expected range for a month from the region's own FIRMS history: P10/P50/P90 of the same month in every earlier
   * year (≥ 5 years). The hindcast is computed here too (2015–2025, one rolling origin per month): coverage of
   * P10–P90 and the median's error against repeating last year's value. No fixed numbers.
   */
  public getProjection(ibge: string, year: number, month: number): {
    year: number;
    month: number;
    method: 'all';
    range: { p10: number; p50: number; p90: number; nYears: number; shrinkWeight: number } | null;
    analog: null;
    observed: number | null;
    hindcast: {
      computedAt: string;
      period: string;
      chosenMethod: 'all';
      analogBeatsRange: false;
      methods: Array<{
        method: 'all';
        nMonths: number;
        coveragePct: number | null;
        meanWidth: number | null;
        maeP50: number | null;
        maePersistence: number | null;
        skillPct: number | null;
      }>;
    } | null;
  } {
    const rows = ibge === '52' ? this.getStateRows() : this.getCalendar(ibge);
    const val = new Map(rows.filter((r) => r.harmonized !== null && !r.partial).map((r) => [r.year * 100 + r.month, r.harmonized as number]));
    const pct = (arr: number[], p: number): number => {
      const pos = (arr.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
      return Math.round((arr[lo]! + (arr[hi]! - arr[lo]!) * (pos - lo)) * 10) / 10;
    };
    const pastOf = (y: number, m: number): number[] =>
      rows.filter((r) => r.month === m && r.year < y && r.harmonized !== null && !r.partial).map((r) => r.harmonized as number).sort((a, b) => a - b);

    const past = pastOf(year, month);
    const range = past.length >= 5
      ? { p10: pct(past, 0.1), p50: pct(past, 0.5), p90: pct(past, 0.9), nYears: past.length, shrinkWeight: 1 }
      : null;

    let n = 0, inside = 0, width = 0, maeP50 = 0, maePers = 0, nPers = 0;
    for (let y = 2015; y <= 2025; y++) {
      for (let m = 1; m <= 12; m++) {
        const actual = val.get(y * 100 + m);
        if (actual === undefined) continue;
        const p = pastOf(y, m);
        if (p.length < 5) continue;
        const lo = pct(p, 0.1), mid = pct(p, 0.5), hi = pct(p, 0.9);
        n++;
        if (actual >= lo && actual <= hi) inside++;
        width += hi - lo;
        maeP50 += Math.abs(actual - mid);
        const prev = val.get((y - 1) * 100 + m);
        if (prev !== undefined) { maePers += Math.abs(actual - prev); nPers++; }
      }
    }
    const r1 = (v: number): number => Math.round(v * 10) / 10;
    const mae = n ? maeP50 / n : null;
    const persistence = nPers ? maePers / nPers : null;
    const cur = val.get(year * 100 + month);
    return {
      year,
      month,
      method: 'all',
      range,
      analog: null,
      observed: cur === undefined ? null : cur,
      hindcast: n
        ? {
            computedAt: new Date().toISOString(),
            period: '2015–2025',
            chosenMethod: 'all',
            analogBeatsRange: false,
            methods: [{
              method: 'all',
              nMonths: n,
              coveragePct: r1((inside / n) * 100),
              meanWidth: r1(width / n),
              maeP50: mae === null ? null : r1(mae),
              maePersistence: persistence === null ? null : r1(persistence),
              skillPct: mae !== null && persistence ? r1((1 - mae / persistence) * 100) : null,
            }],
          }
        : null,
    };
  }

  private getStateRows(): CalendarRow[] {
    const byYm = new Map<number, CalendarRow>();
    for (const rows of this.calendars.values()) {
      for (const r of rows) {
        const key = r.year * 100 + r.month;
        const ex = byYm.get(key);
        if (!ex) {
          byYm.set(key, { ...r });
        } else {
          ex.modis = (ex.modis ?? 0) + (r.modis ?? 0);
          ex.viirs = r.viirs !== null ? (ex.viirs ?? 0) + r.viirs : ex.viirs;
          ex.harmonized = ex.harmonized === null || r.harmonized === null ? null : ex.harmonized + r.harmonized;
        }
      }
    }
    return [...byYm.values()].sort((a, b) => a.year - b.year || a.month - b.month);
  }

  /**
   * Exact circle from the FIRMS index: only 1 km cells whose centre lies inside the radius. Municipality shares and
   * the area inside Goiás come from sampling the circle on a grid against the IBGE outlines. Null without the index.
   */
  public getCircleHistory(
    lon: number,
    lat: number,
    radiusKm: number,
    source: 'harmonized1k' | 'viirs500'
  ): {
    lon: number;
    lat: number;
    radiusKm: number;
    source: 'harmonized1k' | 'viirs500';
    areaKm2: number;
    areaInStateKm2: number;
    pctInState: number;
    rows: Array<{ year: number; month: number; modis: number | null; viirs: number | null; harmonized: number | null; anomalyZ: number | null; daysMissing: number }>;
    municipalities: Array<{ ibge: string; name: string; pctOfMunicipality: number; pctOfCircle: number }>;
  } | null {
    if (!this.index) return null;
    const keepCircle = inCircle(lon, lat, radiusKm);
    const pwc = partialWindow(this.index, (c) => (keepCircle(c) ? 'c' : null));
    const rows = withPartialAnomaly(withAnomaly(monthlyRows(this.index, keepCircle)), pwc, pwc?.sums.get('c'))
      .filter((r) => source === 'harmonized1k' || r.year >= 2012);

    // Area shares: sample the circle (≤ ~40 000 points) and test each point against the municipalities.
    const circleAreaKm2 = Math.PI * radiusKm * radiusKm;
    const stepKm = Math.max(0.5, radiusKm / 110);
    const [cx, cy] = toPolyconic(lon, lat);
    const munis = [...this.municipalities.values()];
    const hits = new Map<string, number>();
    let inState = 0, total = 0;
    for (let dx = -radiusKm + stepKm / 2; dx < radiusKm; dx += stepKm) {
      for (let dy = -radiusKm + stepKm / 2; dy < radiusKm; dy += stepKm) {
        if (dx * dx + dy * dy > radiusKm * radiusKm) continue;
        total++;
        const [plon, plat] = fromPolyconic(cx + dx * 1000, cy + dy * 1000);
        for (const m of munis) {
          const [w, s, e, nn] = m.bbox;
          if (plon < w || plon > e || plat < s || plat > nn) continue;
          if (pointInMunicipality(plat, plon, m)) { hits.set(m.ibgeCode, (hits.get(m.ibgeCode) ?? 0) + 1); inState++; break; }
        }
      }
    }
    const cellKm2 = total ? circleAreaKm2 / total : 0;
    const r1 = (v: number): number => Math.round(v * 10) / 10;
    const municipalities = [...hits.entries()]
      .map(([ibge, k]) => {
        const area = this.getMunicipalityAreaKm2(ibge);
        return {
          ibge,
          name: this.municipalities.get(ibge)?.name ?? ibge,
          pctOfMunicipality: area > 0 ? Math.min(100, r1(((k * cellKm2) / area) * 100)) : 0,
          pctOfCircle: total ? r1((k / total) * 100) : 0,
        };
      })
      .sort((a, b) => b.pctOfCircle - a.pctOfCircle);
    return {
      lon,
      lat,
      radiusKm,
      source,
      areaKm2: r1(circleAreaKm2),
      areaInStateKm2: r1(inState * cellKm2),
      pctInState: total ? r1((inState / total) * 100) : 0,
      rows,
      municipalities,
    };
  }

  private horizonCache = new Map<string, { projection: Projection; hindcast: Hindcast | null }>();

  /**
   * Projection with a validated uncertainty band for an area (state '52', a municipality or a circle): one daily
   * model, simulated forward; each horizon carries its own hindcast skill and is flagged published only when it beats
   * the climatological reference. Cached per index build. Null without the FIRMS index.
   */
  public getHorizons(area: { ibge: string } | { lon: number; lat: number; radiusKm: number }): { projection: Projection; hindcast: Hindcast | null } | null {
    if (!this.index) return null;
    const key = `${this.index.builtAt}|${'ibge' in area ? area.ibge : `${area.lon},${area.lat},${area.radiusKm}`}`;
    const hit = this.horizonCache.get(key);
    if (hit) return hit;
    const keep = 'ibge' in area
      ? (area.ibge === '52' ? () => true : (c: { 2: string }) => c[2] === area.ibge)
      : inCircle(area.lon, area.lat, area.radiusKm);
    const input = dailySeries(this.index, keep as Parameters<typeof dailySeries>[1]);
    const hc = hindcast(input, { paths: 'ibge' in area && area.ibge === '52' ? 200 : 120, twicePerMonth: 'ibge' in area && area.ibge === '52' });
    const widen = hc ? { fortnight: hc.horizons.fortnight.widen, month: hc.horizons.month.widen, semester: hc.horizons.semester.widen } : undefined;
    const projection = projectFrom(input, 500, widen);
    if (!projection) return null;
    const out = { projection, hindcast: hc };
    if (this.horizonCache.size > 300) this.horizonCache.clear();
    this.horizonCache.set(key, out);
    if ('ibge' in area && area.ibge === '52' && hc) {
      try {
        fs.mkdirSync(config.outDir, { recursive: true });
        fs.writeFileSync(path.join(config.outDir, 'projection_validation.json'), JSON.stringify({
          computedAt: new Date().toISOString(), source: 'firms_index', region: 'Goiás (UF 52)',
          model: projection.model, hindcast: hc,
        }, null, 2));
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not write out/projection_validation.json');
      }
    }
    return out;
  }

  /** FIRMS detection days of one map cell in a month (null without the FIRMS index). */
  public getCellDetections(lon: number, lat: number, resM: 1000 | 2000 | 5000, year: number, month: number): ReturnType<typeof cellDetections> | null {
    return this.index ? cellDetections(this.index, lon, lat, resM, year, month) : null;
  }

  private localities: Locality[] | null = null;
  public setLocalities(list: Locality[]): void { this.localities = list; }
  /** IBGE localities (map reference only); null while not loaded. Optionally only one municipality. */
  public getLocalities(ibge?: string): Locality[] | null {
    if (!this.localities) return null;
    return ibge ? this.localities.filter((l) => l.ibge === ibge) : this.localities;
  }

  /** One month, day by day, for a municipality, the state ('52') or a circle (null without the FIRMS index). */
  public getDaily(area: { ibge: string } | { lon: number; lat: number; radiusKm: number }, year: number, month: number): DayRow[] | null {
    if (!this.index) return null;
    const keep = 'ibge' in area
      ? (area.ibge === '52' ? () => true : (c: { 2: string }) => c[2] === area.ibge)
      : inCircle(area.lon, area.lat, area.radiusKm);
    return dailyOfMonth(this.index, keep as Parameters<typeof dailyOfMonth>[1], year, month);
  }

  /** Focos-raiz from the FIRMS index (null without it). */
  public getRecurrenceCells(q: {
    west: number;
    south: number;
    east: number;
    north: number;
    from: number;
    to: number;
    limit: number;
  }): { yearsObserved: number; cells: number[][] } | null {
    return this.index ? recurrenceFromIndex(this.index, q) : null;
  }
}

export const store = new CinderDataStore();
