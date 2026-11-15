/**
 * End-to-end assistant over the real series: PostGIS (fire.calendar_monthly) when its history has both sensors, else
 * the local FIRMS cell index (data/, not in git). Needs out/forecast_validation.json built from that same series;
 * skipped otherwise, like the database tests. No LLM and no POWER call.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { answerQuestion, clearAssistantCache } from '../assistant/agent.js';
import type { LlmClient } from '../assistant/llm.js';
import { numbersInTools, numbersInText } from '../assistant/verifier.js';
import { primeForecastContext, readForecastValidation } from '../db/forecast-service.js';
import { store } from '../db/store.js';

// Real series = PostGIS when its history is complete, else the local cell index. The artifact must describe that series.
await store.init();
const ctx = await primeForecastContext();
const ready = ctx.dataKind !== 'synthetic' && readForecastValidation()?.dataKind === ctx.dataKind;
const now = new Date('2026-11-15T12:00:00Z');
const deps = { now, fetchPower: false, logFile: null };

describe.skipIf(!ready)('assistant over the real series (no LLM)', () => {
  beforeAll(async () => {
    await store.init();
    clearAssistantCache();
  });

  const cases: [string, string][] = [
    ['Qual a temporada típica de fogo em Cavalcante?', 'stats'],
    ['Qual a previsão de focos para Goiânia em setembro de 2026?', 'forecast'],
    ['Como ficam os focos em Goiás em anos de El Niño em setembro?', 'enso'],
    ['Houve alguma intervenção em Cavalcante?', 'intervention'],
    ['Quais municípios priorizar em setembro de 2026?', 'mobilization'],
    ['Posso fazer queima controlada em Niquelândia em agosto de 2026?', 'burn'],
  ];

  it.each(cases)('%s → %s, verified, tools ≤ 2 KB, numbers from the tools', async (question, intent) => {
    const r = await answerQuestion({ question }, deps);
    expect(r.intent).toBe(intent);
    expect(r.mode).toBe('template');
    expect(r.verified).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    for (const t of r.tools) expect(JSON.stringify(t.result).length).toBeLessThanOrEqual(2048);
    const pool = numbersInTools(r.tools);
    for (const n of numbersInText(r.answer, 'pt')) {
      const f = 10 ** n.decimals;
      expect(pool.some((t) => Math.abs(Math.round(Math.abs(t) * f) / f - Math.abs(n.value)) < 1e-9)).toBe(true);
    }
    expect(r.answer.split(/\s+/).length).toBeLessThanOrEqual(150);
  });

  it('controlled burn: cites the law, the agency and the fire department, and never recommends burning', async () => {
    const r = await answerQuestion({ question: 'Posso fazer queima controlada em Niquelândia em agosto de 2026?' }, deps);
    expect(r.answer).toMatch(/não autoriza nem recomenda/);
    expect(r.answer).toMatch(/Lei 14\.944\/2024/);
    expect(r.answer).toMatch(/órgão ambiental/);
    expect(r.answer).toMatch(/Corpo de Bombeiros/);
    expect(r.answer).toMatch(/não de comportamento do fogo/);
  });

  it('flags data older than 24 h, answers "no data" outside Goiás and caches by (ibge, intent, period)', async () => {
    const r = await answerQuestion({ question: 'Qual a previsão de focos para Goiânia em setembro de 2026?' }, deps);
    expect(r.cached).toBe(true);
    // data through 14/11 asked on 15/11 12h: fresh, no staleness notice
    expect(r.notices.join(' ')).not.toMatch(/24 h/);
    // the same data asked three days later is flagged
    const later = await answerQuestion({ question: 'Qual a previsão de focos para Goiânia em outubro de 2026?' }, { ...deps, now: new Date('2026-11-18T12:00:00Z') });
    expect(later.notices.join(' ')).toMatch(/24 h/);
    const out = await answerQuestion({ question: 'Qual a previsão para 3550308?' }, deps);
    expect(out.intent).toBe('no_data');
    expect(out.answer).toMatch(/Sem dados/);
    const none = await answerQuestion({ question: 'Qual a previsão de focos?' }, deps);
    expect(none.intent).toBe('no_data');
  });

  it('LLM mode: an answer with an invented number is rejected twice and the template is served instead', async () => {
    clearAssistantCache();
    let writes = 0;
    const llm: LlmClient = {
      provider: 'gemini',
      models: { router: 'fake-router', writer: 'fake-writer' },
      route: async () => ({ intent: 'enso', municipality: null, year: null, month: 9, months: 1 }),
      write: async () => {
        writes++;
        return 'Em anos de El Niño a média foi 99999,9 células-dia, causada pela seca.';
      },
    };
    const r = await answerQuestion({ question: 'El Niño em Goiás em setembro?' }, { ...deps, llm });
    expect(writes).toBe(2);
    expect(r.checks.map((c) => `${c.writer}:${c.ok}`)).toEqual(['llm:false', 'llm:false', 'template:true']);
    expect(r.checks[0]!.failures.map((f) => f.code)).toEqual(expect.arrayContaining(['NUMBER_NOT_IN_TOOLS', 'CAUSAL_CLAIM']));
    expect(r.verified).toBe(true);
    expect(r.answer).not.toContain('99999');
  });

  it('LLM mode: single-source intents never call the writer model', async () => {
    clearAssistantCache();
    let writes = 0;
    const llm: LlmClient = {
      provider: 'gemini',
      models: { router: 'fake-router', writer: 'fake-writer' },
      route: async () => ({ intent: 'forecast', municipality: 'Goiânia', year: 2026, month: 9, months: 1 }),
      write: async () => {
        writes++;
        return '';
      },
    };
    const r = await answerQuestion({ question: 'previsão Goiânia setembro 2026' }, { ...deps, llm });
    expect(writes).toBe(0);
    expect(r.intent).toBe('forecast');
    expect(r.verified).toBe(true);
  });
});
