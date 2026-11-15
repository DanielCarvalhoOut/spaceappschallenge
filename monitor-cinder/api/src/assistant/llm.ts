/**
 * Optional LLM layer (only when GEMINI_API_KEY or ANTHROPIC_API_KEY is set; Gemini wins when both are). Economy rules:
 *  - the small model routes the intent; the larger model only writes multi-source analyses;
 *  - the model receives tool aggregates only (≈2 KB each), never raw hotspots;
 *  - the system prompt goes first and never changes, so the provider can cache it (explicit `cache_control` on
 *    Anthropic; implicit prefix caching on Gemini); max_tokens is low; answers are ≤ 150 words;
 *  - whatever the model writes goes through verifier.ts before it reaches the user.
 * The key never leaves the server, travels in a header (never in the URL) and is never logged (logger redaction).
 */
import { z } from 'zod';
import { redactSecrets } from '../core/logger.js';
import type { Intent } from './router.js';
import type { ToolResult } from './tools.js';
import type { CheckFailure, Lang } from './verifier.js';

export const LLM_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export const DEFAULT_MODELS: Record<LlmProvider, { router: string; writer: string }> = {
  // Checked against the live API on 15/11/2026: 2.5-flash-lite is closed to new keys (404) and "gemini-flash-latest"
  // was answering 503. 3.5-flash-lite routes in ~1 s; 3.5-flash writes in under 1 s with thinking switched off.
  gemini: { router: 'gemini-3.5-flash-lite', writer: 'gemini-3.5-flash' },
  anthropic: { router: 'claude-haiku-5-5', writer: 'claude-sonnet-5-5' },
  // Not checked against the live API (no OpenAI key on 15/11/2026): override with OPENAI_ROUTER_MODEL / OPENAI_WRITER_MODEL.
  openai: { router: 'gpt-4o-mini', writer: 'gpt-4o' },
};
const OpenAiResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })),
});
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const MAX_TOOL_BYTES = 2048;
/** Gemini models whose thinking can be switched off; the others get a larger output budget instead. */
const thinkingOff = (model: string): boolean => /^gemini-(2\.5|3\.5)-flash$/.test(model);

export const WRITER_SYSTEM = `You write short answers for Monitor Cinder, a NASA FIRMS hotspot platform for Goiás, Brazil.
Rules (an automatic checker rejects any answer that breaks them):
1. Use ONLY numbers that appear in the TOOLS JSON, written exactly as they are there (same digits). Never compute, sum, round differently or estimate new numbers. Do not number list items.
2. Every forecast states its P10–P90 interval, the training period and the MAE on the test period. Every probability states "n = <number>" and its source ("fonte:" / "source:").
3. Never attribute cause and do not discuss causality. The only sentence allowed about it is, verbatim, "É uma associação, não causa." (Portuguese) or "This is an association, not a cause." (English). Never "caused by", "due to", "because of", "leads to", "causado por", "devido a", "por causa de", "provoca", "causal", "causalidade".
4. It is a forecast of hotspot occurrence per area and month. Never state fire speed, direction or reach.
5. Never authorise or recommend lighting a fire. Do not mention controlled burns, permits or firebreaks at all: those questions are answered elsewhere with fixed text.
6. At most 120 words, plain text, no markdown, in the language requested. In Portuguese copy each number from TOOLS with a decimal comma (8523.2 becomes 8523,2); in English keep the decimal point. Never a thousands separator.
7. If the tools report noData, say there is no data and do not extrapolate.
8. Report what the tools say and nothing else: no explanation, interpretation, advice or association that is not in TOOLS. If a group has "smallSample": true, warn that the sample is small (n < 5). Give n for every group.`;

export const ROUTER_SYSTEM = `Classify the user's question for a fire-hotspot assistant. Answer with one JSON object only, no other text:
{"intent":"stats|forecast|enso|intervention|mobilization|burn|help","municipality":string|null,"year":number|null,"month":number|null,"months":number}
stats = historical pattern, season, percentiles, anomaly. forecast = expected hotspots. enso = El Niño/La Niña comparison.
intervention = declared interventions before/after. mobilization = which municipalities to prioritise. burn = controlled burn context. help = anything else.
municipality = name of the municipality of Goiás in the question, or null. month = 1-12 of the first month asked, months = how many months (1-6).`;

const AnthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const GeminiResponseSchema = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional(), finishReason: z.string().optional() }))
    .optional(),
  usageMetadata: z.object({ promptTokenCount: z.number(), candidatesTokenCount: z.number(), cachedContentTokenCount: z.number() }).partial().optional(),
});

export const LlmRouteSchema = z.object({
  intent: z.enum(['stats', 'forecast', 'enso', 'intervention', 'mobilization', 'burn', 'help']),
  municipality: z.string().max(80).nullable().catch(null),
  year: z.number().int().min(2001).max(2100).nullable().catch(null),
  month: z.number().int().min(1).max(12).nullable().catch(null),
  months: z.number().int().min(1).max(6).catch(1),
});
export type LlmRoute = z.infer<typeof LlmRouteSchema>;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly models: { router: string; writer: string };
  route(question: string): Promise<LlmRoute>;
  write(input: { question: string; intent: Intent; lang: Lang; tools: readonly ToolResult[]; previousFailures?: CheckFailure[] }): Promise<string>;
}

export interface LlmOptions {
  provider: LlmProvider;
  apiKey: string;
  routerModel?: string;
  writerModel?: string;
}

/** Tool results as sent to the model: compact JSON, truncated at ≈2 KB per tool. */
export function toolsForModel(tools: readonly ToolResult[]): string {
  return tools
    .map((t) => {
      const json = JSON.stringify(t.result);
      return `${t.name}: ${json.length > MAX_TOOL_BYTES ? `${json.slice(0, MAX_TOOL_BYTES)}…(truncated)` : json}`;
    })
    .join('\n');
}

export function createLlmClient(opts: LlmOptions, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 25_000): LlmClient {
  const models = {
    router: opts.routerModel ?? DEFAULT_MODELS[opts.provider].router,
    writer: opts.writerModel ?? DEFAULT_MODELS[opts.provider].writer,
  };

  /** One retry on 429/503 (provider overloaded); anything else fails at once and the agent falls back to the template. */
  async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    try {
      return await postOnce(url, headers, body);
    } catch (err) {
      if (!(err instanceof Error) || !/LLM HTTP (429|503)/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 800));
      return postOnce(url, headers, body);
    }
  }

  async function postOnce(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      throw new Error(redactSecrets(err instanceof Error ? err.message : 'LLM call failed').replaceAll(opts.apiKey, '[REDACTED]'));
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(model: string, system: string, user: string, maxTokens: number, json: boolean): Promise<string> {
    let text: string;
    if (opts.provider === 'anthropic') {
      const raw = await post(ANTHROPIC_URL, { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' }, {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      });
      text = AnthropicResponseSchema.parse(raw)
        .content.filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
    } else if (opts.provider === 'openai') {
      const raw = await post(OPENAI_URL, { authorization: `Bearer ${opts.apiKey}` }, {
        model,
        max_completion_tokens: maxTokens * 3, // room for reasoning models; the answer itself is short
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      });
      text = OpenAiResponseSchema.parse(raw).choices[0]?.message.content ?? '';
    } else {
      const raw = await post(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': opts.apiKey }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: thinkingOff(model) ? maxTokens : maxTokens * 3,
          temperature: 0,
          ...(json ? { responseMimeType: 'application/json' } : {}),
          // Flash can answer without "thinking" tokens: cheaper and faster for a 120-word text.
          ...(thinkingOff(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });
      const parsed = GeminiResponseSchema.parse(raw);
      text = (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text.trim()) throw new Error(`LLM returned no text (finishReason ${parsed.candidates?.[0]?.finishReason ?? 'unknown'})`);
    }
    text = text.trim();
    if (!text) throw new Error('LLM returned no text');
    return text;
  }

  return {
    provider: opts.provider,
    models,
    async route(question) {
      const text = await call(models.router, ROUTER_SYSTEM, question.slice(0, 500), 150, true);
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      return LlmRouteSchema.parse(JSON.parse(json));
    },
    async write({ question, intent, lang, tools, previousFailures }) {
      const retry = previousFailures?.length
        ? `\nYour previous answer was rejected: ${previousFailures.map((f) => `${f.code} (${f.detail})`).join('; ')}. Fix exactly that.`
        : '';
      const user = `LANGUAGE: ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}\nINTENT: ${intent}\nQUESTION: ${question.slice(0, 500)}\nTOOLS:\n${toolsForModel(tools)}${retry}`;
      return call(models.writer, WRITER_SYSTEM, user, 450, false);
    },
  };
}

/**
 * Several providers in order of preference: the first one answers; when it fails (quota, outage, bad model name) the
 * next one is tried. If all fail the error goes up and the agent serves the keyword route / template answer.
 */
export function createLlmChain(clients: readonly LlmClient[]): LlmClient | null {
  const first = clients[0];
  if (!first) return null;
  if (clients.length === 1) return first;
  async function firstThatWorks<T>(run: (c: LlmClient) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const c of clients) {
      try {
        return await run(c);
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error('all LLM providers failed');
  }
  return {
    provider: first.provider,
    models: first.models,
    route: (question) => firstThatWorks((c) => c.route(question)),
    write: (input) => firstThatWorks((c) => c.write(input)),
  };
}
