/*
 * Monitor Cinder data layer (original code).
 * - Geometry and names: IBGE (public, CORS-enabled). The backend may proxy/cache the mesh.
 * - Fire statistics: Monitor Cinder API only (NASA FIRMS history). If the API is unreachable or the history
 *   is still loading, the map shows the outlines and says so: no value is ever generated in the browser.
 * Every response is validated before use; nothing from the network is ever inserted as HTML.
 */
(function (global) {
  'use strict';
  const CFG = global.CINDER_CONFIG;
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
      noaa20: num(r.noaa20), provisional: r.provisional === true, partial: r.partial === true,
      partialDays: intIn(r.partialDays, 1, 31) ? r.partialDays : null,
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
  function apiSource(meta, getIds, getArea) {
    const base = CFG.apiBase;
    const sources = Array.isArray(meta.sources) ? meta.sources.filter((s) => s && typeof s.name === 'string').slice(0, 12) : [];
    return {
      kind: 'api',
      dataKind: ['firms_db', 'firms_index', 'loading'].includes(meta.dataKind) ? meta.dataKind : 'none',
      historyLoad: meta.historyLoad && typeof meta.historyLoad === 'object' ? {
        done: intIn(meta.historyLoad.done, 0, 1000) ? meta.historyLoad.done : 0,
        total: intIn(meta.historyLoad.total, 0, 1000) ? meta.historyLoad.total : 0,
      } : null,
      // last day FIRMS served (YYYY-MM-DD) and first near-real-time day: the edge between observed data and projection
      lastObservedDay: meta.chain && /^\d{4}-\d{2}-\d{2}$/.test(meta.chain.lastObservedDay) ? meta.chain.lastObservedDay : null,
      provisionalFrom: meta.chain && /^\d{4}-\d{2}-\d{2}$/.test(meta.chain.provisionalFrom) ? meta.chain.provisionalFrom : null,
      firstYear: intIn(meta.period && meta.period.firstYear, 2000, 2100) ? meta.period.firstYear : CFG.firstYear,
      lastYear: intIn(meta.period && meta.period.lastYear, 2000, 2100) ? meta.period.lastYear : CFG.lastYear,
      sources,
      validation: meta.validation && typeof meta.validation === 'object' ? {
        mapePct: num(meta.validation.mapePct), wapePct: num(meta.validation.wapePct),
        pearsonR: num(meta.validation.pearsonR), biasPct: num(meta.validation.biasPct),
      } : null,
      async mapValues(year, month, metric) {
        const get = async (k) => {
          const j = await fetchJson(`${base}/api/map?${new URLSearchParams({ year: String(year), month: String(month), metric: k })}`, 20000);
          const out = {};
          if (j && j.values && typeof j.values === 'object') {
            for (const id of Object.keys(j.values)) if (IBGE_CODE.test(id)) out[id] = num(j.values[id]);
          }
          return out;
        };
        if (metric !== 'density') return await get(metric);
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
        const j = await fetchJson(`${base}/api/municipalities/${id}/calendar`, 20000);
        return cleanRows(j && j.rows);
      },
      async pattern(id) {
        if (!IBGE_CODE.test(id)) throw new Error('Invalid IBGE code');
        const j = await fetchJson(`${base}/api/municipalities/${id}/pattern`, 20000);
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
        const j = await fetchJson(`${base}/api/municipalities/${id}/context?year=${encodeURIComponent(year)}`, 20000);
        return sanitizeContext(j);
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
      /**
       * Projection with a validated uncertainty band from the last observed day (daily model, hindcast 2015–2025).
       * area: { ibge } or { lon, lat, radiusKm }. Null while the FIRMS history is not built (HTTP 503).
       */
      async horizons(area) {
        const q = new URLSearchParams();
        if (area && area.ibge) {
          if (!(IBGE_CODE.test(area.ibge) || area.ibge === CFG.uf)) throw new Error('Invalid IBGE code');
          q.set('ibge', area.ibge);
        } else {
          if (!area || !numIn(area.lon, -54, -45) || !numIn(area.lat, -20, -12) || !numIn(area.radiusKm, 5, 300)) throw new Error('Invalid circle');
          q.set('lon', String(area.lon)); q.set('lat', String(area.lat)); q.set('radiusKm', String(area.radiusKm));
        }
        let j;
        try { j = await fetchJson(`${base}/api/projection/horizons?${q}`, 60000); } catch (e) { if (/HTTP 503/.test(e.message)) return null; throw e; }
        const DATE = /^\d{4}-\d{2}-\d{2}$/;
        const date = (v) => (typeof v === 'string' && DATE.test(v) ? v : null);
        const bandOf = (o) => (o && numIn(o.p10, 0, 1e8) && numIn(o.p50, 0, 1e8) && numIn(o.p90, 0, 1e8)) ? { p10: o.p10, p50: o.p50, p90: o.p90 } : null;
        const win = (o) => { const b = bandOf(o); return b && date(o.from) && date(o.to) ? { ...b, from: o.from, to: o.to, climatology: bandOf(o.climatology) } : null; };
        const skill = (o) => (o ? { n: num(o.n), skillPct: num(o.skillPct), coveragePct: num(o.coveragePct), rawCoveragePct: num(o.rawCoveragePct), widen: num(o.widen), published: o.published === true } : null);
        const h = j && j.hindcast && j.hindcast.horizons;
        const asOf = date(j && j.asOf);
        if (!asOf) return null;
        return {
          asOf,
          daily: (Array.isArray(j.daily) ? j.daily : []).slice(0, 15).filter((d) => d && date(d.date) && numIn(d.pAnyPct, 0, 100))
            .map((d) => ({ date: d.date, pAnyPct: d.pAnyPct, p50: num(d.p50), p90: num(d.p90) })),
          fortnight: win(j.fortnight),
          semester: win(j.semester),
          months: (Array.isArray(j.months) ? j.months : []).slice(0, 6).filter((m) => m && intIn(m.year, 2000, 2100) && intIn(m.month, 1, 12) && bandOf(m))
            .map((m) => ({ year: m.year, month: m.month, observedSoFar: num(m.observedSoFar), partial: m.partial === true, ...bandOf(m), climatology: bandOf(m.climatology) })),
          hindcast: h ? {
            period: typeof j.hindcast.period === 'string' ? j.hindcast.period.slice(0, 20) : '',
            calibrationPeriod: typeof j.hindcast.calibrationPeriod === 'string' ? j.hindcast.calibrationPeriod.slice(0, 20) : '',
            testPeriod: typeof j.hindcast.testPeriod === 'string' ? j.hindcast.testPeriod.slice(0, 20) : '',
            day1: skill(h.day1), fortnight: skill(h.fortnight), month: skill(h.month), semester: skill(h.semester),
          } : null,
        };
      },
      /** IBGE localities (Censo 2022), map reference only: [{ id, ibge, name, kind, lon, lat }] (null while loading). */
      async localities() {
        let j;
        try { j = await fetchJson(`${base}/api/localities`, 30000); } catch (e) { if (/HTTP 503/.test(e.message)) return null; throw e; }
        const KINDS = ['sede', 'vila', 'povoado', 'lugarejo', 'urbano', 'rural', 'agrovila', 'quilombola', 'indigena', 'outra'];
        return (Array.isArray(j && j.localities) ? j.localities : []).slice(0, 20000)
          .filter((r) => Array.isArray(r) && typeof r[0] === 'string' && IBGE_CODE.test(r[1]) && typeof r[2] === 'string'
            && KINDS.includes(r[3]) && numIn(r[4], -54, -45) && numIn(r[5], -20, -12))
          .map((r) => ({ id: r[0].slice(0, 15), ibge: r[1], name: r[2].slice(0, 150), kind: r[3], lon: r[4], lat: r[5] }));
      },
      /** FIRMS detection days behind one map cell in a month: { days: [{ date, sensor, provisional }], cells1km }. */
      async cellDetections(lon, lat, res, year, month) {
        if (!numIn(lon, -54, -45) || !numIn(lat, -20, -12) || ![1000, 2000, 5000].includes(res) || !intIn(year, 2001, 2100) || !intIn(month, 1, 12)) throw new Error('Invalid cell');
        let j;
        try { j = await fetchJson(`${base}/api/cell/detections?${new URLSearchParams({ lon: String(lon), lat: String(lat), res: String(res), year: String(year), month: String(month) })}`); }
        catch (e) { if (/HTTP 503/.test(e.message)) return null; throw e; }
        const SENSORS = ['MODIS', 'SNPP', 'NOAA20', 'NOAA21'];
        return {
          cells1km: intIn(j && j.cells1km, 0, 100) ? j.cells1km : 0,
          days: (Array.isArray(j && j.days) ? j.days : []).slice(0, 120)
            .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && SENSORS.includes(d.sensor))
            .map((d) => ({ date: d.date, sensor: d.sensor, provisional: d.provisional === true })),
        };
      },
      /** One month day by day: { days: [{ date, harmonized|null, sensor, provisional, cells }] } (null while loading: 503). */
      /** Months with a high anomaly (z ≥ 1.5 and ≥ 10 cell-days), newest first; [] when none. */
      async alerts(id) {
        if (!IBGE_CODE.test(id)) throw new Error('Invalid IBGE code');
        const j = await fetchJson(`${base}/api/municipalities/${id}/alerts`, 20000);
        return (Array.isArray(j && j.alerts) ? j.alerts : []).slice(0, 12)
          .filter((a) => a && intIn(a.year, 2000, 2100) && intIn(a.month, 1, 12))
          .map((a) => ({ year: a.year, month: a.month, harmonized: num(a.harmonizedCount), z: num(a.anomalyZ) }));
      },
      /** Fire cells of the month as a CSV Blob (municipality or circle); null while the history is not loaded (503). */
      async firesCsv(area, year, month) {
        if (!intIn(year, 2001, 2100) || !intIn(month, 1, 12)) throw new Error('Invalid month');
        const q = new URLSearchParams({ year: String(year), month: String(month) });
        if (area && area.ibge) {
          if (!IBGE_CODE.test(area.ibge)) throw new Error('Invalid IBGE code');
          q.set('ibge', area.ibge);
        } else {
          if (!area || !numIn(area.lon, -54, -45) || !numIn(area.lat, -20, -12) || !numIn(area.radiusKm, 5, 300)) throw new Error('Invalid circle');
          q.set('lon', String(area.lon)); q.set('lat', String(area.lat)); q.set('radiusKm', String(area.radiusKm));
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
          const res = await fetch(`${base}/api/area/fires.csv?${q}`, { signal: ctrl.signal, credentials: 'omit', headers: { Accept: 'text/csv' } });
          if (res.status === 503) return null;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return new Blob([await res.text()], { type: 'text/csv;charset=utf-8' });
        } finally {
          clearTimeout(timer);
        }
      },
      async daily(area, year, month) {
        if (!intIn(year, 2001, 2100) || !intIn(month, 1, 12)) throw new Error('Invalid month');
        const q = new URLSearchParams({ year: String(year), month: String(month) });
        if (area && area.ibge) {
          if (!(IBGE_CODE.test(area.ibge) || area.ibge === CFG.uf)) throw new Error('Invalid IBGE code');
          q.set('ibge', area.ibge);
        } else {
          if (!area || !numIn(area.lon, -54, -45) || !numIn(area.lat, -20, -12) || !numIn(area.radiusKm, 5, 300)) throw new Error('Invalid circle');
          q.set('lon', String(area.lon)); q.set('lat', String(area.lat)); q.set('radiusKm', String(area.radiusKm));
        }
        let j;
        try { j = await fetchJson(`${base}/api/daily?${q}`); } catch (e) { if (/HTTP 503/.test(e.message)) return null; throw e; }
        const SENSORS = ['MODIS', 'SNPP', 'NOAA20', 'NOAA21'];
        return (Array.isArray(j && j.days) ? j.days : []).slice(0, 31)
          .filter((d) => d && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
          .map((d) => ({ date: d.date, harmonized: num(d.harmonized), sensor: SENSORS.includes(d.sensor) ? d.sensor : null,
            provisional: d.provisional === true, cells: intIn(d.cells, 0, 1e6) ? d.cells : 0 }));
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

  /** Smallest set of months (by share, descending) that covers `targetPct` of the yearly total. */
  function seasonFrom(months, targetPct) {
    const sorted = months.filter((m) => m.sharePct !== null).slice().sort((a, b) => b.sharePct - a.sharePct);
    const picked = []; let acc = 0;
    for (const m of sorted) { if (acc >= targetPct) break; picked.push(m.month); acc += m.sharePct; }
    return { months: picked.sort((a, b) => a - b), coveredPct: Math.round(acc * 10) / 10, peakMonth: sorted.length ? sorted[0].month : null };
  }

  /** Without the API there is no data source: the map shows the IBGE outlines and says the API is offline. */
  function offlineSource() {
    const fail = async () => { throw new Error('API offline'); };
    return {
      kind: 'offline', dataKind: 'none', historyLoad: null, lastObservedDay: null, provisionalFrom: null,
      firstYear: CFG.firstYear, lastYear: CFG.lastYear, sources: [], validation: null,
      mapValues: fail, calendar: fail, pattern: fail, context: fail,
      projection: fail, horizons: fail, daily: fail, alerts: fail, firesCsv: fail, localities: fail, cellDetections: fail, areaHistory: fail, cells: fail, recurrence: fail,
      csvUrl() { return null; },
    };
  }

  async function createSource(getIds, getArea) {
    try {
      const meta = await fetchJson(`${CFG.apiBase}/api/meta`, CFG.apiProbeTimeoutMs);
      if (meta && meta.service === 'monitor-cinder') return apiSource(meta, getIds, getArea);
      throw new Error('Unexpected /api/meta payload');
    } catch (e) {
      console.info('Monitor Cinder API not reachable:', e.message);
      return offlineSource();
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
  });
})(window);
