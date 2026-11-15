import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as history from '../db/history.js';
import { registerHistoryRoutes } from './history-routes.js';
import { config } from '../config.js';
import { firmsConnector } from '../connectors/firms.js';
import { ibgeConnector } from '../connectors/ibge.js';
import { clusterHotspotsDbscan, estimateResourcesByFrp } from '../core/analytics.js';
import {
  FirmsSensorSchema,
  IbgeCodeSchema,
  MonthSchema,
  YearSchema,
  type FirmsSensorCode,
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

/**
 * Blocks A–D, the propensity map and the agro score stay off until they are rebuilt on real inputs
 * (they used a fixed weather table, an ML model trained on generated features and hand-set weights).
 */
const REVIEWED_INPUTS_ONLY_FEATURES = false;

/** Features whose inputs are not real yet (fixed weather table, ML trained on generated features, hand-set weights). */
async function disabledFeature(reply: FastifyReply): Promise<FastifyReply> {
  return reply
    .code(503)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({
      type: 'about:blank',
      title: 'Not available',
      status: 503,
      detail: 'Disabled: this output depended on generated inputs (weather table, ML weights) not validated with real data.',
    });
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
export function sanitizeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t\r]/.test(str)) {
    return `"'${str.replace(/"/g, '""')}"`;
  }
  if (str.includes(',') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

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
          name: 'NASA FIRMS (MODIS C6.1 1km & VIIRS 375m S-NPP/NOAA-20/NOAA-21 + Landsat NRT)',
          url: 'https://firms.modaps.eosdis.nasa.gov/',
          role: 'Core hotspot harmonization (DBSCAN/H3 1km), FRP resource scaling & 2000–Present Root Fire Archive',
        },
        {
          id: 'nasa_power',
          name: 'NASA POWER Daily & Monthly API (T2M_MAX, RH2M, PRECTOTCORR, WS10M, WD10M)',
          url: 'https://power.larc.nasa.gov/api/temporal/daily/point',
          role: 'Daily meteorological variables, ML Fire Propensity score & downwind fire propagation vector',
        },
        {
          id: 'ibge',
          name: 'IBGE Malhas e Localidades (UF 52 · Goiás)',
          url: 'https://servicodados.ibge.gov.br/',
          role: '246 municipal boundaries and spatial aggregation units',
        },
        {
          id: 'inpe_queimadas',
          name: 'INPE BDQueimadas (Satélite de Referência Aqua M-T)',
          url: 'https://terrabrasilis.dpi.inpe.br/queimadas/',
          role: 'External validation of FIRMS MODIS series',
        },
        {
          id: 'inpe_terrabrasilis',
          name: 'INPE PRODES & DETER Cerrado',
          url: 'https://terrabrasilis.dpi.inpe.br/',
          role: 'Annual deforestation & border alert context',
        },
        {
          id: 'embrapa_satveg',
          name: 'Embrapa SATVeg & NASA LP DAAC MOD13Q1 (250m NDVI/EVI)',
          url: 'https://www.satveg.cnptia.embrapa.br/',
          role: 'Biomass vigor (NDVI/EVI), dry fuel load (t/ha) & curing rate for Agro-Insurance',
        },
        {
          id: 'modis_mcd12q1',
          name: 'NASA LP DAAC MODIS MCD12Q1 v6.1 (IGBP 500m Land Cover)',
          url: 'https://lpdaac.usgs.gov/products/mcd12q1v061/',
          role: 'Cropland, pasture, savanna & Reserva Legal/APP exposure for B2B underwriting & credit audit',
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
      mlModel: null,
    };
  });

  // 1b. GET /api/ml/model
  app.get('/api/ml/model', async (_req: FastifyRequest, reply: FastifyReply) => disabledFeature(reply));

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

  // 3. GET /api/map?year=2024&month=9&metric=anomaly|count|density|propensity|agro_score
  app.get('/api/map', async (req: FastifyRequest, reply: FastifyReply) => {
    const qSchema = z.object({
      year: YearSchema.default(2024),
      month: MonthSchema.default(9),
      metric: z
        .enum(['anomaly', 'count', 'density', 'propensity', 'agro_score'])
        .default('anomaly'),
    });
    const parsed = qSchema.safeParse(req.query);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid map query parameters', parsed.error.message);
    }
    const { year, month, metric } = parsed.data;
    if (metric === 'propensity' || metric === 'agro_score') return disabledFeature(reply);
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
  app.get('/api/municipalities/:ibge/calendar.csv', async (req: FastifyRequest, reply: FastifyReply) => {
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

  // ============================================================================
  // A. Harmonização MODIS + VIIRS & Escala de Recursos (DBSCAN/H3 + FRP MW)
  // ============================================================================
  app.get('/api/municipalities/:ibge/resources', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!REVIEWED_INPUTS_ONLY_FEATURES) return disabledFeature(reply);
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const qSchema = z.object({
      year: YearSchema.default(2024),
      month: MonthSchema.default(9),
    });
    const pParsed = pSchema.safeParse(req.params);
    const qParsed = qSchema.safeParse(req.query);
    if (!pParsed.success || !qParsed.success) {
      return sendProblem(reply, 400, 'Invalid parameters', 'Valid 7-digit IBGE, year, and month required');
    }
    const muni = store.getMunicipality(pParsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${pParsed.data.ibge} not found`);
    }
    return store.getMunicipalityResourcesAndClusters(
      muni.ibgeCode,
      qParsed.data.year,
      qParsed.data.month
    );
  });

  /**
   * Direct FIRMS Area REST API Harmonizer & Spatial DBSCAN Cluster Endpoint
   * Proxies GET /api/area/csv/{MAP_KEY}/{SENSOR}/{COORDINATES}/{DAY_RANGE} safely without exposing MAP_KEY.
   */
  app.get('/api/firms/area', async (req: FastifyRequest, reply: FastifyReply) => {
    const qSchema = z.object({
      sensor: z
        .union([FirmsSensorSchema, z.literal('ALL')])
        .default('ALL'),
      bbox: z.string().default(config.GOIAS_BBOX),
      days: z.coerce.number().int().min(1).max(5).default(2),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      epsMeters: z.coerce.number().min(100).max(5000).default(1000),
    });
    const parsed = qSchema.safeParse(req.query);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid FIRMS area query parameters', parsed.error.message);
    }

    const coordParts = parsed.data.bbox.split(',').map(Number);
    if (
      coordParts.length !== 4 ||
      coordParts.some((n) => !Number.isFinite(n)) ||
      coordParts[0]! >= coordParts[2]! ||
      coordParts[1]! >= coordParts[3]!
    ) {
      return sendProblem(reply, 400, 'Invalid bbox', 'Expected west,south,east,north with west < east and south < north');
    }
    const bbox: [number, number, number, number] = [
      coordParts[0]!,
      coordParts[1]!,
      coordParts[2]!,
      coordParts[3]!,
    ];

    const sensors: FirmsSensorCode[] =
      parsed.data.sensor === 'ALL'
        ? ['MODIS_NRT', 'MODIS_SP', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'LANDSAT_NRT']
        : [parsed.data.sensor];

    const hotspots = await firmsConnector.fetchMultiSensorArea(
      bbox,
      parsed.data.days,
      sensors,
      parsed.data.date
    );
    const clusters = clusterHotspotsDbscan(hotspots, parsed.data.epsMeters);
    const meanFrp =
      clusters.length > 0
        ? clusters.reduce((a, c) => a + c.meanFrpMw, 0) / clusters.length
        : 0;
    const maxFrp =
      clusters.length > 0 ? Math.max(...clusters.map((c) => c.maxFrpMw)) : 0;
    const scaling = estimateResourcesByFrp(
      clusters.length,
      hotspots.length,
      meanFrp,
      maxFrp
    );

    return {
      endpointTemplate: 'GET /api/area/csv/{MAP_KEY}/{SENSOR}/{COORDINATES}/{DAY_RANGE}',
      sensorsQueried: sensors,
      bbox,
      dayRange: parsed.data.days,
      epsMeters: parsed.data.epsMeters,
      rawHotspotsCount: hotspots.length,
      deduplicatedClustersCount: clusters.length,
      scaling,
      clusters: clusters.slice(0, 100),
    };
  });

  // ============================================================================
  // B. Calendário de Focos Raízes & Histórico (2000–Presente)
  // ============================================================================
  app.get('/api/municipalities/:ibge/root-fires', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!REVIEWED_INPUTS_ONLY_FEATURES) return disabledFeature(reply);
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const parsed = pSchema.safeParse(req.params);
    if (!parsed.success) {
      return sendProblem(reply, 400, 'Invalid IBGE code', parsed.error.message);
    }
    const muni = store.getMunicipality(parsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${parsed.data.ibge} not found`);
    }
    return store.getRootFireAnalysis(muni.ibgeCode);
  });

  // ============================================================================
  // C. Clima e Previsibilidade de Ocorrência (NASA POWER Daily Point)
  // ============================================================================
  app.get('/api/municipalities/:ibge/predictability', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!REVIEWED_INPUTS_ONLY_FEATURES) return disabledFeature(reply);
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const qSchema = z.object({
      year: YearSchema.default(2024),
      month: MonthSchema.default(9),
    });
    const pParsed = pSchema.safeParse(req.params);
    const qParsed = qSchema.safeParse(req.query);
    if (!pParsed.success || !qParsed.success) {
      return sendProblem(reply, 400, 'Invalid parameters', 'Valid 7-digit IBGE, year, and month required');
    }
    const muni = store.getMunicipality(pParsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${pParsed.data.ibge} not found`);
    }
    return store.getPredictabilityAndWeather(
      muni.ibgeCode,
      qParsed.data.year,
      qParsed.data.month
    );
  });

  // ============================================================================
  // D. Score Agrícola para Seguros & Inteligência B2B
  //    (FIRMS + NASA POWER + MOD13Q1 Biomassa/Safra + MCD12Q1 Uso do Solo)
  // ============================================================================
  const handleAgroScore = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!REVIEWED_INPUTS_ONLY_FEATURES) return disabledFeature(reply);
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const qSchema = z.object({
      year: YearSchema.default(2024),
      month: MonthSchema.default(9),
    });
    const pParsed = pSchema.safeParse(req.params);
    const qParsed = qSchema.safeParse(req.query);
    if (!pParsed.success || !qParsed.success) {
      return sendProblem(reply, 400, 'Invalid parameters', 'Valid 7-digit IBGE, year, and month required');
    }
    const muni = store.getMunicipality(pParsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${pParsed.data.ibge} not found`);
    }
    const report = await store.getAgroB2BRiskReport(
      muni.ibgeCode,
      qParsed.data.year,
      qParsed.data.month
    );
    const isLive = store.hasLiveSatelliteData(muni.ibgeCode, qParsed.data.year, qParsed.data.month);
    return {
      ibge: muni.ibgeCode,
      name: muni.name,
      year: qParsed.data.year,
      month: qParsed.data.month,
      telemetryMode: isLive ? 'live_satellite' : 'fallback_mock',
      ...report,
    };
  };
  app.get('/api/municipalities/:ibge/agro-score', handleAgroScore);
  app.get('/api/municipalities/:ibge/b2b-risk', handleAgroScore);

  // ============================================================================
  // Unified Intelligence Endpoint (A + B + C + D in a single round-trip)
  // ============================================================================
  app.get('/api/municipalities/:ibge/intelligence', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!REVIEWED_INPUTS_ONLY_FEATURES) return disabledFeature(reply);
    const pSchema = z.object({ ibge: IbgeCodeSchema });
    const qSchema = z.object({
      year: YearSchema.default(2024),
      month: MonthSchema.default(9),
    });
    const pParsed = pSchema.safeParse(req.params);
    const qParsed = qSchema.safeParse(req.query);
    if (!pParsed.success || !qParsed.success) {
      return sendProblem(reply, 400, 'Invalid parameters', 'Valid 7-digit IBGE, year, and month required');
    }
    const muni = store.getMunicipality(pParsed.data.ibge);
    if (!muni) {
      return sendProblem(reply, 404, 'Municipality not found', `IBGE ${pParsed.data.ibge} not found`);
    }
    const { year, month } = qParsed.data;
    const [resources, rootFires, predictability, agroB2B] = await Promise.all([
      Promise.resolve(store.getMunicipalityResourcesAndClusters(muni.ibgeCode, year, month)),
      Promise.resolve(store.getRootFireAnalysis(muni.ibgeCode)),
      store.getPredictabilityAndWeather(muni.ibgeCode, year, month),
      store.getAgroB2BRiskReport(muni.ibgeCode, year, month),
    ]);
    const isLive = store.hasLiveSatelliteData(muni.ibgeCode, year, month);

    return {
      ibge: muni.ibgeCode,
      name: muni.name,
      year,
      month,
      telemetryMode: isLive ? 'live_satellite' : 'fallback_mock',
      resources,
      rootFires,
      predictability,
      agroB2B,
    };
  });

  // Real-history routes (PostGIS): projection, exact circle, focos-raiz overlay, validation
  await registerHistoryRoutes(app);
}
