/*
 * Monitor Cinder UI controller (original code).
 * Connects the controls, the map engine, the side panel, the 2D circle area selector,
 * the lateral scale indicator, and the data layer.
 * DOM updates use createElement + textContent only — never innerHTML with external strings.
 */
(function (global) {
  'use strict';

  const CFG = global.FIREHUB_CONFIG;
  const I = global.FireI18n;
  const t = I.t;
  const $ = (id) => document.getElementById(id);

  const state = {
    source: null,
    ids: [],
    names: new Map(),
    info: new Map(),
    year: CFG.defaultYear,
    month: CFG.defaultMonth,
    metric: 'anomaly',
    selected: null,
    sphereSelection: null, // { radiusKm, areaKm2, ids, centerId }
    sphereRows: null,
    roots: { on: false, data: null, loading: false },
    detail: null, // { res, yearsObserved } of the cell layer on screen
    values: {},
    rows: new Map(),
    patterns: new Map(),
    lastView: null,
    reqSeq: 0,
    panelSeq: 0,
  };

  let map = null;

  /* ---------- small DOM & formatting helpers ---------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function svg(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    return e;
  }

  const fmtInt = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : I.num(Math.round(v)));
  const fmtZ = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : (v >= 0 ? '+' : '') + I.num(v, 2) + 'σ');
  const monthName = (m) => I.months()[m - 1] || '';
  const fmt1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : I.num(Math.round(v * 10) / 10));
  /** Value text for the active map metric (pills, tooltip). */
  const valueText = (v) => (
    state.metric === 'anomaly'
      ? fmtZ(v)
      : state.metric === 'density'
        ? fmt1(v)
        : state.metric === 'propensity'
          ? (v === null || v === undefined || !Number.isFinite(v) ? '–' : I.num(v, 1) + '%')
          : state.metric === 'agro_score'
            ? (v === null || v === undefined || !Number.isFinite(v) ? '–' : I.num(v, 1) + '/100')
            : fmtInt(v)
  );
  const period = () => `${monthName(state.month)}/${state.year}`;
  function zText(z) {
    if (z === null || z === undefined || !Number.isFinite(z)) return t('z.none');
    if (z >= 2) return t('z.farAbove');
    if (z >= 1) return t('z.above');
    if (z <= -1) return t('z.below');
    return t('z.normal');
  }

  /* ---------- URL hash ---------- */
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const y = Number(p.get('y')), m = Number(p.get('m')), k = p.get('k'), mun = p.get('mun');
    if (Number.isInteger(y) && y >= state.source.firstYear && y <= state.source.lastYear) state.year = y;
    if (Number.isInteger(m) && m >= 1 && m <= 12) state.month = m;
    if (k === 'anomaly' || k === 'count' || k === 'density' || k === 'propensity' || k === 'agro_score') state.metric = k;
    if (mun && /^\d{7}$/.test(mun) && state.ids.includes(mun)) state.selected = mun;
  }
  function writeHash() {
    const p = new URLSearchParams();
    p.set('y', String(state.year));
    p.set('m', String(state.month));
    p.set('k', state.metric);
    if (state.selected) p.set('mun', state.selected);
    history.replaceState(null, '', '#' + p.toString());
  }

  /* ---------- status & badge ---------- */
  function setStatus(key, params, isErr, retry) {
    const box = $('status'), retryBtn = $('status-retry');
    if (!key) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('status--error', !!isErr);
    $('status-text').textContent = t(key, params);
    retryBtn.hidden = !retry;
    retryBtn.onclick = retry || null;
  }
  function setBadge() {
    const b = $('source-badge');
    if (!state.source) { b.textContent = t('badge.loading'); b.className = 'badge'; return; }
    const demo = state.source.kind === 'demo';
    const synthetic = !demo && state.source.dataKind !== 'firms_db';
    b.className = 'badge ' + (demo || synthetic ? 'badge--demo' : 'badge--live');
    b.textContent = t(demo ? 'badge.demo' : synthetic ? 'badge.synthetic' : 'badge.firms');
  }

  /* ---------- Lateral Scale & Proportion HUD ---------- */
  function updateLateralScale(v) {
    if (!v) return;
    state.lastView = v;
    const zoomEl = $('scale-zoom');
    const ratioEl = $('scale-ratio');
    const fillEl = $('scale-bar-fill');
    const topEl = $('scale-top-km');
    const midEl = $('scale-mid-km');
    const botEl = $('scale-bot-km');
    const spanEl = $('scale-span');
    if (!zoomEl || !fillEl) return;

    zoomEl.textContent = `${I.num(Math.max(0.1, v.zoomRatio), 1)}×`;

    const d = v.scaleDenom;
    const ratioStr = d >= 1e6
      ? `1 : ${I.num(d / 1e6, 1)}M`
      : d >= 1e3
        ? `1 : ${I.num(Math.round(d / 1e3))}k`
        : `1 : ${I.num(d)}`;
    ratioEl.textContent = ratioStr;

    const trackPx = 108;
    const maxKmInTrack = trackPx * v.kmPerPx;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
    let niceKm = steps[0];
    for (const s of steps) {
      if (s <= maxKmInTrack) niceKm = s;
    }
    const barPx = Math.max(18, Math.min(trackPx, Math.round(niceKm * v.pxPerKm)));
    fillEl.style.height = `${barPx}px`;

    topEl.textContent = '0';
    midEl.textContent = `${I.num(niceKm / 2, niceKm < 5 ? 1 : 0)} km`;
    botEl.textContent = `${I.num(niceKm)} km`;
    spanEl.textContent = t('scale.span', { km: I.num(Math.round(v.spanKm)) });
  }

  /* ---------- controls ---------- */
  function fillControls() {
    const ySel = $('year');
    clear(ySel);
    for (let y = state.source.lastYear; y >= state.source.firstYear; y--) ySel.append(new Option(String(y), String(y)));
    ySel.value = String(state.year);
    renderMonthOptions();
    $('metric').value = state.metric;
    ySel.onchange = () => { state.year = Number(ySel.value); onPeriodChange(); };
    $('month').onchange = () => { state.month = Number($('month').value); onPeriodChange(); };
    $('metric').onchange = () => { state.metric = $('metric').value; refreshMap(); };
  }
  function renderMonthOptions() {
    const mSel = $('month');
    clear(mSel);
    I.months().forEach((label, i) => mSel.append(new Option(label, String(i + 1))));
    mSel.value = String(state.month);
  }
  function onPeriodChange() {
    $('year').value = String(state.year);
    $('month').value = String(state.month);
    refreshMap();
    if (state.sphereSelection) {
      renderSpherePanel(state.sphereSelection);
    } else if (state.selected && state.rows.has(state.selected)) {
      updateKpis();
      markCalendar();
      renderNeighborsList(state.selected);
      const seq = ++state.panelSeq;
      loadRange(state.selected, seq);
      loadIntelligence(state.selected, seq);
      loadContext(state.selected, seq);
      const cur = currentRow();
      loadDetail({ kind: 'muni', id: state.selected }, cur ? cur.harmonized : 0, seq);
    }
  }

  /* ---------- map & legend ---------- */
  const Z_SCALE = { type: 'diverging', min: -3, max: 3 };
  const PROPENSITY_SCALE = { type: 'sequential', min: 0, max: 100 };
  function scaleFor(values) {
    if (state.metric === 'anomaly') return Object.assign({}, Z_SCALE);
    if (state.metric === 'propensity' || state.metric === 'agro_score') return PROPENSITY_SCALE;
    let max = 10;
    for (const k of Object.keys(values)) { const v = values[k]; if (typeof v === 'number' && v > max) max = v; }
    return { type: 'sequential', min: 0, max };
  }

  async function refreshMap() {
    writeHash();
    const seq = ++state.reqSeq;
    try {
      const isAnomaly = state.metric === 'anomaly';
      const [values, counts] = await Promise.all([
        state.source.mapValues(state.year, state.month, state.metric),
        // Anomaly is undefined where a month never had fire; those municipalities are painted white (no fire), not "no data".
        isAnomaly ? state.source.mapValues(state.year, state.month, 'count') : null,
      ]);
      if (seq !== state.reqSeq) return;
      state.values = values;
      const scale = scaleFor(values);
      if (isAnomaly && counts) {
        scale.noFireIds = Object.keys(values).filter((id) => values[id] === null && counts[id] === 0);
      }
      map.setValues(values, scale);
      drawLegend(scale);
      if (state.selected) renderNeighborsList(state.selected);
      setStatus(null);
    } catch (e) {
      if (seq !== state.reqSeq) return;
      console.error(e);
      setStatus('status.valuesErr', null, true, refreshMap);
    }
  }

  function drawLegend(scale) {
    $('legend-title').textContent = t(`legend.${state.metric}`, { period: period() });
    const c = $('legend-canvas');
    const ctx = c.getContext('2d');
    for (let x = 0; x < c.width; x++) {
      const u = x / (c.width - 1);
      const val = scale.type === 'sequential' ? Math.expm1(u * Math.log1p(scale.max)) : scale.min + u * (scale.max - scale.min);
      ctx.fillStyle = map.colorFor(val, scale);
      ctx.fillRect(x, 0, 1, c.height);
    }
    const ticks = $('legend-ticks');
    clear(ticks);
    const labels =
      scale.type === 'diverging'
        ? ['−3σ', '−1σ', t('legend.normal'), '+1σ', '+3σ']
        : state.metric === 'propensity'
          ? ['0%', '50%', '100%']
          : state.metric === 'agro_score'
            ? ['0 (AAA)', '50 (BBB)', '100 (CCC)']
            : ['0', fmtInt(Math.sqrt(scale.max)), fmtInt(scale.max)];
    for (const s of labels) ticks.append(el('span', '', s));
  }

  function onHover(h) {
    const tip = $('tooltip');
    if (!h) { tip.hidden = true; return; }
    const v = state.values[h.id];
    const muniName = state.names.get(h.id) || h.id;
    $('tt-name').textContent = muniName;
    $('tt-value').textContent = state.metric === 'anomaly'
      ? `${fmtZ(v)} · ${zText(v)}`
      : state.metric === 'density'
        ? t('tt.density', { v: fmt1(v), period: period() })
        : state.metric === 'propensity'
          ? t('tt.propensity', { n: v === null || v === undefined ? '–' : I.num(v, 1), period: period() })
          : state.metric === 'agro_score'
            ? t('tt.agro_score', { n: v === null || v === undefined ? '–' : I.num(v, 1), period: period() })
            : t('tt.count', { n: fmtInt(v), period: period() });
    tip.hidden = false;
    const x = Math.min(h.x + 14, $('map').clientWidth - 250);
    const y = Math.max(8, h.y - 38);
    tip.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
  }

  /* ---------- search combobox ---------- */
  const normalize = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function setupSearch() {
    const input = $('search'), list = $('search-list');
    const index = state.ids.map((id) => {
      const name = state.names.get(id) || id;
      const micro = (state.info.get(id) || {}).microregion || '';
      return { id, name, micro, key: normalize(name) };
    }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    let matches = [], active = -1;

    function render() {
      clear(list);
      if (!matches.length) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      matches.forEach((it, i) => {
        const li = el('li');
        li.id = 's-opt-' + it.id;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', i === active ? 'true' : 'false');
        li.append(el('span', '', it.name), el('small', '', it.micro));
        li.onmousedown = (e) => { e.preventDefault(); choose(it.id); };
        list.append(li);
      });
    }
    function update() {
      const q = normalize(input.value.trim());
      if (!q) { matches = []; active = -1; render(); return; }
      const starts = index.filter((x) => x.key.startsWith(q));
      const contains = index.filter((x) => !x.key.startsWith(q) && x.key.includes(q));
      matches = starts.concat(contains).slice(0, 8);
      active = matches.length ? 0 : -1;
      render();
    }
    function choose(id) {
      input.value = ''; matches = []; active = -1; render(); input.blur();
      setModeUI('municipality');
      selectMunicipality(id, true);
    }
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && matches.length) { active = (active + 1) % matches.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && matches.length) { active = (active - 1 + matches.length) % matches.length; render(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { choose(matches[active].id); e.preventDefault(); }
      else if (e.key === 'Escape') { input.value = ''; update(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { matches = []; active = -1; render(); }, 120));
    document.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') { e.preventDefault(); input.focus(); }
    });
  }

  /* ---------- Mode Switcher (Município vs Esfera) ---------- */
  function setModeUI(mode) {
    const isSphere = mode === 'sphere';
    $('mode-muni').classList.toggle('is-active', !isSphere);
    $('mode-sphere').classList.toggle('is-active', isSphere);
    $('sphere-controls').hidden = !isSphere;
    map.setSelectionMode(isSphere ? 'sphere' : 'municipality');
    clearDetail();
    if (!isSphere && state.sphereSelection) {
      state.sphereSelection = null;
      state.sphereRows = null;
      if (!state.selected) {
        $('panel-body').hidden = true;
        $('panel-empty').hidden = false;
      }
    }
  }

  /* ---------- Panel: Single Municipality & Sphere Aggregation ---------- */
  function selectMunicipality(id, fly) {
    state.sphereSelection = null;
    state.sphereRows = null;
    state.selected = id && state.ids.includes(id) ? id : null;
    if (fly || map.selected() !== state.selected) {
      map.select(state.selected, { fly: !!fly, emit: false });
    }
    writeHash();
    clearDetail();
    if (!state.selected) { $('panel-body').hidden = true; $('panel-empty').hidden = false; return; }
    openPanel(state.selected);
  }

  function renderHeader(id) {
    $('p-name').textContent = state.names.get(id) || id;
    const inf = state.info.get(id) || {};
    $('p-sub').textContent = [t('panel.sub', { id }), inf.microregion && t('panel.micro', { name: inf.microregion })].filter(Boolean).join(' · ');
  }

  function renderNeighborsList(id) {
    const block = $('subareas-block');
    const list = $('subareas-list');
    if (!block || !list) return;
    clear(list);
    const neighbors = map.neighborsOf(id, 8);
    if (!neighbors.length) { block.hidden = true; return; }
    block.hidden = false;
    $('subareas-title').textContent = t('block.subareas');
    $('subareas-small').textContent = t('block.subareasSmall');

    for (const n of neighbors) {
      const btn = el('button', 'subarea-pill');
      btn.type = 'button';
      const distBadge = el('strong', 'subarea-pill__num', `${n.distKm} km`);
      const nameSpan = el('span', 'subarea-pill__name', state.names.get(n.id) || n.id);
      const v = state.values[n.id];
      const valText = valueText(v);
      const valSpan = el('em', 'subarea-pill__val', valText);
      btn.append(distBadge, nameSpan, valSpan);
      btn.onclick = () => selectMunicipality(n.id, true);
      list.append(btn);
    }
  }

  async function openPanel(id) {
    const seq = ++state.panelSeq;
    $('panel-empty').hidden = true;
    $('panel-body').hidden = false;
    renderHeader(id);
    renderNeighborsList(id);
    if (!state.rows.has(id)) ['k-count', 'k-z'].forEach((k) => { $(k).textContent = '…'; });
    try {
      const [rows, pattern] = await Promise.all([
        state.rows.has(id) ? state.rows.get(id) : state.source.calendar(id),
        state.patterns.has(id) ? state.patterns.get(id) : state.source.pattern(id),
      ]);
      if (seq !== state.panelSeq) return;
      state.rows.set(id, rows);
      state.patterns.set(id, pattern);
      renderPanelBody(id);
      loadRange(id, seq);
      loadIntelligence(id, seq);
      loadContext(id, seq);
      const cur = currentRow();
      loadDetail({ kind: 'muni', id }, cur ? cur.harmonized : 0, seq);
    } catch (e) {
      if (seq !== state.panelSeq) return;
      console.error(e);
      $('season-text').textContent = t('panel.loadErr');
    }
  }

  function renderPanelBody(id) {
    updateKpis();
    renderNeighborsList(id);
    renderPattern(state.patterns.get(id));
    renderCalendar(state.rows.get(id));
    renderCompare(state.rows.get(id));
  }

  async function onSphereSelect(sphere) {
    if (!sphere || !sphere.ids || !sphere.ids.length) {
      state.sphereSelection = null;
      state.sphereRows = null;
      clearDetail();
      $('panel-body').hidden = true;
      $('panel-empty').hidden = false;
      return;
    }
    state.selected = null;
    state.sphereSelection = sphere;
    $('sphere-radius').value = String(sphere.radiusKm);
    $('sphere-radius-val').textContent = `${sphere.radiusKm} km`;
    await renderSpherePanel(sphere);
  }

  /** Typical-season pattern from a monthly series (baseline years 2002–2024). */
  function patternFromRows(rows) {
    const sums = new Array(12).fill(0), counts = new Array(12).fill(0);
    for (const r of rows) {
      if (r.year >= 2002 && r.year <= 2024 && Number.isFinite(r.harmonized)) { sums[r.month - 1] += r.harmonized; counts[r.month - 1]++; }
    }
    const total = sums.reduce((a, b) => a + b, 0) || 1;
    const months = sums.map((sum, i) => ({
      month: i + 1,
      mean: counts[i] ? Math.round((sum / counts[i]) * 10) / 10 : 0,
      sharePct: Math.round((sum / total) * 1000) / 10,
    }));
    const sorted = months.slice().sort((a, b) => b.sharePct - a.sharePct);
    const picked = []; let acc = 0;
    for (const m of sorted) { if (acc >= 80) break; picked.push(m.month); acc += m.sharePct; }
    return { months, season: { months: picked.sort((a, b) => a - b), coveredPct: Math.round(acc * 10) / 10, peakMonth: sorted[0].month } };
  }

  /** Fallback: sum whole municipalities touched by the circle; z against the summed 2002–2024 baseline. */
  async function sumMunicipalities(ids, shares) {
    const calendars = await Promise.all(ids.map(async (id) => {
      if (state.rows.has(id)) return state.rows.get(id);
      const r = await state.source.calendar(id);
      state.rows.set(id, r);
      return r;
    }));
    const byYm = new Map();
    for (let ci = 0; ci < calendars.length; ci++) {
      const cal = calendars[ci];
      const w = shares && Number.isFinite(shares[ids[ci]]) ? shares[ids[ci]] : 1;
      for (const r of cal) {
        const key = r.year * 100 + r.month;
        let a = byYm.get(key);
        if (!a) { a = { year: r.year, month: r.month, modis: 0, viirs: 0, viirsN: 0, harmonized: 0, daysMissing: 0 }; byYm.set(key, a); }
        if (r.modis !== null) a.modis += r.modis * w;
        if (r.viirs !== null) { a.viirs += r.viirs * w; a.viirsN++; }
        if (r.harmonized !== null) a.harmonized += r.harmonized * w;
        if (r.daysMissing) a.daysMissing = Math.max(a.daysMissing, r.daysMissing);
      }
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    for (const a of byYm.values()) { a.modis = r1(a.modis); a.viirs = r1(a.viirs); a.harmonized = r1(a.harmonized); }
    const rows = [...byYm.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month));
    for (let m = 1; m <= 12; m++) {
      const vals = rows.filter((r) => r.month === m && r.year >= 2002 && r.year <= 2024).map((r) => r.harmonized);
      const n = vals.length, mean = n ? vals.reduce((x, y) => x + y, 0) / n : 0;
      const sd = n >= 2 ? Math.sqrt(vals.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
      for (const r of rows) if (r.month === m) r.anomalyZ = sd > 0 ? Math.round(((r.harmonized - mean) / sd) * 100) / 100 : null;
    }
    return rows.map((r) => ({ year: r.year, month: r.month, modis: r.modis, viirs: r.viirsN ? r.viirs : null,
      harmonized: r.harmonized, anomalyZ: r.anomalyZ, daysMissing: r.daysMissing }));
  }

  function spherePill(id, extraText) {
    const btn = el('button', 'subarea-pill');
    btn.type = 'button';
    btn.append(el('span', 'subarea-pill__name', state.names.get(id) || id));
    if (extraText) btn.append(el('strong', 'subarea-pill__num', extraText));
    btn.append(el('em', 'subarea-pill__val', valueText(state.values[id])));
    btn.onclick = () => { setModeUI('municipality'); selectMunicipality(id, true); };
    return btn;
  }

  async function renderSpherePanel(sphere) {
    const seq = ++state.panelSeq;
    $('panel-empty').hidden = true;
    $('panel-body').hidden = false;
    const centerName = (sphere.centerId && state.names.get(sphere.centerId)) || CFG.ufName;
    const subBase = t('sphere.sub', { r: sphere.radiusKm, area: I.num(sphere.areaKm2), name: centerName });
    $('p-name').textContent = t('sphere.title', { n: sphere.ids.length });
    $('p-sub').textContent = subBase;
    ['k-count', 'k-z'].forEach((k) => { $(k).textContent = '…'; });

    const block = $('subareas-block'), list = $('subareas-list');
    block.hidden = false;
    $('subareas-title').textContent = t('block.sphereMunis');
    $('subareas-small').textContent = t('block.sphereMunisSmall');

    try {
      // 1. Exact circle from the API: only 1 km cells whose centre lies inside the radius.
      let exact = null;
      if (state.source.areaHistory && Number.isFinite(sphere.lon) && Number.isFinite(sphere.lat)) {
        try { exact = await state.source.areaHistory(sphere.lon, sphere.lat, sphere.radiusKm); } catch (e) { console.warn('area history:', e.message); }
        if (seq !== state.panelSeq) return;
      }
      let rows;
      clear(list);
      if (exact && exact.rows.length) {
        rows = exact.rows;
        const munis = exact.municipalities.filter((m) => state.names.has(m.ibge));
        $('p-name').textContent = t('sphere.title', { n: munis.length });
        $('p-sub').textContent = `${subBase} · ${t('sphere.exact', { pct: fmt1(exact.pctInState) })}`;
        for (const m of munis) list.append(spherePill(m.ibge, t('sphere.pctMuni', { pct: fmt1(m.pctOfMunicipality) })));
      } else {
        // 2. DEMO or history not built: each municipality weighted by the share of its area inside the circle.
        const shares = sphere.shares || {};
        const ids = sphere.ids.filter((id) => (shares[id] ?? 1) > 0.001)
          .sort((a, b) => (shares[b] ?? 0) - (shares[a] ?? 0));
        rows = await sumMunicipalities(ids, shares);
        if (seq !== state.panelSeq) return;
        $('p-name').textContent = t('sphere.title', { n: ids.length });
        $('p-sub').textContent = `${subBase} · ${t('sphere.est')}`;
        for (const id of ids) list.append(spherePill(id, Number.isFinite(shares[id]) ? t('sphere.pctMuni', { pct: fmt1(shares[id] * 100) }) : null));
      }
      state.sphereRows = rows;

      const cur = rows.find((r) => r.year === state.year && r.month === state.month) || null;
      $('k-period').textContent = period();
      $('k-count').textContent = fmtInt(cur ? cur.harmonized : null);
      const z = cur ? cur.anomalyZ : null;
      const kz = $('k-z');
      kz.textContent = fmtZ(z);
      kz.className = z === null ? '' : z >= 1 ? 'z-up' : z <= -1 ? 'z-down' : '';
      $('k-z-text').textContent = zText(z);

      renderPattern(patternFromRows(rows));
      renderCalendar(rows);
      renderCompare(rows);
      // A free-drawn circle has no hindcast of its own: the range comes from its own history and says so.
      renderRangeBox({
        method: 'all', range: global.FireData.rangeFromRows(rows, state.year, state.month), analog: null,
        observed: cur ? cur.harmonized : null, hindcast: null,
      }, true);
      const sphereIntel = global.FireData.computeClientIntelligence(
        rows,
        state.year,
        state.month,
        `sphere:${sphere.centerId || 'go'}:${sphere.radiusKm}`
      );
      renderResourcesBox(sphereIntel.resources);
      renderRootFiresBox(sphereIntel.rootFires);
      renderPredictabilityBox(sphereIntel.predictability);
      renderAgroB2BBox(sphereIntel.agroB2B);
      if (sphere.centerId) loadContext(sphere.centerId, seq);
      if (Number.isFinite(sphere.lon) && sphere.radiusKm >= 5) {
        loadDetail({ kind: 'circle', lon: sphere.lon, lat: sphere.lat, radiusKm: sphere.radiusKm }, cur ? cur.harmonized : 0, seq);
      } else {
        clearDetail();
      }
    } catch (e) {
      if (seq !== state.panelSeq) return;
      console.error(e);
      $('season-text').textContent = t('panel.loadErr');
    }
  }

  function currentRow() {
    const rows = state.rows.get(state.selected) || [];
    return rows.find((r) => r.year === state.year && r.month === state.month) || null;
  }
  function updateKpis() {
    const r = currentRow();
    $('k-period').textContent = period();
    $('k-count').textContent = fmtInt(r ? r.harmonized : null);
    const z = r ? r.anomalyZ : null;
    const kz = $('k-z');
    kz.textContent = fmtZ(z);
    kz.className = z === null ? '' : z >= 1 ? 'z-up' : z <= -1 ? 'z-down' : '';
    $('k-z-text').textContent = zText(z) + (r && r.daysMissing ? ` · ${t('z.missing', { n: r.daysMissing })}` : '');
  }

  function renderPattern(p) {
    const box = $('pattern');
    clear(box);
    if (!p) return;
    const max = Math.max(1, ...p.months.map((m) => m.sharePct || 0));
    const season = new Set(p.season.months);
    for (let m = 1; m <= 12; m++) {
      const d = p.months.find((x) => x.month === m) || { sharePct: null, mean: null };
      const col = el('div', 'bar-col');
      if (season.has(m)) col.classList.add('is-season');
      if (p.season.peakMonth === m) col.classList.add('is-peak');
      const bar = el('i');
      bar.style.height = `${Math.round(((d.sharePct || 0) / max) * 90)}%`;
      col.title = t('bar.title', { m: monthName(m), pct: d.sharePct === null ? '–' : I.num(d.sharePct, 1), mean: fmtInt(d.mean) });
      col.append(bar, el('span', '', monthName(m)[0]));
      box.append(col);
    }
    const s = p.season;
    $('season-text').textContent = s.months.length && s.coveredPct !== null
      ? t('season.text', { months: s.months.map(monthName).join(', '), pct: I.num(s.coveredPct, 1), peak: s.peakMonth ? monthName(s.peakMonth) : '–' })
      : t('season.none');
  }

  function renderCalendar(rows) {
    const box = $('calendar');
    clear(box);
    if (!rows) return;
    box.append(el('span', 'cal-h', ''));
    I.months().forEach((m) => box.append(el('span', 'cal-h', m[0])));
    const byKey = new Map(rows.map((r) => [`${r.year}-${r.month}`, r]));
    const frag = document.createDocumentFragment();
    for (let y = state.source.lastYear; y >= state.source.firstYear; y--) {
      frag.append(el('span', 'cal-y', String(y)));
      for (let m = 1; m <= 12; m++) {
        const r = byKey.get(`${y}-${m}`);
        const b = el('button', 'cal-cell');
        b.type = 'button';
        b.dataset.y = String(y); b.dataset.m = String(m);
        if (r && r.anomalyZ !== null) b.style.background = map.colorFor(r.anomalyZ, Z_SCALE);
        else if (r && r.harmonized === 0) b.style.background = map.colorFor(Z_SCALE.min, Z_SCALE); // no fire: start of the scale
        if (r && r.daysMissing) b.classList.add('is-missing');
        const label = r ? t('cal.cell', { m: monthName(m), y, n: fmtInt(r.harmonized), z: fmtZ(r.anomalyZ) }) : t('cal.empty', { m: monthName(m), y });
        b.title = label; b.setAttribute('aria-label', label);
        frag.append(b);
      }
    }
    box.append(frag);
    markCalendar();
  }
  function markCalendar() {
    const box = $('calendar');
    for (const c of box.querySelectorAll('.cal-cell.is-current')) c.classList.remove('is-current');
    const cur = box.querySelector(`.cal-cell[data-y="${state.year}"][data-m="${state.month}"]`);
    if (cur) cur.classList.add('is-current');
  }

  function renderCompare(rows) {
    const box = $('compare');
    clear(box);
    if (!rows) return;
    const years = [];
    for (let y = state.source.firstYear; y <= state.source.lastYear; y++) years.push(y);
    const sum = (y, k) => {
      const rs = rows.filter((r) => r.year === y && r[k] !== null);
      return rs.length ? rs.reduce((a, r) => a + r[k], 0) : null;
    };
    const css = getComputedStyle(document.documentElement);
    const series = [
      { k: 'modis', color: css.getPropertyValue('--muted').trim() || '#9e9e9e', label: t('cmp.modis') },
      { k: 'viirs', color: css.getPropertyValue('--accent-2').trim() || '#f26d6d', label: t('cmp.viirs') },
      { k: 'harmonized', color: css.getPropertyValue('--accent').trim() || '#c62828', label: t('cmp.harm') },
    ].map((s) => ({ ...s, pts: years.map((y) => [y, sum(y, s.k)]) }));
    const max = Math.max(1, ...series.flatMap((s) => s.pts.map((p) => p[1] || 0)));
    const W = 360, H = 150, L = 38, R = 8, T = 8, B = 20;
    const x = (y) => L + ((y - years[0]) / Math.max(1, years.length - 1)) * (W - L - R);
    const yv = (v) => T + (1 - v / max) * (H - T - B);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('cmp.aria') });
    root.append(svg('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'axis' }));
    root.append(svg('line', { x1: L, y1: T, x2: L, y2: H - B, class: 'axis' }));
    [0, 0.5, 1].forEach((f) => { const e = svg('text', { x: L - 4, y: yv(max * f) + 3, 'text-anchor': 'end' }); e.textContent = fmtInt(max * f); root.append(e); });
    [years[0], 2012, years[years.length - 1]].forEach((y) => { const e = svg('text', { x: x(y), y: H - 6, 'text-anchor': 'middle' }); e.textContent = String(y); root.append(e); });
    root.append(svg('line', { x1: x(2012), y1: T, x2: x(2012), y2: H - B, stroke: 'currentColor', 'stroke-dasharray': '2 3', opacity: 0.35 }));
    for (const s of series) {
      let d = '', pen = false;
      for (const [y, v] of s.pts) {
        if (v === null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(y).toFixed(1)},${yv(v).toFixed(1)}`; pen = true;
      }
      if (d) root.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.k === 'harmonized' ? 2.4 : 1.6, 'stroke-linejoin': 'round' }));
    }
    const legend = el('div', 'legend-row');
    for (const s of series) {
      const item = el('span');
      const sw = el('i'); sw.style.background = s.color;
      item.append(sw, document.createTextNode(s.label));
      legend.append(item);
    }
    box.append(root, legend);
  }

  /* ---------- Detail inside the selected area: grid cells (municipality or circle) ---------- */
  const DETAIL_CLASSES = [
    { key: 'detail.k0', color: '#f5f5f5', test: (v) => v <= 0 },
    { key: 'detail.k1', color: '#f26d6d', test: (v) => v > 0 && v <= 1.5 },
    { key: 'detail.k2', color: '#c62828', test: (v) => v > 1.5 && v <= 4 },
    { key: 'detail.k3', color: '#6d0a0a', test: (v) => v > 4 },
  ];
  function clearDetail() {
    state.detail = null;
    if (map) map.setPointLayer(null, 'detail');
    const b = $('detail-block');
    if (b) b.hidden = true;
  }
  /**
   * area: { kind: 'muni', id } | { kind: 'circle', lon, lat, radiusKm }
   * total: the area's harmonized value for the month (only used by DEMO to spread synthetic cells).
   */
  async function loadDetail(area, total, seq) {
    const block = $('detail-block'), box = $('detail-box');
    block.hidden = false;
    $('detail-small').textContent = period();
    clear(box);
    box.append(el('p', 'muted', t('detail.loading')));
    const res = area.kind === 'muni' ? 1000 : area.radiusKm <= 40 ? 1000 : area.radiusKm <= 120 ? 2000 : 5000;
    let spec = null;
    if (state.source.kind === 'demo') {
      if (area.kind === 'muni') {
        spec = { seed: area.id, bbox: map.bboxLonLat(area.id), inside: (lon, lat) => map.contains(area.id, lon, lat), total };
      } else {
        const dLat = area.radiusKm / 111, dLon = dLat / Math.cos((area.lat * Math.PI) / 180);
        spec = {
          seed: `c${area.lon.toFixed(2)}:${area.lat.toFixed(2)}:${area.radiusKm}`,
          bbox: [area.lon - dLon, area.lat - dLat, area.lon + dLon, area.lat + dLat],
          inside: (lon, lat) => Math.hypot((lon - area.lon) / dLon, (lat - area.lat) / dLat) <= 1,
          total,
        };
      }
    }
    let d = null;
    try { d = await state.source.cells(area, state.year, state.month, res, spec); } catch (e) { console.warn('cells:', e.message); }
    if (seq !== state.panelSeq) return;
    clear(box);
    if (!d) { map.setPointLayer(null, 'detail'); box.append(el('p', 'muted', t('detail.unavailable'))); return; }
    state.detail = { res: d.res, yearsObserved: d.yearsObserved };
    const classes = DETAIL_CLASSES.map((c) => ({ color: c.color, cells: [] }));
    let withFire = 0;
    for (const c of d.cells) {
      const i = DETAIL_CLASSES.findIndex((k) => k.test(c[2]));
      if (i >= 0) classes[i].cells.push(c);
      if (c[2] > 0) withFire++;
    }
    map.setPointLayer({
      cellKm: d.res / 1000, classes, hover: true, grid: true, alpha: 0.92,
      clip: area.kind === 'muni' ? { kind: 'feature', id: area.id } : { kind: 'sphere' },
    }, 'detail');

    if (d.demo) box.append(el('p', 'detail-demo', t('detail.demo')));
    if (!d.cells.length) { box.append(el('p', 'muted', t('detail.none'))); return; }
    box.append(el('p', 'range-line', t('detail.summary', {
      n: I.num(withFire), res: I.num(d.res / 1000), period: period(), m: I.num(d.cells.length),
      from: state.source.firstYear, to: state.source.lastYear,
    })));
    if (Number.isFinite(d.total)) box.append(el('p', 'range-line', t('detail.sum', { v: fmt1(d.total) })));
    const keys = el('div', 'roots-legend__keys');
    keys.append(el('span', 'muted', t('detail.legend')));
    for (const c of DETAIL_CLASSES) {
      const k = el('span', 'roots-key');
      const sw = el('i', 'roots-key__sw');
      sw.style.background = c.color;
      k.append(sw, el('span', '', t(c.key)));
      keys.append(k);
    }
    box.append(keys);
    box.append(el('small', 'range-meta muted', t('detail.hint')));
  }
  function onCellHover(h) {
    if (!h || !state.detail) return;
    const tip = $('tooltip');
    const c = h.cell;
    $('tt-name').textContent = t('tt.cell', { res: I.num(state.detail.res / 1000), v: fmt1(c[2]), period: period() });
    $('tt-value').textContent = t('tt.cellYears', { y: c[3], n: state.detail.yearsObserved ?? '–', ly: c[4] ?? '–' });
    tip.hidden = false;
    const x = Math.min(h.x + 14, $('map').clientWidth - 280);
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, h.y - 38)}px)`;
  }

  /* ---------- Expected range from history (P10–P90 of the same month in earlier years) ---------- */
  async function loadRange(id, seq) {
    clear($('range-box'));
    $('range-small').textContent = period();
    try {
      const p = state.source.projection ? await state.source.projection(id, state.year, state.month) : null;
      if (seq !== state.panelSeq) return;
      if (p && p.range) { renderRangeBox(p, state.source.kind === 'demo'); return; }
    } catch (e) {
      if (seq !== state.panelSeq) return;
      console.warn('projection:', e.message);
    }
    // API without history (503) or failure: same rule, computed from the series already on screen.
    const rows = state.rows.get(id) || [];
    const cur = rows.find((r) => r.year === state.year && r.month === state.month);
    renderRangeBox({ method: 'all', range: global.FireData.rangeFromRows(rows, state.year, state.month), analog: null,
      observed: cur ? cur.harmonized : null, hindcast: null }, true);
  }

  function renderRangeBox(p, local) {
    const box = $('range-box');
    clear(box);
    $('range-small').textContent = period();
    if (!p || !p.range) { box.append(el('p', 'muted', t('range.none'))); return; }
    const { p10, p50, p90 } = p.range;
    const obs = Number.isFinite(p.observed) ? p.observed : null;

    // Bar from 0 to max(P90, observed): P10–P90 band, median tick, observed marker.
    const top = Math.max(p90, obs || 0, 1) * 1.12;
    const pct = (v) => `${Math.max(0, Math.min(100, (v / top) * 100)).toFixed(2)}%`;
    const bar = el('div', 'range-bar');
    bar.setAttribute('aria-hidden', 'true');
    const band = el('span', 'range-bar__band');
    band.style.left = pct(p10);
    band.style.width = `calc(${pct(p90)} - ${pct(p10)})`;
    const med = el('span', 'range-bar__median');
    med.style.left = pct(p50);
    bar.append(band, med);
    if (obs !== null) {
      const o = el('span', 'range-bar__obs');
      o.style.left = pct(obs);
      bar.append(o);
    }
    box.append(bar);

    box.append(el('p', 'range-line', t('range.p', { p10: fmt1(p10), p50: fmt1(p50), p90: fmt1(p90) })));
    if (obs !== null) {
      const where = obs > p90 ? 'range.above' : obs < p10 ? 'range.below' : 'range.within';
      box.append(el('p', 'range-line ' + (obs > p90 ? 'z-up' : obs < p10 ? 'z-down' : ''),
        `${t('range.obs', { period: period(), v: fmtInt(obs) })} · ${t(where)}`));
    } else {
      box.append(el('p', 'range-line muted', t('range.obsNone', { period: period() })));
    }
    if (p.analog) {
      box.append(el('p', 'range-line', t('range.analog', { years: p.analog.years.join(', '), p10: fmt1(p.analog.p10), p90: fmt1(p.analog.p90) })));
    }
    const meta = [];
    if (Number.isFinite(p.range.nYears)) meta.push(t('range.years', { n: p.range.nYears, method: t(`range.method.${p.method}`) }));
    if (p.hindcast && Number.isFinite(p.hindcast.coveragePct)) {
      meta.push(t('range.hindcast', { period: p.hindcast.period, cov: fmt1(p.hindcast.coveragePct), skill: fmt1(p.hindcast.skillPct) }));
    } else if (local) {
      meta.push(t('range.noHindcast'));
    }
    meta.push(t('range.note'));
    for (const m of meta) box.append(el('small', 'range-meta muted', m));
  }

  /* ---------- Focos-raiz layer (cells that burned in many years; computed in PostGIS) ---------- */
  const ROOT_CLASSES = [
    { min: 0.6, color: '#6d0a0a' },
    { min: 0.4, color: '#c62828' },
    { min: 0.25, color: '#f26d6d' },
  ];
  async function toggleRoots() {
    const btn = $('toggle-roots');
    const r = state.roots;
    if (r.loading) return;
    r.on = !r.on;
    btn.classList.toggle('is-active', r.on);
    btn.setAttribute('aria-pressed', String(r.on));
    if (!r.on) { map.setPointLayer(null); $('roots-legend').hidden = true; return; }
    if (state.source.kind === 'demo') { showRootsMessage('roots.demo'); return; }
    if (!r.data) {
      r.loading = true;
      showRootsMessage('roots.loading');
      try {
        r.data = await state.source.recurrence(state.source.firstYear, state.source.lastYear);
      } catch (e) {
        console.warn('recurrence:', e.message);
        r.data = null;
      } finally {
        r.loading = false;
      }
      if (!r.data) { showRootsMessage(state.source.dataKind === 'firms_db' ? 'roots.err' : 'roots.demo'); return; }
    }
    if (r.on) drawRoots();
  }
  function showRootsMessage(key) {
    $('roots-legend').hidden = false;
    $('roots-title').textContent = t(key);
    clear($('roots-keys'));
    $('roots-hit').textContent = '';
  }
  function drawRoots() {
    const d = state.roots.data;
    const n = d.yearsObserved || 1;
    const classes = ROOT_CLASSES.map((c) => ({ color: c.color, cells: [] }));
    for (const c of d.cells) {
      const i = ROOT_CLASSES.findIndex((k) => c[2] / n >= k.min);
      if (i >= 0) classes[i].cells.push([c[0], c[1]]);
    }
    map.setPointLayer({ cellKm: 1, classes });
    $('roots-legend').hidden = false;
    $('roots-title').textContent = t('roots.legend', { n, from: state.source.firstYear, to: state.source.lastYear });
    const keys = $('roots-keys');
    clear(keys);
    let upper = n;
    for (const c of ROOT_CLASSES) {
      const lo = Math.ceil(c.min * n);
      const k = el('span', 'roots-key');
      const sw = el('i', 'roots-key__sw');
      sw.style.background = c.color;
      k.append(sw, el('span', '', lo >= upper ? `${lo}` : `${lo}–${upper}`));
      keys.append(k);
      upper = lo - 1;
    }
    const h = d.hitRate;
    $('roots-hit').textContent = h && h.testYear
      ? t('roots.hit', { y: h.testYear, hit: fmt1(h.hitPct), area: fmt1(h.areaSharePct) })
      : '';
  }

  /* ---------- A, B, C & D Operational, ML & Agro-Insurance B2B Intelligence Renderers ---------- */
  function renderIntelLoading(boxIds) {
    const labelNodes = [];
    for (const bid of boxIds) {
      const box = $(bid);
      if (!box) continue;
      clear(box);
      const wrap = el('div', 'intel-loading');
      const spin = el('span', 'intel-spinner');
      const txt = el('span', '', t('intel.loading', { s: 0 }));
      wrap.append(spin, txt);
      box.append(wrap);
      labelNodes.push(txt);
    }
    let elapsed = 0;
    const intervalId = setInterval(() => {
      elapsed += 1;
      for (const n of labelNodes) {
        n.textContent = t('intel.loading', { s: Math.min(20, elapsed) });
      }
    }, 1000);
    return () => clearInterval(intervalId);
  }

  async function loadIntelligence(id, seq) {
    const stopLoading = renderIntelLoading(['resources-box', 'root-fires-box', 'predictability-box', 'agro-b2b-box']);
    try {
      const fetchPromise = state.source.intelligence
        ? state.source.intelligence(id, state.year, state.month)
        : Promise.resolve(global.FireData.computeClientIntelligence(state.rows.get(id) || [], state.year, state.month, id));

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Satellite query exceeded 20s timeout')), 20000);
      });

      const intel = await Promise.race([fetchPromise, timeoutPromise]);
      stopLoading();
      if (seq !== state.panelSeq || !intel) return;
      if (intel.resources) renderResourcesBox(intel.resources);
      if (intel.rootFires) renderRootFiresBox(intel.rootFires);
      if (intel.predictability) renderPredictabilityBox(intel.predictability);
      if (intel.agroB2B) renderAgroB2BBox(intel.agroB2B, intel.telemetryMode || 'live_satellite');
    } catch (err) {
      stopLoading();
      if (seq !== state.panelSeq) return;
      const fallback = global.FireData.computeClientIntelligence(state.rows.get(id) || [], state.year, state.month, id);
      renderResourcesBox(fallback.resources);
      renderRootFiresBox(fallback.rootFires);
      renderPredictabilityBox(fallback.predictability);
      renderAgroB2BBox(fallback.agroB2B, 'fallback_mock');
    }
  }

  function renderResourcesBox(resData) {
    const box = $('resources-box');
    if (!box) return;
    clear(box);
    const sc = (resData && resData.scaling) || resData;
    if (!sc) return;

    const head = el('div', 'intel-head');
    const badge = el(
      'span',
      `intel-badge intel-badge--${sc.intensityClass || 'low'}`,
      t(`res.intensity.${sc.intensityClass || 'low'}`)
    );
    const frpTag = el('strong', 'intel-mono', `${I.num(sc.totalFrpMw || 0, 1)} MW FRP`);
    head.append(badge, frpTag);
    box.append(head);

    box.append(
      el(
        'p',
        'intel-note',
        t('res.dedup', {
          clusters: fmtInt(sc.activeClusters),
          raw: fmtInt(sc.rawDetections),
          pct: I.num(sc.deduplicatedRatioPct || 0, 1),
        })
      ),
      el(
        'p',
        'intel-note',
        t('res.frp', {
          mean: I.num(sc.meanFrpMw || 0, 1),
          max: I.num(sc.maxFrpMw || 0, 1),
          total: I.num(sc.totalFrpMw || 0, 1),
        })
      )
    );

    const grid = el('div', 'res-grid');
    const cards = [
      {
        label: t('res.brigadistas'),
        val: fmtInt(sc.brigadistas),
        sub: t('res.squads', { n: fmtInt(sc.squads) }),
      },
      {
        label: t('res.water'),
        val: `${fmtInt(sc.waterLiters)} L`,
        sub: t('res.trucks', { n: fmtInt(sc.waterTrucks) }),
      },
      {
        label: t('res.kits'),
        val: fmtInt(sc.manualKits),
        sub: t('res.kitsSub'),
      },
      {
        label: t('res.air'),
        val: fmtInt(sc.aircraftSupport),
        sub: t('res.airSub'),
      },
    ];
    for (const c of cards) {
      const card = el('div', 'res-card');
      card.append(
        el('span', 'res-card__label', c.label),
        el('strong', 'res-card__val', c.val),
        el('small', 'res-card__sub', c.sub)
      );
      grid.append(card);
    }
    box.append(grid, el('small', 'intel-foot', t('res.sensors')));
  }

  function renderRootFiresBox(rf) {
    const box = $('root-fires-box');
    if (!box) return;
    clear(box);
    if (!rf) return;

    const head = el('div', 'intel-head');
    const regimeKey = `root.regime.${rf.dominantRegime || 'low_activity'}`;
    const badgeClass =
      rf.dominantRegime === 'anthropogenic_root'
        ? 'high'
        : rf.dominantRegime === 'root_with_climate_spikes'
          ? 'extreme'
          : rf.dominantRegime === 'climatic_anomaly_driven'
            ? 'moderate'
            : 'low';
    head.append(
      el('span', `intel-badge intel-badge--${badgeClass}`, t(regimeKey)),
      el('strong', 'intel-mono', `${I.num(rf.persistenceScorePct || 0, 1)}%`)
    );
    box.append(head);

    const metaList = el('ul', 'context');
    const rows = [
      [t('root.persistence'), `${I.num(rf.persistenceScorePct || 0, 1)}%`],
      [t('root.anthroShare'), `${I.num(rf.anthropogenicSharePct || 0, 1)}%`],
      [
        t('root.anomalyYears'),
        Array.isArray(rf.climaticAnomalyYears) && rf.climaticAnomalyYears.length
          ? rf.climaticAnomalyYears.slice(-6).join(', ')
          : '–',
      ],
    ];
    for (const [lbl, val] of rows) {
      const li = el('li');
      li.append(el('span', '', lbl), el('strong', '', val));
      metaList.append(li);
    }
    box.append(metaList);

    if (Array.isArray(rf.months) && rf.months.length) {
      box.append(el('p', 'intel-subhead', t('root.matrixTitle')));
      const matrix = el('div', 'root-matrix');
      for (const m of rf.months) {
        const cell = el('div', 'root-cell');
        if (m.isRootMonth) cell.classList.add('is-root');
        const pct = Math.round(m.recurrencePct || 0);
        cell.title = `${monthName(m.month)}: ${pct}% (${m.yearsWithFire}/${m.yearsObserved})`;
        cell.append(
          el('span', 'root-cell__m', monthName(m.month)[0]),
          el('strong', 'root-cell__p', `${pct}%`)
        );
        matrix.append(cell);
      }
      box.append(matrix);
    }
  }

  function renderPredictabilityBox(pred) {
    const box = $('predictability-box');
    if (!box) return;
    clear(box);
    if (!pred) return;

    const head = el('div', 'intel-head');
    const rClass = pred.ignitionRiskClass || 'moderate';
    const ml = pred.mlPropensity || null;
    const aucText = ml && ml.modelRocAuc ? I.num(ml.modelRocAuc, 3) : '0.957';
    head.append(
      el('span', `intel-badge intel-badge--${rClass}`, t(`pred.risk.${rClass}`)),
      el('strong', 'intel-mono', `${I.num(pred.ignitionRiskScore || 0, 1)}%`)
    );
    box.append(head);
    box.append(el('p', 'intel-note', t('pred.mlTitle', { auc: aucText })));

    if (ml && Array.isArray(ml.contributions) && ml.contributions.length) {
      box.append(el('p', 'intel-subhead', t('pred.mlDrivers')));
      const driversBox = el('div', 'ml-drivers');
      const isEn = I.lang() === 'en';
      for (const c of ml.contributions.slice(0, 5)) {
        const row = el('div', 'ml-driver-row');
        const top = el('div', 'ml-driver-top');
        top.append(
          el('span', '', isEn ? c.labelEn : c.labelPt),
          el('strong', 'intel-mono', `${I.num(c.sharePct, 1)}%`)
        );
        const track = el('div', 'ml-driver-track');
        const fill = el('div', 'ml-driver-fill');
        fill.style.width = `${Math.max(4, Math.min(100, Math.round(c.sharePct * 1.8)))}%`;
        track.append(fill);
        row.append(top, track);
        driversBox.append(row);
      }
      box.append(driversBox);
    }

    const prop = pred.propagation || { azimuthDeg: 270, cardinal: 'W', spreadRateKmh: 0.8, reachRadius6hKm: 4.8 };
    const w = pred.weatherSummary || { t2mMaxC: 34, rh2mPct: 28, prectotcorrMm: 0, ws10mMs: 3.5, wd10mDeg: 90, windFromCardinal: 'E' };

    const compassRow = el('div', 'pred-compass-row');
    const compassSvg = svg('svg', { viewBox: '0 0 64 64', class: 'pred-compass', 'aria-hidden': 'true' });
    compassSvg.append(svg('circle', { cx: 32, cy: 32, r: 27, fill: 'none', stroke: 'currentColor', opacity: 0.28, 'stroke-width': 1.5 }));
    const nLabel = svg('text', { x: 32, y: 11, 'text-anchor': 'middle', class: 'compass-n' });
    nLabel.textContent = 'N';
    compassSvg.append(nLabel);

    const angleRad = ((prop.azimuthDeg - 90) * Math.PI) / 180;
    const x2 = 32 + Math.cos(angleRad) * 20;
    const y2 = 32 + Math.sin(angleRad) * 20;
    compassSvg.append(
      svg('line', {
        x1: 32,
        y1: 32,
        x2: x2.toFixed(1),
        y2: y2.toFixed(1),
        stroke: '#f26d6d',
        'stroke-width': 2.6,
        'stroke-linecap': 'round',
      }),
      svg('circle', { cx: x2.toFixed(1), cy: y2.toFixed(1), r: 3.4, fill: '#c62828' }),
      svg('circle', { cx: 32, cy: 32, r: 2.2, fill: 'currentColor' })
    );

    const vecInfo = el('div', 'pred-vec-info');
    vecInfo.append(
      el('strong', '', `${t('pred.vectorLabel')}: ${prop.azimuthDeg}° (${prop.cardinal})`),
      el('span', '', t('pred.vectorSub', { az: prop.azimuthDeg, card: prop.cardinal, rate: I.num(prop.spreadRateKmh, 2), reach: I.num(prop.reachRadius6hKm, 1) })),
      el('small', 'muted', t('pred.windFrom', { deg: w.wd10mDeg, card: w.windFromCardinal, ws: I.num(w.ws10mMs, 1) }))
    );
    compassRow.append(compassSvg, vecInfo);
    box.append(compassRow);

    const varsList = el('ul', 'context');
    const items = [
      [t('pred.t2mMax'), `${I.num(w.t2mMaxC, 1)} °C`],
      [t('pred.rh2m'), `${I.num(w.rh2mPct, 1)} %`],
      [t('pred.precip'), `${I.num(w.prectotcorrMm, 1)} mm`],
      [t('pred.ws10m'), `${I.num(w.ws10mMs, 1)} m/s · ${w.wd10mDeg}° (${w.windFromCardinal})`],
      [t('pred.dryDays'), `${pred.consecutiveDryDays || 0} d · ${I.num(pred.vaporPressureDeficitHpa || 0, 1)} hPa`],
    ];
    for (const [lbl, val] of items) {
      const li = el('li');
      li.append(el('span', '', lbl), el('strong', '', val));
      varsList.append(li);
    }
    box.append(varsList);
  }

  function renderAgroB2BBox(agro, telemetryMode) {
    const box = $('agro-b2b-box');
    if (!box) return;
    clear(box);
    if (!agro || !agro.insurance) return;

    const ins = agro.insurance;
    const fin = agro.financialRisk || {};
    const tx = agro.transmissionLine || {};
    const cred = agro.creditAudit || {};
    const m13 = agro.mod13q1 || {};
    const m12 = agro.mcd12q1 || {};
    const pil = agro.pillars || {};

    const head = el('div', 'intel-head');
    const tier = ins.riskTier || 'moderate';
    const scoreWrap = el('strong', 'intel-mono', `${I.num(ins.agroInsuranceScore || 0, 1)} / 100`);
    const isLive = telemetryMode !== 'fallback_mock';
    const dot = el('span', `sat-dot ${isLive ? 'sat-dot--live' : 'sat-dot--snapshot'}`);
    dot.title = isLive ? t('intel.source.live') : t('intel.source.fallback');
    scoreWrap.append(dot);
    head.append(
      el(
        'span',
        `intel-badge intel-badge--${tier}`,
        t('agro.ratingBadge', { rating: ins.underwritingRating || 'BBB', tier: t(`pred.risk.${tier}`) })
      ),
      scoreWrap
    );
    box.append(head);

    box.append(
      el(
        'p',
        'intel-note',
        `${t('agro.scoreSummary', {
          score: I.num(ins.agroInsuranceScore || 0, 1),
          ins: fmtInt(ins.insurabilityScore || 0),
        })} · ${t(`agro.decision.${ins.underwritingDecision || 'approve_with_firebreak_covenant'}`)}`
      )
    );

    box.append(el('p', 'intel-subhead', t('agro.pillarsTitle')));
    const pillarsBox = el('div', 'ml-drivers');
    const pillarRows = [
      [t('agro.pillar.firms'), pil.firmsFireScore || 0],
      [t('agro.pillar.power'), pil.powerClimateScore || 0],
      [t('agro.pillar.mod13q1'), pil.mod13q1BiomassScore || 0],
      [t('agro.pillar.mcd12q1'), pil.mcd12q1LandUseScore || 0],
    ];
    for (const [label, val] of pillarRows) {
      const row = el('div', 'ml-driver-row');
      const top = el('div', 'ml-driver-top');
      top.append(el('span', '', label), el('strong', 'intel-mono', `${I.num(val, 1)}/100`));
      const track = el('div', 'ml-driver-track');
      const fill = el('div', 'ml-driver-fill');
      fill.style.width = `${Math.max(4, Math.min(100, Math.round(val)))}%`;
      track.append(fill);
      row.append(top, track);
      pillarsBox.append(row);
    }
    box.append(pillarsBox);

    const grid = el('div', 'res-grid');
    const loadSign = (ins.recommendedLoadingPct || 0) >= 0 ? '+' : '';
    const cards = [
      {
        label: t('agro.v1.title'),
        val: `${ins.underwritingRating || 'BBB'} · ${I.num(ins.pureRiskRatePct || 0, 2)}%`,
        sub: t('agro.v1.sub', {
          rate: I.num(ins.pureRiskRatePct || 0, 2),
          ded: fmtInt(ins.suggestedDeductiblePct || 10),
          load: `${loadSign}${I.num(ins.recommendedLoadingPct || 0, 1)}`,
        }),
      },
      {
        label: t('agro.v2.title'),
        val: `R$ ${fmtInt(fin.valueAtRiskBrlPerHa || 0)}/ha`,
        sub: t('agro.v2.sub', {
          eal: I.num(fin.expectedAnnualLossPct || 0, 2),
          pml: I.num(fin.probableMaximumLossP95Pct || 0, 1),
        }),
      },
      {
        label: t('agro.v3.title'),
        val: `${I.num(tx.rowClearingPriorityScore || 0, 1)}/100`,
        sub: t('agro.v3.sub', {
          buf: fmtInt(tx.recommendedBufferWidthM || 40),
          smoke: t(`pred.risk.${tx.smokeOutageRiskClass || 'moderate'}`),
        }),
      },
      {
        label: t('agro.v4.title'),
        val: `${I.num(cred.complianceScore || 0, 1)}/100`,
        sub: t('agro.v4.sub', {
          rl: I.num(cred.rlAppExposurePct || 0, 1),
          status: t(`agro.status.${cred.creditAuditStatus || 'compliant'}`),
        }),
      },
    ];
    for (const c of cards) {
      const card = el('div', 'res-card');
      card.append(
        el('span', 'res-card__label', c.label),
        el('strong', 'res-card__val', c.val),
        el('small', 'res-card__sub', c.sub)
      );
      grid.append(card);
    }
    box.append(grid);

    const anomSign = (m13.ndviAnomalyPct || 0) >= 0 ? '+' : '';
    box.append(
      el(
        'p',
        'intel-note',
        t('agro.mod13q1.line', {
          ndvi: I.num(m13.ndviMean || 0, 2),
          anom: `${anomSign}${I.num(m13.ndviAnomalyPct || 0, 1)}`,
          evi: I.num(m13.eviMean || 0, 2),
          curing: I.num(m13.curingRatePct || 0, 1),
          fuel: I.num(m13.fuelLoadTonsHa || 0, 1),
        })
      ),
      el(
        'p',
        'intel-note',
        t('agro.mcd12q1.line', {
          crop: I.num(m12.croplandPct || 0, 1),
          past: I.num(m12.pastureGrasslandPct || 0, 1),
          sav: I.num(m12.savannaCerradoPct || 0, 1),
          for: I.num(m12.forestRlAppPct || 0, 1),
          iface: I.num(m12.interfaceRiskIndex || 0, 1),
        })
      )
    );
  }

  async function loadContext(id, seq) {
    const ul = $('context');
    $('ctx-year').textContent = String(state.year);
    clear(ul);
    const loadingLi = el('li', 'intel-loading');
    const spin = el('span', 'intel-spinner');
    const txt = el('span', '', t('intel.loading', { s: 0 }));
    loadingLi.append(spin, txt);
    ul.append(loadingLi);
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += 1;
      txt.textContent = t('intel.loading', { s: Math.min(20, elapsed) });
    }, 1000);
    try {
      const items = await state.source.context(id, state.year);
      clearInterval(timer);
      if (seq !== state.panelSeq) return;
      clear(ul);
      if (!items.length) { ul.append(el('li', '', t('ctx.none'))); return; }
      for (const it of items) {
        const li = el('li');
        const label = it.key && I.has('ctx.' + it.key) ? t('ctx.' + it.key) : it.label;
        const val = it.value === null ? '–' : `${I.num(it.value)}${it.unit ? ' ' + it.unit : ''}`;
        const src = it.source.replace(/^DEMO\b/, t('ctx.demo'));
        li.append(el('span', '', label), el('strong', '', val), el('small', '', src));
        ul.append(li);
      }
    } catch (_) {
      clearInterval(timer);
      if (seq === state.panelSeq) {
        clear(ul);
        ul.append(el('li', '', t('ctx.err')));
      }
    }
  }

  /* ---------- CSV export ---------- */
  function downloadCsv() {
    const id = state.selected;
    const sphere = state.sphereSelection;
    if (!id && !sphere) return;

    const rows = id ? (state.rows.get(id) || []) : (state.sphereRows || []);
    const code = id || `sphere_${sphere.radiusKm}km_${sphere.ids.length}mun`;
    const name = id
      ? (state.names.get(id) || id).replace(/["\r\n]/g, '')
      : t('sphere.title', { n: sphere.ids.length }).replace(/["\r\n]/g, '');

    const lines = ['ibge_code,municipality,year,month,modis_hotspots,viirs_hotspots,harmonized_cell_days,anomaly_z,days_missing'];
    const csvCell = (v) => (v === null || v === undefined ? '' : String(v));
    for (const r of rows) {
      lines.push([code, `"${name}"`, r.year, r.month, csvCell(r.modis), csvCell(r.viirs), csvCell(r.harmonized), csvCell(r.anomalyZ), csvCell(r.daysMissing)].join(','));
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `monitor-cinder-goias-${code}-${state.year}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- language & theme ---------- */
  function applyLanguage() {
    I.apply();
    setBadge();
    map.setAriaLabel(t('map.aria'));
    if (state.lastView) updateLateralScale(state.lastView);
    if (!state.source) return;
    renderMonthOptions();
    drawLegend(scaleFor(state.values));
    if (state.sphereSelection) {
      renderSpherePanel(state.sphereSelection);
    } else if (state.selected && state.rows.has(state.selected)) {
      renderHeader(state.selected);
      renderPanelBody(state.selected);
      const seq = ++state.panelSeq;
      loadRange(state.selected, seq);
      loadIntelligence(state.selected, seq);
      loadContext(state.selected, seq);
      const cur = currentRow();
      loadDetail({ kind: 'muni', id: state.selected }, cur ? cur.harmonized : 0, seq);
    }
    if (state.roots.on && state.roots.data) drawRoots();
  }
  function setupLanguage() {
    $('lang').addEventListener('click', () => { I.setLang(I.lang() === 'pt' ? 'en' : 'pt'); applyLanguage(); });
    applyLanguage();
  }
  function setupTheme() {
    let theme = 'dark';
    try { theme = localStorage.getItem('firehub.theme') === 'light' ? 'light' : 'dark'; } catch (_) { /* storage blocked */ }
    const apply = (th) => {
      document.documentElement.dataset.theme = th;
      $('theme').textContent = th === 'dark' ? '☾' : '☀';
      map.setTheme(th);
      if (state.source) {
        drawLegend(scaleFor(state.values));
        if (state.selected && state.rows.has(state.selected)) { renderCalendar(state.rows.get(state.selected)); renderCompare(state.rows.get(state.selected)); }
      }
    };
    apply(theme);
    $('theme').addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('firehub.theme', theme); } catch (_) { /* ignore */ }
      apply(theme);
    });
  }

  /* ---------- boot ---------- */
  async function boot() {
    const mapEl = $('map');
    const reserved = () => {
      const o = mapEl.getBoundingClientRect();
      return [
        document.querySelector('.map-tools'),
        document.querySelector('.mode-hud'),
        document.querySelector('.scale-lateral'),
        document.querySelector('.legend'),
      ].filter(Boolean).map((e) => {
        const r = e.getBoundingClientRect();
        return { left: r.left - o.left - 6, top: r.top - o.top - 6, right: r.right - o.left + 6, bottom: r.bottom - o.top + 6 };
      });
    };
    map = global.FireMap.create(mapEl, { theme: 'dark', lon0: -54, ariaLabel: t('map.aria'), reserved });
    setupTheme();
    setupLanguage();
    map.on('hover', onHover);
    map.on('select', (id) => selectMunicipality(id, false));
    map.on('sphere', onSphereSelect);
    map.on('view', updateLateralScale);
    map.on('cell', onCellHover);

    // Mode switcher (Município vs Esfera/Área 2D)
    let radiusTimer = 0;
    $('mode-muni').addEventListener('click', () => setModeUI('municipality'));
    $('mode-sphere').addEventListener('click', () => setModeUI('sphere'));
    $('sphere-radius').addEventListener('input', (e) => {
      const r = Number(e.target.value) || 85;
      $('sphere-radius-val').textContent = `${r} km`;
      clearTimeout(radiusTimer);
      radiusTimer = setTimeout(() => map.setSphereRadius(r), 60);
    });

    // Map tools
    $('zoom-in').addEventListener('click', () => map.zoomBy(1.6));
    $('zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.6));
    $('zoom-reset').addEventListener('click', () => {
      if (state.selected || state.sphereSelection) selectMunicipality(null, true);
      else map.reset(850);
    });
    $('zoom-brazil').addEventListener('click', () => map.resetBrazil(960));
    $('toggle-roots').addEventListener('click', toggleRoots);
    $('toggle-numbers').addEventListener('click', () => {
      const on = map.setShowNumbers();
      $('toggle-numbers').classList.toggle('is-active', on);
    });

    $('p-close').addEventListener('click', () => {
      setModeUI('municipality');
      selectMunicipality(null, true);
    });
    $('csv').addEventListener('click', downloadCsv);
    $('calendar').addEventListener('click', (e) => {
      const b = e.target.closest('.cal-cell');
      if (!b) return;
      state.year = Number(b.dataset.y); state.month = Number(b.dataset.m);
      onPeriodChange();
    });

    setStatus('status.loading');
    try {
      state.source = await global.FireData.createSource(() => state.ids, (id) => map.areaKm2(id));
      setBadge();
      const [mesh, brazilMesh, names] = await Promise.all([
        global.FireData.loadGeometry(state.source.kind === 'api'),
        global.FireData.loadBrazilGeometry(),
        global.FireData.loadNames(),
      ]);
      if (brazilMesh) map.setBrazilGeometry(brazilMesh);
      const n = map.setGeometry(mesh);
      if (!n) throw new Error('no municipalities');
      state.ids = map.featureIds();
      state.names = names.names; state.info = names.info;
      map.setNames(state.names);
      readHash();
      fillControls();
      setupSearch();
      await refreshMap();

      // Cinematic flight in motion from Brazil overview into Goiás (or selected municipality)
      setTimeout(() => {
        if (state.selected) selectMunicipality(state.selected, true);
        else map.reset(1180);
      }, 180);

      document.documentElement.dataset.ready = 'true';
    } catch (e) {
      console.error(e);
      setStatus('status.mapErr', { msg: e.message }, true, () => location.reload());
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
