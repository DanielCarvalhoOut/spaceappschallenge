/**
 * Forecast of hotspot cell-days per municipality and month (read-only).
 * Every answer carries the interval, the training period and the out-of-sample metric. 503 until job:forecast has run.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ForecastValidation } from '../core/forecast.js';
import { logger } from '../core/logger.js';
import { getForecast, getForecastContext, primeForecastContext, readForecastValidation } from '../db/forecast-service.js';
import { store } from '../db/store.js';

function problem(reply: FastifyReply, status: number, title: string, detail: string) {
  return reply
    .code(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type: 'about:blank', title, status, detail });
}

/** The part of the validation that travels with every forecast (small on purpose). */
export function validationSummary(v: ForecastValidation) {
  return {
    trainPeriod: `${v.trainPeriod.from}-${v.trainPeriod.to}`,
    testPeriod: `${v.testPeriod.from}-${v.testPeriod.to}`,
    nTest: v.nTest,
    mae: v.mae,
    maeClimatologyMedian: v.maeClimatologyMedian,
    skillVsClimatologyPct: v.skillVsClimatologyPct,
    brier: v.exceedance.brier,
    coverageP10P90Pct: v.coverageP10P90Pct,
    official: v.official,
    probabilityOfficial: v.exceedance.official,
    dataKind: v.dataKind,
  };
}

export async function registerForecastRoutes(app: FastifyInstance): Promise<void> {
  // PostGIS series when the history is complete, in-memory series otherwise (decided once, at start-up).
  const ctx0 = await primeForecastContext();
  logger.info({ dataKind: ctx0.dataKind, dataThrough: ctx0.dataThrough }, 'forecast series');

  app.get('/api/forecast/validation', async (_req, reply) => {
    const v = readForecastValidation();
    if (!v) return problem(reply, 503, 'Forecast not validated yet', 'Run: npm run job:forecast');
    return v;
  });

  app.get('/api/forecast', async (req, reply) => {
    const q = z
      .object({
        ibge: z.string().regex(/^52\d{5}$/),
        year: z.coerce.number().int().min(2003).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
      .safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid forecast query', q.error.message);
    const muni = store.getMunicipality(q.data.ibge);
    if (!muni) return problem(reply, 404, 'Municipality not found', `IBGE ${q.data.ibge} is not a municipality of Goiás`);
    const out = getForecast(q.data.ibge, q.data.year, q.data.month);
    if (!out) return problem(reply, 503, 'Forecast not available', 'Run: npm run job:forecast (the artifact must match the series being served)');
    const ctx = getForecastContext();
    return {
      name: muni.name,
      unit: out.validation.series.unit,
      ...out.forecast,
      dataThrough: ctx.dataThrough,
      validation: validationSummary(out.validation),
    };
  });
}
