import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { logger, redactSecrets } from './core/logger.js';
import { store } from './db/store.js';
import { registerRoutes } from './modules/routes.js';
import { isMain } from './core/entry.js';
import { hasHistory } from './db/history.js';
import { loadCellIndex } from './core/cell-index.js';
import { historyStatus } from './core/history-status.js';
import { runBuildCellIndex } from './jobs/build-cell-index.js';
import { fetchLocalities, loadCachedLocalities } from './connectors/ibge-localities.js';

/** IBGE localities (Censo 2022): cached in data/; downloaded once in the background when missing. Map reference only. */
export function startLocalitiesLoad(): void {
  const cached = loadCachedLocalities('52');
  if (cached) { store.setLocalities(cached); return; }
  void (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try { store.setLocalities(await fetchLocalities('52', 'GO', ctrl.signal)); }
    catch (err) { logger.warn({ err: redactSecrets(err instanceof Error ? err.message : String(err)) }, 'IBGE localities not loaded (map works without them)'); }
    finally { clearTimeout(t); }
  })();
}

/**
 * Without PostGIS history and without the cell index, load the real FIRMS history in the background
 * (job:build-cell-index). The API answers meanwhile; data routes return 503 with the progress.
 */
export function startHistoryLoadIfMissing(): void {
  if (historyStatus.phase === 'building') return;
  void (async () => {
    if (await hasHistory()) { historyStatus.phase = 'ready'; return; }
    const existing = loadCellIndex();
    // An index older than 6 h is refreshed in the background (only the current year is fetched again);
    // meanwhile the API keeps serving it.
    // ...and also when it stops more than 3 days before today (a year or a satellite failed to load).
    const lastDay = existing ? Math.max(...Object.values(existing.sensors).map((r) => r.last ?? -1)) : -1;
    const behind = Math.floor(Date.now() / 86_400_000) - lastDay > 3;
    if (existing && !behind && Date.now() - Date.parse(existing.builtAt) < 6 * 3_600_000) { historyStatus.phase = 'ready'; return; }
    historyStatus.phase = existing ? 'ready' : 'building';
    historyStatus.startedAt = new Date().toISOString();
    historyStatus.error = null;
    logger.info(existing ? 'Refreshing the FIRMS history up to today in the background' : 'No FIRMS history yet: loading it in the background (job:build-cell-index, 2001 to today)');
    try {
      await runBuildCellIndex(2001);
      store.reloadFromIndex();
      historyStatus.phase = 'ready';
    } catch (err) {
      historyStatus.phase = 'failed';
      historyStatus.error = redactSecrets(err instanceof Error ? err.message : String(err));
      logger.error({ err: historyStatus.error }, 'FIRMS history load failed');
    }
  })();
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN,
    methods: ['GET', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    const safeMsg = redactSecrets(err.message || 'Internal Server Error');
    if (status >= 500) {
      logger.error({ err: safeMsg }, 'Unhandled API error');
    }
    return reply
      .code(status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send({
        type: `https://httpstatuses.com/${status}`,
        title: status === 429 ? 'Too Many Requests' : status >= 500 ? 'Internal Server Error' : 'Bad Request',
        status,
        detail: status >= 500 ? 'An unexpected server error occurred' : safeMsg,
      });
  });

  await store.init();
  await registerRoutes(app);

  return app;
}

if (isMain(import.meta.url)) {
  buildApp()
    .then(async (app) => {
      await app.listen({ port: config.PORT, host: config.HOST });
      logger.info({ port: config.PORT, host: config.HOST }, 'Monitor Cinder API listening');
      startHistoryLoadIfMissing();
      startLocalitiesLoad();
    })
    .catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start server');
      process.exit(1);
    });
}
