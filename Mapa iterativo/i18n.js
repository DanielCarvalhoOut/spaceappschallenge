/*
 * Monitor Cinder i18n (original code). Português é o padrão (apresentação local);
 * inglês fica a um clique para o júri global e para o vídeo da submissão.
 * Textos são sempre aplicados com textContent / setAttribute, nunca como HTML.
 */
(function (global) {
  'use strict';

  const DICT = {
    pt: {
      'doc.title': 'Monitor Cinder · Padrões históricos de fogo em Goiás',
      'brand.sub': 'Padrões históricos de fogo · Goiás',
      'badge.loading': 'Carregando…',
      'badge.demo': 'DEMO · valores sintéticos, não são focos reais',
      'badge.live': 'Dados da API',
      'field.metric': 'Métrica',
      'metric.anomaly': 'Anomalia vs. padrão (z)',
      'metric.count': 'Focos (harmonizados)',
      'field.year': 'Ano',
      'field.month': 'Mês',
      'search.ph': 'Buscar município ( / )',
      'search.aria': 'Buscar município',
      'theme.aria': 'Alternar tema claro ou escuro',
      'lang.aria': 'Switch to English',
      'lang.btn': 'EN',
      'map.aria': 'Mapa dos municípios de Goiás no contexto do Brasil',
      'zoom.in': 'Aproximar',
      'zoom.out': 'Afastar',
      'zoom.reset': 'Focar em Goiás (voo)',
      'zoom.brazil': 'Ver Brasil inteiro (voo)',
      'zoom.numbers': 'Alternar números nos municípios da região',
      'mode.aria': 'Modo de seleção no mapa',
      'mode.muni': '⬡ Município',
      'mode.muniTitle': 'Selecionar por município individual',
      'mode.sphere': '◎ Esfera (Área)',
      'mode.sphereTitle': 'Selecionar uma área com uma esfera/raio no mapa',
      'mode.radius': 'Raio',
      'mode.hint': 'Clique ou arraste no mapa',
      'scale.title': 'Proporção',
      'scale.span': 'Campo: {km} km',
      'legend.nodata': 'Sem dado',
      'legend.anomaly': 'Anomalia vs. padrão histórico · {period}',
      'legend.count': 'Células-dia com foco (harmonizado) · {period}',
      'legend.normal': 'normal',
      'status.loading': 'Carregando os limites municipais do IBGE…',
      'status.mapErr': 'Não foi possível carregar o mapa ({msg}). Verifique a conexão com o IBGE.',
      'status.valuesErr': 'Não foi possível carregar os valores da API.',
      'status.retry': 'Tentar de novo',
      'empty.title': 'Escolha um município ou área',
      'empty.p1': 'Clique num município no mapa, busque pelo nome ou ative o modo Esfera (Área) para analisar um raio regional. Você verá o padrão histórico de fogo, a época típica de queimadas e o calendário desde 2001.',
      'empty.p2': 'O Monitor Cinder mostra histórico e anomalias. Ele não faz previsão de incêndios.',
      'panel.close': 'Fechar painel',
      'panel.sub': 'IBGE {id}',
      'panel.micro': 'Microrregião {name}',
      'panel.loadErr': 'Não foi possível carregar este município.',
      'sphere.title': 'Esfera · {n} municípios',
      'sphere.sub': 'Raio {r} km (~{area} km²) · Centro: {name}',
      'block.subareas': 'Municípios próximos na região',
      'block.subareasSmall': 'clique para focar no município',
      'block.sphereMunis': 'Municípios na esfera',
      'block.sphereMunisSmall': 'clique para focar no município',
      'kpi.unit': 'células-dia com foco (harmonizado)',
      'kpi.anomaly': 'Anomalia',
      'block.pattern': 'Padrão histórico',
      'block.patternSmall': 'base 2002–2024',
      'block.calendar': 'Calendário de fogo',
      'block.calendarSmall': 'clique numa célula para ver o mês no mapa',
      'block.compare': 'MODIS × VIIRS × harmonizado',
      'block.compareSmall': 'totais anuais',
      'block.context': 'Contexto',
      'csv': 'Baixar CSV',
      'z.none': 'sem base para este mês',
      'z.farAbove': 'muito acima do padrão histórico',
      'z.above': 'acima do padrão histórico',
      'z.below': 'abaixo do padrão histórico',
      'z.normal': 'dentro do normal',
      'z.missing': '{n} dia(s) sem dado de satélite',
      'season.text': 'Época típica de fogo: {months}. Esses meses concentram {pct}% dos focos da base; o pico é em {peak}.',
      'season.none': 'Poucos focos para descrever uma época típica de fogo.',
      'tt.count': '{n} células-dia · {period}',
      'bar.title': '{m}: {pct}% dos focos do ano · média de {mean} células-dia',
      'cal.cell': '{m} de {y}: {n} células-dia, {z}',
      'cal.empty': '{m} de {y}: sem dado',
      'cmp.aria': 'Totais anuais de focos por sensor',
      'cmp.modis': 'MODIS (Terra+Aqua)',
      'cmp.viirs': 'VIIRS S-NPP',
      'cmp.harm': 'Harmonizado',
      'ctx.none': 'Sem dados de contexto para este ano.',
      'ctx.err': 'Fontes de contexto indisponíveis agora.',
      'ctx.demo': 'DEMO',
      'ctx.inpe_queimadas.reference_hotspots': 'Focos do satélite de referência do INPE (ano)',
      'ctx.inpe_prodes.deforestation_km2': 'Desmatamento PRODES Cerrado (ano)',
      'ctx.inpe_deter.alerts_km2': 'Alertas DETER Cerrado (ano)',
      'ctx.embrapa_satveg.ndvi_dry_mean': 'NDVI médio na seca (jun–set)',
      'ctx.nasa_power.ws10m_dry_mean': 'Vento médio na seca',
      'ctx.nasa_power.precip_dry_mm': 'Chuva na seca',
      'foot.firms': 'Focos: NASA FIRMS (MODIS Coleção 6.1, VIIRS S-NPP 375 m)',
      'foot.ibge': 'Limites e nomes: IBGE',
      'foot.inpe': 'Série de referência e desmatamento: INPE (Programa Queimadas, PRODES/DETER)',
      'foot.embrapa': 'Vegetação: Embrapa SATVeg',
      'foot.power': 'Clima: NASA POWER',
    },
    en: {
      'doc.title': 'Monitor Cinder · Historical fire patterns in Goiás',
      'brand.sub': 'Historical fire patterns · Goiás, Brazil',
      'badge.loading': 'Loading…',
      'badge.demo': 'DEMO data · synthetic values, not real fire counts',
      'badge.live': 'Live API',
      'field.metric': 'Metric',
      'metric.anomaly': 'Anomaly vs. pattern (z)',
      'metric.count': 'Hotspots (harmonized)',
      'field.year': 'Year',
      'field.month': 'Month',
      'search.ph': 'Search municipality ( / )',
      'search.aria': 'Search municipality',
      'theme.aria': 'Toggle light or dark theme',
      'lang.aria': 'Mudar para português',
      'lang.btn': 'PT',
      'map.aria': 'Map of Goiás municipalities in the context of Brazil',
      'zoom.in': 'Zoom in',
      'zoom.out': 'Zoom out',
      'zoom.reset': 'Focus on Goiás (fly)',
      'zoom.brazil': 'Show all of Brazil (fly)',
      'zoom.numbers': 'Toggle municipal numbers in region',
      'mode.aria': 'Map selection mode',
      'mode.muni': '⬡ Municipality',
      'mode.muniTitle': 'Select by individual municipality',
      'mode.sphere': '◎ Sphere (Area)',
      'mode.sphereTitle': 'Select a regional area using a sphere/radius on the map',
      'mode.radius': 'Radius',
      'mode.hint': 'Click or drag on map',
      'scale.title': 'Scale',
      'scale.span': 'Span: {km} km',
      'legend.nodata': 'No data',
      'legend.anomaly': 'Anomaly vs. historical pattern · {period}',
      'legend.count': 'Harmonized hotspot cell-days · {period}',
      'legend.normal': 'normal',
      'status.loading': 'Loading municipal boundaries from IBGE…',
      'status.mapErr': 'Could not load the map ({msg}). Check your connection to IBGE.',
      'status.valuesErr': 'Could not load map values from the API.',
      'status.retry': 'Retry',
      'empty.title': 'Pick a municipality or area',
      'empty.p1': 'Click a municipality on the map, search by name, or switch to Sphere (Area) mode to analyze a regional radius. You will see the historical fire pattern, typical fire season, and fire calendar since 2001.',
      'empty.p2': 'Monitor Cinder shows history and anomalies. It does not forecast fires.',
      'panel.close': 'Close panel',
      'panel.sub': 'IBGE {id}',
      'panel.micro': 'Microregion {name}',
      'panel.loadErr': 'Could not load this municipality.',
      'sphere.title': 'Sphere · {n} municipalities',
      'sphere.sub': 'Radius {r} km (~{area} km²) · Center: {name}',
      'block.subareas': 'Nearby municipalities in region',
      'block.subareasSmall': 'click to focus municipality',
      'block.sphereMunis': 'Municipalities in sphere',
      'block.sphereMunisSmall': 'click to focus municipality',
      'kpi.unit': 'harmonized hotspot cell-days',
      'kpi.anomaly': 'Anomaly',
      'block.pattern': 'Historical pattern',
      'block.patternSmall': 'baseline 2002–2024',
      'block.calendar': 'Fire calendar',
      'block.calendarSmall': 'click a cell to show that month on the map',
      'block.compare': 'MODIS × VIIRS × harmonized',
      'block.compareSmall': 'yearly totals',
      'block.context': 'Context',
      'csv': 'Download CSV',
      'z.none': 'no baseline for this month',
      'z.farAbove': 'far above the historical pattern',
      'z.above': 'above the historical pattern',
      'z.below': 'below the historical pattern',
      'z.normal': 'within the normal range',
      'z.missing': '{n} day(s) without satellite data',
      'season.text': 'Typical fire season: {months}. These months hold {pct}% of the hotspots in the baseline; the peak is {peak}.',
      'season.none': 'Not enough hotspots to describe a typical fire season.',
      'tt.count': '{n} cell-days · {period}',
      'bar.title': '{m}: {pct}% of yearly hotspots · mean {mean} cell-days',
      'cal.cell': '{m} {y}: {n} cell-days, {z}',
      'cal.empty': '{m} {y}: no data',
      'cmp.aria': 'Yearly hotspot totals by sensor',
      'cmp.modis': 'MODIS (Terra+Aqua)',
      'cmp.viirs': 'VIIRS S-NPP',
      'cmp.harm': 'Harmonized',
      'ctx.none': 'No context data for this year.',
      'ctx.err': 'Context sources unavailable right now.',
      'ctx.demo': 'DEMO',
      'ctx.inpe_queimadas.reference_hotspots': 'INPE reference-satellite hotspots (year)',
      'ctx.inpe_prodes.deforestation_km2': 'PRODES Cerrado deforestation (year)',
      'ctx.inpe_deter.alerts_km2': 'DETER Cerrado alerts (year)',
      'ctx.embrapa_satveg.ndvi_dry_mean': 'Mean NDVI, dry season (Jun–Sep)',
      'ctx.nasa_power.ws10m_dry_mean': 'Dry-season mean wind speed',
      'ctx.nasa_power.precip_dry_mm': 'Dry-season precipitation',
      'foot.firms': 'Hotspots: NASA FIRMS (MODIS Collection 6.1, VIIRS S-NPP 375 m)',
      'foot.ibge': 'Boundaries & names: IBGE',
      'foot.inpe': 'Reference series & deforestation: INPE (Programa Queimadas, PRODES/DETER)',
      'foot.embrapa': 'Vegetation: Embrapa SATVeg',
      'foot.power': 'Weather: NASA POWER',
    },
  };
  const MONTHS = {
    pt: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dez'],
  };
  const LOCALE = { pt: 'pt-BR', en: 'en-US' };

  let lang = 'pt';
  try { if (global.localStorage.getItem('firehub.lang') === 'en') lang = 'en'; } catch (_) { /* storage blocked */ }

  function t(key, params) {
    let s = (DICT[lang] && DICT[lang][key]) ?? DICT.pt[key] ?? key;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
    return s;
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(DICT[lang], key);
  const num = (v, digits) => Number(v).toLocaleString(LOCALE[lang], digits === undefined ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits });

  /** Apply data-i18n (textContent) and data-i18n-attr ("attr:key;attr:key") inside root. */
  function apply(root) {
    const r = root || document;
    for (const el of r.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of r.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(';')) {
        const [attr, key] = pair.split(':');
        if (attr && key && /^(placeholder|aria-label|title)$/.test(attr)) el.setAttribute(attr, t(key));
      }
    }
    document.documentElement.lang = LOCALE[lang];
    document.title = t('doc.title');
  }
  function setLang(next) {
    lang = next === 'en' ? 'en' : 'pt';
    try { global.localStorage.setItem('firehub.lang', lang); } catch (_) { /* ignore */ }
    apply();
  }

  global.FireI18n = Object.freeze({
    t, has, num, apply, setLang,
    lang: () => lang,
    months: () => MONTHS[lang].slice(),
  });
})(window);
