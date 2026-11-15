import pino from 'pino';

/**
 * Redacts any 32-character hexadecimal FIRMS MAP_KEY or OAuth secrets from strings.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/\/api\/(area|country|data_availability|missing_data)\/csv\/[0-9a-fA-F]{32}/g, '/api/$1/csv/[REDACTED_MAP_KEY]')
    .replace(/[0-9a-fA-F]{32}/g, '[REDACTED_KEY]')
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_LLM_KEY]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_LLM_KEY]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_LLM_KEY]');
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'FIRMS_MAP_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENAI_API_KEY',
      'req.headers["x-goog-api-key"]',
      'apiKey',
      'req.headers["x-api-key"]',
      'mapKey',
    ],
    censor: '[REDACTED]',
  },
});
