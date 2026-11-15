import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it } from 'vitest';
import { emptyState } from '../core/goes-watch.js';
import { __setWatchState, registerWatchRoutes } from '../modules/watch-routes.js';

async function app() {
  process.env.GOES_WATCH = 'off';
  process.env.GOES_WATCH_FILE = path.join(os.tmpdir(), `goes_watch_test_${process.pid}.json`);
  __setWatchState(emptyState());
  const a = Fastify();
  await a.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await registerWatchRoutes(a);
  return a;
}

describe('watch routes (opt-in GOES-19 notices)', () => {
  it('creates a circle watch, lists its alerts and the feed, then deletes it', async () => {
    const a = await app();
    const created = await a.inject({ method: 'POST', url: '/api/watch', payload: { lon: -49.25, lat: -16.68, radiusKm: 25, label: 'Goiânia' } });
    expect(created.statusCode).toBe(201);
    const { watch } = created.json() as { watch: { id: string } };
    const list = await a.inject({ method: 'GET', url: `/api/watch/${watch.id}/alerts` });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { alerts: unknown[]; feed: { activeWatches: number; source: string } };
    expect(body.alerts).toEqual([]);
    expect(body.feed.activeWatches).toBe(1);
    expect(body.feed.source).toContain('GOES-19');
    expect((await a.inject({ method: 'DELETE', url: `/api/watch/${watch.id}` })).statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: `/api/watch/${watch.id}/alerts` })).statusCode).toBe(404);
  });

  it('accepts the whole state (52) and refuses an unknown municipality code', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/watch', payload: { ibge: '52', label: 'Goiás' } })).statusCode).toBe(201);
    expect((await a.inject({ method: 'POST', url: '/api/watch', payload: { ibge: '5299999' } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/watch', payload: { ibge: '35' } })).statusCode).toBe(400);
  });

  it('refuses areas outside Goiás, unknown fields and malformed ids', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/watch', payload: { lon: -46.6, lat: -23.5, radiusKm: 20 } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/watch', payload: { lon: -49.2, lat: -16.6, radiusKm: 20, admin: true } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/watch/../../etc/alerts' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/watch/not-a-uuid/alerts' })).statusCode).toBe(400);
  });
});
