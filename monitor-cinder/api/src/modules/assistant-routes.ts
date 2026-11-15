/**
 * POST /api/assistant — conversational assistant over the read-only tools.
 * Body validated with zod, tight rate limit, problem+json errors. The LLM key (optional) stays on the server.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { answerQuestion } from '../assistant/agent.js';
import { createLlmClient, type LlmClient } from '../assistant/llm.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

const BodySchema = z
  .object({
    question: z.string().trim().min(3).max(500),
    ibge: z.string().regex(/^52\d{5}$/).optional(),
    lang: z.enum(['pt', 'en']).optional(),
  })
  .strict();

function problem(reply: FastifyReply, status: number, title: string, detail: string) {
  return reply
    .code(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type: 'about:blank', title, status, detail });
}

export async function registerAssistantRoutes(app: FastifyInstance): Promise<void> {
  const llm: LlmClient | null = config.ANTHROPIC_API_KEY ? createLlmClient(config.ANTHROPIC_API_KEY) : null;
  logger.info({ mode: llm ? 'llm' : 'template' }, 'assistant mode');

  app.post('/api/assistant', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = BodySchema.safeParse(req.body);
    if (!body.success) return problem(reply, 400, 'Invalid assistant request', body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    try {
      return await answerQuestion(body.data, { llm });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'assistant failed');
      return problem(reply, 500, 'Assistant error', 'The assistant could not answer this question.');
    }
  });
}
