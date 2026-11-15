import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as history from '../db/history.js';
import { registerHistoryRoutes } from './history-routes.js';
import { registerForecastRoutes } from './forecast-routes.js';
import { registerAssistantRoutes } from './assistant-routes.js';
import { ibgeConnector } from '../connectors/ibge.js';
import {
  IbgeCodeSchema,
  MonthSchema,
  YearSchema,
} from '../core/types.js';
import { store } from '../db/store.js';
import { historyStatus } from '../core/history-status.js';
import { buildChain, isoDay } from '../core/cell-index.js';

/** FIRMS history available (PostGIS or the cell index)? Otherwise answer 503 with the load progress. */
async function requireFirmsHistory(reply: FastifyReply): Promise<boolean> {
  if ((await history.hasHistory()) || store.getCalendarKind() === 'firms_index') return true;
  const detail = historyStatus.phase === 'building'
    ? `Loading the NASA FIRMS history: year ${historyStatus.done} of ${historyStatus.total}.`
    : historyStatus.phase === 'failed'
      ? `Loading the NASA FIRMS history failed: ${historyStatus.error ?? 'unknown error'}.`
      : 'NASA FIRMS history not loaded (run job:build-cell-index or the PostGIS jobs).';
  await reply
    .code(503)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .header('Retry-After', '15')
    .send({ type: 'about:blank', title: 'History not loaded', status: 503, detail });
  return false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../../../../Mapa iterativo');

const STATIC_ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/mapa.css': { file: 'mapa.css', type: 'text/css; charset=utf-8' },
  '/config.js': { file: 'config.js', type: 'application/javascript; charset=utf-8' },
  '/i18n.js': { file: 'i18n.js', type: 'application/javascript; charset=utf-8' },
  '/mapa-engine.js': { file: 'mapa-engine.js', type: 'application/javascript; charset=utf-8' },
  '/cinder-data.js': { file: 'cinder-data.js', type: 'application/javascript; charset=utf-8' },
  '/cinder-ui.js': { file: 'cinder-ui.js', type: 'application/javascript; charset=utf-8' },
};

function sendProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string
): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({
      type: `https://httpstatuses.com/${status}`,
      title,
      status,
      detail,
    });
}

/**
 * Protects CSV exports from spreadsheet formula injection (OWASP CSV Injection).
 */
export { sanitizeCsvCell } from '../core/csv.js';
import { sanitizeCsvCell } from '../core/csv.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // 0. Static front-end routes (serves "Mapa iterativo/" directly on http://localhost:8787/)
  for (const [routePath, asset] of Object.entries(STATIC_ASSETS)) {
    app.get(routePath, async (_req: FastifyRequest, reply: FastifyReply) => {
      const fullPath = path.join(FRONTEND_DIR, asset.file);
      if (!fs.existsSync(fullPath)) {
        return sendProblem(reply, 404, 'Not Found', `Asset ${asset.file} not found`);
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      return reply.header('Content-Type', asset.type).send(content);
    });
  }

  // 1. GET /api/meta
  app.get('/api/meta', async () => {
    const fromDb = await history.hasHistory();
    const calKind = store.getCalendarKind();
    const computed = fromDb ? history.readHarmonizationValidation() : store.ensureValidationArtifacts();
    const projectionCheck = history.readProjectionValidation();
    const index = store.getIndex();
    const chain = index ? buildChain(index) : null;
    const indexYears = chain && chain.last >= chain.first
      ? [new Date(chain.first * 86_400_000).getUTCFullYear(), new Date(chain.last * 86_400_000).getUTCFullYear()] : [];
    return {
      service: 'monitor-cinder',
      // 'firms_db' = FIRMS history in PostGIS; 'firms_index' = FIRMS history in the local cell index;
      // 'loading' = being downloaded now; 'none' = not loaded. There is no synthetic mode.
      dataKind: fromDb ? 'firms_db' : calKind === 'firms_index' ? 'firms_index' : historyStatus.phase === 'building' ? 'loading' : 'none',
      historyLoad: { phase: historyStatus.phase, done: historyStatus.done, total: historyStatus.total, error: historyStatus.error },
      period: {
        firstYear: !fromDb && indexYears.length ? Math.min(...indexYears) : 2001,
        lastYear: !fromDb && indexYears.length ? Math.max(...indexYears) : 2025,
      },
      // Satellite chain behind the series (index mode): last observed day, provisional (NRT) days, error per link.
      chain: chain && chain.last >= chain.first ? {
        lastObservedDay: isoDay(chain.last),
        provisionalFrom: chain.provisionalFrom === null ? null : isoDay(chain.provisionalFrom),
        links: chain.links,
      } : null,
      supportedSensors: [
        'MODIS_NRT',
        'MODIS_SP',
        'VIIRS_SNPP_NRT',
        'VIIRS_SNPP_SP',
        'VIIRS_NOAA20_NRT',
        'VIIRS_NOAA20_SP',
        'VIIRS_NOAA21_NRT',
        'VIIRS_NOAA21_SP',
      ],
      sources: [
        {
          id: 'firms',
          name: 'NASA FIRMS (MODIS C6.1 1 km; VIIRS 375 m S-NPP, NOAA-20, NOAA-21)',
          url: 'https://firms.modaps.eosdis.nasa.gov/',
          role: 'Only input of the harmonization, the anomaly, the calendar and the projection',
        },
        {
          id: 'ibge',
          name: 'IBGE: municipal boundaries and names (UF 52) and Censo 2022 localities',
          url: 'https://servicodados.ibge.gov.br/',
          role: 'Map geography, municipal aggregation and nearest locality (reference only)',
        },
        {
          id: 'inpe_queimadas',
          name: 'INPE Programa Queimadas: state statistics (reference satellite AQUA)',
          url: 'https://data.inpe.br/queimadas/estatisticas/',
          role: 'External validation only (job:validate); never an input',
        },
        {
          id: 'nasa_power',
          name: 'NASA POWER Daily Point API (T2M_MAX, RH2M, PRECTOTCORR, WS10M)',
          url: 'https://power.larc.nasa.gov/',
          role: 'Context tab: dry-season weather; never presented as a cause',
        },
        {
          id: 'ornl_modis',
          name: 'NASA ORNL DAAC MODIS Web Service (MOD13Q1 NDVI 250 m, MCD12Q1 land cover 500 m)',
          url: 'https://modis.ornl.gov/',
          role: 'Context tab: vegetation and cropland share; never presented as a cause',
        },
      ],
      validation: computed
        ? {
            mapePct: computed.mapePct,
            wapePct: computed.wapePct,
            pearsonR: computed.pearsonR,
            biasPct: computed.biasPct,
            calibrationPeriod: computed.calibrationPeriod,
            testPeriod: computed.testPeriod,
            nMonths: computed.nMonths,
            municipalities: computed.municipalities,
            computedAt: computed.computedAt,
          }
        : null,
      projectionCheck: fromDb ? projectionCheck : null,
    };
  });

  // 2. GET /api/geo/municipalities?uf=52
  app.get('/api/geo/municipalities', async (req: FastifyRequest, reply: FastifyReply) => {
    const qSchema = z.object({ uf: z.string().regex(/^\d{2}$/).default('52') });
    const parsed = qSchema.safeParse(req.query);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid UF parameter', parsed.error.message);
    }
    const mesh = await ibgeConnector.getMeshFeatureCollection(parsed.data.uf);
    reply.header('Cache-Control', 'public, max-age=86400');
    return mesh;
  });

  // 3. GET /api/map?year=2024&month=9&metric=anomaly|count|density|typical
  app.get('/api/map', async (req: FastifyRequest, reply: FastifyReply) => {
    const qSchema = z.object({
      year: YearSchema.default(2024),
      month: MonthSchema.default(9),
      metric: z
        .enum(['anomaly', 'count', 'density', 'typical'])
        .default('anomaly'),
    });
    const parsed = qSchema.safeParse(req.query);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid map query parameters', parsed.error.message);
    }
    const { year, month, metric } = parsed.data;
    if (metric === 'typical') {
      // future months: the map shows the historical pattern of that calendar month (median of earlier years)
      if (!(await requireFirmsHistory(reply))) return reply;
      return { year, month, metric, dataKind: store.getCalendarKind(), values: store.getMapValues(year, month, 'typical') };
    }
    if (await history.hasHistory()) {
      return { year, month, metric, dataKind: 'firms_db', values: await history.mapValues(year, month, metric) };
    }
    if (!(await requireFirmsHistory(reply))) return reply;
    return {
      year,
      month,
      metric,
      dataKind: store.getCalendarKind(),
      values: store.getMapValues(year, month, metric),
    };
  });

  // 4. GET /api/municipalities/:ibge/calendar
  app.get('/api/municipalities/:ibge/calendar', async (req: FastifyRequest, reply: FastifyReply) => {
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const parsed = pSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid IBGE code', parsed.error.message);
    }
    if (await history.hasHistory()) {
      const region = await history.regionIdByIbge(parsed.data.ibge);
      if (!region) return sendProblem(reply, 404, 'Municipality not found', `IBGE ${parsed.data.ibge} not found in Goiás`);
      return { ibge: parsed.data.ibge, name: region.name, areaKm2: region.areaKm2, dataKind: 'firms_db', rows: await history.calendar(region.id) };
    }
    if (!(await requireFirmsHistory(reply))) return reply;
    const muni = store.getMunicipality(parsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${parsed.data.ibge} not found in Goiás`);
    }
    return {
      ibge: muni.ibgeCode,
      name: muni.name,
      dataKind: store.getCalendarKind(),
      rows: store.getCalendar(muni.ibgeCode),
    };
  });

  // 5. GET /api/municipalities/:ibge/pattern
  app.get('/api/municipalities/:ibge/pattern', async (req: FastifyRequest, reply: FastifyReply) => {
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const parsed = pSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid IBGE code', parsed.error.message);
    }
    if (await history.hasHistory()) {
      const region = await history.regionIdByIbge(parsed.data.ibge);
      if (!region) return sendProblem(reply, 404, 'Municipality not found', `IBGE ${parsed.data.ibge} not found in Goiás`);
      return { dataKind: 'firms_db', ...(await history.pattern(region.id)) };
    }
    if (!(await requireFirmsHistory(reply))) return reply;
    const muni = store.getMunicipality(parsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${parsed.data.ibge} not found in Goiás`);
    }
    return store.getPattern(muni.ibgeCode);
  });

  // 6. GET /api/municipalities/:ibge/context?year=2024
  app.get('/api/municipalities/:ibge/context', async (req: FastifyRequest, reply: FastifyReply) => {
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const qSchema = z.object({ year: YearSchema.default(2024) });
    const pParsed = pSchema.safeParse(req.params);
    const qParsed = qSchema.safeParse(req.query);
    if (!pParsed.success || !qParsed.success) {
      return sendProblem(reply, 400, 'Invalid parameters', 'Valid 7-digit IBGE and year (2000-2100) required');
    }
    const muni = store.getMunicipality(pParsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${pParsed.data.ibge} not found`);
    }
    const items = await store.getContextItems(muni.ibgeCode, qParsed.data.year);
    return { items };
  });

  // 7. GET /api/municipalities/:ibge/alerts
  app.get('/api/municipalities/:ibge/alerts', async (req: FastifyRequest, reply: FastifyReply) => {
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const parsed = pSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid IBGE code', parsed.error.message);
    }
    const muni = store.getMunicipality(parsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${parsed.data.ibge} not found`);
    }
    const rows = store
      .getCalendar(muni.ibgeCode)
      .filter((r) => (r.anomalyZ ?? 0) >= 1.5 && (r.harmonized ?? 0) >= 10)
      .sort((a, b) => b.year - a.year || b.month - a.month)
      .slice(0, 12);

    const alerts = rows.map((r, idx) => ({
      id: idx + 1,
      ibge: muni.ibgeCode,
      year: r.year,
      month: r.month,
      harmonizedCount: r.harmonized,
      anomalyZ: r.anomalyZ,
      message: `${muni.name}: ${String(r.month).padStart(2, '0')}/${r.year} com ${r.harmonized} células-dia harmonizadas (${r.anomalyZ}σ acima da base histórica).`,
    }));
    return { alerts };
  });

  // 8. GET /api/municipalities/:ibge/calendar.csv
  app.get('/api/municipalities/:ibge/calendar.csv', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req: FastifyRequest, reply: FastifyReply) => {
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const parsed = pSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid IBGE code', parsed.error.message);
    }
    const muni = store.getMunicipality(parsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${parsed.data.ibge} not found`);
    }
    let rows: Array<{ year: number; month: number; modis: number | null; viirs: number | null; harmonized: number | null; anomalyZ: number | null; daysMissing: number | null }>;
    if (await history.hasHistory()) {
      const region = await history.regionIdByIbge(muni.ibgeCode);
      rows = region ? await history.calendar(region.id) : [];
    } else {
      if (!(await requireFirmsHistory(reply))) return reply;
      rows = store.getCalendar(muni.ibgeCode);
    }
    const lines = [
      'ibge_code,municipality,year,month,modis_cell_days,viirs_snpp_cell_days,harmonized_cell_days,anomaly_z,days_missing',
    ];
    for (const r of rows) {
      lines.push(
        [
          sanitizeCsvCell(muni.ibgeCode),
          sanitizeCsvCell(muni.name),
          sanitizeCsvCell(r.year),
          sanitizeCsvCell(r.month),
          sanitizeCsvCell(r.modis),
          sanitizeCsvCell(r.viirs),
          sanitizeCsvCell(r.harmonized),
          sanitizeCsvCell(r.anomalyZ),
          sanitizeCsvCell(r.daysMissing),
        ].join(',')
      );
    }
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="monitor-cinder-goias-${muni.ibgeCode}.csv"`
      );
    return '\ufeff' + lines.join('\r\n');
  });

  // Real-history routes (PostGIS): projection, exact circle, focos-raiz overlay, validation
  await registerHistoryRoutes(app);

  // Forecast per municipality and month (validated against climatology and persistence)
  await registerForecastRoutes(app);

  // Conversational assistant (read-only tools + deterministic check of every answer)
  await registerAssistantRoutes(app);
}
