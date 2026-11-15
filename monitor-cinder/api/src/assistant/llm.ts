/**
 * Optional LLM layer (only when ANTHROPIC_API_KEY is set). Economy rules:
 *  - the small model routes the intent; the larger model only writes multi-source analyses;
 *  - the model receives tool aggregates only (≈2 KB each), never raw hotspots;
 *  - the system prompt is sent with prompt caching; max_tokens is low; answers are ≤ 150 words;
 *  - whatever the model writes goes through verifier.ts before it reaches the user.
 * The key never leaves the server and is never logged (logger redaction).
 */
import { z } from 'zod';
import { redactSecrets } from '../core/logger.js';
import type { Intent } from './router.js';
import type { ToolResult } from './tools.js';
import type { CheckFailure, Lang } from './verifier.js';

export const ROUTER_MODEL = 'claude-haiku-5-5';
export const WRITER_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
export const MAX_TOOL_BYTES = 2048;

export const WRITER_SYSTEM = `You write short answers for Monitor Cinder, a NASA FIRMS hotspot platform for Goiás, Brazil.
Rules (an automatic checker rejects any answer that breaks them):
1. Use ONLY numbers that appear in the TOOLS JSON. Never compute, round differently or estimate new numbers.
2. Every forecast states its P10–P90 interval, the training period and the MAE on the test period. Every probability states "n = <number>" and its source.
3. Never attribute cause. Say "associated with" / "associado a". Never "caused by", "due to", "because of", "causado por", "devido a".
4. It is a forecast of hotspot occurrence per area and month. Never state fire speed, direction or reach.
5. Never authorise or recommend lighting a fire. For controlled burns always say it requires authorisation from the environmental agency (Lei 14.944/2024 and Goiás regulations), a burn plan and a firebreak, and to consult the agency and the Fire Department.
6. At most 150 words, plain text, no markdown, in the language requested. Decimal comma in Portuguese, no thousands separator.
7. If the tools report noData, say there is no data and do not extrapolate.`;

export const ROUTER_SYSTEM = `Classify the user's question for a fire-hotspot assistant. Answer with one JSON object only:
{"intent":"stats|forecast|enso|intervention|mobilization|burn|help","municipality":string|null,"year":number|null,"month":number|null,"months":number}
stats = historical pattern, season, percentiles, anomaly. forecast = expected hotspots. enso = El Niño/La Niña comparison.
intervention = declared interventions before/after. mobilization = which municipalities to prioritise. burn = controlled burn context. help = anything else.`;

const ResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});

export const LlmRouteSchema = z.object({
  intent: z.enum(['stats', 'forecast', 'enso', 'intervention', 'mobilization', 'burn', 'help']),
  municipality: z.string().max(80).nullable(),
  year: z.number().int().min(2001).max(2100).nullable(),
  month: z.number().int().min(1).max(12).nullable(),
  months: z.number().int().min(1).max(6).catch(1),
});
export type LlmRoute = z.infer<typeof LlmRouteSchema>;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface LlmClient {
  route(question: string): Promise<LlmRoute>;
  write(input: { question: string; intent: Intent; lang: Lang; tools: readonly ToolResult[]; previousFailures?: CheckFailure[] }): Promise<string>;
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

export function createLlmClient(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 20_000): LlmClient {
  async function call(model: string, system: string, user: string, maxTokens: number): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const parsed = ResponseSchema.parse(await res.json());
      const text = parsed.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
        .trim();
      if (!text) throw new Error('LLM returned no text');
      return text;
    } catch (err) {
      throw new Error(redactSecrets(err instanceof Error ? err.message : 'LLM call failed').replaceAll(apiKey, '[REDACTED]'));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async route(question) {
      const text = await call(ROUTER_MODEL, ROUTER_SYSTEM, question.slice(0, 500), 120);
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      return LlmRouteSchema.parse(JSON.parse(json));
    },
    async write({ question, intent, lang, tools, previousFailures }) {
      const retry = previousFailures?.length
        ? `\nYour previous answer was rejected: ${previousFailures.map((f) => `${f.code} (${f.detail})`).join('; ')}. Fix exactly that.`
        : '';
      const user = `LANGUAGE: ${lang === 'pt' ? 'Brazilian Portuguese' : 'English'}\nINTENT: ${intent}\nQUESTION: ${question.slice(0, 500)}\nTOOLS:\n${toolsForModel(tools)}${retry}`;
      return call(WRITER_MODEL, WRITER_SYSTEM, user, 400);
    },
  };
}
