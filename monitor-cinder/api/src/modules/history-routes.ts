/**
 * Routes backed by the PostGIS history (real FIRMS data). They answer 503 until job:build-history has run,
 * so the front can tell "no data yet" apart from "zero fires".
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logger } from '../core/logger.js';
import {
  areaCells,
  circle,
  hasHistory,
  projection,
  readHarmonizationValidation,
  readProjectionValidation,
  recurrence,
  regionIdByIbge,
} from '../db/history.js';
import { store } from '../db/store.js';
import { areaCellsFromIndex, loadCellIndex } from '../core/cell-index.js';
import { pointInMunicipality } from '../connectors/ibge.js';

const GOIAS = { west: -53.3, south: -19.55, east: -45.85, north: -12.35 };

function problem(reply: FastifyReply, status: number, title: string, detail: string) {
  return reply
    .code(status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send({ type: 'about:blank', title, status, detail });
}

/** SQL raises carry user-facing validation messages (radius, centre, resolution); everything else is a 500 without details. */
function sqlProblem(reply: FastifyReply, err: unknown) {
  const msg = err instanceof Error ? err.message : '';
  if (/^(radius|center|invalid|centre)/i.test(msg)) return problem(reply, 400, 'Invalid request', msg);
  logger.error({ err: msg }, 'history query failed');
  return problem(reply, 500, 'Internal error', 'The history query failed.');
}

const lon = z.coerce.number().min(GOIAS.west).max(GOIAS.east);
const lat = z.coerce.number().min(GOIAS.south).max(GOIAS.north);

export async function registerHistoryRoutes(app: FastifyInstance): Promise<void> {
  // Validation numbers for the "Method & limits" page and the pitch (computed, never typed).
  app.get('/api/validation', async () => ({
    harmonization: readHarmonizationValidation(),
    projection: readProjectionValidation(),
  }));

  // Expected range for a month (P10/P50/P90 of the same month in previous years) + hindcast quality.
  app.get('/api/projection', async (req, reply) => {
    const q = z
      .object({
        ibge: z.string().regex(/^(52|52\d{5})$/),
        year: z.coerce.number().int().min(2005).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
      .safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid projection query', q.error.message);
    if (!(await hasHistory())) {
      if (store.getCalendarKind() !== 'firms_index') return problem(reply, 503, 'History not loaded', 'NASA FIRMS history not loaded yet.');
      const muni = q.data.ibge === '52' ? { name: 'Goiás' } : store.getMunicipality(q.data.ibge);
      if (!muni) return problem(reply, 404, 'Region not found', `IBGE ${q.data.ibge}`);
      const p = store.getProjection(q.data.ibge, q.data.year, q.data.month);
      return { ibge: q.data.ibge, name: muni.name, ...p };
    }
    try {
      const region = await regionIdByIbge(q.data.ibge);
      if (!region) return problem(reply, 404, 'Region not found', `IBGE ${q.data.ibge}`);
      const p = await projection(region.id, q.data.year, q.data.month);
      return { ibge: q.data.ibge, name: region.name, ...p };
    } catch (err) {
      return sqlProblem(reply, err);
    }
  });

  // History of exactly what lies inside a circle (cells whose centre is within the radius).
  app.get('/api/area/history', async (req, reply) => {
    const q = z
      .object({
        lon,
        lat,
        radiusKm: z.coerce.number().min(1).max(300),
        source: z.enum(['harmonized1k', 'viirs500']).default('harmonized1k'),
      })
      .refine((v) => v.source === 'viirs500' || v.radiusKm >= 5, { message: 'radius below 5 km needs source=viirs500' })
      .safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid area query', q.error.message);
    if (!(await hasHistory())) {
      const out = store.getCircleHistory(q.data.lon, q.data.lat, q.data.radiusKm, q.data.source);
      return out ?? problem(reply, 503, 'History not loaded', 'NASA FIRMS history not loaded yet.');
    }
    try {
      return await circle(q.data.lon, q.data.lat, q.data.radiusKm, q.data.source);
    } catch (err) {
      return sqlProblem(reply, err);
    }
  });

  // Detail inside an area: grid cells of a municipality (ibge) or of a circle (lon/lat/radiusKm) for one month.
  app.get('/api/layers/cells', async (req, reply) => {
    const q = z
      .object({
        ibge: z.string().regex(/^52\d{5}$/).optional(),
        lon: lon.optional(),
        lat: lat.optional(),
        radiusKm: z.coerce.number().min(5).max(300).optional(),
        year: z.coerce.number().int().min(2001).max(2100),
        month: z.coerce.number().int().min(1).max(12),
        res: z.coerce.number().pipe(z.union([z.literal(1000), z.literal(2000), z.literal(5000)])).default(1000),
      })
      .refine((v) => (v.ibge !== undefined) !== (v.lon !== undefined && v.lat !== undefined && v.radiusKm !== undefined), {
        message: 'give either ibge or lon+lat+radiusKm',
      })
      .safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid cells query', q.error.message);
    if (!(await hasHistory())) {
      if (q.data.ibge && !store.getMunicipality(q.data.ibge)) {
        return problem(reply, 404, 'Region not found', `IBGE ${q.data.ibge}`);
      }
      // Without PostGIS, cells come from the real FIRMS index (job:build-cell-index); never synthesized.
      const index = loadCellIndex();
      if (!index) {
        return problem(reply, 503, 'History not loaded', 'Per-cell detail needs the FIRMS history (run job:build-cell-index or job:build-history).');
      }
      const muni = q.data.ibge ? store.getMunicipality(q.data.ibge) : undefined;
      if (q.data.ibge && !muni) return problem(reply, 404, 'Region not found', `IBGE ${q.data.ibge}`);
      const out = areaCellsFromIndex(index, {
        ibge: q.data.ibge,
        lon: q.data.lon,
        lat: q.data.lat,
        radiusKm: q.data.radiusKm,
        year: q.data.year,
        month: q.data.month,
        resM: q.data.res as 1000 | 2000 | 5000,
      }, muni ? { bbox: muni.bbox, inside: (lo, la) => pointInMunicipality(la, lo, muni) } : undefined);
      return {
        source: 'firms_index',
        res: q.data.res,
        year: q.data.year,
        month: q.data.month,
        columns: ['lon', 'lat', 'cellDays', 'yearsBurned', 'lastYear'],
        ...out,
      };
    }
    try {
      let regionId: number | null = null;
      if (q.data.ibge) {
        const region = await regionIdByIbge(q.data.ibge);
        if (!region) return problem(reply, 404, 'Region not found', `IBGE ${q.data.ibge}`);
        regionId = region.id;
      }
      const out = await areaCells({
        regionId,
        lon: regionId === null ? (q.data.lon ?? null) : null,
        lat: regionId === null ? (q.data.lat ?? null) : null,
        radiusKm: regionId === null ? (q.data.radiusKm ?? null) : null,
        year: q.data.year,
        month: q.data.month,
        resM: q.data.res as 1000 | 2000 | 5000,
      });
      reply.header('Cache-Control', 'public, max-age=3600');
      return {
        res: q.data.res,
        year: q.data.year,
        month: q.data.month,
        columns: ['lon', 'lat', 'cellDays', 'yearsBurned', 'lastYear'],
        ...out,
      };
    } catch (err) {
      return sqlProblem(reply, err);
    }
  });

  // Projection with a validated uncertainty band: next days, 15 days, months and 6 months from the last observed day.
  app.get('/api/projection/horizons', async (req, reply) => {
    const q = z
      .object({
        ibge: z.string().regex(/^(52|52\d{5})$/).optional(),
        lon: lon.optional(),
        lat: lat.optional(),
        radiusKm: z.coerce.number().min(5).max(300).optional(),
      })
      .refine((v) => (v.ibge !== undefined) !== (v.lon !== undefined && v.lat !== undefined && v.radiusKm !== undefined), {
        message: 'give either ibge or lon+lat+radiusKm',
      })
      .safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid projection query', q.error.message);
    if (q.data.ibge && q.data.ibge !== '52' && !store.getMunicipality(q.data.ibge)) return problem(reply, 404, 'Region not found', `IBGE ${q.data.ibge}`);
    const area = q.data.ibge ? { ibge: q.data.ibge } : { lon: q.data.lon!, lat: q.data.lat!, radiusKm: q.data.radiusKm! };
    const out = store.getHorizons(area);
    if (!out) return problem(reply, 503, 'History not loaded', 'The daily projection needs the FIRMS index (job:build-cell-index).');
    reply.header('Cache-Control', 'public, max-age=1800');
    return { ...out.projection, hindcast: out.hindcast };
  });

  // IBGE localities (Censo 2022): vilas, povoados, comunidades — geographic reference for the map, never a fire input.
  app.get('/api/localities', async (req, reply) => {
    const q = z.object({ ibge: z.string().regex(/^52\d{5}$/).optional() }).safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid localities query', q.error.message);
    const list = store.getLocalities(q.data.ibge);
    if (!list) return problem(reply, 503, 'Localities not loaded', 'The IBGE localities are downloaded in the background on first start.');
    reply.header('Cache-Control', 'public, max-age=86400');
    return { source: 'IBGE, Base de Localidades, Censo 2022', count: list.length, localities: list.map((l) => [l.id, l.ibge, l.name, l.kind, l.lon, l.lat]) };
  });

  // Detections behind one map cell: which days and which satellite saw fire there in the month.
  app.get('/api/cell/detections', async (req, reply) => {
    const q = z.object({
      lon, lat,
      res: z.coerce.number().refine((v): v is 1000 | 2000 | 5000 => v === 1000 || v === 2000 || v === 5000).default(1000),
      year: z.coerce.number().int().min(2001).max(2100),
      month: z.coerce.number().int().min(1).max(12),
    }).safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid cell query', q.error.message);
    const r = store.getCellDetections(q.data.lon, q.data.lat, q.data.res as 1000 | 2000 | 5000, q.data.year, q.data.month);
    if (!r) return problem(reply, 503, 'History not loaded', 'Cell detections need the FIRMS index.');
    reply.header('Cache-Control', 'public, max-age=600');
    return r;
  });

  // One month day by day (calendar of the History tab): municipality, state or circle.
  app.get('/api/daily', async (req, reply) => {
    const q = z
      .object({
        ibge: z.string().regex(/^(52|52\d{5})$/).optional(),
        lon: lon.optional(),
        lat: lat.optional(),
        radiusKm: z.coerce.number().min(5).max(300).optional(),
        year: z.coerce.number().int().min(2001).max(2100),
        month: z.coerce.number().int().min(1).max(12),
      })
      .refine((v) => (v.ibge !== undefined) !== (v.lon !== undefined && v.lat !== undefined && v.radiusKm !== undefined), {
        message: 'give either ibge or lon+lat+radiusKm',
      })
      .safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid daily query', q.error.message);
    if (q.data.ibge && q.data.ibge !== '52' && !store.getMunicipality(q.data.ibge)) return problem(reply, 404, 'Region not found', `IBGE ${q.data.ibge}`);
    const area = q.data.ibge ? { ibge: q.data.ibge } : { lon: q.data.lon!, lat: q.data.lat!, radiusKm: q.data.radiusKm! };
    const days = store.getDaily(area, q.data.year, q.data.month);
    if (!days) return problem(reply, 503, 'History not loaded', 'The daily calendar needs the FIRMS index (job:build-cell-index).');
    reply.header('Cache-Control', 'public, max-age=600');
    return { year: q.data.year, month: q.data.month, unit: 'cell-days (VIIRS S-NPP scale)', days };
  });

  // Focos-raiz overlay: recurrence per cell inside the visible box, aggregated to the requested resolution.
  app.get('/api/layers/recurrence', async (req, reply) => {
    const q = z
      .object({
        west: lon,
        south: lat,
        east: lon,
        north: lat,
        from: z.coerce.number().int().min(2001).max(2100).default(2015),
        to: z.coerce.number().int().min(2001).max(2100).default(2024),
        month: z.coerce.number().int().min(1).max(12).optional(),
        source: z.enum(['harmonized1k', 'viirs500']).default('harmonized1k'),
        res: z.coerce.number().pipe(z.union([z.literal(500), z.literal(1000), z.literal(2000), z.literal(5000), z.literal(10000)])).default(1000),
        limit: z.coerce.number().int().min(1).max(20000).default(20000),
      })
      .refine((v) => v.east > v.west && v.north > v.south, { message: 'empty box' })
      .refine((v) => v.to >= v.from && v.to - v.from <= 30, { message: 'invalid period' })
      .refine((v) => v.source === 'viirs500' || v.res >= 1000, { message: '500 m needs source=viirs500' })
      .safeParse(req.query);
    if (!q.success) return problem(reply, 400, 'Invalid layer query', q.error.message);
    if (!(await hasHistory())) {
      // Without PostGIS: 1 km harmonized cells from the FIRMS index, whole year (the only grid the index has).
      if (q.data.source !== 'harmonized1k' || q.data.res !== 1000 || q.data.month !== undefined) {
        return problem(reply, 400, 'Invalid layer query', 'Without PostGIS only res=1000, source=harmonized1k and no month are available');
      }
      const out = store.getRecurrenceCells(q.data);
      if (!out) return problem(reply, 503, 'History not loaded', 'NASA FIRMS history not loaded yet.');
      reply.header('Cache-Control', 'public, max-age=3600');
      return {
        res: q.data.res,
        source: q.data.source,
        from: q.data.from,
        to: q.data.to,
        month: null,
        columns: ['lon', 'lat', 'yearsBurnedWithNeighbours', 'yearsBurned', 'lastYear', 'peakMonth'],
        ...out,
        hitRate: null, // computed only by job:build-history (PostGIS); never a fixed number
      };
    }
    try {
      const out = await recurrence({ ...q.data, month: q.data.month ?? null, resM: q.data.res as 500 | 1000 | 2000 | 5000 | 10000 });
      reply.header('Cache-Control', 'public, max-age=3600');
      return {
        res: q.data.res,
        source: q.data.source,
        from: q.data.from,
        to: q.data.to,
        month: q.data.month ?? null,
        columns: ['lon', 'lat', 'yearsBurnedWithNeighbours', 'yearsBurned', 'lastYear', 'peakMonth'],
        ...out,
        hitRate: readProjectionValidation()?.recurrence ?? null,
      };
    } catch (err) {
      return sqlProblem(reply, err);
    }
  });
}
