/**
 * The assistant's decision cycle. The code chooses every edge; the LLM (when there is one) only writes:
 *
 *   route (keywords, or the small model) → read-only tools → write (template, or the larger model for multi-source
 *   answers) → deterministic check → at most one rewrite → template → "verifiable only".
 *
 * Works without any LLM key: routing by keywords and answers by templates filled with the tool results.
 * Every check is appended to the decision log (out/logs/assistant_decisions.jsonl): pass/fail and the reason.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { store } from '../db/store.js';
import type { LlmClient } from './llm.js';
import { findPlace, routeQuestion, type Intent, type Place, type Route } from './router.js';
import { helpText, noDataText, noticesFor, renderTemplate, verifiableOnly } from './templates.js';
import { burnContext, dataStatus, ensoComparison, forecastWindow, historicalStats, interventionsFor, mobilizationRanking, type ToolResult } from './tools.js';
import { verifyAnswer, type CheckFailure, type Lang } from './verifier.js';

/** Intents that combine more than one source: the only ones the larger model is allowed to write. */
export const MULTI_SOURCE: readonly Intent[] = ['enso', 'intervention', 'burn'];
const CACHE_MAX = 500;

export interface AssistantRequest {
  question: string;
  ibge?: string;
  lang?: Lang;
}

export interface AssistantReply {
  answer: string;
  lang: Lang;
  intent: Intent | 'no_data';
  reason: string;
  mode: 'template' | 'llm';
  verified: boolean;
  cached: boolean;
  municipality: { ibge: string; name: string } | null;
  period: { year: number | null; month: number | null; months: number };
  notices: string[];
  tools: ToolResult[];
  checks: { attempt: number; writer: 'llm' | 'template' | 'verifiable_only'; ok: boolean; failures: CheckFailure[] }[];
}

export interface AgentDeps {
  now?: Date;
  llm?: LlmClient | null;
  /** Tests switch the live NASA POWER call off. */
  fetchPower?: boolean;
  logFile?: string | null;
}

const cache = new Map<string, AssistantReply>();
export const clearAssistantCache = (): void => cache.clear();

function logDecision(file: string | null | undefined, entry: Record<string, unknown>): void {
  if (file === null) return;
  const target = file ?? path.join(config.outDir, 'logs', 'assistant_decisions.jsonl');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'assistant decision log not written');
  }
}

async function runTools(route: Route, now: Date, deps: AgentDeps): Promise<ToolResult[]> {
  const tools: ToolResult[] = [dataStatus(now)];
  const ibge = route.ibge;
  const muni = ibge && ibge !== '52' ? ibge : null;
  const y = route.year ?? now.getUTCFullYear();
  const m = route.month ?? now.getUTCMonth() + 1;
  switch (route.intent) {
    case 'stats':
      if (muni) tools.push(historicalStats(muni, route.year ?? undefined, route.month ?? undefined));
      break;
    case 'forecast':
      if (muni) tools.push(forecastWindow(muni, y, m, route.months));
      break;
    case 'enso':
      tools.push(ensoComparison(ibge ?? '52', route.month ?? (muni ? (store.getPattern(muni).season.peakMonth ?? 9) : 9)));
      break;
    case 'intervention':
      if (muni) tools.push(interventionsFor(muni), forecastWindow(muni, y, m, 1));
      break;
    case 'mobilization':
      tools.push(mobilizationRanking(y, m));
      break;
    case 'burn':
      if (muni) tools.push(await burnContext(muni, y, m, { fetchPower: deps.fetchPower }));
      break;
    case 'help':
      break;
  }
  return tools;
}

export async function answerQuestion(req: AssistantRequest, deps: AgentDeps = {}): Promise<AssistantReply> {
  const now = deps.now ?? new Date();
  const places: Place[] = [...store.getMunicipalities().values()].map((m) => ({ ibge: m.ibgeCode, name: m.name }));
  let route = routeQuestion(req, places, now);
  let mode: 'template' | 'llm' = 'template';

  // Small model as router; any failure falls back to the keyword route already computed.
  if (deps.llm) {
    try {
      const r = await deps.llm.route(req.question);
      const place = r.municipality ? findPlace(r.municipality, places).place : null;
      const merged = routeQuestion({ ...req, question: req.question }, places, now);
      route = {
        ...merged,
        intent: r.intent,
        reason: `router model (${r.intent})`,
        ibge: place?.ibge ?? merged.ibge,
        year: r.year ?? merged.year,
        month: r.month ?? merged.month,
        months: r.months > 1 ? r.months : merged.months,
      };
      mode = 'llm';
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'router model failed; using keyword routing');
    }
  }

  const lang = route.lang;
  const needsPlace = route.intent === 'stats' || route.intent === 'forecast' || route.intent === 'intervention' || route.intent === 'burn';
  const muni = route.ibge && route.ibge !== '52' ? store.getMunicipality(route.ibge) : undefined;
  const base = {
    lang,
    reason: route.reason,
    municipality: muni ? { ibge: muni.ibgeCode, name: muni.name } : null,
    period: { year: route.year, month: route.month, months: route.months },
  };

  // Outside Goiás, or an intent that needs a municipality without one: "no data", never an extrapolation.
  if (route.outside || (needsPlace && !muni)) {
    const text = route.outside || route.ibge === null ? noDataText(lang) : helpText(lang);
    const tools = [dataStatus(now)];
    const check = verifyAnswer(text, tools, { lang, intent: 'no_data' });
    logDecision(deps.logFile, { ts: now.toISOString(), intent: 'no_data', mode: 'template', attempt: 1, ok: check.ok, failures: check.failures });
    return { ...base, answer: text, intent: 'no_data', mode: 'template', verified: check.ok, cached: false, notices: [], tools, checks: [{ attempt: 1, writer: 'template', ok: check.ok, failures: check.failures }] };
  }

  const useWriter = mode === 'llm' && MULTI_SOURCE.includes(route.intent);
  const key = [route.ibge ?? '-', route.intent, `${route.year ?? '-'}-${route.month ?? '-'}-${route.months}`, lang, useWriter ? 'llm' : 'template'].join('|');
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const tools = await runTools(route, now, deps);
  const notices = noticesFor(tools, lang);
  const qHash = crypto.createHash('sha256').update(req.question).digest('hex').slice(0, 12);
  const checks: AssistantReply['checks'] = [];
  const check = (text: string, attempt: number, writer: 'llm' | 'template' | 'verifiable_only'): boolean => {
    // Notices are checked together with the answer (their numbers also come from tools); the word limit is the answer's.
    const v = verifyAnswer(text, tools, { lang, intent: route.intent });
    const n = verifyAnswer(notices.join(' '), tools, { lang, intent: 'notice', allowLong: true });
    const failures = [...v.failures, ...n.failures];
    checks.push({ attempt, writer, ok: failures.length === 0, failures });
    logDecision(deps.logFile, { ts: now.toISOString(), q: qHash, intent: route.intent, ibge: route.ibge, writer, attempt, ok: failures.length === 0, failures });
    return failures.length === 0;
  };

  let answer: string | null = null;
  let writer: 'llm' | 'template' = 'template';
  if (useWriter && deps.llm) {
    // write → check → write again with the failures → check (at most 2 attempts; an infrastructure error ends the loop)
    for (let attempt = 1; attempt <= 2 && answer === null; attempt++) {
      try {
        const draft = await deps.llm.write({ question: req.question, intent: route.intent, lang, tools, previousFailures: checks[checks.length - 1]?.failures });
        if (check(draft, attempt, 'llm')) {
          answer = draft;
          writer = 'llm';
        }
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'writer model failed; using the template');
        break;
      }
    }
  }
  let verified = answer !== null;
  if (answer === null) {
    const draft = renderTemplate(route.intent, tools, lang);
    if (check(draft, checks.length + 1, 'template')) {
      answer = draft;
      verified = true;
    } else {
      // Two failed checks: answer only with what is verifiable and say what was missing.
      const failed = [...new Set(checks.flatMap((c) => c.failures.map((f) => f.code)))];
      answer = verifiableOnly(tools, failed, lang);
      verified = check(answer, checks.length + 1, 'verifiable_only');
    }
  }

  const reply: AssistantReply = { ...base, answer, intent: route.intent, mode: writer === 'llm' || mode === 'llm' ? 'llm' : 'template', verified, cached: false, notices, tools, checks };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, reply);
  return reply;
}
