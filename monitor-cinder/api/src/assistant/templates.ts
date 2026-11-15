/**
 * No-LLM answers: text templates filled only with values that came out of the tools (pt and en, ≤ 150 words).
 * Every sentence here is written to pass verifier.ts: forecasts carry interval, training period and metric;
 * probabilities carry n and source; nothing attributes cause; nothing describes fire behaviour.
 */
import type { Intent } from './router.js';
import type { ToolResult } from './tools.js';
import type { Lang } from './verifier.js';

type Dict = Record<string, unknown>;
const obj = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const MONTH_NAMES: Record<Lang, string[]> = {
  pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
export const monthName = (m: unknown, lang: Lang): string => MONTH_NAMES[lang][(num(m) ?? 1) - 1] ?? '';

/** Number as shown to the user: decimal comma in pt, no thousands separator (the verifier parses it back). */
export function fmt(v: unknown, lang: Lang, digits = 1): string {
  const n = num(v);
  if (n === null) return lang === 'pt' ? 'sem dado' : 'no data';
  return n.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US', { maximumFractionDigits: digits, useGrouping: false });
}

const list = (items: string[], lang: Lang): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${lang === 'pt' ? 'e' : 'and'} ${items[items.length - 1]}`;

const tool = (tools: readonly ToolResult[], name: ToolResult['name']): Dict => obj(tools.find((t) => t.name === name)?.result);

const PHASE: Record<Lang, Record<string, string>> = {
  pt: { el_nino: 'El Niño', la_nina: 'La Niña', neutral: 'neutro' },
  en: { el_nino: 'El Niño', la_nina: 'La Niña', neutral: 'neutral' },
};

export const NOT_BEHAVIOUR: Record<Lang, string> = {
  pt: 'É previsão de ocorrência de focos por área e mês, não de comportamento do fogo.',
  en: 'It is a forecast of hotspot occurrence per area and month, not of fire behaviour.',
};

export function noDataText(lang: Lang): string {
  return lang === 'pt'
    ? 'Sem dados para esse local ou período. Só há dados dos municípios de Goiás, e não faço extrapolação.'
    : 'No data for this place or period. Only municipalities of Goiás are covered, and I do not extrapolate.';
}

export function helpText(lang: Lang): string {
  return lang === 'pt'
    ? 'Posso responder, para municípios de Goiás: padrão histórico e anomalia; previsão de focos com intervalo; comparação por fase do ENSO; intervenções cadastradas; municípios a priorizar; e contexto para queima controlada (sem autorizar). Diga o município e, se quiser, o mês e o ano.'
    : 'For municipalities of Goiás I can answer: historical pattern and anomaly; hotspot forecast with interval; comparison by ENSO phase; registered interventions; municipalities to prioritise; and context for a controlled burn (never an authorisation). Name the municipality and, if you wish, the month and year.';
}

function validationSentence(v: Dict, lang: Lang): string {
  const official = str(v.official) === 'model';
  return lang === 'pt'
    ? `Método: ${official ? 'modelo' : 'climatologia'}, treino ${str(v.trainPeriod)}; no teste ${str(v.testPeriod)} o MAE foi ${fmt(v.maeModel, lang, 3)}, contra ${fmt(v.maeClimatology, lang, 3)} da climatologia e ${fmt(v.maePersistence, lang, 3)} da persistência.`
    : `Method: ${official ? 'model' : 'climatology'}, trained on ${str(v.trainPeriod)}; on the ${str(v.testPeriod)} test the MAE was ${fmt(v.maeModel, lang, 3)}, against ${fmt(v.maeClimatology, lang, 3)} for climatology and ${fmt(v.maePersistence, lang, 3)} for persistence.`;
}

function probSource(p: Dict, lang: Lang): string {
  const clim = str(p.method) === 'climatology';
  return lang === 'pt'
    ? `${clim ? 'frequência climatológica' : 'modelo calibrado'}, n = ${fmt(p.n, lang)}; fonte: NASA FIRMS`
    : `${clim ? 'climatological frequency' : 'calibrated model'}, n = ${fmt(p.n, lang)}; source: NASA FIRMS`;
}

function stats(t: Dict, lang: Lang): string {
  const season = obj(t.season);
  const month = obj(t.month);
  const an = obj(t.anomaly);
  const names = arr(season.months).map((m) => monthName(m, lang));
  const z = num(an.z);
  if (lang === 'pt') {
    return [
      `${str(t.municipality)}: temporada típica de fogo em ${list(names, lang)} (${fmt(season.coveredPct, lang)} % das células-dia do ano; pico em ${monthName(season.peakMonth, lang)}). Base ${str(t.basePeriod)}, n = ${fmt(t.n, lang)} anos.`,
      `Em ${monthName(month.month, lang)}: mediana ${fmt(month.p50, lang)}, P10 ${fmt(month.p10, lang)}, P90 ${fmt(month.p90, lang)} e média ${fmt(month.mean, lang)} células-dia harmonizadas (1 km).`,
      num(an.value) !== null
        ? `Em ${monthName(an.month, lang)} de ${fmt(an.year, lang)} foram ${fmt(an.value, lang)}${z !== null ? `, anomalia z = ${fmt(z, lang, 2)} em relação à base` : ''}.`
        : '',
      'Fonte: NASA FIRMS (MODIS + VIIRS S-NPP), série harmonizada.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `${str(t.municipality)}: typical fire season in ${list(names, lang)} (${fmt(season.coveredPct, lang)} % of the year's cell-days; peak in ${monthName(season.peakMonth, lang)}). Base ${str(t.basePeriod)}, n = ${fmt(t.n, lang)} years.`,
    `In ${monthName(month.month, lang)}: median ${fmt(month.p50, lang)}, P10 ${fmt(month.p10, lang)}, P90 ${fmt(month.p90, lang)} and mean ${fmt(month.mean, lang)} harmonized cell-days (1 km).`,
    num(an.value) !== null
      ? `In ${monthName(an.month, lang)} ${fmt(an.year, lang)} there were ${fmt(an.value, lang)}${z !== null ? `, anomaly z = ${fmt(z, lang, 2)} against the base` : ''}.`
      : '',
    'Source: NASA FIRMS (MODIS + VIIRS S-NPP), harmonized series.',
  ]
    .filter(Boolean)
    .join(' ');
}

function forecast(t: Dict, lang: Lang): string {
  const months = arr(t.months).map(obj);
  const p = obj(t.probability);
  const v = obj(t.validation);
  const far = arr(t.flags).some((f) => str(f).startsWith('model_not_applicable'));
  const lines = months.map((m) =>
    lang === 'pt'
      ? `${monthName(m.month, lang)} de ${fmt(m.year, lang)}: ${fmt(m.value, lang)} células-dia (intervalo P10–P90: ${fmt(m.p10, lang)} a ${fmt(m.p90, lang)}); probabilidade de passar do P90 histórico (${fmt(m.p90Threshold, lang)}): ${fmt(m.probAboveP90Pct, lang)} %`
      : `${monthName(m.month, lang)} ${fmt(m.year, lang)}: ${fmt(m.value, lang)} cell-days (P10–P90 interval: ${fmt(m.p10, lang)} to ${fmt(m.p90, lang)}); probability of exceeding the historical P90 (${fmt(m.p90Threshold, lang)}): ${fmt(m.probAboveP90Pct, lang)} %`
  );
  const head = lang === 'pt' ? `Previsão para ${str(t.municipality)}` : `Forecast for ${str(t.municipality)}`;
  const body = lines.length === 1 ? `${head}, ${lines[0]}` : `${head}:\n${lines.map((l) => `• ${l}`).join('\n')}\n`;
  const farNote = far
    ? lang === 'pt'
      ? ' Além de um ano após o último ano carregado vale a climatologia.'
      : ' More than one year past the last loaded year, climatology is used.'
    : '';
  return `${body} (${probSource(p, lang)}). ${validationSentence(v, lang)}${farNote} ${NOT_BEHAVIOUR[lang]}`.replace(/\n \(/, '\n(');
}

function enso(t: Dict, lang: Lang): string {
  const phases = arr(t.phases).map(obj);
  const latest = obj(t.latest);
  const small = phases.filter((p) => p.smallSample === true).map((p) => PHASE[lang][str(p.phase)] ?? '');
  const parts = phases.map((p) =>
    lang === 'pt'
      ? `${PHASE.pt[str(p.phase)]} (n = ${fmt(p.n, lang)}): média ${fmt(p.mean, lang)}, mediana ${fmt(p.median, lang)}`
      : `${PHASE.en[str(p.phase)]} (n = ${fmt(p.n, lang)}): mean ${fmt(p.mean, lang)}, median ${fmt(p.median, lang)}`
  );
  if (lang === 'pt') {
    return [
      `${str(t.place)}, ${monthName(t.month, lang)}, ${str(t.basePeriod)}, células-dia harmonizadas por fase do ENSO no mesmo mês: ${parts.join('; ')}.`,
      small.length ? `Atenção: amostra pequena (n < ${fmt(t.smallSampleBelow, lang)}) em ${list(small, lang)}.` : '',
      `ONI mais recente: ${fmt(latest.anom, lang, 2)} (${str(latest.season)} ${fmt(latest.year, lang)}), fase ${PHASE.pt[str(latest.phase)]}.`,
      'É uma associação, não causa. Fontes: NOAA CPC (ONI) e NASA FIRMS.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `${str(t.place)}, ${monthName(t.month, lang)}, ${str(t.basePeriod)}, harmonized cell-days by ENSO phase of the same month: ${parts.join('; ')}.`,
    small.length ? `Caution: small sample (n < ${fmt(t.smallSampleBelow, lang)}) for ${list(small, lang)}.` : '',
    `Latest ONI: ${fmt(latest.anom, lang, 2)} (${str(latest.season)} ${fmt(latest.year, lang)}), ${PHASE.en[str(latest.phase)]} phase.`,
    'This is an association, not a cause. Sources: NOAA CPC (ONI) and NASA FIRMS.',
  ]
    .filter(Boolean)
    .join(' ');
}

function interventions(t: Dict, v: Dict, lang: Lang): string {
  const items = arr(t.items).map(obj);
  if (!items.length) {
    return lang === 'pt'
      ? `Nenhuma intervenção cadastrada para ${str(t.municipality)}. O cadastro exige local, data, tipo, fonte ou URL e quem registrou; sem ele não há comparação.`
      : `No intervention registered for ${str(t.municipality)}. A record needs place, date, type, source or URL and who registered it; without it there is no comparison.`;
  }
  const i = items[0]!;
  const c = obj(i.comparison);
  if (lang === 'pt') {
    return [
      `${str(t.municipality)}: "${str(i.type)}" em ${str(i.date)} (fonte: ${str(i.source)}; cadastro: ${str(i.registeredBy)}).`,
      `Na janela de maio a outubro, a média foi ${fmt(c.beforeMean, lang)} células-dia antes (n = ${fmt(c.beforeN, lang)} anos) e ${fmt(c.afterMean, lang)} depois (n = ${fmt(c.afterN, lang)} anos).`,
      num(c.firstSeasonAfter) !== null
        ? `Na primeira temporada depois (${fmt(c.firstSeasonAfter, lang)}): observado ${fmt(c.firstSeasonObserved, lang)}, nível esperado pelo modelo ${fmt(c.firstSeasonForecast, lang)} (treino ${str(v.trainPeriod)}; MAE mensal ${fmt(v.maeModel, lang, 3)} no teste ${str(v.testPeriod)}).`
        : '',
      'É uma associação no tempo, não causa: outros fatores mudam junto.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `${str(t.municipality)}: "${str(i.type)}" on ${str(i.date)} (source: ${str(i.source)}; registered by ${str(i.registeredBy)}).`,
    `In the May–October window the mean was ${fmt(c.beforeMean, lang)} cell-days before (n = ${fmt(c.beforeN, lang)} years) and ${fmt(c.afterMean, lang)} after (n = ${fmt(c.afterN, lang)} years).`,
    num(c.firstSeasonAfter) !== null
      ? `In the first season after (${fmt(c.firstSeasonAfter, lang)}): observed ${fmt(c.firstSeasonObserved, lang)}, level expected by the model ${fmt(c.firstSeasonForecast, lang)} (trained on ${str(v.trainPeriod)}; monthly MAE ${fmt(v.maeModel, lang, 3)} on the ${str(v.testPeriod)} test).`
      : '',
    'This is an association in time, not a cause: other factors change as well.',
  ]
    .filter(Boolean)
    .join(' ');
}

function mobilization(t: Dict, lang: Lang): string {
  const p = obj(t.probability);
  const v = obj(t.validation);
  const rows = arr(t.ranking).map(obj);
  const lines = rows.map((r) =>
    lang === 'pt'
      ? `• ${str(r.name)}: ${fmt(r.probAboveP90Pct, lang)} % (P90 histórico: ${fmt(r.p90Threshold, lang)} células-dia)`
      : `• ${str(r.name)}: ${fmt(r.probAboveP90Pct, lang)} % (historical P90: ${fmt(r.p90Threshold, lang)} cell-days)`
  );
  return lang === 'pt'
    ? `Municípios com maior probabilidade de mês acima do P90 em ${monthName(t.month, lang)} de ${fmt(t.year, lang)} (${probSource(p, lang)}):\n${lines.join('\n')}\nNo teste ${str(v.testPeriod)}, o Brier dessa probabilidade foi ${fmt(v.brierClimatology, lang, 4)}. Empates são ordenados pela proximidade do valor esperado ao P90 do município.`
    : `Municipalities with the highest probability of a month above the P90 in ${monthName(t.month, lang)} ${fmt(t.year, lang)} (${probSource(p, lang)}):\n${lines.join('\n')}\nOn the ${str(v.testPeriod)} test the Brier score of this probability was ${fmt(v.brierClimatology, lang, 4)}. Ties are ordered by how close the expected value is to the municipality's P90.`;
}

export const BURN_SAFEGUARD: Record<Lang, string> = {
  pt: 'Esta resposta não autoriza nem recomenda queimar. Queima controlada exige autorização do órgão ambiental competente (Lei 14.944/2024 e regulamentação de Goiás), plano de queima e aceiro. Consulte o órgão ambiental e o Corpo de Bombeiros.',
  en: 'This answer does not authorise or recommend burning. A controlled burn requires authorisation from the competent environmental agency (Law 14.944/2024 and Goiás regulations), a burn plan and a firebreak. Consult the environmental agency and the Fire Department.',
};

function burn(t: Dict, lang: Lang): string {
  const season = obj(t.season);
  const f = obj(t.forecast);
  const v = obj(t.validation);
  const e = obj(t.enso);
  const pw = obj(t.power);
  const names = arr(season.months).map((m) => monthName(m, lang));
  const nb = arr(t.neighbors)
    .map(obj)
    .filter((n) => num(n.value) !== null)
    .sort((a, b) => (num(b.value) ?? 0) - (num(a.value) ?? 0))
    .slice(0, 2)
    .map((n) => `${str(n.name)} (${fmt(n.value, lang)})`);
  if (lang === 'pt') {
    return [
      BURN_SAFEGUARD.pt,
      `Contexto de ${str(t.municipality)}: temporada típica de fogo em ${list(names, lang)} (base ${str(season.basePeriod)}).`,
      num(f.value) !== null
        ? `Para ${monthName(f.month, lang)} de ${fmt(f.year, lang)}, previsão de ${fmt(f.value, lang)} células-dia (intervalo P10–P90: ${fmt(f.p10, lang)} a ${fmt(f.p90, lang)}; treino ${str(v.trainPeriod)}; MAE ${fmt(v.maeModel, lang, 3)} no teste ${str(v.testPeriod)}).`
        : 'Sem dados de previsão para o mês.',
      nb.length ? `Vizinhos com maior valor esperado: ${list(nb, lang)}.` : '',
      str(e.phase) ? `ENSO: ${PHASE.pt[str(e.phase)]} (ONI ${fmt(e.anom, lang, 2)}, ${str(e.season)} ${fmt(e.year, lang)}).` : '',
      num(pw.windMeanMs) !== null
        ? `Em ${monthName(pw.month, lang)} de ${fmt(pw.year, lang)}, vento médio de ${fmt(pw.windMeanMs, lang)} m/s e umidade de ${fmt(pw.humidityMeanPct, lang)} % (NASA POWER, ${fmt(pw.nDays, lang)} dias).`
        : 'Sem dados de vento e umidade agora.',
      'Sem dados conferidos de uso do solo.',
      NOT_BEHAVIOUR.pt,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    BURN_SAFEGUARD.en,
    `Context for ${str(t.municipality)}: typical fire season in ${list(names, lang)} (base ${str(season.basePeriod)}).`,
    num(f.value) !== null
      ? `For ${monthName(f.month, lang)} ${fmt(f.year, lang)}, forecast of ${fmt(f.value, lang)} cell-days (P10–P90 interval: ${fmt(f.p10, lang)} to ${fmt(f.p90, lang)}; trained on ${str(v.trainPeriod)}; MAE ${fmt(v.maeModel, lang, 3)} on the ${str(v.testPeriod)} test).`
      : 'No forecast data for the month.',
    nb.length ? `Neighbours with the highest expected value: ${list(nb, lang)}.` : '',
    str(e.phase) ? `ENSO: ${PHASE.en[str(e.phase)]} (ONI ${fmt(e.anom, lang, 2)}, ${str(e.season)} ${fmt(e.year, lang)}).` : '',
    num(pw.windMeanMs) !== null
      ? `In ${monthName(pw.month, lang)} ${fmt(pw.year, lang)}, mean wind of ${fmt(pw.windMeanMs, lang)} m/s and humidity of ${fmt(pw.humidityMeanPct, lang)} % (NASA POWER, ${fmt(pw.nDays, lang)} days).`
      : 'No wind and humidity data right now.',
    'No verified land-use data.',
    NOT_BEHAVIOUR.en,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Template answer for an intent. Returns the no-data text when the tool reported `noData`. */
export function renderTemplate(intent: Intent, tools: readonly ToolResult[], lang: Lang): string {
  const name: Partial<Record<Intent, ToolResult['name']>> = {
    stats: 'historical_stats',
    forecast: 'forecast',
    enso: 'enso',
    intervention: 'interventions',
    mobilization: 'mobilization',
    burn: 'burn_context',
  };
  if (intent === 'help') return helpText(lang);
  const t = tool(tools, name[intent]!);
  if (!Object.keys(t).length || t.noData === true) return intent === 'burn' ? `${BURN_SAFEGUARD[lang]} ${noDataText(lang)}` : noDataText(lang);
  switch (intent) {
    case 'stats':
      return stats(t, lang);
    case 'forecast':
      return forecast(t, lang);
    case 'enso':
      return enso(t, lang);
    case 'intervention':
      return interventions(t, tool(tools, 'forecast').validation ? obj(tool(tools, 'forecast').validation) : obj(tool(tools, 'mobilization').validation), lang);
    case 'mobilization':
      return mobilization(t, lang);
    case 'burn':
      return burn(t, lang);
  }
}

/** Notices shown under the answer (freshness, synthetic data). Their numbers also come from data_status. */
export function noticesFor(tools: readonly ToolResult[], lang: Lang): string[] {
  const s = tool(tools, 'data_status');
  const out: string[] = [];
  if (str(s.dataKind) === 'synthetic') {
    out.push(lang === 'pt' ? 'Série sintética de demonstração: estes números não são dados reais do FIRMS.' : 'Synthetic demo series: these numbers are not real FIRMS data.');
  }
  if (s.stale === true) {
    out.push(
      lang === 'pt'
        ? `Dados do FIRMS até ${str(s.dataThrough)}: defasagem de ${fmt(s.staleDays, lang)} dias (mais de 24 h).`
        : `FIRMS data through ${str(s.dataThrough)}: ${fmt(s.staleDays, lang)} days old (more than 24 h).`
    );
  }
  return out;
}

/** Last resort after two failed checks: only tool facts, plus what could not be verified. */
export function verifiableOnly(tools: readonly ToolResult[], failed: string[], lang: Lang): string {
  const facts: string[] = [];
  for (const t of tools) {
    if (t.name === 'data_status') continue;
    for (const [key, value] of Object.entries(t.result)) {
      if (facts.length >= 8) break;
      if (typeof value === 'number') facts.push(`${t.name}.${key} = ${fmt(value, lang, 4)}`);
    }
  }
  return lang === 'pt'
    ? `Não consegui conferir a resposta completa. Verificável nas ferramentas: ${facts.join('; ') || 'nenhum valor numérico'}. Faltou: ${failed.join(', ')}.`
    : `I could not verify the full answer. Verifiable from the tools: ${facts.join('; ') || 'no numeric value'}. Missing: ${failed.join(', ')}.`;
}
