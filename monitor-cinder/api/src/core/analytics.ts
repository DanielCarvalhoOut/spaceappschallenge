import type {
  AgroB2BRiskReport,
  AgroInsuranceUnderwriting,
  ClusteredFireEvent,
  FinancialRiskAnalysis,
  FirePredictabilityReport,
  FirmsHotspotRecord,
  Mcd12q1LandCoverProfile,
  Mod13q1BiomassProfile,
  NasaPowerDailyRecord,
  ResourceScalingEstimate,
  RootFireMonthProfile,
  RootFireSummary,
  RuralCreditAuditReport,
  TransmissionLineRowPriority,
} from './types.js';

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;

/**
 * Normalizes confidence across MODIS (0..100) and VIIRS/OLI ('l' | 'n' | 'h').
 * 0 = low, 1 = nominal, 2 = high
 */
export function normalizeConfidence(instrument: 'MODIS' | 'VIIRS' | 'OLI', raw: string): 0 | 1 | 2 {
  const clean = raw.trim().toLowerCase();
  if (instrument === 'VIIRS' || instrument === 'OLI') {
    if (clean === 'h' || clean === 'high') return 2;
    if (clean === 'l' || clean === 'low') return 0;
    const n = Number(clean);
    if (Number.isFinite(n)) return n < 30 ? 0 : n < 80 ? 1 : 2;
    return 1;
  }
  const num = Number(clean);
  if (!Number.isFinite(num)) return 1;
  if (num < 30) return 0;
  if (num < 80) return 1;
  return 2;
}

/**
 * Haversine distance in meters between two WGS84 coordinates.
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/**
 * Computes a 1 km Polyconic (SIRGAS 2000 / EPSG:5880, central meridian -54°) cell key
 * and an H3-like hexagonal spatial index (resolution ~8 / ~0.7 km²).
 */
export function computeSpatialKeys(lat: number, lon: number, cellMeters = 1000): { cellKey: string; h3LikeIndex: string } {
  const lon0 = -54.0;
  const xMeters = (lon - lon0) * DEG_TO_RAD * EARTH_RADIUS_M * Math.cos(lat * DEG_TO_RAD);
  const yMeters = lat * DEG_TO_RAD * EARTH_RADIUS_M;
  const gx = Math.floor(xMeters / cellMeters) + 10000000;
  const gy = Math.floor(yMeters / cellMeters) + 50000000;
  const cellKey = `${gx}${gy}`;

  // Axial hex coordinates (flat-top hex with radius ~620 m -> area ~1 km², similar to H3 res 8)
  const hexRadius = 620.0;
  const q = Math.round(((Math.sqrt(3) / 3) * xMeters - (1 / 3) * yMeters) / hexRadius);
  const r = Math.round(((2 / 3) * yMeters) / hexRadius);
  const qHex = ((q + 0x80000) & 0xfffff).toString(16).padStart(5, '0');
  const rHex = ((r + 0x80000) & 0xfffff).toString(16).padStart(5, '0');
  const h3LikeIndex = `88${qHex}${rHex}fff`;

  return { cellKey, h3LikeIndex };
}

/**
 * A. Spatial DBSCAN + H3/Grid Clustering for MODIS (1 km) & VIIRS (375 m) & LANDSAT (30 m)
 * Groups detections on the same day within `epsMeters` (default 1000 m) so the same fire front
 * detected by multiple satellites (Terra, Aqua, S-NPP, NOAA-20, NOAA-21) is counted once,
 * while aggregating Fire Radiative Power (FRP, in MW).
 */
export function clusterHotspotsDbscan(
  records: readonly FirmsHotspotRecord[],
  epsMeters = 1000
): ClusteredFireEvent[] {
  // Filter nominal + high confidence detections
  const valid = records.filter((r) => r.confidenceNorm >= 1);
  if (valid.length === 0) return [];

  // Group by acquisition day (UTC)
  const byDay = new Map<string, FirmsHotspotRecord[]>();
  for (const r of valid) {
    const list = byDay.get(r.acqDate);
    if (list) list.push(r);
    else byDay.set(r.acqDate, [r]);
  }

  const out: ClusteredFireEvent[] = [];
  let globalClusterId = 1;

  for (const [day, dayRecords] of byDay.entries()) {
    const n = dayRecords.length;
    const visited = new Uint8Array(n);
    const assigned = new Int32Array(n).fill(-1);

    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const clusterId = globalClusterId++;
      assigned[i] = clusterId;

      // BFS expansion within epsMeters (minPoints = 1 so isolated single-pixel fires also form a 1-pixel cluster)
      const queue: number[] = [i];
      while (queue.length > 0) {
        const curIdx = queue.pop()!;
        const cur = dayRecords[curIdx]!;
        for (let j = 0; j < n; j++) {
          if (visited[j]) continue;
          const cand = dayRecords[j]!;
          // Quick bounding box pre-filter (~0.015 deg ~ 1.6 km)
          if (Math.abs(cur.latitude - cand.latitude) > 0.015 || Math.abs(cur.longitude - cand.longitude) > 0.015) {
            continue;
          }
          if (haversineMeters(cur.latitude, cur.longitude, cand.latitude, cand.longitude) <= epsMeters) {
            visited[j] = 1;
            assigned[j] = clusterId;
            queue.push(j);
          }
        }
      }
    }

    // Aggregate clusters for this day
    const clustersMap = new Map<number, FirmsHotspotRecord[]>();
    for (let i = 0; i < n; i++) {
      const cid = assigned[i]!;
      const rec = dayRecords[i]!;
      const arr = clustersMap.get(cid);
      if (arr) arr.push(rec);
      else clustersMap.set(cid, [rec]);
    }

    for (const [cid, members] of clustersMap.entries()) {
      let sumLat = 0;
      let sumLon = 0;
      let maxFrp = 0;
      let sumFrp = 0;
      let maxBright: number | null = null;
      let maxConf: 0 | 1 | 2 = 0;
      let modisPixels = 0;
      let viirsPixels = 0;
      let landsatPixels = 0;
      const sensorSet = new Set<string>();

      for (const m of members) {
        sumLat += m.latitude;
        sumLon += m.longitude;
        const frp = Number.isFinite(m.frpMw) && m.frpMw >= 0 ? m.frpMw : 0;
        if (frp > maxFrp) maxFrp = frp;
        sumFrp += frp;
        if (m.brightnessK !== null && (maxBright === null || m.brightnessK > maxBright)) {
          maxBright = m.brightnessK;
        }
        if (m.confidenceNorm > maxConf) maxConf = m.confidenceNorm;
        if (m.instrument === 'MODIS') modisPixels++;
        else if (m.instrument === 'VIIRS') viirsPixels++;
        else landsatPixels++;
        sensorSet.add(m.sensor);
      }

      const centroidLat = Math.round((sumLat / members.length) * 100000) / 100000;
      const centroidLon = Math.round((sumLon / members.length) * 100000) / 100000;
      const { cellKey, h3LikeIndex } = computeSpatialKeys(centroidLat, centroidLon, 1000);

      out.push({
        clusterId: cid,
        day,
        centroidLat,
        centroidLon,
        cellKey,
        h3LikeIndex,
        detectionsCount: members.length,
        modisPixels,
        viirsPixels,
        landsatPixels,
        deduplicatedCount: members.length - 1,
        sensors: [...sensorSet].sort(),
        maxFrpMw: Math.round(maxFrp * 100) / 100,
        sumFrpMw: Math.round(sumFrp * 100) / 100,
        meanFrpMw: Math.round((sumFrp / members.length) * 100) / 100,
        maxBrightnessK: maxBright !== null ? Math.round(maxBright * 10) / 10 : null,
        maxConfidence: maxConf,
      });
    }
  }

  return out.sort((a, b) => b.day.localeCompare(a.day) || b.maxFrpMw - a.maxFrpMw);
}

/**
 * A. Operational Resource Scaling based on Fire Radiative Power (FRP, in MW) & Deduplicated Clusters
 */
export function estimateResourcesByFrp(
  activeClusters: number,
  rawDetections: number,
  meanFrpMw: number,
  maxFrpMw?: number
): ResourceScalingEstimate {
  const clusters = Math.max(0, Math.round(activeClusters));
  const raw = Math.max(clusters, Math.round(rawDetections));
  const avgFrp = Math.max(0, Number.isFinite(meanFrpMw) ? meanFrpMw : 0);
  const peakFrp = Math.max(avgFrp, Number.isFinite(maxFrpMw) ? maxFrpMw! : avgFrp);
  const totalFrpMw = Math.round(clusters * Math.max(avgFrp, clusters > 0 ? 12.5 : 0) * 10) / 10;

  let intensityClass: ResourceScalingEstimate['intensityClass'] = 'low';
  if (clusters === 0) intensityClass = 'low';
  else if (peakFrp >= 150 || totalFrpMw >= 1500) intensityClass = 'extreme';
  else if (peakFrp >= 50 || totalFrpMw >= 500) intensityClass = 'high';
  else if (peakFrp >= 15 || totalFrpMw >= 120) intensityClass = 'moderate';

  const brigadistas = clusters === 0 ? 0 : Math.max(4, Math.ceil(clusters * 2.2 + totalFrpMw / 22));
  const squads = clusters === 0 ? 0 : Math.max(1, Math.ceil(brigadistas / 6));
  const waterLiters =
    clusters === 0 ? 0 : Math.round((totalFrpMw * 350 + clusters * 1200) / 500) * 500;
  const waterTrucks = clusters === 0 ? 0 : Math.max(1, Math.ceil(waterLiters / 8000));
  const manualKits = clusters === 0 ? 0 : Math.max(4, Math.ceil(clusters * 2.5 + totalFrpMw / 20));
  const aircraftSupport =
    totalFrpMw >= 1200 || peakFrp >= 150 ? Math.max(1, Math.floor(totalFrpMw / 1200)) : 0;

  const deduplicatedRatioPct =
    raw > 0 ? Math.round(((raw - clusters) / raw) * 1000) / 10 : 0;

  return {
    intensityClass,
    activeClusters: clusters,
    rawDetections: raw,
    deduplicatedRatioPct,
    meanFrpMw: Math.round(avgFrp * 10) / 10,
    maxFrpMw: Math.round(peakFrp * 10) / 10,
    totalFrpMw,
    brigadistas,
    squads,
    waterLiters,
    waterTrucks,
    manualKits,
    aircraftSupport,
  };
}

/**
 * B. Root Fire Calendar & Historical Recurrence Analysis (2000–Present)
 * Crosses 20+ years of time series per geographic polygon to identify seasonal recurrence
 * (e.g., recurring agricultural burning in Aug/Sep or border clearing) and separate
 * climatic anomalies from recurring anthropogenic patterns (root fires / focos raízes).
 */
export function analyzeRootFires(
  rows: ReadonlyArray<{
    year: number;
    month: number;
    harmonized: number | null;
    anomalyZ: number | null;
  }>,
  fromYear = 2001,
  toYear = 2025
): RootFireSummary {
  const filtered = rows.filter((r) => r.year >= fromYear && r.year <= toYear && r.harmonized !== null);
  const byMonth = new Map<number, number[]>();
  for (let m = 1; m <= 12; m++) byMonth.set(m, []);
  for (const r of filtered) {
    const arr = byMonth.get(r.month);
    if (arr && r.harmonized !== null) arr.push(r.harmonized);
  }

  let totalMeanSum = 0;
  const rawStats: Array<{
    month: number;
    yearsObserved: number;
    mean: number;
    sd: number;
    vals: number[];
  }> = [];

  for (let m = 1; m <= 12; m++) {
    const vals = byMonth.get(m) ?? [];
    const n = vals.length;
    const mean = n > 0 ? vals.reduce((a, b) => a + b, 0) / n : 0;
    const sd =
      n >= 2 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0;
    totalMeanSum += mean;
    rawStats.push({ month: m, yearsObserved: n, mean, sd, vals });
  }

  const annualMonthlyAvg = totalMeanSum / 12;
  const profiles: RootFireMonthProfile[] = [];
  const rootMonths: number[] = [];

  for (const st of rawStats) {
    const threshold = Math.max(4, st.mean * 0.35, annualMonthlyAvg * 0.45);
    const yearsWithFire = st.vals.filter((v) => v >= threshold).length;
    const recurrencePct =
      st.yearsObserved > 0 ? Math.round((yearsWithFire / st.yearsObserved) * 1000) / 10 : 0;
    const cvRatio = st.mean > 0 ? Math.round((st.sd / st.mean) * 100) / 100 : 0;
    const isRootMonth =
      recurrencePct >= 65 && st.mean >= Math.max(6, annualMonthlyAvg * 0.75);

    let regime: RootFireMonthProfile['regime'] = 'low_activity';
    if (isRootMonth && cvRatio <= 0.85) {
      regime = 'anthropogenic_root';
    } else if (recurrencePct >= 50 && st.mean >= Math.max(5, annualMonthlyAvg * 0.6)) {
      regime = cvRatio > 0.85 ? 'root_with_climate_spikes' : 'anthropogenic_root';
    } else if (st.mean >= Math.max(4, annualMonthlyAvg * 0.4)) {
      regime = 'climatic_anomaly_driven';
    }

    if (isRootMonth) rootMonths.push(st.month);

    profiles.push({
      month: st.month,
      yearsObserved: st.yearsObserved,
      yearsWithFire,
      recurrencePct,
      meanHarmonized: Math.round(st.mean * 10) / 10,
      sdHarmonized: Math.round(st.sd * 10) / 10,
      cvRatio,
      isRootMonth,
      regime,
    });
  }

  // Persistence score in peak dry-season months (Jul–Oct)
  const dryMonths = profiles.filter((p) => p.month >= 7 && p.month <= 10);
  const persistenceScorePct =
    dryMonths.length > 0
      ? Math.round(
          (dryMonths.reduce((acc, p) => acc + p.recurrencePct, 0) / dryMonths.length) * 10
        ) / 10
      : 0;

  // Identify years with climatic anomalies (mean z >= 1.25 in fire season)
  const byYearZ = new Map<number, number[]>();
  for (const r of filtered) {
    if (r.month >= 7 && r.month <= 10 && r.anomalyZ !== null) {
      const list = byYearZ.get(r.year) ?? [];
      list.push(r.anomalyZ);
      byYearZ.set(r.year, list);
    }
  }
  const climaticAnomalyYears: number[] = [];
  for (const [yr, zs] of byYearZ.entries()) {
    const maxZ = Math.max(...zs);
    if (maxZ >= 1.45) climaticAnomalyYears.push(yr);
  }
  climaticAnomalyYears.sort((a, b) => a - b);

  // Share of hotspots occurring in root months vs episodic anomaly spikes
  const rootMonthSet = new Set(rootMonths.length ? rootMonths : [8, 9]);
  const rootSum = profiles
    .filter((p) => rootMonthSet.has(p.month))
    .reduce((acc, p) => acc + p.meanHarmonized, 0);
  const anthropogenicSharePct =
    totalMeanSum > 0 ? Math.round((rootSum / totalMeanSum) * 1000) / 10 : 0;

  let dominantRegime: RootFireSummary['dominantRegime'] = 'low_activity';
  if (persistenceScorePct >= 72) dominantRegime = 'anthropogenic_root';
  else if (persistenceScorePct >= 52 && climaticAnomalyYears.length >= 2)
    dominantRegime = 'root_with_climate_spikes';
  else if (totalMeanSum >= 24) dominantRegime = 'climatic_anomaly_driven';

  const peakProfile = [...profiles].sort((a, b) => b.meanHarmonized - a.meanHarmonized)[0];
  const peakM = peakProfile?.month ?? 9;
  const criticalWeeksLabel =
    peakM === 8
      ? 'Semanas 32–35 (Ago · Manejo/Queima Recorrente)'
      : peakM === 9
        ? 'Semanas 35–39 (Ago/Set · Pico Sazonal de Focos Raízes)'
        : peakM === 10
          ? 'Semanas 39–42 (Set/Out · Transição Seca–Chuva)'
          : `Mês ${peakM} (Semanas críticas de recorrência)`;

  return {
    persistenceScorePct,
    dominantRegime,
    rootMonths,
    criticalWeeksLabel,
    anthropogenicSharePct,
    climaticAnomalyYears,
    months: profiles,
  };
}

export function degreeToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const norm = ((deg % 360) + 360) % 360;
  const idx = Math.floor(((norm + 22.5) % 360) / 45);
  return dirs[idx] ?? 'N';
}

/**
 * C. Weather & Fire Predictability Engine (NASA POWER Daily Point + Root Fire Memory)
 * Variables: T2M_MAX (°C), RH2M (%), PRECTOTCORR (mm/day), WS10M (m/s), WD10M (°)
 */
export function computeFirePredictability(
  dailySeries: readonly NasaPowerDailyRecord[],
  rootRecurrencePct = 65,
  meanFrpMw = 22
): FirePredictabilityReport {
  const validT = dailySeries.map((d) => d.t2mMaxC).filter((v): v is number => v !== null && Number.isFinite(v));
  const validRh = dailySeries.map((d) => d.rh2mPct).filter((v): v is number => v !== null && Number.isFinite(v));
  const validRain = dailySeries.map((d) => d.prectotcorrMm).filter((v): v is number => v !== null && Number.isFinite(v));
  const validWs = dailySeries.map((d) => d.ws10mMs).filter((v): v is number => v !== null && Number.isFinite(v));
  const validWd = dailySeries.map((d) => d.wd10mDeg).filter((v): v is number => v !== null && Number.isFinite(v));

  const avg = (arr: number[], fallback: number) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : fallback;

  const t2mMaxC = Math.round(avg(validT, 34.5) * 10) / 10;
  const rh2mPct = Math.round(avg(validRh, 32.0) * 10) / 10;
  const prectotcorrMm = Math.round(validRain.reduce((a, b) => a + b, 0) * 10) / 10;
  const ws10mMs = Math.round(avg(validWs, 3.4) * 10) / 10;

  // Circular mean for wind direction WD10M (meteorological direction FROM which wind blows)
  let wd10mDeg = 82;
  if (validWd.length > 0) {
    let sinSum = 0;
    let cosSum = 0;
    for (const deg of validWd) {
      sinSum += Math.sin(deg * DEG_TO_RAD);
      cosSum += Math.cos(deg * DEG_TO_RAD);
    }
    const meanAngle = Math.atan2(sinSum / validWd.length, cosSum / validWd.length) / DEG_TO_RAD;
    wd10mDeg = Math.round(((meanAngle % 360) + 360) % 360);
  }

  // Count consecutive dry days (< 1.5 mm precipitation)
  let consecutiveDryDays = 0;
  let curDry = 0;
  for (const d of dailySeries) {
    if ((d.prectotcorrMm ?? 0) < 1.5) {
      curDry++;
      if (curDry > consecutiveDryDays) consecutiveDryDays = curDry;
    } else {
      curDry = 0;
    }
  }
  if (dailySeries.length === 0) consecutiveDryDays = 18;

  // Vapor Pressure Deficit (VPD in hPa) from Tetens equation at T2M_MAX and RH2M
  const esatHpa = 6.1078 * Math.exp((17.27 * t2mMaxC) / (t2mMaxC + 237.3));
  const vaporPressureDeficitHpa = Math.round(esatHpa * (1 - rh2mPct / 100) * 10) / 10;

  // Ignition Risk Score (0..100):
  // - Thermal factor (T2M_MAX): 0..28 pts
  // - Atmospheric dryness (RH2M + VPD): 0..28 pts
  // - Drought / precipitation deficit (consecutiveDryDays + rain): 0..18 pts
  // - Wind factor (WS10M): 0..11 pts
  // - Historical Root Fire memory (rootRecurrencePct): 0..15 pts
  const tempPts = Math.min(28, Math.max(0, (t2mMaxC - 22) * 1.65));
  const rhPts = Math.min(28, Math.max(0, (78 - rh2mPct) * 0.48));
  const dryPts = Math.min(18, Math.max(0, consecutiveDryDays * 0.65 - prectotcorrMm * 0.15));
  const windPts = Math.min(11, Math.max(0, ws10mMs * 2.1));
  const rootPts = Math.min(15, Math.max(0, rootRecurrencePct * 0.15));

  const ignitionRiskScore =
    Math.round(Math.min(100, Math.max(0, tempPts + rhPts + dryPts + windPts + rootPts)) * 10) / 10;

  let ignitionRiskClass: FirePredictabilityReport['ignitionRiskClass'] = 'low';
  if (ignitionRiskScore >= 78) ignitionRiskClass = 'extreme';
  else if (ignitionRiskScore >= 58) ignitionRiskClass = 'high';
  else if (ignitionRiskScore >= 38) ignitionRiskClass = 'moderate';

  // Downwind fire propagation vector:
  // WD10M is the direction the wind blows FROM; fire spreads TOWARD (WD10M + 180) mod 360
  const azimuthDeg = Math.round((wd10mDeg + 180) % 360);
  const cardinal = degreeToCardinal(azimuthDeg);
  const windFromCardinal = degreeToCardinal(wd10mDeg);

  // Rothermel-inspired savanna/Cerrado surface spread approximation (km/h & m/min)
  const moistureDamping = 1 + Math.max(0, 60 - rh2mPct) / 40;
  const frpBoost = 1 + Math.min(0.6, Math.max(0, meanFrpMw) / 150);
  const spreadRateKmh =
    Math.round(0.16 * Math.max(0.5, ws10mMs) * moistureDamping * frpBoost * 100) / 100;
  const spreadRateMMin = Math.round(((spreadRateKmh * 1000) / 60) * 10) / 10;
  const reachRadius6hKm = Math.round(spreadRateKmh * 6 * 10) / 10;

  return {
    ignitionRiskScore,
    ignitionRiskClass,
    consecutiveDryDays,
    vaporPressureDeficitHpa,
    weatherSummary: {
      t2mMaxC,
      rh2mPct,
      prectotcorrMm,
      ws10mMs,
      wd10mDeg,
      windFromCardinal,
    },
    propagation: {
      azimuthDeg,
      cardinal,
      spreadRateKmh,
      spreadRateMMin,
      reachRadius6hKm,
    },
    dailySeries: [...dailySeries],
  };
}

/**
 * D. Multi-Sensor B2B SaaS Fusion Engine:
 * Combines Fogo (FIRMS) + Clima (NASA POWER) + Biomassa/Safra (MOD13Q1) + Uso do Solo (MCD12Q1)
 * to compute the Agricultural Insurance Score (Score Agrícola para Seguros) and 4 B2B Verticals:
 * 1) Subscrição de Seguro Agrícola (Underwriting Rating AAA..CCC, Pure Risk Rate, Loading, Deductible)
 * 2) Análise de Risco Financeiro (EAL %, PML 95% %, VaR R$/ha)
 * 3) Priorização de Roçada de Linhas de Transmissão (ROW Clearing Priority, Smoke Flashover Risk, Buffer m)
 * 4) Auditoria de Crédito Rural & Compliance (BACEN Sicor / PROAGRO, RL/APP Exposure, Anthropogenic Flag)
 */
export function computeAgroB2BRiskReport(params: {
  harmonizedCount: number;
  anomalyZ: number | null;
  meanFrpMw: number;
  maxFrpMw: number;
  rootFires: RootFireSummary;
  month: number;
  predictability: FirePredictabilityReport;
  mod13q1: Mod13q1BiomassProfile;
  mcd12q1: Mcd12q1LandCoverProfile;
}): AgroB2BRiskReport {
  const {
    harmonizedCount,
    anomalyZ,
    meanFrpMw,
    maxFrpMw,
    rootFires,
    month,
    predictability,
    mod13q1,
    mcd12q1,
  } = params;

  const monthRoot = rootFires.months.find((m) => m.month === month);
  const monthRecurrencePct = monthRoot?.recurrencePct ?? rootFires.persistenceScorePct;

  // 1. Pillar 1: Fogo · NASA FIRMS (0..100, weight 30%)
  const zClamped = Math.max(-1.5, Math.min(3.5, anomalyZ ?? 0));
  const zPts = Math.max(0, (zClamped + 0.5) * 9.5); // 0..38
  const recPts = Math.min(34, monthRecurrencePct * 0.22 + rootFires.persistenceScorePct * 0.14); // 0..34
  const frpPts = Math.min(28, Math.log1p(Math.max(0, harmonizedCount)) * 3.8 + Math.min(14, maxFrpMw / 14)); // 0..28
  const firmsFireScore =
    Math.round(Math.min(100, Math.max(4, zPts + recPts + frpPts)) * 10) / 10;

  // 2. Pillar 2: Clima · NASA POWER + ML Propensity (0..100, weight 25%)
  const mlScore = predictability.mlPropensity?.propensityScore ?? predictability.ignitionRiskScore;
  const spreadBoost = Math.min(15, predictability.propagation.spreadRateKmh * 6.5);
  const powerClimateScore =
    Math.round(Math.min(100, Math.max(5, mlScore * 0.85 + spreadBoost)) * 10) / 10;

  // 3. Pillar 3: Biomassa / Safra · MODIS MOD13Q1 (0..100, weight 25%)
  const curingPts = Math.min(48, mod13q1.curingRatePct * 0.52);
  const fuelPts = Math.min(34, mod13q1.fuelLoadTonsHa * 2.35);
  const stressPts = Math.min(18, Math.max(0, -mod13q1.ndviAnomalyPct * 0.85));
  const mod13q1BiomassScore =
    Math.round(Math.min(100, Math.max(6, curingPts + fuelPts + stressPts)) * 10) / 10;

  // 4. Pillar 4: Uso do Solo & Interface · MODIS MCD12Q1 + PRODES (0..100, weight 20%)
  const interfacePts = mcd12q1.interfaceRiskIndex * 0.58;
  const agroExposurePts = Math.min(28, (mcd12q1.croplandPct * 0.42 + mcd12q1.pastureGrasslandPct * 0.28));
  const prodesPts = Math.min(16, mcd12q1.prodesDeforestationKm2 * 0.9);
  const mcd12q1LandUseScore =
    Math.round(Math.min(100, Math.max(8, interfacePts + agroExposurePts + prodesPts)) * 10) / 10;

  // Composite Agricultural Insurance Risk Score (0..100)
  const agroInsuranceScore =
    Math.round(
      Math.min(
        100,
        Math.max(
          5,
          firmsFireScore * 0.3 +
            powerClimateScore * 0.25 +
            mod13q1BiomassScore * 0.25 +
            mcd12q1LandUseScore * 0.2
        )
      ) * 10
    ) / 10;

  const insurabilityScore = Math.round((100 - agroInsuranceScore) * 10);

  let underwritingRating: AgroInsuranceUnderwriting['underwritingRating'] = 'BBB';
  if (agroInsuranceScore < 20) underwritingRating = 'AAA';
  else if (agroInsuranceScore < 32) underwritingRating = 'AA';
  else if (agroInsuranceScore < 45) underwritingRating = 'A';
  else if (agroInsuranceScore < 58) underwritingRating = 'BBB';
  else if (agroInsuranceScore < 70) underwritingRating = 'BB';
  else if (agroInsuranceScore < 82) underwritingRating = 'B';
  else underwritingRating = 'CCC';

  let riskTier: AgroInsuranceUnderwriting['riskTier'] = 'low';
  if (agroInsuranceScore >= 75) riskTier = 'extreme';
  else if (agroInsuranceScore >= 55) riskTier = 'high';
  else if (agroInsuranceScore >= 35) riskTier = 'moderate';

  // Actuarial pure risk rate (% p.a. of sum insured)
  const pureRiskRatePct =
    Math.round((0.55 + Math.pow(agroInsuranceScore / 100, 1.65) * 5.85) * 100) / 100;
  // Technical loading/discount vs neutral benchmark (score = 42)
  const recommendedLoadingPct = Math.round((agroInsuranceScore - 42) * 1.45 * 10) / 10;
  const suggestedDeductiblePct =
    agroInsuranceScore >= 75
      ? 22
      : agroInsuranceScore >= 55
        ? 15
        : agroInsuranceScore >= 35
          ? 10
          : 8;

  let underwritingDecision: AgroInsuranceUnderwriting['underwritingDecision'] = 'auto_approve';
  if (agroInsuranceScore >= 75) underwritingDecision = 'decline_or_reinsurance';
  else if (agroInsuranceScore >= 56) underwritingDecision = 'manual_inspection_required';
  else if (agroInsuranceScore >= 35) underwritingDecision = 'approve_with_firebreak_covenant';

  // Vertical 2: Financial Risk Analysis
  const expectedAnnualLossPct =
    Math.round(Math.min(35, pureRiskRatePct * 0.84) * 100) / 100;
  const probableMaximumLossP95Pct =
    Math.round(
      Math.min(
        85,
        expectedAnnualLossPct * (2.6 + predictability.propagation.spreadRateKmh * 0.95) +
          mod13q1.fuelLoadTonsHa * 0.55
      ) * 10
    ) / 10;
  // Average crop/pasture capital exposure per hectare in Goiás (~R$ 7,400/ha weighted by cropland share)
  const capitalPerHaBrl = 4200 + mcd12q1.croplandPct * 68;
  const valueAtRiskBrlPerHa = Math.round(capitalPerHaBrl * (probableMaximumLossP95Pct / 100));

  let burnSeverityPotential: FinancialRiskAnalysis['burnSeverityPotential'] = 'low';
  if (probableMaximumLossP95Pct >= 26 || maxFrpMw >= 140) burnSeverityPotential = 'catastrophic';
  else if (probableMaximumLossP95Pct >= 16 || maxFrpMw >= 65) burnSeverityPotential = 'high';
  else if (probableMaximumLossP95Pct >= 8 || meanFrpMw >= 20) burnSeverityPotential = 'moderate';

  // Vertical 3: Transmission Line Right-of-Way (ROW) Clearing Priority
  const rowClearingPriorityScore =
    Math.round(
      Math.min(
        100,
        Math.max(
          5,
          mod13q1BiomassScore * 0.36 +
            powerClimateScore * 0.32 +
            firmsFireScore * 0.32
        )
      ) * 10
    ) / 10;

  let priorityTier: TransmissionLineRowPriority['priorityTier'] = 'routine';
  if (rowClearingPriorityScore >= 76) priorityTier = 'immediate_dispatch';
  else if (rowClearingPriorityScore >= 56) priorityTier = 'urgent_7d';
  else if (rowClearingPriorityScore >= 36) priorityTier = 'scheduled_30d';

  let smokeOutageRiskClass: TransmissionLineRowPriority['smokeOutageRiskClass'] = 'low';
  if (rowClearingPriorityScore >= 75 || (maxFrpMw >= 110 && mod13q1.fuelLoadTonsHa >= 9)) {
    smokeOutageRiskClass = 'extreme';
  } else if (rowClearingPriorityScore >= 55 || maxFrpMw >= 55) {
    smokeOutageRiskClass = 'high';
  } else if (rowClearingPriorityScore >= 35) {
    smokeOutageRiskClass = 'moderate';
  }

  const recommendedBufferWidthM = Math.round(
    Math.min(85, Math.max(30, 28 + mod13q1.fuelLoadTonsHa * 2.4 + predictability.propagation.spreadRateKmh * 14))
  );

  // Vertical 4: Rural Credit Audit & Compliance (BACEN Sicor / PROAGRO)
  const anthroPenalty =
    monthRecurrencePct * 0.22 +
    rootFires.persistenceScorePct * 0.2 +
    rootFires.anthropogenicSharePct * 0.32 +
    Math.min(25, mcd12q1.prodesDeforestationKm2 * 1.4);
  const complianceScore =
    Math.round(Math.max(8, Math.min(98, 100 - anthroPenalty)) * 10) / 10;

  const anthropogenicBurnFlag =
    rootFires.dominantRegime === 'anthropogenic_root' ||
    rootFires.persistenceScorePct >= 65 ||
    (rootFires.rootMonths.length >= 1 && rootFires.anthropogenicSharePct >= 55);

  let creditAuditStatus: RuralCreditAuditReport['creditAuditStatus'] = 'compliant';
  if (complianceScore < 48 || (anthropogenicBurnFlag && mcd12q1.prodesDeforestationKm2 >= 8)) {
    creditAuditStatus = 'non_compliant_high_recurrence';
  } else if (complianceScore < 70 || anthropogenicBurnFlag) {
    creditAuditStatus = 'attention_seasonal_burn';
  }

  const rlAppExposurePct =
    Math.round(
      Math.min(
        100,
        Math.max(4, mcd12q1.forestRlAppPct * (0.45 + (firmsFireScore / 100) * 0.85))
      ) * 10
    ) / 10;

  return {
    pillars: {
      firmsFireScore,
      powerClimateScore,
      mod13q1BiomassScore,
      mcd12q1LandUseScore,
    },
    mod13q1,
    mcd12q1,
    insurance: {
      agroInsuranceScore,
      insurabilityScore,
      underwritingRating,
      riskTier,
      pureRiskRatePct,
      recommendedLoadingPct,
      suggestedDeductiblePct,
      underwritingDecision,
    },
    financialRisk: {
      expectedAnnualLossPct,
      probableMaximumLossP95Pct,
      valueAtRiskBrlPerHa,
      burnSeverityPotential,
    },
    transmissionLine: {
      rowClearingPriorityScore,
      priorityTier,
      smokeOutageRiskClass,
      recommendedBufferWidthM,
    },
    creditAudit: {
      complianceScore,
      creditAuditStatus,
      anthropogenicBurnFlag,
      rlAppExposurePct,
    },
  };
}
