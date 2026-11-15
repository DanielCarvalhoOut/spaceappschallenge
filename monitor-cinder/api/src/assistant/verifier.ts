/**
 * Deterministic check of every assistant answer (zero tokens). An answer is released only if:
 *   1. every number in it exists in the result of a tool of this conversation;
 *   2. every forecast carries interval, training period and validation metric; every probability carries n and source;
 *   3. no sentence attributes cause ("associated with" is fine; "caused by" is not);
 *   4. safeguards: no fire-behaviour claim (speed, direction, reach); a controlled-burn answer cites the law, the
 *      environmental agency and the fire department, and never authorises or recommends burning.
 * The codes are fixed so the decision log can be audited.
 */
import type { ToolResult } from './tools.js';

export type Lang = 'pt' | 'en';
export type CheckCode =
  | 'NUMBER_NOT_IN_TOOLS'
  | 'FORECAST_WITHOUT_INTERVAL'
  | 'FORECAST_WITHOUT_TRAIN_PERIOD'
  | 'FORECAST_WITHOUT_METRIC'
  | 'PROBABILITY_WITHOUT_N'
  | 'PROBABILITY_WITHOUT_SOURCE'
  | 'CAUSAL_CLAIM'
  | 'FIRE_BEHAVIOUR_CLAIM'
  | 'BURN_WITHOUT_SAFEGUARD'
  | 'BURN_RECOMMENDATION'
  | 'SMALL_SAMPLE_WITHOUT_WARNING'
  | 'ASSOCIATION_NOT_IN_TOOLS'
  | 'BURN_TEXT_OUTSIDE_BURN_ANSWER'
  | 'TOO_LONG';

export interface CheckFailure {
  code: CheckCode;
  detail: string;
}
export interface Verification {
  ok: boolean;
  failures: CheckFailure[];
}

export const MAX_WORDS = 150;

/** Fixed, non-data tokens that may appear in any answer (percentile names, the law, units of the method). */
const SAFE_TOKENS: RegExp[] = [
  /\bP(10|50|90)\b/g,
  /\b(Lei|Law)\s+(n[ºo.]?\s*)?14[.,]944\/2024/gi,
  /\b1\s?km\b/gi,
  /\b24\s?h\b/gi,
  /\bn\s*=\s*(?=\d)/gi, // keeps the number, drops the "n ="
];

/** Disclaimers that mention cause / burning / fire behaviour only to deny them. Removed before the checks. */
const DISCLAIMERS: RegExp[] = [
  /n[ãa]o\s+(indica|atribui|implica|significa|é)\s+causa(lidade)?/gi,
  /sem\s+atribuir\s+causa/gi,
  /associa[çc][ãa]o,?\s+n[ãa]o\s+(uma\s+)?causa/gi,
  /(is\s+)?not\s+(a\s+)?caus(e|ation|al)/gi,
  /does\s+not\s+(imply|indicate|mean)\s+caus\w+/gi,
  /no\s+cause\s+is\s+attributed/gi,
  /n[ãa]o\s+autoriza\s+nem\s+recomenda[^.\n]*/gi,
  /does\s+not\s+authori[sz]e\s+or\s+recommend[^.\n]*/gi,
  /n[ãa]o\s+(é|são)\s+(uma\s+)?previs(ão|ões)\s+d[eo]\s+comportamento\s+do\s+fogo[^.\n]*/gi,
  /n[ãa]o\s+(de|do)\s+comportamento\s+do\s+fogo[^.\n]*/gi,
  /not\s+(a\s+forecast\s+of\s+)?fire\s+behaviou?r[^.\n]*/gi,
];

const CAUSAL =
  /\bcausad[oa]s?\b|\bcausou\b|\bcausam?\b|\bcausar(á|am|ia)?\b|\bprovoc\w+|\bdevido\s+(a|ao|aos|à|às)\b|\bpor\s+causa\s+d\w+|\bem\s+raz[ãa]o\s+d\w+|\brespons[áa]ve(l|is)\s+p(or|el[oa]s?)\b|\bcaused\s+by\b|\bcauses?\b|\bcausing\b|\bbecause\s+of\b|\bdue\s+to\b|\bleads?\s+to\b|\bresult(s|ed|ing)?\s+in\b|\bdriven\s+by\b|\bresponsible\s+for\b/i;

const FIRE_BEHAVIOUR =
  /velocidade\s+d[oe]\s+(fogo|propaga)|dire[çc][ãa]o\s+d[oe]\s+fogo|alcance\s+d[oe]\s+fogo|o\s+fogo\s+(vai|deve|ir[áa]|pode)\s+(avan[çc]ar|atingir|chegar|se\s+espalhar)|rate\s+of\s+spread|fire\s+will\s+(reach|spread|advance|move)|spread\s+(speed|rate|direction)|fire\s+(speed|direction|reach)/i;

const BURN_RECOMMENDATION =
  /\b(pode|podem|deve|devem)\s+(queimar|acender|fazer\s+a\s+queima)|recomend\w+\s+(a\s+)?(queima\w*|acender)|autoriz(o|amos|ado|ada)\b|[ée]\s+seguro\s+(queimar|acender)|boa\s+(hora|janela|época)\s+para\s+queimar|you\s+(can|may|should)\s+burn|safe\s+to\s+burn|go\s+ahead\s+(and|with)|good\s+(time|window)\s+to\s+burn|i\s+recommend\s+burning/i;

const stripAll = (text: string, patterns: RegExp[]): string => patterns.reduce((t, p) => t.replace(p, ' '), text);

/** Numbers written in the answer, parsed with the decimal mark of its language. Keeps the decimals shown. */
export function numbersInText(text: string, lang: Lang): { value: number; decimals: number; raw: string }[] {
  const clean = stripAll(text, SAFE_TOKENS);
  const out: { value: number; decimals: number; raw: string }[] = [];
  const re = /(?<![\w.,])[-−]?\d(?:[\d.,]*\d)?/g;
  for (const m of clean.matchAll(re)) {
    let raw = m[0].replace('−', '-');
    // A hyphen after a digit is a range ("2003-2019"), not a sign.
    const prev = clean[(m.index ?? 0) - 1];
    if (raw.startsWith('-') && prev !== undefined && /[\d)]/.test(prev)) raw = raw.slice(1);
    const norm = lang === 'pt' ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
    const value = Number(norm);
    if (!Number.isFinite(value)) continue;
    const dot = norm.indexOf('.');
    out.push({ value, decimals: dot < 0 ? 0 : norm.length - dot - 1, raw: m[0] });
  }
  return out;
}

/** Every number present in the tool results: numeric leaves plus digits inside strings ("2003-2019", "2025-12-31"). */
export function numbersInTools(tools: readonly ToolResult[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string') {
      for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const t of tools) walk(t.result);
  return out;
}

/** True when a tool result flags a group with a small sample (e.g. an ENSO phase with n < 5). */
function hasSmallSample(tools: readonly ToolResult[]): boolean {
  const walk = (v: unknown): boolean =>
    Array.isArray(v) ? v.some(walk) : !!v && typeof v === 'object' && (('smallSample' in v && (v as { smallSample: unknown }).smallSample === true) || Object.values(v).some(walk));
  return tools.some((t) => walk(t.result));
}

/** Tools that compare groups carry a `note` saying the result is an association (and nothing more). */
function toolsReportAssociation(tools: readonly ToolResult[]): boolean {
  return tools.some((t) => typeof t.result.note === 'string' && /association/i.test(t.result.note));
}

function inTools(n: { value: number; decimals: number }, pool: readonly number[]): boolean {
  const f = 10 ** n.decimals;
  return pool.some((t) => Math.abs(Math.round(Math.abs(t) * f) / f - Math.abs(n.value)) < 1e-9);
}

export function verifyAnswer(
  text: string,
  tools: readonly ToolResult[],
  /** scope 'notice' (freshness lines) and 'facts' (last-resort list) are not the comparison itself: no small-sample rule. */
  opts: { lang: Lang; intent: string; allowLong?: boolean; scope?: 'answer' | 'notice' | 'facts' }
): Verification {
  const failures: CheckFailure[] = [];

  // 1. numbers
  const pool = numbersInTools(tools);
  const missing = numbersInText(text, opts.lang).filter((n) => !inTools(n, pool));
  if (missing.length) failures.push({ code: 'NUMBER_NOT_IN_TOOLS', detail: [...new Set(missing.map((m) => m.raw))].slice(0, 8).join(' ') });

  // 2. forecast and probability requirements
  if (/\bprevis(ão|ões|to|ta|tos|tas)\b|\bprev[êe]\b|\bforecast\w*|\bprediction|\bpredicted\b/i.test(stripAll(text, DISCLAIMERS))) {
    if (!/P10[^.\n]{0,60}P90|\bintervalo\b|\binterval\b/i.test(text)) failures.push({ code: 'FORECAST_WITHOUT_INTERVAL', detail: 'no P10–P90 interval' });
    if (!/\btrein\w+|\btrain\w+/i.test(text)) failures.push({ code: 'FORECAST_WITHOUT_TRAIN_PERIOD', detail: 'no training period' });
    if (!/\bMAE\b|\bBrier\b/i.test(text)) failures.push({ code: 'FORECAST_WITHOUT_METRIC', detail: 'no out-of-sample metric' });
  }
  if (/\bprobabilidade|\bprobability/i.test(text)) {
    if (!/\bn\s*=\s*\d/i.test(text)) failures.push({ code: 'PROBABILITY_WITHOUT_N', detail: 'no n' });
    if (!/\bfonte\b|\bsource\b/i.test(text)) failures.push({ code: 'PROBABILITY_WITHOUT_SOURCE', detail: 'no source' });
  }

  // 3. cause, 4. safeguards
  const bare = stripAll(text, DISCLAIMERS);
  const causal = bare.match(CAUSAL);
  if (causal) failures.push({ code: 'CAUSAL_CLAIM', detail: causal[0] });
  const behaviour = bare.match(FIRE_BEHAVIOUR);
  if (behaviour) failures.push({ code: 'FIRE_BEHAVIOUR_CLAIM', detail: behaviour[0] });
  const recommend = bare.match(BURN_RECOMMENDATION);
  if (recommend) failures.push({ code: 'BURN_RECOMMENDATION', detail: recommend[0] });
  if (opts.intent === 'burn') {
    const hasLaw = /14[.,]944\/2024/.test(text);
    const hasAgency = /[óo]rg[ãa]o\s+ambiental|environmental\s+agency/i.test(text);
    const hasFire = /bombeiros|fire\s+department/i.test(text);
    const hasPlan = /plano\s+de\s+queima|burn\s+plan/i.test(text) && /aceiro|firebreak/i.test(text);
    // The denial itself must be on the page: a list of requirements alone can read as "do this and you may burn".
    const hasDenial = /n[ãa]o\s+autoriza\s+nem\s+recomenda|does\s+not\s+authori[sz]e\s+or\s+recommend/i.test(text);
    if (!(hasLaw && hasAgency && hasFire && hasPlan && hasDenial)) {
      failures.push({ code: 'BURN_WITHOUT_SAFEGUARD', detail: 'denial of authorisation, law, agency, fire department, burn plan and firebreak are required' });
    }
  }

  // Burn guidance belongs only to the fixed controlled-burn answer; in a statistics, forecast, ENSO or ranking answer
  // it is off-topic model text. (The help text lists the capability and an intervention may be a firebreak: exempt.)
  if (['stats', 'forecast', 'enso', 'mobilization'].includes(opts.intent) && /queima\s+(controlada|prescrita)|plano\s+de\s+queima|\baceiro\b|controlled\s+burn|prescribed\s+burn|burn\s+plan|\bfirebreak\b/i.test(text)) {
    failures.push({ code: 'BURN_TEXT_OUTSIDE_BURN_ANSWER', detail: 'burn guidance in an answer that is not about a controlled burn' });
  }

  // 5. a comparison with fewer than 5 cases in a group must say so
  if ((opts.scope ?? 'answer') === 'answer' && hasSmallSample(tools) && !/amostra\s+pequena|small\s+sample|\bn\s*<\s*\d/i.test(text)) {
    failures.push({ code: 'SMALL_SAMPLE_WITHOUT_WARNING', detail: 'a group has a small n and the answer does not warn about it' });
  }

  // 6. an association may be stated only when a tool reports one (ENSO, interventions); never as free interpretation
  if (/\bassociad[oa]s?\b|\bassocia[çc][ãa]o\b|\bassociat(ed|ion)\b|\bcorrela\w+|\brelacionad[oa]s?\s+(a|à|ao|com)\b|\blinked\s+to\b/i.test(text) && !toolsReportAssociation(tools)) {
    failures.push({ code: 'ASSOCIATION_NOT_IN_TOOLS', detail: 'the answer states an association that no tool reported' });
  }

  if (!opts.allowLong && text.trim().split(/\s+/).length > MAX_WORDS) failures.push({ code: 'TOO_LONG', detail: `more than ${MAX_WORDS} words` });

  return { ok: failures.length === 0, failures };
}
