/**
 * Keyword router (zero tokens): question → intent, place and period, with the reason for the choice.
 * It is the only router in no-LLM mode and the fallback whenever the LLM router fails.
 */
import type { Lang } from './verifier.js';

export type Intent = 'stats' | 'forecast' | 'enso' | 'intervention' | 'mobilization' | 'burn' | 'help';

export interface Route {
  intent: Intent;
  reason: string;
  /** Municipality of Goiás (7 digits), '52' for the state, or null when none was named or selected. */
  ibge: string | null;
  /** The question names a place outside Goiás (an IBGE code that is not a Goiás municipality). */
  outside: boolean;
  year: number | null;
  month: number | null;
  months: number;
  lang: Lang;
}

export interface Place {
  ibge: string;
  name: string;
}

export const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const MONTHS: [RegExp, number][] = [
  [/\b(janeiro|january|jan)\b/, 1],
  [/\b(fevereiro|february|fev|feb)\b/, 2],
  [/\b(marco|march|mar)\b/, 3],
  [/\b(abril|april|abr|apr)\b/, 4],
  [/\b(maio|may|mai)\b/, 5],
  [/\b(junho|june|jun)\b/, 6],
  [/\b(julho|july|jul)\b/, 7],
  [/\b(agosto|august|ago|aug)\b/, 8],
  [/\b(setembro|september|set|sep|sept)\b/, 9],
  [/\b(outubro|october|out|oct)\b/, 10],
  [/\b(novembro|november|nov)\b/, 11],
  [/\b(dezembro|december|dez|dec)\b/, 12],
];

const RULES: [Intent, RegExp][] = [
  ['burn', /\bqueima (controlada|prescrita)\b|\bqueimar\b|\bacender\b|\baceiro\b|\bprescribed\b|\bcontrolled burn|\bcan i burn|\bburn (permit|window|my|the)\b/],
  ['intervention', /\binterven\w+|\bbrigada\w*|\bantes e depois\b|\bbefore and after\b|\bcampanha\w*/],
  ['mobilization', /\bmobiliz\w+|\bprioriz\w+|\bprioriti[sz]\w+|\branking\b|\bquais municipios\b|\bwhich municipalities\b|\bonde (enviar|concentrar|alocar)\b|\bwhere to (send|deploy)\b/],
  ['enso', /\bel nino\b|\bla nina\b|\benso\b|\boni\b/],
  ['forecast', /\bprevis\w+|\bprever\b|\bforecast\w*|\bpredict\w*|\besperad\w+|\bexpected\b|\bproxim\w+|\bnext\b|\bmes que vem\b|\bprobabilidade\b|\bprobability\b|\brisco\b|\brisk\b/],
  ['stats', /\bhistoric\w+|\btemporada\b|\bseason\b|\btipic\w+|\btypical\b|\bpercenti\w+|\banomal\w+|\bmedia\b|\baverage\b|\bfrequen\w+|\bnormal\b|\bpadrao\b|\bpattern\b|\bquantos focos\b|\bhow many\b|\bpico\b|\bpeak\b/],
];

export function detectLang(question: string, hint?: Lang): Lang {
  if (hint) return hint;
  const q = norm(question);
  const en = (q.match(/\b(what|which|how|the|is|are|in|for|season|forecast|when|where|should)\b/g) ?? []).length;
  const pt = (q.match(/\b(qual|quais|como|o|a|os|as|em|para|de|do|da|temporada|previsao|quando|onde)\b/g) ?? []).length;
  return en > pt ? 'en' : 'pt';
}

/** Longest municipality name written in the question. "Goiás" alone means the state, unless "cidade/município de Goiás". */
export function findPlace(question: string, places: readonly Place[]): { place: Place | null; state: boolean; outside: boolean } {
  const q = ` ${norm(question)} `;
  const code = q.match(/\b(\d{7})\b/);
  if (code) {
    const hit = places.find((p) => p.ibge === code[1]);
    return hit ? { place: hit, state: false, outside: false } : { place: null, state: false, outside: true };
  }
  let best: Place | null = null;
  for (const p of places) {
    const n = norm(p.name);
    if (!q.includes(` ${n} `)) continue;
    if (n === 'goias' && !/\b(cidade|municipio|city|municipality) (de|of) goias\b/.test(q)) continue;
    if (!best || n.length > norm(best.name).length) best = p;
  }
  return { place: best, state: !best && /\bgoias\b|\bestado\b|\bstate\b/.test(q), outside: false };
}

export function routeQuestion(input: { question: string; ibge?: string; lang?: Lang }, places: readonly Place[], now: Date): Route {
  const q = norm(input.question);
  const lang = detectLang(input.question, input.lang);

  const found = findPlace(input.question, places);
  const selected = input.ibge && places.some((p) => p.ibge === input.ibge) ? input.ibge : null;
  const ibge = found.place?.ibge ?? (found.state ? '52' : selected);

  let intent: Intent | null = null;
  let reason = '';
  for (const [name, re] of RULES) {
    const m = q.match(re);
    if (m) {
      intent = name;
      reason = `keyword "${m[0]}"`;
      break;
    }
  }
  if (!intent) {
    intent = ibge && ibge !== '52' ? 'stats' : 'help';
    reason = intent === 'stats' ? 'municipality named, no keyword: historical statistics by default' : 'no keyword and no municipality';
  }

  const monthsFound: number[] = [];
  for (const [re, num] of MONTHS) {
    const m = q.match(re);
    if (m && m.index !== undefined) monthsFound.push(m.index * 100 + num);
  }
  monthsFound.sort((a, b) => a - b);
  const m1 = monthsFound.length ? monthsFound[0]! % 100 : null;
  const m2 = monthsFound.length > 1 ? monthsFound[monthsFound.length - 1]! % 100 : null;
  const yearMatch = q.match(/\b(20\d{2})\b/);
  let year = yearMatch ? Number(yearMatch[1]) : null;
  let month = m1;
  let months = m1 !== null && m2 !== null && m2 !== m1 ? ((m2 - m1 + 12) % 12) + 1 : 1;

  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth() + 1;
  const wantsFuture = intent === 'forecast' || intent === 'mobilization' || intent === 'burn';
  if (wantsFuture) {
    if (/\b(temporada|dry season|estacao seca|seca)\b/.test(q) && month === null) {
      month = 5;
      months = 6;
    }
    if (month === null) {
      // "next month" is also the default window of a forecast question without dates.
      month = nowM === 12 ? 1 : nowM + 1;
      year ??= nowM === 12 ? nowY + 1 : nowY;
    }
    year ??= month >= nowM ? nowY : nowY + 1;
  }

  return { intent, reason, ibge, outside: found.outside, year, month, months: Math.min(6, months), lang };
}
