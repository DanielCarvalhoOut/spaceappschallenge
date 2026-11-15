/*
 * Monitor Cinder map engine (original code, no dependencies).
 * Canvas 2D + Path2D choropleth for Goiás in the full context of Brazil.
 *
 * Palette profile: black/gray interface; map fills are one red ramp starting at white.
 *
 * Interactive & Performance Architecture:
 * - Full Brazil UF backdrop (dimmed/opaque) surrounding Goiás (100% vibrant).
 * - Smooth swooping camera flight in motion (Brazil -> Goiás -> Municipality / Circle Area).
 * - Dual Selection Modes:
 *   1. Municipality Mode: select individual municipality, dim others, display real
 *      municipality values across the region when Nº is active.
 *   2. 2D Circle / Area Mode: lightweight flat 2D circle (no 3D shaders/gradients or
 *      base-canvas redraws during drag) for lag-free regional selection.
 * - Real-time Lateral Scale & Proportion telemetry (`view` event) for the lateral scale ruler.
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const EARTH_R_KM = 6371.0088;

  /* ---------- Projection: spherical American polyconic (EPSG:5880 parameters) ---------- */
  function polyconic(lon0Deg) {
    const l0 = lon0Deg * DEG;
    return function project(lon, lat) {
      const lam = lon * DEG - l0;
      const phi = lat * DEG;
      if (Math.abs(phi) < 1e-10) return [EARTH_R_KM * lam, 0];
      const cot = 1 / Math.tan(phi);
      const E = lam * Math.sin(phi);
      return [EARTH_R_KM * cot * Math.sin(E), -EARTH_R_KM * (phi + cot * (1 - Math.cos(E)))];
    };
  }

  /* Inverse approximation for graticule bounds (world km -> [lon, lat]) */
  function inversePolyconic(lon0Deg) {
    const fwd = polyconic(lon0Deg);
    return function unproject(wx, wy) {
      let lat = -wy / (EARTH_R_KM * DEG);
      let lon = lon0Deg + wx / (EARTH_R_KM * DEG * Math.max(0.2, Math.cos(lat * DEG)));
      for (let i = 0; i < 3; i++) {
        const [px, py] = fwd(lon, lat);
        const dx = wx - px;
        const dy = wy - py;
        lat -= dy / (EARTH_R_KM * DEG);
        lon += dx / (EARTH_R_KM * DEG * Math.max(0.2, Math.cos(lat * DEG)));
      }
      return [lon, lat];
    };
  }

  /* ---------- Colour (OKLab) ---------- */
  function hexToRgb(hex) {
    const h = hex.replace('#', '').slice(0, 6);
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const fromLin = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  function rgbToOklab([r, g, b]) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }
  function oklabToRgb([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      fromLin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      fromLin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      fromLin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }
  function makeRamp(stops) {
    const labs = stops.map((s) => ({ t: s.t, lab: rgbToOklab(hexToRgb(s.hex)) }));
    const table = new Array(256);
    for (let n = 0; n < 256; n++) {
      const t = n / 255;
      let i = 0;
      while (i < labs.length - 2 && t > labs[i + 1].t) i++;
      const a = labs[i], b = labs[i + 1];
      const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
      const [r, g, bl] = oklabToRgb([0, 1, 2].map((k) => a.lab[k] + (b.lab[k] - a.lab[k]) * u));
      table[n] = `rgb(${r},${g},${bl})`;
    }
    return (t) => table[Math.round(Math.max(0, Math.min(1, t)) * 255)];
  }
  function relLuminance(color) {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(color);
    const [r, g, b] = m ? [m[1], m[2], m[3]].map(Number) : hexToRgb(color);
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  }
  const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

  /*
   * Choropleth ramps: one red scale starting at white, the same in both themes.
   * - sequential (hotspot count, log scale): white = no/few hotspots, deep red = most.
   * - "diverging" (anomaly z, -3..+3): white = well below the historical pattern,
   *   mid red = typical, deep red = well above it.
   */
  const REDS = makeRamp([
    { t: 0, hex: '#ffffff' }, { t: 0.25, hex: '#fcbba1' }, { t: 0.5, hex: '#fb6a4a' },
    { t: 0.75, hex: '#cb181d' }, { t: 1, hex: '#67000d' },
  ]);
  const RAMPS = {
    diverging: { dark: REDS, light: REDS },
    sequential: { dark: REDS, light: REDS },
  };

  /* ---------- Geometry ---------- */
  function ringArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return a / 2;
  }
  function ringCentroid(r) {
    let cx = 0, cy = 0, a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f; a += f;
    }
    return Math.abs(a) < 1e-9 ? r[0] : [cx / (3 * a), cy / (3 * a)];
  }

  function buildFeatures(fc, idProp, project, idPattern) {
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error('Invalid FeatureCollection');
    const regex = idPattern || /^\d{7}$/;
    const out = [];
    const edgeCounts = new Map();
    const edgeCoords = new Map();
    const qKey = (p) => `${Math.round(p[0] * 50)},${Math.round(p[1] * 50)}`;

    for (const f of fc.features) {
      const id = f && f.properties ? String(f.properties[idProp] ?? '') : '';
      const g = f && f.geometry;
      if (!regex.test(id) || !g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null;
      if (!Array.isArray(polys)) continue;
      const path = new Path2D();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let best = null, bestArea = 0, totalArea = 0;
      const samplePts = [];
      for (const poly of polys) {
        if (!Array.isArray(poly)) continue;
        poly.forEach((ring, ri) => {
          if (!Array.isArray(ring) || ring.length < 4) return;
          const pr = [];
          const step = Math.max(1, Math.floor(ring.length / 18));
          for (let ci = 0; ci < ring.length; ci++) {
            const c = ring[ci];
            const lon = Number(c[0]), lat = Number(c[1]);
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
            const p = project(lon, lat);
            pr.push(p);
            if (ri === 0 && ci % step === 0) samplePts.push(p);
            if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
          }
          if (pr.length < 3) return;
          path.moveTo(pr[0][0], pr[0][1]);
          for (let i = 1; i < pr.length; i++) path.lineTo(pr[i][0], pr[i][1]);
          path.closePath();

          for (let i = 0; i < pr.length; i++) {
            const a = pr[i], b = pr[(i + 1) % pr.length];
            const ka = qKey(a), kb = qKey(b);
            if (ka === kb) continue;
            const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            edgeCounts.set(k, (edgeCounts.get(k) || 0) + 1);
            if (!edgeCoords.has(k)) edgeCoords.set(k, [a, b]);
          }

          if (ri === 0) {
            const a = Math.abs(ringArea(pr));
            totalArea += a;
            if (a > bestArea) { bestArea = a; best = pr; }
          }
        });
      }
      if (!best) continue;
      const anchor = ringCentroid(best);
      samplePts.push(anchor);
      out.push({
        id,
        sigla: f.properties && f.properties.sigla ? String(f.properties.sigla) : '',
        path,
        bbox: [minX, minY, maxX, maxY],
        anchor,
        samplePts,
        areaKm2: totalArea,
        fill: '#3a3a3a',
        ink: '#f5f5f5',
        labelW: -1,
      });
    }

    const outerPath = new Path2D();
    const innerPath = new Path2D();
    for (const [k, count] of edgeCounts) {
      const [a, b] = edgeCoords.get(k);
      const target = count === 1 ? outerPath : innerPath;
      target.moveTo(a[0], a[1]);
      target.lineTo(b[0], b[1]);
    }

    return { features: out, outerPath, innerPath };
  }

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  function roundRectPath(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function formatShortVal(val, scaleType) {
    if (val === null || val === undefined || !Number.isFinite(val)) return '';
    if (scaleType === 'sequential') return String(Math.round(val));
    return (val >= 0 ? '+' : '') + val.toFixed(1) + 'σ';
  }

  /* ---------- Engine ---------- */
  function create(container, opts) {
    const options = Object.assign({ lon0: -54, theme: 'dark', idProp: 'codarea', ariaLabel: 'Map', reserved: null }, opts || {});
    const project = polyconic(options.lon0);
    const unproject = inversePolyconic(options.lon0);

    const base = document.createElement('canvas');
    const over = document.createElement('canvas');
    base.className = 'fh-canvas fh-canvas--base';
    over.className = 'fh-canvas fh-canvas--overlay';
    over.setAttribute('role', 'img');
    over.setAttribute('aria-label', options.ariaLabel);
    over.tabIndex = 0;
    container.append(base, over);
    const bctx = base.getContext('2d', { alpha: true });
    const octx = over.getContext('2d');
    const hit = document.createElement('canvas').getContext('2d');

    const st = {
      features: [], byArea: [], byId: new Map(), all: null, outerPath: null, innerPath: null,
      brazilStates: [], brazilOuterPath: null, brazilInnerPath: null, brazilWorld: null, brazilFit: null,
      names: new Map(), values: new Map(),
      scale: { type: 'diverging', min: -3, max: 3 }, theme: options.theme,
      w: 0, h: 0, dpr: 1, cam: { x: 0, y: 0, k: 1 }, fit: null, world: null, places: [],
      hover: null, selected: null, prevSelected: null,
      selectionMode: 'municipality', // 'municipality' | 'sphere'
      sphereRadiusKm: 85,
      sphere: null, // { x, y, rKm, ids: Set, centerId: string }
      spherePreview: null, // { x, y }
      sphereDrag: null, // { sx, sy, x0, y0, rKm, count, dragged }
      showNumbers: true,
      layers: { roots: null, detail: null }, // cell layers: { paths, colors, cellKm, clip, index }
      cellHover: null,
      focusMix: 0, focusFrom: 0, focusTo: 0, focusT0: 0, focusDur: 340,
      switchMix: 1, switchT0: 0, switchDur: 300,
      pulse: null, intro: null,
      listeners: { hover: [], select: [], sphere: [], view: [], cell: [] }, colors: null, noFire: new Set(),
      frame: 0, dirtyBase: false, dirtyOver: false,
      flight: null, wheel: null, inertia: null, drag: null, pinch: null, pointers: new Map(), hoverReq: null,
    };

    /* colours */
    function readColors() {
      const cs = getComputedStyle(container);
      const v = (n, d) => cs.getPropertyValue(n).trim() || d;
      const isLight = st.theme === 'light';
      st.colors = {
        border: v('--map-border', isLight ? 'rgba(0,0,0,.28)' : 'rgba(0,0,0,.35)'),
        outerStroke: isLight ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.6)',
        brazilFill: isLight ? '#d6d6d6' : '#4a4a4a',
        brazilBorder: isLight ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.12)',
        brazilOuter: isLight ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 255, 255, 0.22)',
        brazilText: isLight ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.36)',
        gridLine: isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.05)',
        gridText: isLight ? 'rgba(0, 0, 0, 0.38)' : 'rgba(255, 255, 255, 0.32)',
        nodata: v('--map-nodata', '#2a2a2a'),
        hover: v('--map-hover', '#ffffff'),
        hoverFill: v('--map-hover-fill', 'rgba(255,255,255,.14)'),
        select: v('--map-select', '#ffffff'),
        accent: v('--accent', '#c62828'),
        halo: v('--map-halo', 'rgba(0,0,0,.84)'),
        inkDark: v('--ink-on-light', '#111111'),
        inkLight: v('--ink-on-dark', '#ffffff'),
        font: v('--map-font', '600 11.5px system-ui, sans-serif'),
        fontStrong: v('--map-font-strong', '700 13px system-ui, sans-serif'),
        monoFont: '600 10px ui-monospace, "Cascadia Mono", Consolas, monospace',
      };
    }

    function colorFor(value, scaleOverride) {
      if (value === null || value === undefined || !Number.isFinite(value)) return st.colors ? st.colors.nodata : '#2a2a2a';
      const s = scaleOverride || st.scale;
      const ramp = RAMPS[s.type === 'sequential' ? 'sequential' : 'diverging'][st.theme === 'light' ? 'light' : 'dark'];
      const t = s.type === 'sequential'
        ? Math.log1p(Math.max(0, value)) / Math.log1p(Math.max(1, s.max))
        : (value - s.min) / (s.max - s.min || 1);
      return ramp(t);
    }

    function recolor() {
      const dl = relLuminance(st.colors.inkDark), ll = relLuminance(st.colors.inkLight);
      const floor = colorFor(st.scale.type === 'sequential' ? 0 : st.scale.min);
      for (const f of st.features) {
        const v = st.values.get(f.id);
        // No hotspots this month: always the start of the scale (white), whatever the anomaly value or "no data".
        f.fill = st.noFire.has(f.id) ? floor : colorFor(v);
        const L = relLuminance(f.fill);
        f.ink = contrast(L, dl) >= contrast(L, ll) ? st.colors.inkDark : st.colors.inkLight;
      }
      invalidate(true, true);
    }

    /* camera helpers */
    function fitTo(bbox, pad) {
      if (!bbox) return { x: 0, y: 0, k: 1 };
      const [x0, y0, x1, y1] = bbox;
      const k = Math.min((st.w * pad) / Math.max(1e-6, x1 - x0), (st.h * pad) / Math.max(1e-6, y1 - y0));
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k };
    }
    function minAllowedK() {
      if (st.brazilFit && st.fit) return Math.min(st.brazilFit.k * 0.75, st.fit.k * 0.22);
      return st.fit ? st.fit.k * 0.22 : 0.05;
    }
    function clampK(k) {
      const kMax = st.fit ? st.fit.k * 85 : 100;
      return Math.max(minAllowedK(), Math.min(kMax, k));
    }
    function screenToWorld(sx, sy) { const c = st.cam; return [(sx - st.w / 2) / c.k + c.x, (sy - st.h / 2) / c.k + c.y]; }
    function worldToScreen(wx, wy) { const c = st.cam; return [(wx - c.x) * c.k + st.w / 2, (wy - c.y) * c.k + st.h / 2]; }
    function applyTransform(ctx) {
      const { x, y, k } = st.cam, d = st.dpr;
      ctx.setTransform(d * k, 0, 0, d * k, d * (st.w / 2 - x * k), d * (st.h / 2 - y * k));
    }
    function viewBounds() {
      const [x0, y0] = screenToWorld(0, 0), [x1, y1] = screenToWorld(st.w, st.h);
      return [x0, y0, x1, y1];
    }
    const visible = (b, v) => !(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]);
    function stopMotion() { st.flight = null; st.wheel = null; st.inertia = null; }

    function emitView() {
      if (!st.w || !st.h || !st.cam.k) return;
      const kmPerPx = 1 / st.cam.k;
      const zoomRatio = st.fit ? st.cam.k / st.fit.k : 1;
      const spanKm = st.h * kmPerPx;
      const scaleDenom = Math.max(1000, Math.round(kmPerPx / 2.645833e-7));
      emit('view', {
        k: st.cam.k,
        fitK: st.fit ? st.fit.k : 1,
        zoomRatio,
        kmPerPx,
        pxPerKm: st.cam.k,
        spanKm,
        widthKm: st.w * kmPerPx,
        scaleDenom,
        heightPx: st.h,
      });
    }

    /* render loop */
    function invalidate(b, o) {
      if (b !== false) st.dirtyBase = true;
      if (o !== false) st.dirtyOver = true;
      if (!st.frame) st.frame = requestAnimationFrame(frame);
    }

    function stepFocusAnimations(now) {
      let active = false;
      if (st.focusMix !== st.focusTo) {
        const u = Math.min(1, Math.max(0, (now - st.focusT0) / st.focusDur));
        st.focusMix = st.focusFrom + (st.focusTo - st.focusFrom) * easeInOut(u);
        if (u >= 1) {
          st.focusMix = st.focusTo;
          if (st.focusTo === 0) st.prevSelected = null;
        } else {
          active = true;
        }
        st.dirtyBase = true;
        st.dirtyOver = true;
      }
      if (st.switchMix < 1) {
        const u = Math.min(1, Math.max(0, (now - st.switchT0) / st.switchDur));
        st.switchMix = easeOutCubic(u);
        if (u >= 1) {
          st.switchMix = 1;
          st.prevSelected = null;
        } else {
          active = true;
        }
        st.dirtyBase = true;
        st.dirtyOver = true;
      }
      if (st.intro) {
        const u = Math.min(1, Math.max(0, (now - st.intro.t0) / st.intro.dur));
        st.intro.progress = easeOutCubic(u);
        st.dirtyBase = true;
        if (u >= 1) st.intro = null;
        else active = true;
      }
      if (st.pulse) {
        const elapsed = now - st.pulse.t0;
        if (elapsed < 1000) {
          st.dirtyOver = true;
          active = true;
        } else {
          st.pulse = null;
          st.dirtyOver = true;
        }
      }
      return active;
    }

    function frame(now) {
      st.frame = 0;
      const hadMotion = !!(st.flight || st.wheel || st.inertia);
      let animating = false;
      if (st.flight) animating = stepFlight(now) || animating;
      if (st.wheel) animating = stepWheel() || animating;
      if (st.inertia) animating = stepInertia() || animating;
      if (stepFocusAnimations(now)) animating = true;

      const camMoving = animating || hadMotion || (st.drag && st.drag.moved) || !!st.pinch;
      if (camMoving) {
        st.dirtyBase = true;
        st.dirtyOver = true;
      }
      if (st.hoverReq && !(st.drag && st.drag.moved) && !st.sphereDrag) doHover();

      if (st.dirtyBase) {
        drawBase(true);
        st.dirtyBase = false;
        st.dirtyOver = true;
      }
      if (st.dirtyOver) {
        drawOverlay(now);
        st.dirtyOver = false;
      }
      if (camMoving) emitView();
      if (animating) st.frame = requestAnimationFrame(frame);
    }

    /* ---------- Tactical Graticule (Lat/Lon HUD Grid) ---------- */
    function drawGraticule(ctx, v) {
      if (!st.w || !st.h) return;
      const ratio = st.fit ? st.cam.k / st.fit.k : 1;
      const stepDeg = ratio > 4 ? 0.5 : ratio > 1.8 ? 1 : ratio > 0.7 ? 2 : 5;
      const [lon0, lat0] = unproject(v[0], v[3]);
      const [lon1, lat1] = unproject(v[2], v[1]);
      const minLon = Math.max(-80, Math.floor(Math.min(lon0, lon1) / stepDeg - 1) * stepDeg);
      const maxLon = Math.min(-30, Math.ceil(Math.max(lon0, lon1) / stepDeg + 1) * stepDeg);
      const minLat = Math.max(-38, Math.floor(Math.min(lat0, lat1) / stepDeg - 1) * stepDeg);
      const maxLat = Math.min(8, Math.ceil(Math.max(lat0, lat1) / stepDeg + 1) * stepDeg);

      ctx.save();
      applyTransform(ctx);
      ctx.strokeStyle = st.colors.gridLine;
      ctx.lineWidth = 1 / st.cam.k;
      ctx.beginPath();

      for (let lon = minLon; lon <= maxLon; lon += stepDeg) {
        const [x0, y0] = project(lon, minLat);
        const [x1, y1] = project(lon, maxLat);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      for (let lat = minLat; lat <= maxLat; lat += stepDeg) {
        const [x0, y0] = project(minLon, lat);
        const [x1, y1] = project(maxLon, lat);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();

      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      ctx.font = st.colors.monoFont;
      ctx.fillStyle = st.colors.gridText;
      const midLat = (minLat + maxLat) / 2;
      const midLon = (minLon + maxLon) / 2;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let lon = minLon; lon <= maxLon; lon += stepDeg) {
        const [wx] = project(lon, midLat);
        const [sx] = worldToScreen(wx, st.cam.y);
        if (sx > 68 && sx < st.w - 86) {
          ctx.fillText(`${Math.abs(lon).toFixed(stepDeg < 1 ? 1 : 0)}°W`, sx, 6);
        }
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let lat = minLat; lat <= maxLat; lat += stepDeg) {
        const [, wy] = project(midLon, lat);
        const [, sy] = worldToScreen(st.cam.x, wy);
        if (sy > 44 && sy < st.h - 44) {
          const hemi = lat <= 0 ? 'S' : 'N';
          ctx.fillText(`${Math.abs(lat).toFixed(stepDeg < 1 ? 1 : 0)}°${hemi}`, st.w - 84, sy);
        }
      }
      ctx.restore();
    }

    /* ---------- Brazil Context Backdrop (Rest of Brazil Dimmed/Opaque) ---------- */
    function drawBrazilBackdrop(ctx, v, fMix) {
      if (!st.brazilStates.length) return;
      const k = st.cam.k;
      const brAlpha = 0.24 * (1 - 0.42 * fMix);

      ctx.save();
      applyTransform(ctx);

      // 1. Fill all non-Goiás Brazilian UFs
      ctx.globalAlpha = brAlpha;
      ctx.fillStyle = st.colors.brazilFill;
      for (const uf of st.brazilStates) {
        if (uf.id === '52') continue;
        if (!visible(uf.bbox, v)) continue;
        ctx.fill(uf.path, 'evenodd');
      }

      // 2. Internal UF borders across Brazil
      if (st.brazilInnerPath) {
        ctx.globalAlpha = brAlpha * 1.45;
        ctx.strokeStyle = st.colors.brazilBorder;
        ctx.lineWidth = 1.05 / k;
        ctx.lineJoin = 'round';
        ctx.stroke(st.brazilInnerPath);
      }

      // 3. Outer Brazil silhouette border
      if (st.brazilOuterPath) {
        ctx.globalAlpha = brAlpha * 1.85;
        ctx.strokeStyle = st.colors.brazilOuter;
        ctx.lineWidth = 1.4 / k;
        ctx.lineJoin = 'round';
        ctx.stroke(st.brazilOuterPath);
      }

      // 4. UF Sigla labels on surrounding states
      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      ctx.font = '700 11px ui-monospace, "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = st.colors.brazilText;
      ctx.globalAlpha = Math.max(0.18, 0.72 * (1 - 0.5 * fMix));

      for (const uf of st.brazilStates) {
        if (uf.id === '52' || !uf.sigla) continue;
        if (!visible(uf.bbox, v)) continue;
        const [sx, sy] = worldToScreen(uf.anchor[0], uf.anchor[1]);
        if (sx < 24 || sy < 24 || sx > st.w - 24 || sy > st.h - 24) continue;
        const bw = (uf.bbox[2] - uf.bbox[0]) * k;
        if (bw < 22 && uf.sigla !== 'DF') continue;
        ctx.fillText(uf.sigla, sx, sy);
      }

      ctx.restore();
    }

    /* ---------- Drawing ---------- */
    function clearCtx(ctx, canvas) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function drawBase(withLabels) {
      const ctx = bctx;
      clearCtx(ctx, base);
      if (!st.features.length) return;

      const k = st.cam.k, v = viewBounds();
      const whole = st.fit && k <= st.fit.k * 1.6;
      const sel = st.selected && st.byId.get(st.selected);
      const prevSel = st.prevSelected && st.byId.get(st.prevSelected);
      const hov = st.hover && st.byId.get(st.hover);
      const hasSphere = !!(st.sphere && st.sphere.ids && st.sphere.ids.size);
      const fMix = st.focusMix;

      // 1. Tactical Lat/Lon HUD Graticule
      drawGraticule(ctx, v);

      // 2. Full Brazil Backdrop (Other 26 UFs dimmed/opaque around Goiás)
      drawBrazilBackdrop(ctx, v, fMix);

      applyTransform(ctx);

      // 3. Outer Goiás State Silhouette (fast stroke, no shadowBlur lag)
      if (st.outerPath) {
        ctx.strokeStyle = st.colors.outerStroke;
        ctx.lineWidth = (1.8 * (1 - 0.35 * fMix)) / k;
        ctx.lineJoin = 'round';
        ctx.stroke(st.outerPath);
      }

      // 4. Draw Goiás Municipalities with Spotlight Opacity Dimming
      const baseDimAlpha = 1 - 0.76 * fMix;
      for (const f of st.features) {
        if (!whole && !visible(f.bbox, v)) continue;
        if (!hasSphere && f === sel && fMix > 0.01) continue;

        let alpha = baseDimAlpha;
        if (hasSphere) {
          // Only the part inside the circle is the analysed area: the rest of a touched municipality stays dimmed
          // like any other (the circle fill below restores full colour inside the ring).
          if (f === hov && !st.sphere.ids.has(f.id)) alpha = Math.max(alpha, 0.68);
        } else if (f === prevSel && st.switchMix < 1) {
          alpha = baseDimAlpha + (1 - baseDimAlpha) * (1 - st.switchMix);
        } else if (f === hov && fMix > 0.01) {
          alpha = Math.max(alpha, 0.72);
        }

        ctx.globalAlpha = alpha;
        ctx.fillStyle = f.fill;
        ctx.fill(f.path, 'evenodd');
      }

      // 5. Internal & External Borders for Goiás municipalities
      ctx.globalAlpha = 1 - 0.55 * fMix;
      ctx.strokeStyle = st.colors.border;
      ctx.lineWidth = 0.85 / k;
      ctx.lineJoin = 'round';
      if (whole) {
        ctx.stroke(st.all);
      } else {
        for (const f of st.features) {
          if (visible(f.bbox, v)) ctx.stroke(f.path);
        }
      }

      // Inside the circle only: full colour and borders of the municipalities it covers (the analysed area)
      if (hasSphere) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(st.sphere.x, st.sphere.y, st.sphere.rKm, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = 1;
        for (const id of st.sphere.ids) {
          const mf = st.byId.get(id);
          if (!mf || !visible(mf.bbox, v)) continue;
          ctx.fillStyle = mf.fill;
          ctx.fill(mf.path, 'evenodd');
        }
        ctx.strokeStyle = st.colors.border;
        ctx.lineWidth = 0.85 / k;
        for (const id of st.sphere.ids) {
          const mf = st.byId.get(id);
          if (mf && visible(mf.bbox, v)) ctx.stroke(mf.path);
        }
        ctx.restore();
      }

      // 6. Selected Municipality fill (fast, no shadowBlur)
      if (!hasSphere && sel && fMix > 0.01) {
        const selAlpha = prevSel && st.switchMix < 1 ? baseDimAlpha + (1 - baseDimAlpha) * st.switchMix : 1;
        ctx.globalAlpha = selAlpha;
        ctx.fillStyle = sel.fill;
        ctx.fill(sel.path, 'evenodd');
      }

      ctx.globalAlpha = 1;

      // 6b. Cell layers: state-wide focos-raiz, then the detail of the selected area (clipped to it)
      for (const name of ['roots', 'detail']) {
        const L = st.layers[name];
        if (!L) continue;
        ctx.save();
        if (L.clip && L.clip.kind === 'feature') {
          const cf = st.byId.get(L.clip.id);
          if (cf) ctx.clip(cf.path, 'evenodd');
        } else if (L.clip && L.clip.kind === 'sphere' && st.sphere) {
          ctx.beginPath();
          ctx.arc(st.sphere.x, st.sphere.y, st.sphere.rKm, 0, Math.PI * 2);
          ctx.clip();
        }
        const grow = Math.max(0, 1.6 / k - L.cellKm);
        ctx.globalAlpha = L.alpha;
        ctx.lineJoin = 'miter';
        for (let i = 0; i < L.paths.length; i++) {
          ctx.fillStyle = L.colors[i];
          ctx.fill(L.paths[i]);
          if (grow > 0) { ctx.strokeStyle = L.colors[i]; ctx.lineWidth = grow; ctx.stroke(L.paths[i]); }
        }
        if (L.grid && k * L.cellKm >= 7) {   // cell outlines once cells are big enough to read
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = st.colors.border;
          ctx.lineWidth = 0.6 / k;
          for (const pth of L.paths) ctx.stroke(pth);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      // 7. Labels & Real Regional Numbers
      if (withLabels) drawLabels(ctx, v, fMix);

      // 8. Intro Reveal
      if (st.intro && st.intro.progress < 1) {
        const p = st.intro.progress;
        const cx = st.w * st.dpr * 0.5;
        const cy = st.h * st.dpr * 0.5;
        const maxR = Math.hypot(cx, cy) * 1.15;
        const curR = Math.max(10, maxR * p);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        const grad = ctx.createRadialGradient(cx, cy, curR * 0.55, cx, cy, curR);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(0.82, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, base.width, base.height);
        ctx.restore();
      }
    }

    function labelWidth(ctx, f, name) {
      if (f.labelW < 0) f.labelW = ctx.measureText(name).width;
      return f.labelW;
    }

    function drawLabels(ctx, v, fMix) {
      const k = st.cam.k, ratio = st.fit ? k / st.fit.k : 1;
      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const taken = [];

      if (typeof options.reserved === 'function') {
        try { for (const r of options.reserved() || []) taken.push([r.left, r.top, r.right, r.bottom]); } catch (_) { /* ignore */ }
      }

      const sel = !st.sphere && st.selected && st.byId.get(st.selected);
      const hasSphere = !!(st.sphere && st.sphere.ids && st.sphere.ids.size);
      const isSeq = st.scale && st.scale.type === 'sequential';

      if (sel) {
        const [sx, sy] = worldToScreen(sel.anchor[0], sel.anchor[1]);
        taken.push([sx - 105, sy - 18, sx + 105, sy + 18]);
      }

      if (ratio < 0.85 && !st.showNumbers) return;
      const neighborAlpha = 1 - 0.45 * fMix;

      for (const f of st.byArea) {
        if (f === sel || !visible(f.bbox, v)) continue;
        const name = st.names.get(f.id);
        if (!name) continue;
        const [sx, sy] = worldToScreen(f.anchor[0], f.anchor[1]);
        if (sx < 24 || sy < 20 || sx > st.w - 80 || sy > st.h - 20) continue;

        const polyScreenW = (f.bbox[2] - f.bbox[0]) * k;
        const inSphere = hasSphere && st.sphere.ids.has(f.id);
        const val = st.values.get(f.id);
        // With a circle, a municipality's value is its whole-territory number, not the circle's: hide it.
        const valStr = st.showNumbers && !hasSphere ? formatShortVal(val, isSeq ? 'sequential' : 'diverging') : '';

        ctx.font = st.colors.font;
        const tw = labelWidth(ctx, f, name);

        const showFullName = ratio >= 1.25 ? tw <= polyScreenW * 1.35 : (inSphere || polyScreenW >= 46);
        const showOnlyNum = !showFullName && st.showNumbers && valStr && (inSphere || polyScreenW >= 22);
        if (!showFullName && !showOnlyNum) continue;

        const boxW = showFullName ? Math.max(tw, valStr ? 42 : tw) + 8 : 34;
        const boxH = showFullName && valStr ? 26 : 16;
        const r = [sx - boxW / 2, sy - boxH / 2, sx + boxW / 2, sy + boxH / 2];
        if (taken.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
        taken.push(r);

        const alpha = f.id === st.hover || inSphere ? 0.98 : neighborAlpha;
        ctx.globalAlpha = alpha;
        // Halo always opposes the ink: light text gets a dark halo (also on dark-red fills in the light theme).
        const haloColor = f.ink === st.colors.inkLight ? 'rgba(0,0,0,.78)' : 'rgba(255,255,255,.82)';

        if (showFullName) {
          ctx.font = st.colors.font;
          ctx.lineWidth = 3;
          ctx.strokeStyle = haloColor;
          const nameY = valStr ? sy - 5 : sy;
          ctx.strokeText(name, sx, nameY);
          ctx.fillStyle = f.ink;
          ctx.fillText(name, sx, nameY);

          if (valStr) {
            ctx.font = '700 10.5px ui-monospace, "Cascadia Mono", Consolas, monospace';
            ctx.strokeText(valStr, sx, sy + 8);
            ctx.fillStyle = inSphere ? st.colors.select : f.ink;
            ctx.fillText(valStr, sx, sy + 8);
          }
        } else if (showOnlyNum) {
          ctx.font = '700 10px ui-monospace, "Cascadia Mono", Consolas, monospace';
          ctx.lineWidth = 2.8;
          ctx.strokeStyle = haloColor;
          ctx.strokeText(valStr, sx, sy);
          ctx.fillStyle = inSphere ? st.colors.select : f.ink;
          ctx.fillText(valStr, sx, sy);
        }
      }
      ctx.globalAlpha = 1;
      drawPlaces(ctx, ratio, taken);
    }

    /**
     * IBGE localities (povoados, vilas, comunidades): reference points that appear only when zoomed in.
     * ratio = zoom relative to the whole-state fit. Ranks: 1 vila, 2 povoado/quilombola/indígena, 3 lugarejo/agrovila,
     * 4 núcleos, 5 other. Labels never cover a municipality label or another place label.
     */
    function drawPlaces(ctx, ratio, taken) {
      if (!st.places.length || ratio < 3) return;
      const maxRank = ratio >= 7 ? 5 : ratio >= 4.5 ? 4 : 3;
      const showText = ratio >= 3.6;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '600 10.5px system-ui, -apple-system, "Segoe UI", sans-serif';
      for (const p of st.places) {
        if (p.rank > maxRank) continue;
        const [sx, sy] = worldToScreen(p.x, p.y);
        if (sx < 4 || sy < 4 || sx > st.w - 4 || sy > st.h - 4) continue;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(sx, sy, p.rank <= 2 ? 3.2 : 2.4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.stroke();
        if (!showText) continue;
        if (p.w < 0) p.w = ctx.measureText(p.name).width;
        const r = [sx + 5, sy - 7, sx + 7 + p.w, sy + 7];
        if (taken.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
        taken.push(r);
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,.8)';
        ctx.strokeText(p.name, sx + 6, sy);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(p.name, sx + 6, sy);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
    }

    /** places = [{ lon, lat, name, rank }] (or null to clear). Projected once. */
    function setPlaces(places) {
      st.places = Array.isArray(places)
        ? places.filter((p) => p && Number.isFinite(p.lon) && Number.isFinite(p.lat) && typeof p.name === 'string')
          .map((p) => { const [x, y] = project(p.lon, p.lat); return { x, y, name: p.name.slice(0, 80), rank: Number(p.rank) || 5, w: -1, ref: p }; })
          .sort((a, b) => a.rank - b.rank)
        : [];
      invalidate(true, false);
    }

    /* ---------- Lightweight 2D Circle Overlay (No 3D dome, no per-frame gradients/clips) ---------- */
    function drawCircleOverlay(ctx) {
      const activeCircle = st.sphereDrag
        ? { x: st.sphereDrag.x0, y: st.sphereDrag.y0, rKm: st.sphereDrag.rKm, count: st.sphereDrag.count, preview: false }
        : st.sphere
          ? { x: st.sphere.x, y: st.sphere.y, rKm: st.sphere.rKm, count: st.sphere.ids.size, preview: false }
          : st.selectionMode === 'sphere' && st.spherePreview
            ? { x: st.spherePreview.x, y: st.spherePreview.y, rKm: st.sphereRadiusKm, count: null, preview: true }
            : null;

      if (!activeCircle) return;
      const [cx, cy] = worldToScreen(activeCircle.x, activeCircle.y);
      const rPx = Math.max(6, activeCircle.rKm * st.cam.k);
      const isPreview = activeCircle.preview;

      ctx.save();
      ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);

      // 1. Flat 2D Circle Fill & Border
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.fillStyle = isPreview ? 'rgba(198, 40, 40, 0.10)' : 'rgba(198, 40, 40, 0.16)';
      ctx.fill();
      ctx.strokeStyle = isPreview ? 'rgba(198, 40, 40, 0.72)' : st.colors.select;
      ctx.lineWidth = isPreview ? 1.5 : 2;
      if (isPreview) ctx.setLineDash([6, 4]);
      ctx.stroke();
      if (isPreview) ctx.setLineDash([]);

      // 2. Center point + 2D radius line
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fillStyle = st.colors.accent;
      ctx.fill();

      if (rPx > 28) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + rPx, cy);
        ctx.strokeStyle = st.colors.select;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const label = activeCircle.count !== null
          ? `R ${Math.round(activeCircle.rKm)} km · ${activeCircle.count} mun.`
          : `R ${Math.round(activeCircle.rKm)} km`;
        ctx.font = '700 11px ui-monospace, "Cascadia Mono", Consolas, monospace';
        const tw = ctx.measureText(label).width;
        const pw = tw + 14, ph = 20;
        const px = Math.min(Math.max(8, cx - pw / 2), st.w - pw - 8);
        const py = Math.max(8, cy - rPx - ph - 6);

        roundRectPath(ctx, px, py, pw, ph, 6);
        ctx.fillStyle = st.theme === 'light' ? 'rgba(255, 255, 255, 0.94)' : 'rgba(20, 20, 20, 0.94)';
        ctx.fill();
        ctx.strokeStyle = st.colors.select;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.fillStyle = st.theme === 'light' ? st.colors.inkDark : st.colors.inkLight;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, px + pw / 2, py + ph / 2 + 0.5);
      }

      ctx.restore();
    }

    function drawOverlay(now = performance.now()) {
      const ctx = octx;
      const hov = st.hover && st.byId.get(st.hover);
      const sel = !st.sphere && st.selected && st.byId.get(st.selected);
      clearCtx(ctx, over);

      const k = st.cam.k;
      applyTransform(ctx);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // 1. Hover highlight on municipality
      if (hov && hov !== sel) {
        ctx.fillStyle = st.colors.hoverFill;
        ctx.fill(hov.path, 'evenodd');
        ctx.strokeStyle = st.colors.hover;
        ctx.lineWidth = 2 / k;
        ctx.stroke(hov.path);
      }

      // 2. Selected municipality crisp double-border (no shadowBlur lag) + radar pulse + HUD pill
      if (sel) {
        ctx.strokeStyle = st.colors.accent;
        ctx.lineWidth = 4.2 / k;
        ctx.stroke(sel.path);

        ctx.strokeStyle = st.colors.select;
        ctx.lineWidth = 2 / k;
        ctx.stroke(sel.path);

        if (st.pulse && st.pulse.id === sel.id) {
          const u = Math.min(1, Math.max(0, (now - st.pulse.t0) / 1000));
          const easeU = easeOutCubic(u);
          const [sx, sy] = worldToScreen(sel.anchor[0], sel.anchor[1]);
          const maxRad = Math.max(40, Math.min(130, Math.hypot(sel.bbox[2] - sel.bbox[0], sel.bbox[3] - sel.bbox[1]) * k * 0.65));
          const rad = 8 + maxRad * easeU;

          ctx.save();
          ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
          ctx.beginPath();
          ctx.arc(sx, sy, rad, 0, Math.PI * 2);
          ctx.strokeStyle = st.colors.select;
          ctx.globalAlpha = (1 - u) * 0.75;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }

        const name = st.names.get(sel.id);
        if (name) {
          const isSeq = st.scale && st.scale.type === 'sequential';
          const realVal = st.values.get(sel.id);
          const valStr = st.showNumbers ? formatShortVal(realVal, isSeq ? 'sequential' : 'diverging') : '';
          const pillLabel = valStr ? `${name} · ${valStr}` : name;

          const [sx, sy] = worldToScreen(sel.anchor[0], sel.anchor[1]);
          ctx.save();
          ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
          ctx.font = st.colors.fontStrong;
          const tw = ctx.measureText(pillLabel).width;
          const pillW = tw + 26;
          const pillH = 26;
          const px = Math.min(Math.max(8, sx - pillW / 2), st.w - pillW - 8);
          const py = Math.min(Math.max(8, sy - pillH / 2), st.h - pillH - 8);

          roundRectPath(ctx, px, py, pillW, pillH, 13);
          ctx.fillStyle = st.theme === 'light' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(20, 20, 20, 0.95)';
          ctx.fill();

          ctx.lineWidth = 1.4;
          ctx.strokeStyle = st.colors.select;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(px + 11, py + pillH / 2, 3.6, 0, Math.PI * 2);
          ctx.fillStyle = st.colors.accent;
          ctx.fill();

          ctx.fillStyle = st.theme === 'light' ? st.colors.inkDark : st.colors.inkLight;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pillLabel, px + 6 + pillW / 2, py + pillH / 2 + 0.5);
          ctx.restore();
        }
      }

      // 3. Draw 2D Circle / Area overlay
      drawCircleOverlay(ctx);
    }

    /* ---------- Motion Steps ---------- */
    function startFocusTransition(hasSelection, switchedTarget) {
      const now = performance.now();
      st.focusFrom = st.focusMix;
      st.focusTo = hasSelection ? 1 : 0;
      st.focusT0 = now;
      st.focusDur = hasSelection ? 340 : 280;

      if (switchedTarget) {
        st.switchMix = 0;
        st.switchT0 = now;
      } else {
        st.switchMix = 1;
      }
    }

    function flyTo(target, ms) {
      stopMotion();
      const to = { x: target.x, y: target.y, k: clampK(target.k) };
      if (ms === 0 || !st.w || !st.cam.k) {
        st.cam = to;
        invalidate(true, true);
        emitView();
        return;
      }
      const from = { x: st.cam.x, y: st.cam.y, k: st.cam.k };
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distPx = Math.hypot(dx, dy) * Math.min(from.k, to.k);
      const distNorm = distPx / Math.max(1, Math.min(st.w, st.h));
      const zoomDiff = Math.abs(Math.log(to.k / from.k));

      if (distPx < 1.5 && zoomDiff < 0.005) {
        st.cam = to;
        invalidate(true, true);
        emitView();
        return;
      }

      // Swooping flight altitude arc (hyperbolic zoom-pan trajectory)
      const arc = distNorm > 0.08 ? Math.min(1.1, Math.max(0.2, distNorm * 0.8)) : 0.1 * Math.min(1, zoomDiff);
      const dur = ms || Math.round(Math.max(580, Math.min(1050, 640 + distNorm * 280 + zoomDiff * 120)));

      st.flight = { from, to, arc, t0: performance.now(), dur };
      invalidate(true, true);
    }

    function stepFlight(now) {
      const f = st.flight;
      if (!f) return false;
      const rawT = Math.min(1, Math.max(0, (now - f.t0) / f.dur));
      if (rawT >= 1) {
        st.cam = Object.assign({}, f.to);
        st.flight = null;
        return false;
      }
      const u = easeInOut(rawT);
      const logK = Math.log(f.from.k) + (Math.log(f.to.k) - Math.log(f.from.k)) * u;
      const k = clampK(Math.exp(logK) / (1 + f.arc * Math.sin(Math.PI * u)));
      st.cam = {
        x: f.from.x + (f.to.x - f.from.x) * u,
        y: f.from.y + (f.to.y - f.from.y) * u,
        k,
      };
      return true;
    }

    function stepWheel() {
      const w = st.wheel;
      const lk = Math.log(st.cam.k), lt = Math.log(w.tk);
      const done = Math.abs(lt - lk) < 0.002;
      const k = done ? w.tk : Math.exp(lk + (lt - lk) * 0.34);
      st.cam = { x: w.wx - (w.sx - st.w / 2) / k, y: w.wy - (w.sy - st.h / 2) / k, k };
      if (done) { st.wheel = null; return false; }
      return true;
    }

    function stepInertia() {
      const m = st.inertia;
      st.cam = { x: st.cam.x - m.vx / st.cam.k, y: st.cam.y - m.vy / st.cam.k, k: st.cam.k };
      m.vx *= 0.88; m.vy *= 0.88;
      if (Math.hypot(m.vx, m.vy) < 0.35) { st.inertia = null; return false; }
      return true;
    }

    /* ---------- Fast Picking & 2D Circle Intersection ---------- */
    function pick(sx, sy) {
      const [wx, wy] = screenToWorld(sx, sy);
      for (const f of st.features) {
        const b = f.bbox;
        if (wx < b[0] || wx > b[2] || wy < b[1] || wy > b[3]) continue;
        if (hit.isPointInPath(f.path, wx, wy, 'evenodd')) return f.id;
      }
      return null;
    }

    function computeSphereIds(cx, cy, rKm) {
      const ids = new Set();
      const r2 = rKm * rKm;
      let closestId = null, closestD2 = Infinity;

      for (const f of st.features) {
        const [x0, y0, x1, y1] = f.bbox;
        const nx = Math.max(x0, Math.min(cx, x1));
        const ny = Math.max(y0, Math.min(cy, y1));
        if ((nx - cx) * (nx - cx) + (ny - cy) * (ny - cy) > r2) continue;

        const dAnchor2 = (f.anchor[0] - cx) * (f.anchor[0] - cx) + (f.anchor[1] - cy) * (f.anchor[1] - cy);
        if (dAnchor2 < closestD2) { closestD2 = dAnchor2; closestId = f.id; }

        if (dAnchor2 <= r2) {
          ids.add(f.id);
          continue;
        }
        const pts = f.samplePts;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if ((p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy) <= r2) {
            ids.add(f.id);
            break;
          }
        }
      }
      if (!ids.size && closestId && closestD2 <= (rKm * 1.65) ** 2) {
        ids.add(closestId);
      }
      return ids;
    }

    function applySphereAt(wx, wy, rKm, shouldFly, shouldEmit) {
      const radius = Math.max(5, Math.min(260, Math.round(rKm)));
      st.sphereRadiusKm = radius;
      const ids = computeSphereIds(wx, wy, radius);
      let centerId = null, bestD = Infinity;
      for (const id of ids) {
        const f = st.byId.get(id);
        if (!f) continue;
        const d = Math.hypot(f.anchor[0] - wx, f.anchor[1] - wy);
        if (d < bestD) { bestD = d; centerId = id; }
      }
      st.selected = null;
      st.sphere = { x: wx, y: wy, rKm: radius, ids, centerId };
      startFocusTransition(ids.size > 0, false);

      if (shouldFly && st.fit) {
        const bbox = [wx - radius * 1.35, wy - radius * 1.35, wx + radius * 1.35, wy + radius * 1.35];
        const t = fitTo(bbox, 0.76);
        t.k = Math.min(Math.max(t.k, st.fit.k * 0.9), st.fit.k * 6.5);
        flyTo(t);
      }
      invalidate(true, true);
      if (shouldEmit !== false) {
        const [lon, lat] = unproject(wx, wy);
        emit('sphere', {
          x: wx,
          y: wy,
          lon: Math.round(lon * 1e5) / 1e5,
          lat: Math.round(lat * 1e5) / 1e5,
          radiusKm: radius,
          areaKm2: Math.round(Math.PI * radius * radius),
          shares: sphereShares(),
          ids: [...ids],
          centerId,
        });
      }
    }

    function emit(type, payload) { for (const fn of st.listeners[type] || []) { try { fn(payload); } catch (e) { console.error(e); } } }
    function localXY(ev) { const r = over.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }

    function doHover() {
      const { sx, sy } = st.hoverReq;
      st.hoverReq = null;

      if (st.selectionMode === 'sphere') {
        const [wx, wy] = screenToWorld(sx, sy);
        st.spherePreview = { x: wx, y: wy };
        st.dirtyOver = true;
      } else if (st.spherePreview) {
        st.spherePreview = null;
        st.dirtyOver = true;
      }

      const id = pick(sx, sy);
      if (id !== st.hover) {
        st.hover = id;
        over.style.cursor = st.selectionMode === 'sphere' ? 'crosshair' : id ? 'pointer' : 'grab';
        st.dirtyOver = true;
      }
      emit('hover', id ? { id, x: sx, y: sy } : null);
      // IBGE locality under the cursor (only where the places are drawn)
      const ratio = st.fit ? st.cam.k / st.fit.k : 0;
      if (st.places.length && ratio >= 3) {
        const maxRank = ratio >= 7 ? 5 : ratio >= 4.5 ? 4 : 3;
        let best = null, bd = 49; // 7 px
        for (const p of st.places) {
          if (p.rank > maxRank) continue;
          const [px, py] = worldToScreen(p.x, p.y);
          const d = (px - sx) ** 2 + (py - sy) ** 2;
          if (d < bd) { bd = d; best = p; }
        }
        if (best !== st.placeHover) { st.placeHover = best; }
        emit('place', best ? { place: best.ref, x: sx, y: sy } : null);
      } else if (st.placeHover) { st.placeHover = null; emit('place', null); }
      if (st.layers.detail && st.layers.detail.index) {
        const [wx, wy] = screenToWorld(sx, sy);
        const c = cellAtWorld(wx, wy);
        st.cellHover = c;
        emit('cell', c ? { cell: c.cell, x: sx, y: sy } : null);
      }
    }

    function clearHover() {
      st.hoverReq = null;
      if (st.hover || st.spherePreview) {
        st.hover = null;
        st.spherePreview = null;
        invalidate(false, true);
      }
      emit('hover', null);
      if (st.cellHover) { st.cellHover = null; emit('cell', null); }
    }

    /* ---------- Input ---------- */
    function onPointerDown(ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      over.setPointerCapture(ev.pointerId);
      const [sx, sy] = localXY(ev);
      st.pointers.set(ev.pointerId, { sx, sy });
      stopMotion();

      if (st.pointers.size === 2) {
        const [a, b] = [...st.pointers.values()];
        const mid = [(a.sx + b.sx) / 2, (a.sy + b.sy) / 2];
        st.pinch = { dist: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, world: screenToWorld(mid[0], mid[1]), k: st.cam.k };
        st.drag = null;
        st.sphereDrag = null;
        clearHover();
      } else if (st.pointers.size === 1) {
        if (st.selectionMode === 'sphere') {
          const [wx0, wy0] = screenToWorld(sx, sy);
          const count = computeSphereIds(wx0, wy0, st.sphereRadiusKm).size;
          st.sphereDrag = { sx, sy, x0: wx0, y0: wy0, rKm: st.sphereRadiusKm, count, dragged: false };
          st.drag = null;
          invalidate(false, true);
        } else {
          st.drag = { sx, sy, cam: Object.assign({}, st.cam), moved: false, lx: sx, ly: sy, lt: performance.now(), vx: 0, vy: 0 };
        }
      }
    }

    function onPointerMove(ev) {
      const [sx, sy] = localXY(ev);
      if (st.pointers.has(ev.pointerId)) st.pointers.set(ev.pointerId, { sx, sy });
      if (st.pinch && st.pointers.size >= 2) {
        const [a, b] = [...st.pointers.values()];
        const mid = [(a.sx + b.sx) / 2, (a.sy + b.sy) / 2];
        const k = clampK(st.pinch.k * (Math.hypot(a.sx - b.sx, a.sy - b.sy) / st.pinch.dist));
        st.cam = { x: st.pinch.world[0] - (mid[0] - st.w / 2) / k, y: st.pinch.world[1] - (mid[1] - st.h / 2) / k, k };
        invalidate(true, true);
        return;
      }
      if (st.sphereDrag) {
        const dx = sx - st.sphereDrag.sx, dy = sy - st.sphereDrag.sy;
        if (Math.hypot(dx, dy) > 6) {
          st.sphereDrag.dragged = true;
          const [wx, wy] = screenToWorld(sx, sy);
          const distKm = Math.hypot(wx - st.sphereDrag.x0, wy - st.sphereDrag.y0);
          const nextR = Math.max(5, Math.min(260, Math.round(distKm)));
          if (nextR !== st.sphereDrag.rKm) {
            st.sphereDrag.rKm = nextR;
            st.sphereDrag.count = computeSphereIds(st.sphereDrag.x0, st.sphereDrag.y0, nextR).size;
          }
          // Only redraw the lightweight 2D overlay canvas during radius drag (zero lag)
          invalidate(false, true);
        }
        return;
      }
      const d = st.drag;
      if (d) {
        const dx = sx - d.sx, dy = sy - d.sy;
        if (!d.moved && Math.hypot(dx, dy) > 4) { d.moved = true; over.style.cursor = 'grabbing'; clearHover(); }
        if (d.moved) {
          const now = performance.now(), dt = Math.max(1, now - d.lt);
          d.vx = 0.8 * d.vx + 0.2 * ((sx - d.lx) / dt) * 16;
          d.vy = 0.8 * d.vy + 0.2 * ((sy - d.ly) / dt) * 16;
          d.lx = sx; d.ly = sy; d.lt = now;
          st.cam = { x: d.cam.x - dx / d.cam.k, y: d.cam.y - dy / d.cam.k, k: d.cam.k };
          invalidate(true, true);
          return;
        }
      }
      if (ev.pointerType !== 'touch') { st.hoverReq = { sx, sy }; invalidate(false, false); }
    }

    function onPointerUp(ev) {
      st.pointers.delete(ev.pointerId);
      if (st.pinch) { if (st.pointers.size < 2) { st.pinch = null; invalidate(true, true); } return; }

      if (st.sphereDrag) {
        const sd = st.sphereDrag;
        st.sphereDrag = null;
        applySphereAt(sd.x0, sd.y0, sd.dragged ? sd.rKm : st.sphereRadiusKm, true, true);
        return;
      }

      const d = st.drag;
      st.drag = null;
      if (!d) return;
      if (!d.moved) {
        const [sx, sy] = localXY(ev);
        const picked = pick(sx, sy);
        if (picked && picked === st.selected) {
          select(null, { fly: true, emit: true });
        } else if (picked) {
          select(picked, { fly: true, emit: true });
        } else if (st.selected || st.sphere) {
          select(null, { fly: true, emit: true });
        } else if (st.fit && Math.abs(st.cam.k - st.fit.k) > st.fit.k * 0.15) {
          reset();
        }
      } else {
        const idle = performance.now() - d.lt;
        if (idle < 80 && Math.hypot(d.vx, d.vy) > 1.5) st.inertia = { vx: d.vx, vy: d.vy };
        invalidate(true, true);
      }
      over.style.cursor = st.selectionMode === 'sphere' ? 'crosshair' : st.hover ? 'pointer' : 'grab';
    }

    function onLeave() { if (!st.drag && !st.sphereDrag) clearHover(); }

    function onWheel(ev) {
      ev.preventDefault();
      st.flight = null; st.inertia = null;
      const [sx, sy] = localXY(ev);
      let dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? st.h : 1);
      dy = Math.max(-300, Math.min(300, dy));
      const from = st.wheel ? st.wheel.tk : st.cam.k;
      const [wx, wy] = screenToWorld(sx, sy);
      st.wheel = { tk: clampK(from * Math.exp(-dy * 0.0025)), sx, sy, wx, wy };
      clearHover();
      invalidate(true, true);
    }

    function onKey(ev) {
      const pan = (dx, dy) => flyTo({ x: st.cam.x + dx / st.cam.k, y: st.cam.y + dy / st.cam.k, k: st.cam.k }, 240);
      switch (ev.key) {
        case 'Escape': select(null, { emit: true, fly: true }); break;
        case '+': case '=': zoomBy(1.6); break;
        case '-': zoomBy(1 / 1.6); break;
        case '0': reset(); break;
        case 'ArrowLeft': pan(-80, 0); break;
        case 'ArrowRight': pan(80, 0); break;
        case 'ArrowUp': pan(0, -80); break;
        case 'ArrowDown': pan(0, 80); break;
        default: return;
      }
      ev.preventDefault();
    }

    over.addEventListener('pointerdown', onPointerDown);
    over.addEventListener('pointermove', onPointerMove);
    over.addEventListener('pointerup', onPointerUp);
    over.addEventListener('pointercancel', onPointerUp);
    over.addEventListener('pointerleave', onLeave);
    over.addEventListener('wheel', onWheel, { passive: false });
    over.addEventListener('keydown', onKey);

    /* ---------- Sizing ---------- */
    function resize() {
      const r = container.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      if (w === st.w && h === st.h && dpr === st.dpr) return;
      const wasFit = st.fit && Math.abs(st.cam.k / st.fit.k - 1) < 1e-3 && !st.flight;
      st.w = w; st.h = h; st.dpr = dpr;
      for (const c of [base, over]) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c.style.width = w + 'px'; c.style.height = h + 'px';
      }
      if (st.brazilWorld) {
        st.brazilFit = fitTo(st.brazilWorld, 0.88);
      }
      if (st.world) {
        st.fit = fitTo(st.world, 0.86);
        if ((wasFit || !st.cam.k || st.cam.k === 1) && !st.flight) st.cam = Object.assign({}, st.fit);
      }
      invalidate(true, true);
      emitView();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    /* ---------- Public API ---------- */
    function setBrazilGeometry(fc) {
      if (!fc) return 0;
      const built = buildFeatures(fc, 'codarea', project, /^\d{2}$/);
      st.brazilStates = built.features;
      st.brazilOuterPath = built.outerPath;
      st.brazilInnerPath = built.innerPath;
      let b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const f of st.brazilStates) {
        b = [Math.min(b[0], f.bbox[0]), Math.min(b[1], f.bbox[1]), Math.max(b[2], f.bbox[2]), Math.max(b[3], f.bbox[3])];
      }
      st.brazilWorld = st.brazilStates.length ? b : null;
      if (st.w && st.h && st.brazilWorld) {
        st.brazilFit = fitTo(st.brazilWorld, 0.88);
      }
      invalidate(true, true);
      return st.brazilStates.length;
    }

    function setGeometry(fc) {
      const built = buildFeatures(fc, options.idProp, project, /^\d{7}$/);
      st.features = built.features;
      st.outerPath = built.outerPath;
      st.innerPath = built.innerPath;
      st.byId = new Map(st.features.map((f) => [f.id, f]));
      st.byArea = st.features.slice().sort((a, b) => b.areaKm2 - a.areaKm2);
      st.all = new Path2D();
      let b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const f of st.features) {
        st.all.addPath(f.path);
        b = [Math.min(b[0], f.bbox[0]), Math.min(b[1], f.bbox[1]), Math.max(b[2], f.bbox[2]), Math.max(b[3], f.bbox[3])];
      }
      st.world = st.features.length ? b : null;
      readColors();
      st.w = 0; resize();
      if (st.fit) {
        if (st.brazilFit) {
          st.cam = Object.assign({}, st.brazilFit);
        } else {
          st.cam = { x: st.fit.x, y: st.fit.y, k: st.fit.k * 0.36 };
        }
        st.intro = { t0: performance.now(), dur: 620, progress: 0 };
      }
      recolor();
      return st.features.length;
    }

    function setNames(map) {
      st.names = map instanceof Map ? map : new Map();
      for (const f of st.features) f.labelW = -1;
      invalidate(true, true);
    }

    function setValues(obj, scale) {
      st.values = new Map();
      if (obj) for (const id of Object.keys(obj)) {
        const v = obj[id];
        if (/^\d{7}$/.test(id)) st.values.set(id, typeof v === 'number' && Number.isFinite(v) ? v : null);
      }
      if (scale) st.scale = Object.assign({}, scale);
      st.noFire = new Set(scale && Array.isArray(scale.noFireIds) ? scale.noFireIds : []);
      recolor();
    }

    function select(id, o) {
      const opt = Object.assign({ fly: true, emit: false }, o);
      const next = id && st.byId.has(id) ? id : null;
      const hadSphere = !!st.sphere;
      if (hadSphere) st.sphere = null;

      const changed = next !== st.selected || hadSphere;
      const prev = st.selected;

      if (changed) {
        st.prevSelected = prev;
        st.selected = next;
        startFocusTransition(!!next, !!(prev && next && prev !== next));
        if (next) {
          st.pulse = { id: next, t0: performance.now() };
        } else {
          st.pulse = null;
        }
      }

      if (opt.fly && st.fit) {
        if (next) {
          const f = st.byId.get(next);
          const t = fitTo(f.bbox, 0.42);
          t.k = Math.min(Math.max(t.k, st.fit.k * 2.4), st.fit.k * 10.5);
          flyTo(t);
        } else if (changed || Math.abs(st.cam.k - st.fit.k) > 1e-3) {
          flyTo(Object.assign({}, st.fit));
        }
      }

      if (changed) invalidate(true, true);
      if (opt.emit) emit('select', next);
    }

    function setSelectionMode(mode) {
      const next = mode === 'sphere' ? 'sphere' : 'municipality';
      if (next === st.selectionMode) return;
      st.selectionMode = next;
      st.spherePreview = null;
      over.style.cursor = next === 'sphere' ? 'crosshair' : 'grab';
      if (next === 'municipality' && st.sphere) {
        st.sphere = null;
        startFocusTransition(!!st.selected, false);
        invalidate(true, true);
      } else {
        invalidate(false, true);
      }
    }

    function setSphereRadius(rKm) {
      const radius = Math.max(5, Math.min(260, Number(rKm) || 85));
      st.sphereRadiusKm = radius;
      if (st.sphere) {
        applySphereAt(st.sphere.x, st.sphere.y, radius, false, true);
      } else {
        invalidate(false, true);
      }
    }

    /**
     * Cell layer ('roots' = state-wide focos-raiz, 'detail' = cells of the selected area).
     * layer = { cellKm, classes: [{ color, cells: [[lon, lat, ...data], …] }], clip?: { kind: 'feature', id } | { kind: 'sphere' },
     *           hover?: boolean, grid?: boolean, alpha?: number } or null.
     * Cells are projected once into one Path2D per class; panning/zooming costs one fill per class.
     */
    function setPointLayer(layer, name) {
      const key = name === 'detail' ? 'detail' : 'roots';
      if (!layer || !Array.isArray(layer.classes)) {
        st.layers[key] = null;
        if (key === 'detail' && st.cellHover) { st.cellHover = null; emit('cell', null); }
        invalidate(true, false);
        return 0;
      }
      const cellKm = Math.max(0.2, Math.min(20, Number(layer.cellKm) || 1));
      const half = cellKm / 2;
      const paths = [], colors = [], index = layer.hover ? new Map() : null;
      let n = 0;
      for (const c of layer.classes) {
        if (!c || typeof c.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(c.color) || !Array.isArray(c.cells)) continue;
        const p = new Path2D();
        for (const cell of c.cells) {
          const lon = cell[0], lat = cell[1];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const [x, y] = project(lon, lat);
          p.rect(x - half, y - half, cellKm, cellKm);
          if (index) {
            const bk = Math.floor(x / cellKm) + ':' + Math.floor(y / cellKm);
            const list = index.get(bk);
            const item = { x, y, cell };
            if (list) list.push(item); else index.set(bk, [item]);
          }
          n++;
        }
        paths.push(p); colors.push(c.color);
      }
      const clip = layer.clip && (layer.clip.kind === 'sphere' || (layer.clip.kind === 'feature' && st.byId.has(layer.clip.id))) ? layer.clip : null;
      st.layers[key] = paths.length ? { paths, colors, cellKm, clip, index, grid: !!layer.grid,
        alpha: Number.isFinite(layer.alpha) ? Math.max(0.1, Math.min(1, layer.alpha)) : 0.9 } : null;
      invalidate(true, false);
      return n;
    }

    /** Detail cell under a world point (nearest centre within the cell), or null. */
    function cellAtWorld(wx, wy) {
      const L = st.layers.detail;
      if (!L || !L.index) return null;
      if (L.clip && L.clip.kind === 'sphere' && st.sphere && Math.hypot(wx - st.sphere.x, wy - st.sphere.y) > st.sphere.rKm) return null;
      if (L.clip && L.clip.kind === 'feature') {
        const cf = st.byId.get(L.clip.id);
        if (!cf || !hit.isPointInPath(cf.path, wx, wy, 'evenodd')) return null;
      }
      const bx = Math.floor(wx / L.cellKm), by = Math.floor(wy / L.cellKm);
      let best = null, bestD = L.cellKm * 0.75;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const list = L.index.get((bx + i) + ':' + (by + j));
        if (!list) continue;
        for (const it of list) {
          const d = Math.max(Math.abs(it.x - wx), Math.abs(it.y - wy));
          if (d < bestD) { bestD = d; best = it; }
        }
      }
      return best;
    }

    /** Share of each municipality's area that lies inside the current circle (grid sampling, ~2 000 points). */
    function sphereShares() {
      if (!st.sphere || !st.sphere.ids.size) return {};
      const { x, y, rKm } = st.sphere;
      const step = Math.max(0.25, rKm / 25);
      const cand = [...st.sphere.ids].map((id) => st.byId.get(id)).filter(Boolean);
      const hits = new Map();
      for (let wx = x - rKm + step / 2; wx < x + rKm; wx += step) {
        for (let wy = y - rKm + step / 2; wy < y + rKm; wy += step) {
          if ((wx - x) * (wx - x) + (wy - y) * (wy - y) > rKm * rKm) continue;
          for (const f of cand) {
            const b = f.bbox;
            if (wx < b[0] || wx > b[2] || wy < b[1] || wy > b[3]) continue;
            if (hit.isPointInPath(f.path, wx, wy, 'evenodd')) { hits.set(f.id, (hits.get(f.id) || 0) + 1); break; }
          }
        }
      }
      const out = {};
      for (const f of cand) {
        const inside = (hits.get(f.id) || 0) * step * step;
        out[f.id] = f.areaKm2 > 0 ? Math.min(1, inside / f.areaKm2) : 0;
      }
      return out;
    }

    /** Municipality bounding box in degrees [west, south, east, north] (padded for the polyconic). */
    function bboxLonLat(id) {
      const f = st.byId.get(id);
      if (!f) return null;
      const c = [unproject(f.bbox[0], f.bbox[1]), unproject(f.bbox[2], f.bbox[1]), unproject(f.bbox[0], f.bbox[3]), unproject(f.bbox[2], f.bbox[3])];
      const lons = c.map((q) => q[0]), lats = c.map((q) => q[1]);
      return [Math.min(...lons) - 0.02, Math.min(...lats) - 0.02, Math.max(...lons) + 0.02, Math.max(...lats) + 0.02];
    }

    /** True when the point (lon, lat) falls inside municipality `id`. */
    function contains(id, lon, lat) {
      const f = st.byId.get(id);
      if (!f) return false;
      const [x, y] = project(lon, lat);
      return hit.isPointInPath(f.path, x, y, 'evenodd');
    }

    function setShowNumbers(flag) {
      st.showNumbers = flag === undefined ? !st.showNumbers : !!flag;
      invalidate(true, true);
      return st.showNumbers;
    }

    function neighborsOf(id, count = 8) {
      const target = id && st.byId.get(id);
      if (!target) return [];
      const list = [];
      for (const f of st.features) {
        if (f.id === id) continue;
        const distKm = Math.round(Math.hypot(f.anchor[0] - target.anchor[0], f.anchor[1] - target.anchor[1]));
        list.push({ id: f.id, distKm });
      }
      list.sort((a, b) => a.distKm - b.distKm);
      return list.slice(0, count);
    }

    function reset(ms) {
      if (st.fit) flyTo(Object.assign({}, st.fit), ms);
    }

    function resetBrazil(ms) {
      if (st.brazilFit) {
        flyTo(Object.assign({}, st.brazilFit), ms || 980);
      } else if (st.fit) {
        flyTo({ x: st.fit.x, y: st.fit.y, k: st.fit.k * 0.35 }, ms || 980);
      }
    }

    function zoomBy(factor) {
      flyTo({ x: st.cam.x, y: st.cam.y, k: clampK(st.cam.k * factor) }, 320);
    }

    function setTheme(theme) {
      st.theme = theme === 'light' ? 'light' : 'dark';
      readColors();
      for (const f of st.features) f.labelW = -1;
      recolor();
    }

    function setAriaLabel(text) { over.setAttribute('aria-label', String(text)); }
    function on(type, fn) { if (st.listeners[type]) st.listeners[type].push(fn); return () => off(type, fn); }
    function off(type, fn) { const l = st.listeners[type]; const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); }

    function destroy() {
      cancelAnimationFrame(st.frame);
      ro.disconnect();
      over.removeEventListener('pointerdown', onPointerDown);
      over.removeEventListener('pointermove', onPointerMove);
      over.removeEventListener('pointerup', onPointerUp);
      over.removeEventListener('pointercancel', onPointerUp);
      over.removeEventListener('pointerleave', onLeave);
      over.removeEventListener('wheel', onWheel);
      over.removeEventListener('keydown', onKey);
      base.remove(); over.remove();
      st.listeners = { hover: [], select: [], sphere: [], view: [], cell: [] };
    }

    readColors();
    return {
      setGeometry,
      setBrazilGeometry,
      setNames,
      setValues,
      select,
      setSelectionMode,
      selectionMode: () => st.selectionMode,
      setSphereRadius,
      sphereRadius: () => st.sphereRadiusKm,
      setShowNumbers,
      showNumbers: () => st.showNumbers,
      setPointLayer,
      setPlaces,
      contains,
      bboxLonLat,
      areaKm2: (id) => { const f = st.byId.get(id); return f ? f.areaKm2 : null; },
      neighborsOf,
      reset,
      resetBrazil,
      zoomBy,
      setTheme,
      setAriaLabel,
      on,
      off,
      destroy,
      colorFor: (v, scale) => colorFor(v, scale),
      /** Circle selection at a typed coordinate (sphere mode): same path as a click on the map. */
      sphereAt(lon, lat, rKm) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
        st.selectionMode = 'sphere';
        const [wx, wy] = project(lon, lat);
        applySphereAt(wx, wy, Number.isFinite(rKm) ? rKm : st.sphereRadiusKm, true, true);
        return true;
      },
      /** The current map view (base + overlay layers) on one canvas, at device resolution, for PNG export. */
      snapshot() {
        const c = document.createElement('canvas');
        c.width = base.width; c.height = base.height;
        const g = c.getContext('2d');
        g.drawImage(base, 0, 0); g.drawImage(over, 0, 0);
        return { canvas: c, dpr: st.dpr || 1 };
      },
      featureIds: () => st.features.map((f) => f.id),
      selected: () => st.selected,
      screenPointOf(id) {
        const f = st.byId.get(id); if (!f) return null;
        return worldToScreen(f.anchor[0], f.anchor[1]);
      },
    };
  }

  global.FireMap = Object.freeze({ create, polyconic, makeRamp });
})(window);
