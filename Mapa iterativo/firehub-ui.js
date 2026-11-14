/*
 * FireHub UI controller (original code).
 * Connects the controls, the map engine, the side panel, the sphere area selector,
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
    if (k === 'anomaly' || k === 'count') state.metric = k;
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
    b.className = 'badge ' + (demo ? 'badge--demo' : 'badge--live');
    b.textContent = t(demo ? 'badge.demo' : 'badge.live');
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
      loadContext(state.selected, ++state.panelSeq);
    }
  }

  /* ---------- map & legend ---------- */
  const Z_SCALE = { type: 'diverging', min: -3, max: 3 };
  function scaleFor(values) {
    if (state.metric === 'anomaly') return Z_SCALE;
    let max = 10;
    for (const k of Object.keys(values)) { const v = values[k]; if (typeof v === 'number' && v > max) max = v; }
    return { type: 'sequential', min: 0, max };
  }

  async function refreshMap() {
    writeHash();
    const seq = ++state.reqSeq;
    try {
      const values = await state.source.mapValues(state.year, state.month, state.metric);
      if (seq !== state.reqSeq) return;
      state.values = values;
      const scale = scaleFor(values);
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
    $('legend-title').textContent = t(state.metric === 'anomaly' ? 'legend.anomaly' : 'legend.count', { period: period() });
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
    const labels = scale.type === 'diverging'
      ? ['−3σ', '−1σ', t('legend.normal'), '+1σ', '+3σ']
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
      const valText = state.metric === 'anomaly' ? fmtZ(v) : fmtInt(v);
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
      loadContext(id, seq);
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

  async function renderSpherePanel(sphere) {
    const seq = ++state.panelSeq;
    $('panel-empty').hidden = true;
    $('panel-body').hidden = false;

    const centerName = (sphere.centerId && state.names.get(sphere.centerId)) || CFG.ufName;
    $('p-name').textContent = t('sphere.title', { n: sphere.ids.length });
    $('p-sub').textContent = t('sphere.sub', {
      r: sphere.radiusKm,
      area: I.num(sphere.areaKm2),
      name: centerName,
    });

    // Render clickable pills for all municipalities inside the sphere
    const block = $('subareas-block');
    const list = $('subareas-list');
    clear(list);
    block.hidden = false;
    $('subareas-title').textContent = t('block.sphereMunis');
    $('subareas-small').textContent = t('block.sphereMunisSmall');

    for (const id of sphere.ids) {
      const btn = el('button', 'subarea-pill');
      btn.type = 'button';
      const nameSpan = el('span', 'subarea-pill__name', state.names.get(id) || id);
      const v = state.values[id];
      const valSpan = el('em', 'subarea-pill__val', state.metric === 'anomaly' ? fmtZ(v) : fmtInt(v));
      btn.append(nameSpan, valSpan);
      btn.onclick = () => {
        setModeUI('municipality');
        selectMunicipality(id, true);
      };
      list.append(btn);
    }

    try {
      // Load calendars for ALL municipalities in the sphere (no truncation)
      const calendars = await Promise.all(sphere.ids.map(async (id) => {
        if (state.rows.has(id)) return state.rows.get(id);
        const r = await state.source.calendar(id);
        state.rows.set(id, r);
        return r;
      }));
      if (seq !== state.panelSeq) return;

      // 1. Sum the hotspot series across all selected municipalities by (year, month)
      const byYm = new Map();
      for (const cal of calendars) {
        for (const r of cal) {
          const key = `${r.year}-${r.month}`;
          let agg = byYm.get(key);
          if (!agg) {
            agg = { year: r.year, month: r.month, modis: 0, viirs: 0, viirsCount: 0, harmonized: 0, daysMissing: 0 };
            byYm.set(key, agg);
          }
          if (r.modis !== null) agg.modis += r.modis;
          if (r.viirs !== null) { agg.viirs += r.viirs; agg.viirsCount++; }
          if (r.harmonized !== null) agg.harmonized += r.harmonized;
          if (r.daysMissing) agg.daysMissing = Math.max(agg.daysMissing, r.daysMissing);
        }
      }

      // 2. Compute the 2002–2024 baseline mean & sample standard deviation (stddev_samp, N-1)
      //    directly on the summed regional harmonized series per calendar month
      const baselineByMonth = new Map();
      for (let m = 1; m <= 12; m++) {
        const vals = [];
        for (const a of byYm.values()) {
          if (a.month === m && a.year >= 2002 && a.year <= 2024 && Number.isFinite(a.harmonized)) {
            vals.push(a.harmonized);
          }
        }
        const n = vals.length;
        const sum = vals.reduce((s, v) => s + v, 0);
        const mean = n > 0 ? sum / n : 0;
        const sd = n >= 2
          ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1))
          : 0;
        baselineByMonth.set(m, { mean, sd, sum, n });
      }

      const aggRows = [...byYm.values()]
        .sort((a, b) => (a.year - b.year) || (a.month - b.month))
        .map((a) => {
          const base = baselineByMonth.get(a.month);
          const anomalyZ = base && base.sd > 0
            ? Math.round(((a.harmonized - base.mean) / base.sd) * 100) / 100
            : null;
          return {
            year: a.year,
            month: a.month,
            modis: a.modis,
            viirs: a.viirsCount ? a.viirs : null,
            harmonized: a.harmonized,
            anomalyZ,
            daysMissing: a.daysMissing,
          };
        });
      state.sphereRows = aggRows;

      const cur = aggRows.find((r) => r.year === state.year && r.month === state.month) || null;
      $('k-period').textContent = period();
      $('k-count').textContent = fmtInt(cur ? cur.harmonized : null);
      const z = cur ? cur.anomalyZ : null;
      const kz = $('k-z');
      kz.textContent = fmtZ(z);
      kz.className = z === null ? '' : z >= 1 ? 'z-up' : z <= -1 ? 'z-down' : '';
      $('k-z-text').textContent = zText(z);

      // 3. Compute aggregated seasonal pattern from the summed 2002–2024 baseline
      let totalBase = 0;
      for (let m = 1; m <= 12; m++) totalBase += baselineByMonth.get(m).sum;
      const denom = totalBase || 1;
      const months = [];
      for (let m = 1; m <= 12; m++) {
        const b = baselineByMonth.get(m);
        months.push({
          month: m,
          mean: Math.round(b.mean * 10) / 10,
          sharePct: Math.round((b.sum / denom) * 1000) / 10,
        });
      }
      const sorted = months.slice().sort((a, b) => b.sharePct - a.sharePct);
      const picked = [];
      let acc = 0;
      for (const m of sorted) { if (acc >= 80) break; picked.push(m.month); acc += m.sharePct; }
      const aggPattern = {
        months,
        season: { months: picked.sort((a, b) => a - b), coveredPct: Math.round(acc * 10) / 10, peakMonth: sorted[0].month },
      };

      renderPattern(aggPattern);
      renderCalendar(aggRows);
      renderCompare(aggRows);
      if (sphere.centerId) loadContext(sphere.centerId, seq);
    } catch (e) {
      if (seq !== state.panelSeq) return;
      console.error(e);
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
      { k: 'modis', color: '#8fb359', label: t('cmp.modis') },
      { k: 'viirs', color: css.getPropertyValue('--accent-2').trim() || '#dda15e', label: t('cmp.viirs') },
      { k: 'harmonized', color: css.getPropertyValue('--accent').trim() || '#bc6c25', label: t('cmp.harm') },
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

  async function loadContext(id, seq) {
    const ul = $('context');
    $('ctx-year').textContent = String(state.year);
    clear(ul);
    try {
      const items = await state.source.context(id, state.year);
      if (seq !== state.panelSeq) return;
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
      if (seq === state.panelSeq) ul.append(el('li', '', t('ctx.err')));
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
    a.download = `firehub-goias-${code}-${state.year}.csv`;
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
      loadContext(state.selected, ++state.panelSeq);
    }
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
      state.source = await global.FireData.createSource(() => state.ids);
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
