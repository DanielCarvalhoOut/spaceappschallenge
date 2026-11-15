/*
 * Monitor Cinder UI controller (original code).
 * Connects the controls, the map engine, the details modal, the 2D circle area selector,
 * the lateral scale indicator, and the data layer.
 * DOM updates use createElement + textContent only — never innerHTML with external strings.
 */
(function (global) {
  'use strict';

  const CFG = global.CINDER_CONFIG;
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
    horizonsShown: null,
    calYear: null, // year shown in the History calendar
    places: null, // IBGE localities (map reference only) // projection currently rendered (re-rendered on language change)
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

  /* ---------- the edge between observed data and projection ---------- */
  const keyOf = (y, m) => y * 100 + m;
  const addMonths = (key, n) => { const y = Math.floor(key / 100), m = (key % 100) - 1 + n; return keyOf(y + Math.floor(m / 12), (m % 12) + 1); };
  const PROJ_MONTHS = 6; // the projection reaches 6 months past the last observed day
  function edge() {
    const d = state.source && state.source.lastObservedDay;
    if (!d) return null;
    const p = state.source.provisionalFrom;
    return { key: keyOf(Number(d.slice(0, 4)), Number(d.slice(5, 7))), date: d, provKey: p ? keyOf(Number(p.slice(0, 4)), Number(p.slice(5, 7))) : null, prov: p };
  }
  /** 'obs' | 'prov' (observed, near-real-time) | 'partial' (month in progress) | 'proj' (future, up to 6 months) | 'none' */
  function periodKind(y, m) {
    const k = keyOf(y, m), e = edge();
    if (!state.source || k < keyOf(state.source.firstYear, 1)) return 'none';
    if (!e) return k <= keyOf(state.source.lastYear, 12) ? 'obs' : 'none';
    if (k === e.key) return 'partial';
    if (k < e.key) return e.provKey !== null && k >= e.provKey ? 'prov' : 'obs';
    return k <= addMonths(e.key, PROJ_MONTHS) ? 'proj' : 'none';
  }
  const isFuture = () => periodKind(state.year, state.month) === 'proj';
  /** Metric actually painted: future months show the historical pattern of that calendar month. */
  const viewMetric = () => (isFuture() ? 'typical' : state.metric);
  const lastPickYear = () => { const e = edge(); return e ? Math.floor(addMonths(e.key, PROJ_MONTHS) / 100) : state.source.lastYear; };
  const fmtDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return d.toLocaleDateString(I.lang() === 'en' ? 'en-US' : 'pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); };

  /** Value text for the active map metric (pills, tooltip). */
  const valueText = (v) => (
    viewMetric() === 'typical'
      ? fmtInt(v)
      : state.metric === 'anomaly'
      ? fmtZ(v)
      : state.metric === 'density'
        ? fmt1(v)
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
    if (Number.isInteger(y) && y >= state.source.firstYear && y <= lastPickYear()) state.year = y;
    if (Number.isInteger(m) && m >= 1 && m <= 12) state.month = m;
    if (k === 'anomaly' || k === 'count' || k === 'density') state.metric = k;
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
    const kind = state.source.dataKind;
    const live = kind === 'firms_db' || kind === 'firms_index';
    b.className = 'badge ' + (live ? 'badge--live' : 'badge--demo');
    const h = state.source.historyLoad;
    b.textContent = state.source.kind === 'offline' ? t('badge.offline')
      : kind === 'loading' ? t('badge.historyLoading', { done: h ? h.done : 0, total: h ? h.total : 0 })
        : kind === 'none' ? t('badge.historyNone')
          : t(kind === 'firms_index' ? 'badge.firmsIndex' : 'badge.firms');
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
    if (periodKind(state.year, state.month) === 'none') { const e = edge(); if (e) { state.year = Math.floor(e.key / 100); state.month = e.key % 100; } }
    renderMonthOptions();
    $('metric').value = state.metric;
    $('metric').onchange = () => { state.metric = $('metric').value; refreshMap(); if (state.calRows) renderCalendar(state.calRows); };
    const btn = $('period-btn'), pop = $('period-pop');
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = () => {
      if (!pop.hidden) { close(); return; }
      state.ppYear = state.year;
      renderPeriodPicker();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const cur = pop.querySelector('.period__m.is-current');
      if (cur) cur.focus();
    };
    $('pp-prev').onclick = () => { state.ppYear -= 1; renderPeriodPicker(); };
    $('pp-next').onclick = () => { state.ppYear += 1; renderPeriodPicker(); };
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
    state.closePeriod = close;
  }
  /** Button text + tag (provisional, in progress, projection) for the selected month. */
  function renderMonthOptions() {
    $('period-text').textContent = `${monthName(state.month)} ${state.year}`;
    const kind = periodKind(state.year, state.month), tag = $('period-tag');
    const key = { prov: 'period.tagProv', partial: 'period.tagPartial', proj: 'period.tagProj' }[kind];
    tag.hidden = !key;
    tag.textContent = key ? t(key) : '';
    tag.className = `period__tag period__tag--${kind}`;
    if (!$('period-pop').hidden) renderPeriodPicker();
  }
  function renderPeriodPicker() {
    const first = state.source.firstYear, last = lastPickYear();
    if (!Number.isInteger(state.ppYear)) state.ppYear = state.year;
    state.ppYear = Math.min(last, Math.max(first, state.ppYear));
    const y = state.ppYear;
    $('pp-year').textContent = String(y);
    $('pp-prev').disabled = y <= first;
    $('pp-next').disabled = y >= last;
    const box = $('pp-months');
    clear(box);
    for (let m = 1; m <= 12; m++) {
      const kind = periodKind(y, m);
      const b = el('button', `period__m period__m--${kind}`, monthName(m));
      b.type = 'button';
      if (kind === 'none') b.disabled = true;
      if (y === state.year && m === state.month) { b.classList.add('is-current'); b.setAttribute('aria-current', 'true'); }
      b.title = kind === 'none' ? t('period.none') : t(`period.k${{ obs: 'Obs', prov: 'Prov', partial: 'Partial', proj: 'Proj' }[kind]}`);
      b.onclick = () => { state.year = y; state.month = m; if (state.closePeriod) state.closePeriod(); onPeriodChange(); };
      box.append(b);
    }
    const e = edge();
    $('pp-range').textContent = e
      ? t('period.range', { from: `${monthName(1)}/${first}`, to: fmtDay(e.date), prov: e.prov ? fmtDay(e.prov) : '–' })
      : t('period.rangeNone');
  }
  function onPeriodChange() {
    renderMonthOptions();
    refreshMap();
    if (state.sphereSelection) {
      renderSpherePanel(state.sphereSelection);
    } else if (state.selected && state.rows.has(state.selected)) {
      updateKpis();
      markCalendar();
      renderNeighborsList(state.selected);
      const seq = ++state.panelSeq;
      loadRange(state.selected, seq);
      loadContext(state.selected, seq);
      const cur = currentRow();
      loadDetail({ kind: 'muni', id: state.selected }, cur ? cur.harmonized : 0, seq);
    }
  }

  /* ---------- map & legend ---------- */
  const Z_SCALE = { type: 'diverging', min: -3, max: 3 };
  function scaleFor(values) {
    if (state.metric === 'anomaly') return Object.assign({}, Z_SCALE);
    let max = 10;
    for (const k of Object.keys(values)) { const v = values[k]; if (typeof v === 'number' && v > max) max = v; }
    return { type: 'sequential', min: 0, max };
  }

  async function refreshMap() {
    writeHash();
    const seq = ++state.reqSeq;
    const future = isFuture();
    document.querySelector('.map-wrap').classList.toggle('is-projection', future);
    $('metric').disabled = future;
    if (!future) $('proj-ribbon').hidden = true;
    if (future) {
      try {
        const values = await state.source.mapValues(state.year, state.month, 'typical');
        if (seq !== state.reqSeq) return;
        state.values = values;
        let max = 10;
        for (const k of Object.keys(values)) { const v = values[k]; if (typeof v === 'number' && v > max) max = v; }
        const scale = { type: 'sequential', min: 0, max };
        map.setValues(values, scale);
        drawLegend(scale);
        if (state.selected) renderNeighborsList(state.selected);
        setStatus(null);
        renderRibbon(seq);
      } catch (e) {
        if (seq !== state.reqSeq) return;
        console.error(e);
        setStatus('status.valuesErr', null, true, refreshMap);
      }
      return;
    }
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
        // Colour must say whether the area burned this month: zero hotspots is white even when its anomaly is near normal.
        scale.noFireIds = Object.keys(counts).filter((id) => counts[id] === 0);
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
    $('legend-title').textContent = t(`legend.${viewMetric()}`, { period: period() });
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
        : ['0', fmtInt(Math.sqrt(scale.max)), fmtInt(scale.max)];
    for (const s of labels) ticks.append(el('span', '', s));
  }

  function onHover(h) {
    const tip = $('tooltip');
    if (!h) { tip.hidden = true; return; }
    const v = state.values[h.id];
    const muniName = state.names.get(h.id) || h.id;
    $('tt-name').textContent = muniName;
    $('tt-value').textContent = viewMetric() === 'typical'
      ? t('tt.typical', { n: fmtInt(v), m: monthName(state.month) })
      : state.metric === 'anomaly'
      ? `${fmtZ(v)} · ${zText(v)}`
      : state.metric === 'density'
        ? t('tt.density', { v: fmt1(v), period: period() })
        : t('tt.count', { n: fmtInt(v), period: period() });
    const inf = state.info.get(h.id) || {};
    const extra = $('tt-extra');
    clear(extra);
    if (inf.microregion) extra.append(el('span', '', t('tt.micro')), el('b', '', inf.microregion));
    extra.hidden = !inf.microregion;
    $('tt-hint').textContent = $('mode-sphere').classList.contains('is-active') ? t('tt.hintSphere') : t('tt.hint');
    $('tt-hint').hidden = false;
    tip.hidden = false;
    const x = Math.min(h.x + 14, $('map').clientWidth - 290);
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
        closeModal();
      }
    }
  }

  /* ---------- Details modal (tabs) ---------- */
  let lastFocus = null;
  /** Details open docked beside the map (side) or as the full modal (footer toggle). */
  function isModalMode() { return $('panel').classList.contains('is-modal'); }
  function setPanelMode(modal) {
    const panel = $('panel'), card = $('panel-body'), btn = $('p-expand');
    panel.classList.toggle('is-modal', modal);
    panel.classList.toggle('is-side', !modal);
    card.setAttribute('role', modal ? 'dialog' : 'region');
    if (modal) card.setAttribute('aria-modal', 'true'); else card.removeAttribute('aria-modal');
    labelExpand();
    syncLayout();
    if (modal) {
      lastFocus = document.activeElement;
      card.focus({ preventScroll: true });
    } else if (lastFocus && document.contains(lastFocus) && lastFocus.focus) {
      lastFocus.focus({ preventScroll: true });
      lastFocus = null;
    }
  }
  function labelExpand() {
    const modal = isModalMode(), btn = $('p-expand');
    btn.textContent = (modal ? '⤡ ' : '⤢ ') + t(modal ? 'panel.collapse' : 'panel.expand');
    btn.title = t(modal ? 'panel.collapseTitle' : 'panel.expandTitle');
    btn.setAttribute('aria-pressed', modal ? 'true' : 'false');
  }
  /** The map column shrinks only while the docked panel is visible (the engine's ResizeObserver redraws). */
  function syncLayout() {
    const panel = $('panel');
    panel.closest('.layout').classList.toggle('has-side', !panel.hidden && !isModalMode());
    applySideWidth(state.sideWidth);
  }

  /* ---------- Docked panel width: drag the left edge, arrows on the handle, double-click resets ---------- */
  const SIDE_MIN = 360;            // px, the panel never gets narrower than this
  const SIDE_MAP_MIN = 360;        // px, the map keeps at least this much
  const SIDE_MAX_FRAC = 0.75;      // of the layout width
  const SIDE_KEY = 'cinder.sideWidth';
  function sideLimits() {
    const w = $('panel').closest('.layout').clientWidth || window.innerWidth;
    const max = Math.max(SIDE_MIN, Math.min(w * SIDE_MAX_FRAC, w - SIDE_MAP_MIN));
    return { min: SIDE_MIN, max, def: Math.min(max, Math.max(SIDE_MIN, w * 0.5)) };
  }
  /** null = default (half the screen). Clamped to the limits every time, so a window resize never breaks it. */
  function applySideWidth(px) {
    const layout = $('panel').closest('.layout');
    const { min, max, def } = sideLimits();
    const w = Math.round(Math.min(max, Math.max(min, Number.isFinite(px) ? px : def)));
    layout.style.setProperty('--side-w', `${w}px`);
    const h = $('panel-resize');
    h.setAttribute('aria-valuemin', String(min));
    h.setAttribute('aria-valuemax', String(Math.round(max)));
    h.setAttribute('aria-valuenow', String(w));
    return w;
  }
  function saveSideWidth() {
    try { if (Number.isFinite(state.sideWidth)) localStorage.setItem(SIDE_KEY, String(state.sideWidth)); else localStorage.removeItem(SIDE_KEY); } catch (_) { /* storage blocked */ }
  }
  function setupPanelResize() {
    try { const v = Number(localStorage.getItem(SIDE_KEY)); state.sideWidth = v > 0 ? v : null; } catch (_) { state.sideWidth = null; }
    const handle = $('panel-resize'), layout = $('panel').closest('.layout');
    let dragging = false;
    // After a resize, bring the selected municipality back to the centre of the (new) map column.
    const refocus = () => { if (state.selected) map.select(state.selected, { fly: true, emit: false }); };
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      layout.classList.add('is-resizing');
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      state.sideWidth = applySideWidth(layout.getBoundingClientRect().right - e.clientX);
    });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      layout.classList.remove('is-resizing');
      saveSideWidth();
      refocus();
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', () => { state.sideWidth = null; applySideWidth(null); saveSideWidth(); });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 96 : 32;
      const cur = Number(handle.getAttribute('aria-valuenow')) || sideLimits().def;
      if (e.key === 'ArrowLeft') state.sideWidth = applySideWidth(cur + step);
      else if (e.key === 'ArrowRight') state.sideWidth = applySideWidth(cur - step);
      else if (e.key === 'Home') state.sideWidth = applySideWidth(sideLimits().max);
      else if (e.key === 'End') state.sideWidth = applySideWidth(SIDE_MIN);
      else return;
      e.preventDefault();
      saveSideWidth();
      refocus();
    });
    window.addEventListener('resize', () => applySideWidth(state.sideWidth));
    applySideWidth(state.sideWidth);
  }
  function openModal() {
    const wasOpen = !$('panel').hidden;
    $('panel-empty').hidden = true;
    $('panel').hidden = false;
    $('panel-body').hidden = false;
    $('csv').hidden = !!state.sphereSelection; // the CSV is per municipality
    if (!wasOpen) setTab('summary'); // a new selection starts at the summary
    syncLayout();
  }
  function closeModal() {
    const wasModal = !$('panel').hidden && isModalMode();
    $('panel').hidden = true;
    $('panel-body').hidden = true;
    if (wasModal) setPanelMode(false); // next selection opens docked again
    syncLayout();
    $('panel-empty').hidden = !!(state.selected || state.sphereSelection);
  }
  function setTab(name) {
    for (const b of document.querySelectorAll('#panel .tab')) {
      const on = b.dataset.tab === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      const pane = $(b.getAttribute('aria-controls'));
      if (pane) pane.hidden = !on;
    }
  }
  /** Closing the details ends the analysis (same as before): selection and circle are cleared. */
  function dismissDetails() {
    setModeUI('municipality');
    selectMunicipality(null, true);
  }
  function setupModal() {
    const tabs = [...document.querySelectorAll('#panel .tab')];
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        setTab(next.dataset.tab); next.focus(); e.preventDefault();
      });
    });
    setTab('summary');
    // backdrop click / Esc in the full view go back to the docked panel; Esc in the docked panel closes it
    $('panel').addEventListener('click', (e) => { if (e.target && e.target.dataset && e.target.dataset.close) setPanelMode(false); });
    $('p-expand').addEventListener('click', () => setPanelMode(!isModalMode()));
    setPanelMode(false);
    document.addEventListener('keydown', (e) => {
      if ($('panel').hidden) return;
      if (e.key === 'Escape') {
        if (e.target && e.target.closest && e.target.closest('input, select, .period__pop')) return;
        e.preventDefault();
        if (isModalMode()) setPanelMode(false); else dismissDetails();
        return;
      }
      if (e.key !== 'Tab' || !isModalMode()) return;
      // keep focus inside the dialog (full view only; the docked panel is part of the page)
      const f = [...$('panel-body').querySelectorAll('button, [href], select, input, [tabindex]:not([tabindex="-1"])')]
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === $('panel-body'))) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    });
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
    if (!state.selected) { closeModal(); return; }
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
    openModal();
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
      loadHorizons({ ibge: id }, seq);
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
      closeModal();
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

  function spherePill(id, extraText) {
    const btn = el('button', 'subarea-pill');
    btn.type = 'button';
    btn.append(el('span', 'subarea-pill__name', state.names.get(id) || id));
    // The municipality's own map value is its whole territory, not the circle: show only the share inside.
    if (extraText) btn.append(el('strong', 'subarea-pill__num', extraText));
    btn.onclick = () => { setModeUI('municipality'); selectMunicipality(id, true); };
    return btn;
  }

  async function renderSpherePanel(sphere) {
    const seq = ++state.panelSeq;
    openModal();
    const centerName = (sphere.centerId && state.names.get(sphere.centerId)) || CFG.ufName;
    const subBase = t('sphere.sub', { r: sphere.radiusKm, area: I.num(sphere.areaKm2), name: centerName });
    $('p-name').textContent = t('sphere.titleR', { r: sphere.radiusKm });
    $('p-sub').textContent = `${subBase} · ${t('sphere.inside')}`;
    ['k-count', 'k-z'].forEach((k) => { $(k).textContent = '…'; });

    const block = $('subareas-block'), list = $('subareas-list');
    block.hidden = false;
    $('subareas-title').textContent = t('block.sphereMunis');
    $('subareas-small').textContent = t('block.sphereMunisSmall');

    try {
      // Only 1 km cells whose centre lies inside the radius (API). No whole-municipality estimate.
      let exact = null;
      if (state.source.areaHistory && Number.isFinite(sphere.lon) && Number.isFinite(sphere.lat)) {
        try { exact = await state.source.areaHistory(sphere.lon, sphere.lat, sphere.radiusKm); } catch (e) { console.warn('area history:', e.message); }
        if (seq !== state.panelSeq) return;
      }
      clear(list);
      if (!exact || !exact.rows.length) {
        state.sphereRows = null;
        for (const id of sphere.ids) list.append(spherePill(id, null));
        showSphereUnavailable();
        return;
      }
      const rows = exact.rows;
      const munis = exact.municipalities.filter((m) => state.names.has(m.ibge));
      $('p-sub').textContent = `${subBase} · ${t('sphere.exact', { pct: fmt1(exact.pctInState) })}`;
      for (const m of munis) list.append(spherePill(m.ibge, t('sphere.pctMuni', { pct: fmt1(m.pctOfMunicipality) })));
      state.sphereRows = rows;

      const cur = rows.find((r) => r.year === state.year && r.month === state.month) || null;
      if (isFuture()) futureKpis(rows);
      else {
      $('k-period').textContent = period();
      $('k-count').textContent = fmtInt(cur ? cur.harmonized : null);
      const z = cur ? cur.anomalyZ : null;
      const kz = $('k-z');
      kz.textContent = fmtZ(z);
      kz.className = z === null ? '' : z >= 1 ? 'z-up' : z <= -1 ? 'z-down' : '';
      $('k-z-text').textContent = zText(z);
      }

      renderPattern(patternFromRows(rows));
      renderCalendar(rows);
      renderCompare(rows);
      // A free-drawn circle has no hindcast of its own: the range comes from its own history and says so.
      renderRangeBox({
        method: 'all', range: global.FireData.rangeFromRows(rows, state.year, state.month), analog: null,
        observed: cur ? cur.harmonized : null, hindcast: null,
      }, true);
      if (sphere.radiusKm >= 5) loadHorizons({ lon: sphere.lon, lat: sphere.lat, radiusKm: sphere.radiusKm }, seq);
      else renderHorizonsMessage('proj.unavailable');
      if (sphere.centerId) {
        loadContext(sphere.centerId, seq);
        $('ctx-year').textContent = `${state.year} · ${t('sphere.ctxCenter', { name: state.names.get(sphere.centerId) || sphere.centerId })}`;
      }
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

  /** Circle without the FIRMS history: say so instead of estimating from whole municipalities. */
  function showSphereUnavailable() {
    $('k-period').textContent = period();
    $('k-count').textContent = '–';
    $('k-z').textContent = '–'; $('k-z').className = '';
    $('k-z-text').textContent = '';
    $('season-text').textContent = t('sphere.needHistory');
    clear($('pattern')); clear($('compare')); renderCalendar(null);
    clear($('range-box')); $('range-box').append(el('p', 'muted', t('sphere.needHistory')));
    renderHorizonsMessage('proj.unavailable');
    clearDetail();
  }

  function currentRow() {
    const rows = state.rows.get(state.selected) || [];
    return rows.find((r) => r.year === state.year && r.month === state.month) || null;
  }
  /** KPI boxes for a future month: the historical band of that calendar month (P10–P90 of earlier years). */
  function futureKpis(rows) {
    const rg = rows ? global.FireData.rangeFromRows(rows, state.year, state.month) : null;
    $('k-period').textContent = `${period()} · ${t('period.tagProj')}`;
    $('k-count').textContent = rg ? `${fmtInt(rg.p10)}–${fmtInt(rg.p90)}` : '–';
    const kz = $('k-z');
    kz.textContent = rg ? fmtInt(rg.p50) : '–';
    kz.className = '';
    $('k-z-text').textContent = rg ? t('kpi.futureTypical', { n: rg.nYears }) : t('kpi.futureNone');
  }
  function updateKpis() {
    if (isFuture()) { futureKpis(state.rows.get(state.selected)); return; }
    const r = currentRow();
    $('k-period').textContent = period();
    $('k-count').textContent = fmtInt(r ? r.harmonized : null);
    const z = r ? r.anomalyZ : null;
    const kz = $('k-z');
    kz.textContent = fmtZ(z);
    kz.className = z === null ? '' : z >= 1 ? 'z-up' : z <= -1 ? 'z-down' : '';
    $('k-z-text').textContent = zText(z) + (r && r.partialDays ? ` · ${t('z.partial', { d: r.partialDays })}` : '') + (r && r.daysMissing ? ` · ${t('z.missing', { n: r.daysMissing })}` : '');
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
    state.calRows = rows || null;
    if (!rows) { renderCalView(); return; }
    // Same rule as the map: no hotspots in the month = white; otherwise the colour of the active metric
    // (anomaly scale for "anomaly", the municipality's own count scale for the other metrics).
    const seq = { type: 'sequential', min: 0, max: Math.max(1, ...rows.map((r) => (Number.isFinite(r.harmonized) ? r.harmonized : 0))) };
    const white = map.colorFor(0, seq);
    const cellColor = (r) => {
      if (!r || !Number.isFinite(r.harmonized)) return null;
      if (r.harmonized <= 0) return white;
      if (state.metric === 'anomaly') return r.anomalyZ !== null ? map.colorFor(r.anomalyZ, Z_SCALE) : null;
      return map.colorFor(r.harmonized, seq);
    };
    box.append(el('span', 'cal-h', ''));
    I.months().forEach((m) => box.append(el('span', 'cal-h', m[0])));
    const byKey = new Map(rows.map((r) => [`${r.year}-${r.month}`, r]));
    // Months after the last one the API returned have not happened yet (the API omits them).
    const lastKey = rows.length ? Math.max(...rows.map((r) => r.year * 100 + r.month)) : null;
    const frag = document.createDocumentFragment();
    for (let y = state.source.lastYear; y >= state.source.firstYear; y--) {
      frag.append(el('span', 'cal-y', String(y)));
      for (let m = 1; m <= 12; m++) {
        const r = byKey.get(`${y}-${m}`);
        const b = el('button', 'cal-cell');
        b.type = 'button';
        b.dataset.y = String(y); b.dataset.m = String(m);
        const bg = cellColor(r);
        if (bg) b.style.background = bg;
        if (r && r.daysMissing) b.classList.add('is-missing');
        const future = !r && lastKey !== null && y * 100 + m > lastKey;
        if (future) b.classList.add('is-future');
        if (r && (r.provisional || r.partial)) b.classList.add('is-provisional');
        const label = future
          ? t('cal.future', { m: monthName(m), y })
          : r
            ? t('cal.cell', { m: monthName(m), y, n: fmtInt(r.harmonized), z: fmtZ(r.anomalyZ) })
              + (r.provisional ? t('cal.provisional') : '') + (r.partial ? t('cal.partial') : '')
            : t('cal.empty', { m: monthName(m), y });
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
    state.calYear = state.year;
    renderCalView();
  }



  /* ---------- Projection ribbon (a highlight, not an alert): from this point on it is projection ---------- */
  let stateHorizons = null;
  async function renderRibbon(seq) {
    const rib = $('proj-ribbon'), txt = $('proj-ribbon-text');
    const e = edge();
    rib.hidden = false;
    txt.textContent = t('ribbon.base', { d: e ? fmtDay(e.date) : '–', m: `${monthName(state.month)} ${state.year}` });
    if (!state.source.horizons) return;
    try {
      if (!stateHorizons) stateHorizons = await state.source.horizons({ ibge: CFG.uf });
    } catch (err) { console.warn('horizons:', err.message); return; }
    if (seq !== state.reqSeq || !stateHorizons) return;
    const h = stateHorizons, hc = h.hindcast || {};
    const mo = h.months.find((x) => x.year === state.year && x.month === state.month);
    const parts = [t('ribbon.base', { d: fmtDay(h.asOf), m: `${monthName(state.month)} ${state.year}` })];
    // The model band only where the hindcast validated it (sums up to ~30 days ahead); further out, the historical pattern.
    const monthEnd = Date.UTC(state.year, state.month, 0) / 86400000;
    const ahead = monthEnd - Date.parse(`${h.asOf}T00:00:00Z`) / 86400000;
    if (mo && hc.month && hc.month.published && ahead <= 31) parts.push(t('ribbon.model', { p10: fmtInt(mo.p10), p90: fmtInt(mo.p90) }));
    else if (mo && mo.climatology) parts.push(t('ribbon.clim', { p10: fmtInt(mo.climatology.p10), p90: fmtInt(mo.climatology.p90) }));
    if (h.fortnight && hc.fortnight && hc.fortnight.published) parts.push(t('ribbon.fortnight', { p10: fmtInt(h.fortnight.p10), p90: fmtInt(h.fortnight.p90) }));
    txt.textContent = parts.join(' · ');
  }

  /* ---------- History tab: a real calendar (year → months → days) ---------- */
  const dailyCache = new Map();
  let calSeq = 0;
  const SENSOR_LABEL = { MODIS: 'MODIS', SNPP: 'S-NPP', NOAA20: 'NOAA-20', NOAA21: 'NOAA-21' };
  function calArea() {
    const s = state.sphereSelection;
    if (s && Number.isFinite(s.lon) && s.radiusKm >= 5) return { key: `c${s.lon.toFixed(3)},${s.lat.toFixed(3)},${s.radiusKm}`, area: { lon: s.lon, lat: s.lat, radiusKm: s.radiusKm } };
    if (state.selected) return { key: state.selected, area: { ibge: state.selected } };
    return null;
  }
  /** The years × months grid (#calendar, renderCalendar) is the month picker; below it, the days of the month. */
  function renderCalView() {
    const rows = state.calRows;
    if (!rows || !rows.length) { clear($('cal-month')); return; }
    renderMonthDetail(rows);
  }
  async function renderMonthDetail(rows) {
    const box = $('cal-month');
    const y = state.year, m = state.month;
    const a = calArea();
    clear(box);
    const r = rows.find((x) => x.year === y && x.month === m) || null;
    box.append(el('h4', 'cal-month__title', `${monthName(m)} ${y}`));
    // month summary from the monthly row (same numbers as the map and the KPIs)
    const base = rows.filter((x) => x.month === m && x.year >= 2002 && x.year <= 2024 && Number.isFinite(x.harmonized)).map((x) => x.harmonized);
    const typical = base.length ? base.reduce((s, v) => s + v, 0) / base.length : null;
    const sum = el('p', 'range-line');
    if (periodKind(y, m) === 'proj') {
      box.classList.add('is-proj');
      const rg = global.FireData.rangeFromRows(rows, y, m);
      sum.textContent = rg ? t('day.futureTypical', { p10: fmtInt(rg.p10), p50: fmtInt(rg.p50), p90: fmtInt(rg.p90), n: rg.nYears }) : t('kpi.futureNone');
      box.append(sum, el('p', 'cal-month__facts', t('day.futureNote')));
      return;
    }
    box.classList.remove('is-proj');
    sum.textContent = r
      ? t('day.summary', { n: fmtInt(r.harmonized), z: zText(r.anomalyZ), typ: typical === null ? '–' : fmtInt(typical) })
      : t('cal.empty', { m: monthName(m), y });
    box.append(sum);
    if (!a || !state.source.daily) return;
    const key = `${a.key}|${y}|${m}`;
    const seq = ++calSeq; // own token: a period change also bumps panelSeq while this request is in flight
    let days = dailyCache.get(key);
    if (!days) {
      const wait = el('p', 'muted', t('day.loading'));
      box.append(wait);
      try { days = await state.source.daily(a.area, y, m); } catch (e) { console.warn('daily:', e.message); days = null; }
      if (seq !== calSeq) return;
      wait.remove();
      if (!days) { box.append(el('p', 'muted', t('day.unavailable'))); return; }
      if (dailyCache.size > 200) dailyCache.clear();
      dailyCache.set(key, days);
    }
    if (!days.length) { box.append(el('p', 'muted', t('cal.future', { m: monthName(m), y }))); return; }
    const withFire = days.filter((d) => (d.harmonized || 0) > 0);
    const peak = withFire.slice().sort((p, q) => q.harmonized - p.harmonized)[0] || null;
    const sensors = [...new Set(days.map((d) => d.sensor).filter(Boolean))].map((s) => SENSOR_LABEL[s]);
    const facts = el('p', 'cal-month__facts');
    facts.textContent = [
      t('day.fire', { n: withFire.length, total: days.length }),
      peak ? t('day.peak', { d: Number(peak.date.slice(8, 10)), v: fmt1(peak.harmonized) }) : null,
      sensors.length ? t('day.sat', { s: sensors.join(', ') }) : null,
      days.some((d) => d.provisional) ? t('day.prov') : null,
    ].filter(Boolean).join(' · ');
    box.append(facts);

    const grid = el('div', 'cal-days');
    I.weekdays().forEach((w) => grid.append(el('span', 'cal-days__h', w)));
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    for (let i = 0; i < lead; i++) grid.append(el('span', 'cal-days__pad'));
    const max = Math.max(1, ...days.map((d) => d.harmonized || 0));
    const dseq = { type: 'sequential', min: 0, max };
    const info = el('p', 'cal-month__day muted', t('day.hint'));
    for (const d of days) {
      const b = el('button', 'cal-day');
      b.type = 'button';
      const dn = Number(d.date.slice(8, 10));
      b.append(el('span', 'cal-day__n', String(dn)));
      if (d.harmonized === null) b.classList.add('is-nodata');
      else {
        b.style.background = map.colorFor(d.harmonized, dseq);
        if (d.harmonized > 0) b.append(el('small', 'cal-day__v', fmt1(d.harmonized)));
        if (d.harmonized > max * 0.12) b.classList.add('is-dark'); // the red ramp darkens fast: light ink early
      }
      if (d.provisional) b.classList.add('is-provisional');
      const text = d.harmonized === null
        ? t('day.noSat', { d: dn, m: monthName(m), y })
        : t('day.title', { d: dn, m: monthName(m), y, v: fmt1(d.harmonized), c: I.num(d.cells), s: SENSOR_LABEL[d.sensor] || '–' }) + (d.provisional ? ` · ${t('day.prov')}` : '');
      b.title = text; b.setAttribute('aria-label', text);
      b.addEventListener('click', () => {
        for (const o of grid.querySelectorAll('.cal-day.is-picked')) o.classList.remove('is-picked');
        b.classList.add('is-picked');
        info.textContent = text;
        info.classList.remove('muted');
      });
      grid.append(b);
    }
    box.append(grid, info);
  }

  function renderCompare(rows) {
    const box = $('compare');
    clear(box);
    if (!rows) return;
    const years = [];
    for (let y = state.source.firstYear; y <= state.source.lastYear; y++) years.push(y);
    const sum = (y, k) => {
      const rs = rows.filter((r) => r.year === y && r[k] !== null && r[k] !== undefined);
      return rs.length ? rs.reduce((a, r) => a + r[k], 0) : null;
    };
    const css = getComputedStyle(document.documentElement);
    const series = [
      { k: 'modis', color: css.getPropertyValue('--muted').trim() || '#9e9e9e', label: t('cmp.modis') },
      { k: 'viirs', color: css.getPropertyValue('--accent-2').trim() || '#f26d6d', label: t('cmp.viirs') },
      { k: 'noaa20', color: css.getPropertyValue('--text').trim() || '#f5f5f5', label: t('cmp.noaa20'), dash: '3 3' },
      { k: 'harmonized', color: css.getPropertyValue('--accent').trim() || '#c62828', label: t('cmp.harm') },
    ].map((s) => ({ ...s, pts: years.map((y) => [y, sum(y, s.k)]) }))
      .filter((s) => s.k !== 'noaa20' || s.pts.some((p) => p[1] !== null && p[1] > 0));
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
      if (d) {
        const attrs = { d, fill: 'none', stroke: s.color, 'stroke-width': s.k === 'harmonized' ? 2.4 : 1.6, 'stroke-linejoin': 'round' };
        if (s.dash) attrs['stroke-dasharray'] = s.dash;
        root.append(svg('path', attrs));
      }
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
  // Colour says only whether the cell burned in the month being viewed: white = no fire this month (whatever happened
  // in other years), reds = fire this month by number of days.
  const DETAIL_CLASSES = [
    { key: 'detail.k0', color: '#ffffff', test: (v) => v <= 0 },
    { key: 'detail.k1', color: '#f26d6d', test: (v) => v > 0 && v <= 1.5 },
    { key: 'detail.k2', color: '#c62828', test: (v) => v > 1.5 && v <= 4 },
    { key: 'detail.k3', color: '#6d0a0a', test: (v) => v > 4 },
  ];
  function clearDetail() {
    state.detail = null;
    if (map) map.setPointLayer(null, 'detail');
    const b = $('detail-block');
    if (b) b.hidden = true;
    const pb = $('places-block');
    if (pb) pb.hidden = true;
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
    let d = null;
    try { d = await state.source.cells(area, state.year, state.month, res); } catch (e) { console.warn('cells:', e.message); }
    if (seq !== state.panelSeq) return;
    clear(box);
    if (!d) { map.setPointLayer(null, 'detail'); box.append(el('p', 'muted', t('detail.unavailable'))); return; }
    state.detail = { res: d.res, yearsObserved: d.yearsObserved, cells: d.cells };
    const classes = DETAIL_CLASSES.map((c) => ({ color: c.color, cells: [] }));
    let withFire = 0;
    for (const c of d.cells) {
      const i = DETAIL_CLASSES.findIndex((k) => k.test(c[2]));
      if (i >= 0) classes[i].cells.push(c);
      if (c[2] > 0) withFire++;
    }
    map.setPointLayer({
      cellKm: d.res / 1000, classes, hover: true, grid: true, alpha: 1,
      clip: area.kind === 'muni' ? { kind: 'feature', id: area.id } : { kind: 'sphere' },
    }, 'detail');
    renderPlacesBlock();

    if (!d.cells.length) { box.append(el('p', 'muted', t('detail.none'))); return; }
    box.append(el('p', 'range-line', t('detail.summary', {
      n: I.num(withFire), res: I.num(d.res / 1000), period: period(), m: I.num(d.cells.length),
      from: state.source.firstYear, to: state.source.lastYear,
    })));
    // "Cells add up to the area's value" only holds when the area values also come from the FIRMS database.
    if (Number.isFinite(d.total) && (state.source.dataKind === 'firms_db' || state.source.dataKind === 'firms_index')) box.append(el('p', 'range-line', t('detail.sum', { v: fmt1(d.total) })));
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
    const extra = $('tt-extra');
    clear(extra);
    extra.append(el('span', '', t('places.center')), el('b', '', `${fmtCoord(c[1])}, ${fmtCoord(c[0])}`));
    extra.hidden = false;
    const near = state.places && state.places.length ? nearestPlaces(c[0], c[1], 2) : [];
    $('tt-hint').textContent = near.length ? near.map(placeText).join(' · ') : '';
    $('tt-hint').hidden = !near.length;
    tip.hidden = false;
    const x = Math.min(h.x + 14, $('map').clientWidth - 280);
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, h.y - 38)}px)`;
  }


  /* ---------- IBGE localities: map reference (zoom), nearest locality to a fire cell ---------- */
  const PLACE_RANK = { vila: 1, povoado: 2, quilombola: 2, indigena: 2, lugarejo: 3, agrovila: 3, rural: 4, urbano: 4, outra: 5 };
  const toRad = Math.PI / 180;
  /** Great-circle distance in km (the straight line between the two points, not a road distance). */
  function kmBetween(lat1, lon1, lat2, lon2) {
    const dp = (lat2 - lat1) * toRad, dl = (lon2 - lon1) * toRad;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dl / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  }
  /** The n localities nearest to a point, from all of Goiás (a fire near a border can be closest to the neighbour's). */
  function nearestPlaces(lon, lat, n = 2) {
    const list = state.places || [];
    const best = [];
    for (const p of list) {
      const d = kmBetween(lat, lon, p.lat, p.lon);
      if (best.length < n || d < best[best.length - 1].d) {
        best.push({ p, d });
        best.sort((a, b) => a.d - b.d);
        if (best.length > n) best.pop();
      }
    }
    return best;
  }
  const fmtCoord = (v) => (Number.isFinite(v) ? I.num(v, 4) : '–');
  const placeText = (x) => t('places.near', { name: x.p.name, kind: t(`kind.${x.p.kind}`), muni: state.names.get(x.p.ibge) || x.p.ibge, km: fmt1(x.d) });
  async function loadPlaces() {
    if (!state.source.localities) return;
    let list = null;
    try { list = await state.source.localities(); } catch (e) { console.warn('localities:', e.message); }
    if (!list) { setTimeout(loadPlaces, 30000); return; } // the API downloads them in the background on first start
    state.places = list;
    // sedes are already the municipality labels: they count for "nearest" but are not drawn again
    map.setPlaces(list.filter((p) => p.kind !== 'sede').map((p) => ({ lon: p.lon, lat: p.lat, name: p.name, rank: PLACE_RANK[p.kind] || 5, id: p.id })));
    if (state.selected || state.sphereSelection) renderPlacesBlock();
  }
  function onPlaceHover(h) {
    const tip = $('tooltip');
    if (!h) return; // the municipality hover takes the tooltip back
    const p = (state.places || []).find((x) => x.id === h.place.id);
    if (!p) return;
    $('tt-name').textContent = p.name;
    $('tt-value').textContent = `${t(`kind.${p.kind}`)} · ${state.names.get(p.ibge) || p.ibge}`;
    const extra = $('tt-extra');
    clear(extra);
    extra.append(el('span', '', 'lat, lon'), el('b', '', `${fmtCoord(p.lat)}, ${fmtCoord(p.lon)}`));
    extra.hidden = false;
    $('tt-hint').textContent = t('places.source');
    $('tt-hint').hidden = false;
    tip.hidden = false;
    const x = Math.min(h.x + 14, $('map').clientWidth - 290);
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, h.y - 38)}px)`;
  }
  /** Área tab: fire cells of the month with their nearest localities; each opens the real detection days. */
  function renderPlacesBlock() {
    const block = $('places-block'), box = $('places-box');
    if (!block) return;
    const cells = state.detail && state.detail.cells ? state.detail.cells.filter((c) => c[2] > 0) : [];
    block.hidden = !(state.places && state.places.length);
    clear(box);
    if (block.hidden) return;
    if (!cells.length) { box.append(el('p', 'muted', t('places.noFire', { period: period() }))); return; }
    const top = cells.slice().sort((a, b) => b[2] - a[2]).slice(0, 12);
    box.append(el('p', 'muted', t('places.howto', { n: I.num(cells.length), shown: top.length })));
    const list = el('ul', 'places-list');
    for (const c of top) {
      const near = nearestPlaces(c[0], c[1], 2);
      const li = el('li', 'places-item');
      const head = el('button', 'places-item__head');
      head.type = 'button';
      head.append(el('strong', '', `${fmt1(c[2])} ${t('places.cellDays')}`), el('span', 'muted', `${fmtCoord(c[1])}, ${fmtCoord(c[0])}`));
      const nearEl = el('p', 'places-item__near', near.map(placeText).join(' · '));
      const days = el('div', 'places-item__days');
      head.setAttribute('aria-expanded', 'false');
      head.addEventListener('click', async () => {
        const open = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', open ? 'false' : 'true');
        clear(days);
        if (open) return;
        days.append(el('span', 'muted', t('day.loading')));
        let r = null;
        try { r = await state.source.cellDetections(c[0], c[1], state.detail.res, state.year, state.month); } catch (e) { console.warn('cell detections:', e.message); }
        clear(days);
        if (!r || !r.days.length) { days.append(el('span', 'muted', t('places.noDays'))); return; }
        for (const d of r.days) {
          const chip = el('span', d.provisional ? 'day-chip is-prov' : 'day-chip', `${d.date.slice(8, 10)}/${d.date.slice(5, 7)} · ${SENSOR_LABEL[d.sensor]}`);
          chip.title = d.provisional ? t('day.prov') : '';
          days.append(chip);
        }
      });
      li.append(head, nearEl, days);
      list.append(li);
    }
    box.append(list);
  }

  /* ---------- Projection with a validated uncertainty band (daily model, hindcast 2015–2025) ---------- */
  const horizonCache = new Map();
  const bandNum = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v >= 10 ? fmtInt(v) : fmt1(v));
  const shortDate = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(I.lang() === 'en' ? 'en-US' : 'pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  };
  function renderHorizonsMessage(key) {
    state.horizonsShown = null;
    clear($('horizons-box')); $('horizons-box').append(el('p', 'muted', t(key)));
    clear($('next-box')); $('next-box').append(el('p', 'muted', t(key)));
  }
  async function loadHorizons(area, seq) {
    if (!state.source.horizons) { renderHorizonsMessage('proj.unavailable'); return; }
    const key = area.ibge || `${area.lon.toFixed(3)},${area.lat.toFixed(3)},${area.radiusKm}`;
    if (horizonCache.has(key)) { renderHorizons(horizonCache.get(key)); return; }
    renderHorizonsMessage('proj.loading');
    let h = null;
    try { h = await state.source.horizons(area); } catch (e) { console.warn('horizons:', e.message); }
    if (seq !== state.panelSeq) return;
    if (!h) { renderHorizonsMessage('proj.unavailable'); return; }
    if (horizonCache.size > 60) horizonCache.clear();
    horizonCache.set(key, h);
    renderHorizons(h);
  }
  function skillBadge(sk) {
    if (!sk || sk.skillPct === null) return el('span', 'proj-badge', t('proj.skillNa'));
    return sk.published
      ? el('span', 'proj-badge proj-badge--ok', t('proj.skillOk', { s: fmt1(sk.skillPct), c: fmt1(sk.coveragePct), p: state.horizonsShown && state.horizonsShown.hindcast ? state.horizonsShown.hindcast.testPeriod : '' }))
      : el('span', 'proj-badge proj-badge--off', t('proj.skillOff'));
  }
  /** One horizon card: the model band only when the hindcast beat climatology; otherwise the climatology band. */
  function horizonCard(title, windowText, band, clim, sk) {
    const card = el('div', 'proj-card');
    card.append(el('h4', '', title));
    if (windowText) card.append(el('small', '', windowText));
    const show = sk && sk.published ? band : clim;
    card.append(el('strong', '', show ? t('proj.band', { p10: bandNum(show.p10), p90: bandNum(show.p90) }) : '–'));
    if (show) card.append(el('small', '', sk && sk.published ? t('proj.bandSmall', { p50: bandNum(show.p50) }) : t('proj.climSmall')));
    card.append(skillBadge(sk));
    return card;
  }
  function renderHorizons(h) {
    state.horizonsShown = h;
    const hc = h.hindcast || {};
    // Summary tab: next 15 days in one line.
    const next = $('next-box');
    clear(next);
    const f = h.fortnight;
    if (f && hc.fortnight && hc.fortnight.published) next.append(el('p', 'range-line', t('next.line', { p10: bandNum(f.p10), p50: bandNum(f.p50), p90: bandNum(f.p90) })));
    else if (f && f.climatology) next.append(el('p', 'range-line', t('next.clim', { p10: bandNum(f.climatology.p10), p90: bandNum(f.climatology.p90) })));
    else next.append(el('p', 'muted', t('proj.skillNa')));
    next.append(el('small', 'range-meta muted', `${t('proj.asOf', { d: shortDate(h.asOf) })} ${t('next.more')}`));

    // Projection tab.
    const box = $('horizons-box');
    clear(box);
    box.append(el('p', 'proj-note', t('proj.asOf', { d: shortDate(h.asOf) })));

    const daysBlock = el('section', 'block');
    daysBlock.append(el('h3', '', t('proj.days')));
    const d1 = hc.day1;
    // The daily chance is shown only when it beat the climatological frequency in the test years.
    if (!(d1 && d1.published)) {
      daysBlock.append(el('p', 'proj-note proj-note--warn', t('proj.day1Off')));
      box.append(daysBlock);
    }
    const days = el('div', 'proj-days');
    for (const d of h.daily) {
      const col = el('div', 'proj-day');
      const bar = el('i');
      bar.style.height = `${Math.max(2, Math.round(d.pAnyPct * 0.8))}%`;
      bar.style.opacity = String(0.35 + 0.65 * (d.pAnyPct / 100));
      col.title = t('proj.dayTitle', { d: shortDate(d.date), p: fmtInt(d.pAnyPct), p50: bandNum(d.p50), p90: bandNum(d.p90) });
      col.setAttribute('aria-label', col.title);
      col.append(bar, el('span', '', d.date.slice(8, 10)));
      days.append(col);
    }
    if (d1 && d1.published) {
      daysBlock.append(days);
      daysBlock.append(el('p', 'proj-note', t('proj.day1Ok', { s: fmt1(d1.skillPct) })));
      box.append(daysBlock);
    }

    const cards = el('div', 'proj-cards');
    if (h.fortnight) cards.append(horizonCard(t('proj.fortnight'), t('proj.window', { from: shortDate(h.fortnight.from), to: shortDate(h.fortnight.to) }), h.fortnight, h.fortnight.climatology, hc.fortnight));
    const m0 = h.months[0];
    if (m0) cards.append(horizonCard(`${t('proj.month')} · ${monthName(m0.month)} ${m0.year}`, m0.partial ? t('proj.inProgress') : '', m0, null, hc.month));
    if (h.semester) cards.append(horizonCard(t('proj.semester'), t('proj.window', { from: shortDate(h.semester.from), to: shortDate(h.semester.to) }), h.semester, h.semester.climatology, hc.semester));
    box.append(cards);

    if (hc.month && hc.month.published && h.months.length) {
      const sec = el('section', 'block');
      sec.append(el('h3', '', t('proj.monthsTitle')));
      const table = el('table', 'proj-months');
      const head = el('tr');
      ['proj.colMonth', 'proj.colBand', 'proj.colMedian', 'proj.colObserved'].forEach((k) => head.append(el('th', '', t(k))));
      table.append(head);
      for (const m of h.months) {
        const tr = el('tr');
        tr.append(el('td', '', `${monthName(m.month)} ${m.year}${m.partial ? ` (${t('proj.inProgress')})` : ''}`),
          el('td', 'num', t('proj.band', { p10: bandNum(m.p10), p90: bandNum(m.p90) })),
          el('td', 'num', bandNum(m.p50)),
          el('td', 'num', m.partial ? bandNum(m.observedSoFar) : '–'));
        table.append(tr);
      }
      sec.append(table);
      box.append(sec);
    }
    if (hc.calibrationPeriod) box.append(el('p', 'proj-note', t('proj.calib', { c: hc.calibrationPeriod, t: hc.testPeriod })));
    box.append(el('p', 'proj-note', t('proj.method')));
  }

  /* ---------- Expected range from history (P10–P90 of the same month in earlier years) ---------- */
  async function loadRange(id, seq) {
    clear($('range-box'));
    $('range-small').textContent = period();
    try {
      const p = state.source.projection ? await state.source.projection(id, state.year, state.month) : null;
      if (seq !== state.panelSeq) return;
      if (p && p.range) { renderRangeBox(p, false); return; }
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
    labelExpand();
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
      loadHorizons({ ibge: state.selected }, seq);
      loadContext(state.selected, seq);
      const cur = currentRow();
      loadDetail({ kind: 'muni', id: state.selected }, cur ? cur.harmonized : 0, seq);
    }
    if (state.horizonsShown) renderHorizons(state.horizonsShown);
    if (isFuture()) renderRibbon(state.reqSeq);
    if (state.roots.on && state.roots.data) drawRoots();
  }
  function setupLanguage() {
    $('lang').addEventListener('click', () => { I.setLang(I.lang() === 'pt' ? 'en' : 'pt'); applyLanguage(); });
    applyLanguage();
  }
  function setupTheme() {
    let theme = 'dark';
    try { theme = localStorage.getItem('cinder.theme') === 'light' ? 'light' : 'dark'; } catch (_) { /* storage blocked */ }
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
      try { localStorage.setItem('cinder.theme', theme); } catch (_) { /* ignore */ }
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
    map.on('place', onPlaceHover);

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

    $('p-close').addEventListener('click', dismissDetails);
    setupPanelResize();
    setupModal();
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
      const ready = state.source.dataKind === 'firms_db' || state.source.dataKind === 'firms_index';
      if (ready) await refreshMap(); else watchHistory();
      loadPlaces();

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

  /** While the API downloads the FIRMS history, show its progress and reload once it is ready. */
  function watchHistory() {
    const k = state.source.dataKind;
    if (state.source.kind === 'offline') { setStatus('status.apiOffline', null, true, () => location.reload()); return; }
    if (k !== 'loading' && k !== 'none') return;
    const h = state.source.historyLoad;
    setStatus(k === 'loading' ? 'status.historyLoading' : 'status.historyNone', { done: h ? h.done : 0, total: h ? h.total : 0 }, k === 'none');
    setTimeout(async () => {
      try {
        const src = await global.FireData.createSource(() => state.ids, (id) => map.areaKm2(id));
        if (src.dataKind === 'firms_db' || src.dataKind === 'firms_index') { location.reload(); return; }
        state.source = src;
        setBadge();
      } catch (_) { /* keep polling */ }
      watchHistory();
    }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
