/*
 * FireHub data layer (original code).
 * - Geometry and names: IBGE (public, CORS-enabled). The backend may proxy/cache the mesh.
 * - Fire statistics: FireHub API (TypeScript backend). If the API is unreachable, a clearly
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
  function apiSource(meta) {
    const base = CFG.apiBase;
    const sources = Array.isArray(meta.sources) ? meta.sources.filter((s) => s && typeof s.name === 'string').slice(0, 12) : [];
    return {
      kind: 'api',
      firstYear: intIn(meta.period && meta.period.firstYear, 2000, 2100) ? meta.period.firstYear : CFG.firstYear,
      lastYear: intIn(meta.period && meta.period.lastYear, 2000, 2100) ? meta.period.lastYear : CFG.lastYear,
      sources,
      validation: meta.validation && typeof meta.validation === 'object' ? {
        mapePct: num(meta.validation.mapePct), pearsonR: num(meta.validation.pearsonR), biasPct: num(meta.validation.biasPct),
      } : null,
      async mapValues(year, month, metric) {
        const q = new URLSearchParams({ year: String(year), month: String(month), metric });
        const j = await fetchJson(`${base}/api/map?${q}`);
        const out = {};
        if (j && j.values && typeof j.values === 'object') {
          for (const id of Object.keys(j.values)) if (IBGE_CODE.test(id)) out[id] = num(j.values[id]);
        }
        return out;
      },
      async calendar(id) {
        if (!IBGE_CODE.test(id)) throw new Error('Invalid IBGE code');
        const j = await fetchJson(`${base}/api/municipalities/${id}/calendar`);
        const rows = Array.isArray(j && j.rows) ? j.rows : [];
        return rows.filter((r) => r && intIn(r.year, 2000, 2100) && intIn(r.month, 1, 12)).map((r) => ({
          year: r.year, month: r.month, modis: num(r.modis), viirs: num(r.viirs),
          harmonized: num(r.harmonized), anomalyZ: num(r.anomalyZ), daysMissing: num(r.daysMissing),
        }));
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

  /* ---------------- DEMO source (synthetic, deterministic) ---------------- */
  function hashCode(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const SEASON = [0.012, 0.01, 0.014, 0.022, 0.045, 0.075, 0.12, 0.205, 0.245, 0.14, 0.07, 0.042];
  const RATIO = [3.1, 3.0, 3.2, 3.4, 3.6, 3.7, 3.8, 3.9, 3.8, 3.6, 3.3, 3.1]; // VIIRS ÷ MODIS by month (synthetic)

  function demoSource(getIds) {
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
      firstYear: first, lastYear: last, sources: [], validation: null,
      async mapValues(year, month, metric) {
        const out = {};
        for (const id of getIds()) {
          const row = series(id).rows.find((x) => x.year === year && x.month === month);
          out[id] = row ? (metric === 'count' ? row.harmonized : row.anomalyZ) : null;
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
          { key: 'nasa_power.ws10m_dry_mean', label: 'Dry-season mean wind speed', value: Math.round((2 + r() * 2) * 10) / 10, unit: 'm/s', source: 'DEMO · NASA POWER' },
        ];
      },
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
  async function createSource(getIds) {
    try {
      const meta = await fetchJson(`${CFG.apiBase}/api/meta`, CFG.apiProbeTimeoutMs);
      if (meta && meta.service === 'firehub') return apiSource(meta);
      throw new Error('Unexpected /api/meta payload');
    } catch (e) {
      console.info('FireHub API not reachable, switching to DEMO data:', e.message);
      return demoSource(getIds);
    }
  }

  global.FireData = Object.freeze({
    loadGeometry,
    loadBrazilGeometry,
    loadNames,
    createSource,
    validateMesh,
    validateNames,
  });
})(window);
