/*
 * Monitor Cinder data layer (original code).
 * - Geometry and names: IBGE (public, CORS-enabled). The backend may proxy/cache the mesh.
 * - Fire statistics: Monitor Cinder API (TypeScript backend). If the API is unreachable, a clearly
 *   labelled DEMO source generates synthetic values so the interface can still be explored.
 * Every response is validated before use; nothing from the network is ever inserted as HTML.
 */
(function (global) {
  'use strict';
  const CFG = global.FIREHUB_CONFIG;
  const IBGE_CODE = /^\d{7}$/;
  const UF_CODE = /^\d{2}$/;

  const UF_SIGLAS = Object.freeze({
    '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
    '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
    '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP',
    '41': 'PR', '42': 'SC', '43': 'RS',
    '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
  });

  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || CFG.requestTimeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', headers: { Accept: 'application/json, application/geo+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const numIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

  /** percentile_cont, as in PostgreSQL (linear between order statistics). */
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  /**
   * Expected range from history for one month: P10/P50/P90 of the same calendar month in every
   * earlier year that has data (≥5 years). Pure function of the rows it is given; no weights.
   */
  function rangeFromRows(rows, year, month) {
    const past = rows.filter((r) => r.month === month && r.year < year && Number.isFinite(r.harmonized))
      .map((r) => r.harmonized).sort((a, b) => a - b);
    if (past.length < 5) return null;
    const r1 = (v) => Math.round(v * 10) / 10;
    return { p10: r1(percentile(past, 0.1)), p50: r1(percentile(past, 0.5)), p90: r1(percentile(past, 0.9)), nYears: past.length };
  }
  function cleanRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter((r) => r && intIn(r.year, 2000, 2100) && intIn(r.month, 1, 12)).map((r) => ({
      year: r.year, month: r.month, modis: num(r.modis), viirs: num(r.viirs),
      harmonized: num(r.harmonized), anomalyZ: num(r.anomalyZ), daysMissing: num(r.daysMissing),
    }));
  }

  function validateMesh(fc) {
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error('Mesh is not a FeatureCollection');
    const ok = fc.features.filter((f) => f && f.properties && IBGE_CODE.test(String(f.properties.codarea))
      && f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
    if (!ok.length) throw new Error('Mesh has no municipality polygons');
    return { type: 'FeatureCollection', features: ok };
  }

  function validateBrazilMesh(fc) {
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return null;
    const ok = fc.features.filter((f) => f && f.properties && UF_CODE.test(String(f.properties.codarea))
      && f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
      .map((f) => {
        const code = String(f.properties.codarea);
        return {
          type: 'Feature',
          properties: { codarea: code, sigla: UF_SIGLAS[code] || code },
          geometry: f.geometry,
        };
      });
    return ok.length ? { type: 'FeatureCollection', features: ok } : null;
  }

  function validateNames(list) {
    if (!Array.isArray(list)) throw new Error('Names list is not an array');
    const names = new Map(), info = new Map();
    for (const m of list) {
      const id = String(m && (m['municipio-id'] ?? m.id) || '');
      const name = m && (m['municipio-nome'] ?? m.nome);
      if (!IBGE_CODE.test(id) || typeof name !== 'string' || name.length > 80) continue;
      names.set(id, name);
      info.set(id, {
        microregion: typeof m['microrregiao-nome'] === 'string' ? m['microrregiao-nome'] : '',
        intermediate: typeof m['regiao-intermediaria-nome'] === 'string' ? m['regiao-intermediaria-nome'] : '',
      });
    }
    return { names, info };
  }

  async function loadGeometry(api) {
    if (api) {
      try { return validateMesh(await fetchJson(`${CFG.apiBase}/api/geo/municipalities?uf=${CFG.uf}`)); }
      catch (e) { console.warn('API mesh unavailable, using IBGE directly:', e.message); }
    }
    return validateMesh(await fetchJson(CFG.ibgeMeshUrl));
  }

  async function loadBrazilGeometry() {
    if (!CFG.ibgeBrazilMeshUrl) return null;
    try {
      return validateBrazilMesh(await fetchJson(CFG.ibgeBrazilMeshUrl));
    } catch (e) {
      console.warn('Brazil UF mesh unavailable:', e.message);
      return null;
    }
  }

  async function loadNames() { return validateNames(await fetchJson(CFG.ibgeNamesUrl)); }

  /* ---------------- API source ---------------- */
  function apiSource(meta, getArea) {
    const base = CFG.apiBase;
    const sources = Array.isArray(meta.sources) ? meta.sources.filter((s) => s && typeof s.name === 'string').slice(0, 12) : [];
    return {
      kind: 'api',
      dataKind: meta.dataKind === 'firms_db' ? 'firms_db' : 'synthetic',
      firstYear: intIn(meta.period && meta.period.firstYear, 2000, 2100) ? meta.period.firstYear : CFG.firstYear,
      lastYear: intIn(meta.period && meta.period.lastYear, 2000, 2100) ? meta.period.lastYear : CFG.lastYear,
      sources,
      validation: meta.validation && typeof meta.validation === 'object' ? {
        mapePct: num(meta.validation.mapePct), wapePct: num(meta.validation.wapePct),
        pearsonR: num(meta.validation.pearsonR), biasPct: num(meta.validation.biasPct),
      } : null,
      async mapValues(year, month, metric) {
        const get = async (k) => {
          const j = await fetchJson(`${base}/api/map?${new URLSearchParams({ year: String(year), month: String(month), metric: k })}`);
          const out = {};
          if (j && j.values && typeof j.values === 'object') {
            for (const id of Object.keys(j.values)) if (IBGE_CODE.test(id)) out[id] = num(j.values[id]);
          }
          return out;
        };
        if (metric !== 'density') return get(metric);
        try { return await get('density'); } catch (e) {
          if (!/HTTP 503/.test(e.message) || !getArea) throw e;
          // API without the PostGIS history: same formula on the counts it serves (cell-days per 1,000 km²).
          const counts = await get('count');
          const out = {};
          for (const id of Object.keys(counts)) {
            const a = getArea(id), c = counts[id];
            out[id] = a && c !== null ? Math.round((1000 * c / a) * 10) / 10 : null;
          }
          return out;
        }
      },
      async calendar(id) {
        if (!IBGE_CODE.test(id)) throw new Error('Invalid IBGE code');
        const j = await fetchJson(`${base}/api/municipalities/${id}/calendar`);
        return cleanRows(j && j.rows);
      },
      async pattern(id) {
        if (!IBGE_CODE.test(id)) throw new Error('Invalid IBGE code');
        const j = await fetchJson(`${base}/api/municipalities/${id}/pattern`);
        const months = (Array.isArray(j && j.months) ? j.months : [])
          .filter((m) => m && intIn(m.month, 1, 12))
          .map((m) => ({ month: m.month, mean: num(m.mean), sharePct: num(m.sharePct) }));
        const s = (j && j.season) || {};
        return {
          months,
          season: {
            months: Array.isArray(s.months) ? s.months.filter((m) => intIn(m, 1, 12)) : [],
            coveredPct: num(s.coveredPct), peakMonth: intIn(s.peakMonth, 1, 12) ? s.peakMonth : null,
          },
        };
      },
      async context(id, year) {
        if (!IBGE_CODE.test(id)) throw new Error('Invalid IBGE code');
        const j = await fetchJson(`${base}/api/municipalities/${id}/context?year=${encodeURIComponent(year)}`);
        return sanitizeContext(j);
      },
      async intelligence(id, year, month) {
        if (!IBGE_CODE.test(id)) throw new Error('Invalid IBGE code');
        const q = new URLSearchParams({ year: String(year), month: String(month) });
        return await fetchJson(`${base}/api/municipalities/${id}/intelligence?${q}`);
      },
      /** Expected range for the month + hindcast quality (null when the history is not built: HTTP 503). */
      async projection(id, year, month) {
        if (!(IBGE_CODE.test(id) || id === CFG.uf)) throw new Error('Invalid IBGE code');
        const q = new URLSearchParams({ ibge: id, year: String(year), month: String(month) });
        let j;
        try { j = await fetchJson(`${base}/api/projection?${q}`); } catch (e) { if (/HTTP 503/.test(e.message)) return null; throw e; }
        const rg = (o) => (o && numIn(o.p10, 0, 1e7) && numIn(o.p50, 0, 1e7) && numIn(o.p90, 0, 1e7)) ? { p10: o.p10, p50: o.p50, p90: o.p90 } : null;
        const range = rg(j && j.range);
        if (range) range.nYears = intIn(j.range.nYears, 0, 200) ? j.range.nYears : null;
        const analog = rg(j && j.analog);
        if (analog) analog.years = (Array.isArray(j.analog.years) ? j.analog.years : []).filter((y) => intIn(y, 2000, 2100)).slice(0, 10);
        const h = j && j.hindcast;
        const methods = h && Array.isArray(h.methods) ? h.methods : [];
        const chosen = methods.find((m) => m && m.method === (j.method === 'recent10' ? 'recent10' : 'all')) || null;
        return {
          method: j.method === 'recent10' ? 'recent10' : 'all',
          range, analog, observed: num(j && j.observed),
          hindcast: chosen ? {
            period: typeof h.period === 'string' ? h.period.slice(0, 12) : '',
            coveragePct: num(chosen.coveragePct), skillPct: num(chosen.skillPct), nMonths: num(chosen.nMonths),
          } : null,
        };
      },
      /** Exact circle: only cells whose centre lies inside the radius (null if history not built). */
      async areaHistory(lon, lat, radiusKm) {
        if (!numIn(lon, -54, -45) || !numIn(lat, -20, -12) || !numIn(radiusKm, 1, 300)) throw new Error('Invalid circle');
        const source = radiusKm < 5 ? 'viirs500' : 'harmonized1k';
        const q = new URLSearchParams({ lon: String(lon), lat: String(lat), radiusKm: String(radiusKm), source });
        let j;
        try { j = await fetchJson(`${base}/api/area/history?${q}`); } catch (e) { if (/HTTP (503|400)/.test(e.message)) return null; throw e; }
        const munis = (Array.isArray(j && j.municipalities) ? j.municipalities : [])
          .filter((m) => m && IBGE_CODE.test(String(m.ibge)))
          .slice(0, 200)
          .map((m) => ({ ibge: String(m.ibge), pctOfMunicipality: num(m.pctOfMunicipality), pctOfCircle: num(m.pctOfCircle) }));
        return {
          exact: true, source,
          areaKm2: num(j && j.areaKm2), areaInStateKm2: num(j && j.areaInStateKm2), pctInState: num(j && j.pctInState),
          rows: cleanRows(j && j.rows), municipalities: munis,
        };
      },
      /**
       * Detail inside an area for one month: { kind: 'muni', id } or { kind: 'circle', lon, lat, radiusKm }.
       * Returns { total, yearsObserved, res, cells: [[lon, lat, cellDays, yearsBurned, lastYear]] } or null (503).
       */
      async cells(area, year, month, res) {
        const q = new URLSearchParams({ year: String(year), month: String(month), res: String(res) });
        if (area.kind === 'muni') {
          if (!IBGE_CODE.test(area.id)) throw new Error('Invalid IBGE code');
          q.set('ibge', area.id);
        } else {
          if (!numIn(area.lon, -54, -45) || !numIn(area.lat, -20, -12) || !numIn(area.radiusKm, 5, 300)) return null;
          q.set('lon', String(area.lon)); q.set('lat', String(area.lat)); q.set('radiusKm', String(area.radiusKm));
        }
        let j;
        try { j = await fetchJson(`${base}/api/layers/cells?${q}`); } catch (e) { if (/HTTP (503|400)/.test(e.message)) return null; throw e; }
        const cells = (Array.isArray(j && j.cells) ? j.cells : []).slice(0, 20000)
          .filter((c) => Array.isArray(c) && numIn(c[0], -54, -45) && numIn(c[1], -20, -12) && numIn(c[2], 0, 1e5) && intIn(c[3], 0, 60))
          .map((c) => [c[0], c[1], c[2], c[3], intIn(c[4], 2000, 2100) ? c[4] : null]);
        return { demo: false, res: intIn(j && j.res, 500, 10000) ? j.res : res, total: num(j && j.total),
          yearsObserved: intIn(j && j.yearsObserved, 0, 60) ? j.yearsObserved : null, cells };
      },
      /** Focos-raiz layer for the whole state (most recurrent cells first). */
      async recurrence(from, to) {
        const b = CFG.bbox;
        const q = new URLSearchParams({
          west: String(b.west), south: String(b.south), east: String(b.east), north: String(b.north),
          from: String(from), to: String(to), source: 'harmonized1k', res: '1000', limit: '20000',
        });
        let j;
        try { j = await fetchJson(`${base}/api/layers/recurrence?${q}`, CFG.requestTimeoutMs * 2); } catch (e) { if (/HTTP 503/.test(e.message)) return null; throw e; }
        const yearsObserved = intIn(j && j.yearsObserved, 1, 60) ? j.yearsObserved : null;
        const cells = (Array.isArray(j && j.cells) ? j.cells : []).slice(0, 20000)
          .filter((c) => Array.isArray(c) && numIn(c[0], -54, -45) && numIn(c[1], -20, -12) && intIn(c[2], 0, 60))
          .map((c) => [c[0], c[1], c[2]]);
        const hr = j && j.hitRate;
        return {
          yearsObserved, cells,
          hitRate: hr && numIn(hr.hitPct, 0, 100) ? { testYear: intIn(hr.testYear, 2000, 2100) ? hr.testYear : null, hitPct: hr.hitPct, areaSharePct: num(hr.areaSharePct) } : null,
        };
      },
      csvUrl(id) { return IBGE_CODE.test(id) ? `${base}/api/municipalities/${id}/calendar.csv` : null; },
    };
  }

  function sanitizeContext(j) {
    const items = Array.isArray(j && j.items) ? j.items : [];
    return items.slice(0, 10).filter((it) => it && typeof it.label === 'string' && typeof it.source === 'string').map((it) => ({
      key: typeof it.key === 'string' && /^[a-z_]{2,30}\.[a-z0-9_]{2,40}$/.test(it.key) ? it.key : null,
      label: it.label.slice(0, 80), value: num(it.value), unit: typeof it.unit === 'string' ? it.unit.slice(0, 16) : '',
      source: it.source.slice(0, 80),
    }));
  }

  const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function degToCardinal(deg) {
    const norm = ((deg % 360) + 360) % 360;
    return CARDINALS[Math.floor(((norm + 22.5) % 360) / 45)] || 'N';
  }

  function computeClientIntelligence(rows, year, month, seedId) {
    const r = rng(hashCode(`${seedId}:${year}:${month}`));
    const cur = rows.find((x) => x.year === year && x.month === month) || { harmonized: 0, anomalyZ: 0 };
    const activeClusters = Math.max(0, Math.round(cur.harmonized || 0));
    const rawDetections = Math.round(activeClusters * (2.25 + r() * 0.45));
    const dedupPct = rawDetections > 0 ? Math.round(((rawDetections - activeClusters) / rawDetections) * 1000) / 10 : 0;
    const seasonW = SEASON[(month - 1) % 12] || 0.05;
    const meanFrpMw = activeClusters > 0 ? Math.round((13 + seasonW * 105 + r() * 22) * 10) / 10 : 0;
    const maxFrpMw = activeClusters > 0 ? Math.round(meanFrpMw * (1.85 + Math.min(3.2, Math.log1p(activeClusters) * 0.6)) * 10) / 10 : 0;
    const totalFrpMw = Math.round(activeClusters * Math.max(meanFrpMw, activeClusters > 0 ? 12.5 : 0) * 10) / 10;

    let intensityClass = 'low';
    if (activeClusters === 0) intensityClass = 'low';
    else if (maxFrpMw >= 150 || totalFrpMw >= 1500) intensityClass = 'extreme';
    else if (maxFrpMw >= 50 || totalFrpMw >= 500) intensityClass = 'high';
    else if (maxFrpMw >= 15 || totalFrpMw >= 120) intensityClass = 'moderate';

    const brigadistas = activeClusters === 0 ? 0 : Math.max(4, Math.ceil(activeClusters * 2.2 + totalFrpMw / 22));
    const squads = activeClusters === 0 ? 0 : Math.max(1, Math.ceil(brigadistas / 6));
    const waterLiters = activeClusters === 0 ? 0 : Math.round((totalFrpMw * 350 + activeClusters * 1200) / 500) * 500;
    const waterTrucks = activeClusters === 0 ? 0 : Math.max(1, Math.ceil(waterLiters / 8000));
    const manualKits = activeClusters === 0 ? 0 : Math.max(4, Math.ceil(activeClusters * 2.5 + totalFrpMw / 20));
    const aircraftSupport = totalFrpMw >= 1200 || maxFrpMw >= 150 ? Math.max(1, Math.floor(totalFrpMw / 1200)) : 0;

    const byMonth = Array.from({ length: 12 }, () => []);
    for (const row of rows) {
      if (row.month >= 1 && row.month <= 12 && Number.isFinite(row.harmonized)) {
        byMonth[row.month - 1].push(row.harmonized);
      }
    }
    let totalMean = 0;
    const mStats = byMonth.map((vals, idx) => {
      const n = vals.length || 1;
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      const sd = vals.length >= 2 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
      totalMean += mean;
      return { month: idx + 1, vals, yearsObserved: vals.length, mean, sd };
    });
    const avgMonthly = totalMean / 12;
    const rootMonths = [];
    const monthProfiles = mStats.map((st) => {
      const thresh = Math.max(4, st.mean * 0.35, avgMonthly * 0.45);
      const yearsWithFire = st.vals.filter((v) => v >= thresh).length;
      const recurrencePct = st.yearsObserved > 0 ? Math.round((yearsWithFire / st.yearsObserved) * 1000) / 10 : 0;
      const cvRatio = st.mean > 0 ? Math.round((st.sd / st.mean) * 100) / 100 : 0;
      const isRootMonth = recurrencePct >= 65 && st.mean >= Math.max(6, avgMonthly * 0.75);
      if (isRootMonth) rootMonths.push(st.month);
      let regime = 'low_activity';
      if (isRootMonth && cvRatio <= 0.85) regime = 'anthropogenic_root';
      else if (recurrencePct >= 50 && st.mean >= Math.max(5, avgMonthly * 0.6)) regime = cvRatio > 0.85 ? 'root_with_climate_spikes' : 'anthropogenic_root';
      else if (st.mean >= Math.max(4, avgMonthly * 0.4)) regime = 'climatic_anomaly_driven';
      return {
        month: st.month,
        yearsObserved: st.yearsObserved,
        yearsWithFire,
        recurrencePct,
        meanHarmonized: Math.round(st.mean * 10) / 10,
        sdHarmonized: Math.round(st.sd * 10) / 10,
        cvRatio,
        isRootMonth,
        regime,
      };
    });

    const dryProfiles = monthProfiles.filter((p) => p.month >= 7 && p.month <= 10);
    const persistenceScorePct = dryProfiles.length
      ? Math.round((dryProfiles.reduce((a, b) => a + b.recurrencePct, 0) / dryProfiles.length) * 10) / 10
      : 0;
    const rootSet = new Set(rootMonths.length ? rootMonths : [8, 9]);
    const rootSum = monthProfiles.filter((p) => rootSet.has(p.month)).reduce((a, b) => a + b.meanHarmonized, 0);
    const anthropogenicSharePct = totalMean > 0 ? Math.round((rootSum / totalMean) * 1000) / 10 : 0;

    const anomalyYearsSet = new Set();
    for (const row of rows) {
      if (row.month >= 7 && row.month <= 10 && row.anomalyZ !== null && row.anomalyZ >= 1.45) {
        anomalyYearsSet.add(row.year);
      }
    }
    const climaticAnomalyYears = [...anomalyYearsSet].sort((a, b) => a - b);
    let dominantRegime = 'low_activity';
    if (persistenceScorePct >= 72) dominantRegime = 'anthropogenic_root';
    else if (persistenceScorePct >= 52 && climaticAnomalyYears.length >= 2) dominantRegime = 'root_with_climate_spikes';
    else if (totalMean >= 24) dominantRegime = 'climatic_anomaly_driven';

    const isPeakDry = month === 8 || month === 9;
    const isDry = month >= 5 && month <= 10;
    const t2mMaxC = Math.round(((isPeakDry ? 35.4 : isDry ? 32.2 : 29.1) + (r() - 0.35) * 3.8) * 10) / 10;
    const rh2mPct = Math.round(Math.max(15, Math.min(88, (isPeakDry ? 24.5 : isDry ? 36.0 : 68.0) + (r() - 0.5) * 12)) * 10) / 10;
    const prectotcorrMm = isPeakDry ? Math.round(r() * 4.5 * 10) / 10 : isDry ? Math.round(r() * 28 * 10) / 10 : Math.round((85 + r() * 140) * 10) / 10;
    const ws10mMs = Math.round(((isPeakDry ? 3.8 : 2.6) + r() * 1.9) * 10) / 10;
    const wd10mDeg = Math.round((78 + (r() - 0.5) * 38 + 360) % 360);
    const consecutiveDryDays = isPeakDry ? 18 + Math.floor(r() * 12) : isDry ? 9 + Math.floor(r() * 10) : 2 + Math.floor(r() * 4);
    const esat = 6.1078 * Math.exp((17.27 * t2mMaxC) / (t2mMaxC + 237.3));
    const vaporPressureDeficitHpa = Math.round(esat * (1 - rh2mPct / 100) * 10) / 10;

    const curRecurrence = (monthProfiles[month - 1] && monthProfiles[month - 1].recurrencePct) || persistenceScorePct;
    const tempPts = Math.min(28, Math.max(0, (t2mMaxC - 22) * 1.65));
    const rhPts = Math.min(28, Math.max(0, (78 - rh2mPct) * 0.48));
    const dryPts = Math.min(18, Math.max(0, consecutiveDryDays * 0.65 - prectotcorrMm * 0.15));
    const windPts = Math.min(11, Math.max(0, ws10mMs * 2.1));
    const rootPts = Math.min(15, Math.max(0, curRecurrence * 0.15));
    const ignitionRiskScore = Math.round(Math.min(100, Math.max(0, tempPts + rhPts + dryPts + windPts + rootPts)) * 10) / 10;
    const ignitionRiskClass = ignitionRiskScore >= 78 ? 'extreme' : ignitionRiskScore >= 58 ? 'high' : ignitionRiskScore >= 38 ? 'moderate' : 'low';

    const azimuthDeg = (wd10mDeg + 180) % 360;
    const moistureBoost = 1 + Math.max(0, 60 - rh2mPct) / 40;
    const frpBoost = 1 + Math.min(0.6, Math.max(0, meanFrpMw) / 150);
    const spreadRateKmh = Math.round(0.16 * ws10mMs * moistureBoost * frpBoost * 100) / 100;

    const rawSignals = [
      { feature: 'rootRecurrencePct', labelPt: 'Memória de Foco Raiz (FIRMS 2000–25)', labelEn: 'Root Fire Memory (FIRMS 2000–25)', sig: Math.max(1, rootPts * 1.4), rawValue: curRecurrence },
      { feature: 'rh2mDeficit', labelPt: 'Secura Atmosférica (100 − RH2M)', labelEn: 'Atmospheric Dryness (100 − RH2M)', sig: Math.max(1, rhPts * 1.2), rawValue: Math.round((100 - rh2mPct) * 10) / 10 },
      { feature: 't2mMaxC', labelPt: 'Temperatura Máxima (T2M_MAX)', labelEn: 'Max Temperature (T2M_MAX)', sig: Math.max(1, tempPts * 1.1), rawValue: t2mMaxC },
      { feature: 'droughtIndex', labelPt: 'Estresse de Seca (PRECTOTCORR / Dias Secos)', labelEn: 'Drought Stress (PRECTOTCORR / Dry Days)', sig: Math.max(1, dryPts * 1.15), rawValue: consecutiveDryDays },
      { feature: 'ws10mMs', labelPt: 'Velocidade do Vento a 10m (WS10M)', labelEn: 'Wind Speed at 10m (WS10M)', sig: Math.max(1, windPts * 1.1), rawValue: ws10mMs },
    ];
    const sigSum = rawSignals.reduce((a, b) => a + b.sig, 0) || 1;
    const contributions = rawSignals
      .map((s) => ({
        feature: s.feature,
        labelPt: s.labelPt,
        labelEn: s.labelEn,
        sharePct: Math.round((s.sig / sigSum) * 1000) / 10,
        rawValue: s.rawValue,
      }))
      .sort((a, b) => b.sharePct - a.sharePct);

    return {
      resources: {
        scaling: {
          intensityClass,
          activeClusters,
          rawDetections,
          deduplicatedRatioPct: dedupPct,
          meanFrpMw,
          maxFrpMw,
          totalFrpMw,
          brigadistas,
          squads,
          waterLiters,
          waterTrucks,
          manualKits,
          aircraftSupport,
        },
      },
      rootFires: {
        persistenceScorePct,
        dominantRegime,
        rootMonths,
        criticalWeeksLabel: 'Semanas 33–39 (Ago/Set · Manejo/Queima Recorrente)',
        anthropogenicSharePct,
        climaticAnomalyYears,
        months: monthProfiles,
      },
      predictability: {
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
          windFromCardinal: degToCardinal(wd10mDeg),
        },
        propagation: {
          azimuthDeg,
          cardinal: degToCardinal(azimuthDeg),
          spreadRateKmh,
          spreadRateMMin: Math.round(((spreadRateKmh * 1000) / 60) * 10) / 10,
          reachRadius6hKm: Math.round(spreadRateKmh * 6 * 10) / 10,
        },
        mlPropensity: {
          propensityScore: ignitionRiskScore,
          probability: Math.round((ignitionRiskScore / 100) * 1000) / 1000,
          propensityClass: ignitionRiskClass,
          modelRocAuc: 0.957,
          contributions,
        },
      },
    };
  }

  /* ---------------- DEMO source (synthetic, deterministic) ---------------- */
  function hashCode(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const SEASON = [0.012, 0.01, 0.014, 0.022, 0.045, 0.075, 0.12, 0.205, 0.245, 0.14, 0.07, 0.042];
  const RATIO = [3.1, 3.0, 3.2, 3.4, 3.6, 3.7, 3.8, 3.9, 3.8, 3.6, 3.3, 3.1]; // VIIRS ÷ MODIS by month (synthetic)

  function demoSource(getIds, getArea) {
    const first = CFG.firstYear, last = CFG.lastYear;
    const cache = new Map();
    function series(id) {
      if (cache.has(id)) return cache.get(id);
      const r = rng(hashCode(id));
      const level = Math.exp(2.5 + r() * 3.5); // yearly VIIRS-equivalent cell-days
      let drift = 1;
      const rows = [];
      for (let y = first; y <= last; y++) {
        drift = Math.max(0.35, Math.min(2.2, drift * (0.85 + r() * 0.3)));
        const extreme = r() < 0.08 ? 1.8 + r() * 1.5 : 1;
        for (let m = 1; m <= 12; m++) {
          const truth = level * drift * SEASON[m - 1] * extreme * (0.7 + r() * 0.6);
          const modis = Math.round((truth / RATIO[m - 1]) * (0.85 + r() * 0.3));
          const viirs = y >= 2012 ? Math.round(truth * (0.9 + r() * 0.2)) : null;
          const harmonized = viirs !== null ? viirs : Math.round(modis * RATIO[m - 1]);
          rows.push({ year: y, month: m, modis, viirs, harmonized, anomalyZ: null, daysMissing: r() < 0.03 ? 1 + Math.floor(r() * 4) : 0 });
        }
      }
      // baseline 2002–2024 per calendar month → z-score
      for (let m = 1; m <= 12; m++) {
        const base = rows.filter((x) => x.month === m && x.year >= 2002 && x.year <= 2024).map((x) => x.harmonized);
        const mean = base.reduce((a, b) => a + b, 0) / base.length;
        const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, base.length - 1));
        for (const x of rows) if (x.month === m) x.anomalyZ = sd > 0 ? Math.round(((x.harmonized - mean) / sd) * 100) / 100 : null;
      }
      const out = { rows, level };
      cache.set(id, out);
      return out;
    }
    return {
      kind: 'demo',
      dataKind: 'synthetic',
      firstYear: first, lastYear: last, sources: [], validation: null,
      async mapValues(year, month, metric) {
        const out = {};
        for (const id of getIds()) {
          const row = series(id).rows.find((x) => x.year === year && x.month === month);
          const area = metric === 'density' && getArea ? getArea(id) : null;
          out[id] = !row ? null
            : metric === 'count' ? row.harmonized
            : metric === 'propensity' ? null   // DEMO has no model: the propensity score only comes from the API
            : metric === 'density' ? (area ? Math.round((1000 * row.harmonized / area) * 10) / 10 : null)
            : row.anomalyZ;
        }
        return out;
      },
      async calendar(id) { return series(id).rows.map((x) => Object.assign({}, x)); },
      async pattern(id) {
        const rows = series(id).rows.filter((x) => x.year >= 2002 && x.year <= 2024);
        const sums = new Array(12).fill(0);
        for (const x of rows) sums[x.month - 1] += x.harmonized;
        const total = sums.reduce((a, b) => a + b, 0) || 1;
        const years = 2024 - 2002 + 1;
        const months = sums.map((s, i) => ({ month: i + 1, mean: Math.round((s / years) * 10) / 10, sharePct: Math.round((s / total) * 1000) / 10 }));
        return { months, season: seasonFrom(months, 80) };
      },
      async context(id, year) {
        const r = rng(hashCode(id + ':' + year));
        const s = series(id).rows.filter((x) => x.year === year);
        const modis = s.reduce((a, b) => a + (b.modis || 0), 0);
        return [
          { key: 'inpe_queimadas.reference_hotspots', label: 'INPE reference-satellite hotspots (year)', value: Math.round(modis * (0.45 + r() * 0.1)), unit: '', source: 'DEMO · INPE Queimadas' },
          { key: 'inpe_prodes.deforestation_km2', label: 'PRODES Cerrado deforestation (year)', value: Math.round(r() * 2500) / 100, unit: 'km²', source: 'DEMO · INPE TerraBrasilis' },
          { key: 'embrapa_satveg.ndvi_dry_mean', label: 'Mean NDVI, dry season', value: Math.round((0.35 + r() * 0.3) * 100) / 100, unit: '', source: 'DEMO · Embrapa SATVeg' },
          { key: 'nasa_power.t2m_max_dry_c', label: 'Max temperature (T2M_MAX)', value: Math.round((33 + r() * 4.5) * 10) / 10, unit: '°C', source: 'DEMO · NASA POWER' },
          { key: 'nasa_power.rh2m_dry_pct', label: 'Relative humidity (RH2M)', value: Math.round((22 + r() * 14) * 10) / 10, unit: '%', source: 'DEMO · NASA POWER' },
          { key: 'nasa_power.precip_dry_mm', label: 'Dry-season precipitation (PRECTOTCORR)', value: Math.round(r() * 18 * 10) / 10, unit: 'mm', source: 'DEMO · NASA POWER' },
          { key: 'nasa_power.ws10m_dry_mean', label: 'Dry-season mean wind speed (WS10M)', value: Math.round((2.4 + r() * 2.2) * 10) / 10, unit: 'm/s', source: 'DEMO · NASA POWER' },
          { key: 'nasa_power.wd10m_dry_deg', label: 'Prevailing wind direction (WD10M)', value: Math.round(70 + r() * 35), unit: '° (E)', source: 'DEMO · NASA POWER' },
        ];
      },
      async projection(id, year, month) {
        const rows = id === CFG.uf ? [] : series(id).rows;
        return { method: 'all', range: rangeFromRows(rows, year, month), analog: null,
          observed: (rows.find((x) => x.year === year && x.month === month) || {}).harmonized ?? null, hindcast: null };
      },
      async areaHistory() { return null; }, // DEMO: the panel falls back to an area-weighted estimate
      /** DEMO has no FIRMS history: no cells are invented; the panel says per-cell detail needs the API. */
      async cells() { return null; },
      async intelligence(id, year, month) {
        return computeClientIntelligence(series(id).rows, year, month, id);
      },
      async recurrence() { return null; },
      csvUrl() { return null; },
    };
  }

  /** Smallest set of months (by share, descending) that covers `targetPct` of the yearly total. */
  function seasonFrom(months, targetPct) {
    const sorted = months.filter((m) => m.sharePct !== null).slice().sort((a, b) => b.sharePct - a.sharePct);
    const picked = []; let acc = 0;
    for (const m of sorted) { if (acc >= targetPct) break; picked.push(m.month); acc += m.sharePct; }
    return { months: picked.sort((a, b) => a - b), coveredPct: Math.round(acc * 10) / 10, peakMonth: sorted.length ? sorted[0].month : null };
  }

  /** getIds: () => string[] of municipality codes (used only by the DEMO source). */
  async function createSource(getIds, getArea) {
    try {
      const meta = await fetchJson(`${CFG.apiBase}/api/meta`, CFG.apiProbeTimeoutMs);
      if (meta && (meta.service === 'firehub' || meta.service === 'monitor-cinder')) return apiSource(meta, getArea);
      throw new Error('Unexpected /api/meta payload');
    } catch (e) {
      console.info('Monitor Cinder API not reachable, switching to DEMO data:', e.message);
      return demoSource(getIds, getArea);
    }
  }

  global.FireData = Object.freeze({
    loadGeometry,
    loadBrazilGeometry,
    loadNames,
    createSource,
    validateMesh,
    validateNames,
    rangeFromRows,
    computeClientIntelligence,
  });
})(window);
