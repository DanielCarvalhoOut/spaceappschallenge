import pino from 'pino';

/**
 * Redacts any 32-character hexadecimal FIRMS MAP_KEY or OAuth secrets from strings.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/\/api\/(area|country|data_availability|missing_data)\/csv\/[0-9a-fA-F]{32}/g, '/api/$1/csv/[REDACTED_MAP_KEY]')
    .replace(/[0-9a-fA-F]{32}/g, '[REDACTED_KEY]');
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'FIRMS_MAP_KEY',
      'EMBRAPA_CONSUMER_KEY',
      'EMBRAPA_CONSUMER_SECRET',
      'mapKey',
    ],
    censor: '[REDACTED]',
  },
});
