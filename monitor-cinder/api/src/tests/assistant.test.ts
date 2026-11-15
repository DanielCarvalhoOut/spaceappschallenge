/**
 * Plumbing tests of the assistant: no model, no network, no database.
 * The deterministic check must block an invented number, a causal sentence and a forecast without interval.
 */
import { describe, expect, it } from 'vitest';
import { compareIntervention, parseInterventions } from '../assistant/interventions.js';
import { createLlmChain, createLlmClient, MAX_TOOL_BYTES, toolsForModel, type FetchLike } from '../assistant/llm.js';
import { findPlace, routeQuestion, type Place } from '../assistant/router.js';
import { BURN_SAFEGUARD, noticesFor, renderTemplate, verifiableOnly } from '../assistant/templates.js';
import type { ToolResult } from '../assistant/tools.js';
import { numbersInText, verifyAnswer } from '../assistant/verifier.js';
import { redactSecrets } from '../core/logger.js';

const VALIDATION = {
  trainPeriod: '2003-2019',
  testPeriod: '2020-2025',
  nTest: 17712,
  maeModel: 5.292,
  maeClimatology: 6.683,
  maePersistence: 7.6,
  brierClimatology: 0.111,
  official: 'model',
  probabilityOfficial: 'climatology',
};

const FORECAST: ToolResult = {
  name: 'forecast',
  result: {
    municipality: 'Goiânia',
    ibge: '5208707',
    months: [{ year: 2026, month: 9, method: 'model', value: 28.8, p10: 6.2, p90: 103.7, probAboveP90Pct: 8, p90Threshold: 97.5, observed: null }],
    probability: { method: 'climatology', n: 25, thresholdPeriod: '2001-2019', thresholdN: 19, source: 'share of previous years above the P90' },
    validation: VALIDATION,
    flags: [],
  },
};
const STATUS: ToolResult = {
  name: 'data_status',
  result: { dataKind: 'firms_index', dataThrough: '2025-12-31', staleDays: 318, staleThresholdHours: 24, stale: true },
};
const TOOLS = [STATUS, FORECAST];

const GOOD_PT =
  'Previsão para Goiânia, setembro de 2026: 28,8 células-dia (intervalo P10–P90: 6,2 a 103,7); probabilidade de passar do P90 histórico (97,5): 8 % (frequência climatológica, n = 25; fonte: NASA FIRMS). Método: modelo, treino 2003-2019; no teste 2020-2025 o MAE foi 5,292.';

describe('deterministic check', () => {
  it('approves an answer whose numbers all come from the tools', () => {
    expect(verifyAnswer(GOOD_PT, TOOLS, { lang: 'pt', intent: 'forecast' })).toEqual({ ok: true, failures: [] });
  });

  it('blocks an invented number', () => {
    const v = verifyAnswer(GOOD_PT.replace('28,8', '31,4'), TOOLS, { lang: 'pt', intent: 'forecast' });
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.code)).toContain('NUMBER_NOT_IN_TOOLS');
    expect(v.failures[0]!.detail).toContain('31,4');
  });

  it('blocks a causal sentence in pt and en, but allows "associated with" and the denial of cause', () => {
    const pt = verifyAnswer(`${GOOD_PT} O aumento foi causado pelo El Niño.`, TOOLS, { lang: 'pt', intent: 'forecast' });
    expect(pt.failures.map((f) => f.code)).toContain('CAUSAL_CLAIM');
    const en = verifyAnswer('Hotspots rose due to drought.', TOOLS, { lang: 'en', intent: 'stats' });
    expect(en.failures.map((f) => f.code)).toContain('CAUSAL_CLAIM');
    const withNote: ToolResult[] = [...TOOLS, { name: 'enso', result: { note: 'association only: phase of the same month, no cause attributed' } }];
    expect(verifyAnswer('Os focos estão associados à fase do ENSO. É uma associação, não causa.', withNote, { lang: 'pt', intent: 'enso' }).ok).toBe(true);
  });

  it('blocks a forecast without interval, without training period or without metric', () => {
    const noInterval = verifyAnswer('Previsão para Goiânia, setembro de 2026: 28,8 células-dia. Treino 2003-2019; MAE 5,292.', TOOLS, { lang: 'pt', intent: 'forecast' });
    expect(noInterval.failures.map((f) => f.code)).toEqual(['FORECAST_WITHOUT_INTERVAL']);
    const bare = verifyAnswer('Forecast for Goiânia: 28.8 cell-days.', TOOLS, { lang: 'en', intent: 'forecast' });
    expect(bare.failures.map((f) => f.code)).toEqual(['FORECAST_WITHOUT_INTERVAL', 'FORECAST_WITHOUT_TRAIN_PERIOD', 'FORECAST_WITHOUT_METRIC']);
  });

  it('blocks a probability without n and source', () => {
    const v = verifyAnswer('A probabilidade é 8 %.', TOOLS, { lang: 'pt', intent: 'stats' });
    expect(v.failures.map((f) => f.code)).toEqual(['PROBABILITY_WITHOUT_N', 'PROBABILITY_WITHOUT_SOURCE']);
  });

  it('blocks fire-behaviour claims and burn recommendations', () => {
    expect(verifyAnswer('O fogo vai avançar para o norte.', TOOLS, { lang: 'pt', intent: 'stats' }).failures.map((f) => f.code)).toContain('FIRE_BEHAVIOUR_CLAIM');
    expect(verifyAnswer('Você pode queimar em agosto.', TOOLS, { lang: 'pt', intent: 'burn' }).failures.map((f) => f.code)).toEqual(
      expect.arrayContaining(['BURN_RECOMMENDATION', 'BURN_WITHOUT_SAFEGUARD'])
    );
    expect(verifyAnswer(BURN_SAFEGUARD.pt, TOOLS, { lang: 'pt', intent: 'burn' }).ok).toBe(true);
    expect(verifyAnswer(BURN_SAFEGUARD.en, TOOLS, { lang: 'en', intent: 'burn' }).ok).toBe(true);
  });

  it('requires the small-sample warning, the denial in a burn answer, and refuses associations no tool reported', () => {
    const enso: ToolResult = {
      name: 'enso',
      result: { month: 8, phases: [{ phase: 'la_nina', n: 4, mean: 9084.1, smallSample: true }], smallSampleBelow: 5, note: 'association only: phase of the same month, no cause attributed' },
    };
    expect(verifyAnswer('La Niña (n = 4): mean 9084.1.', [enso], { lang: 'en', intent: 'enso' }).failures.map((f) => f.code)).toEqual(['SMALL_SAMPLE_WITHOUT_WARNING']);
    expect(verifyAnswer('La Niña (n = 4): mean 9084.1. Caution: small sample (n < 5). This is an association, not a cause.', [enso], { lang: 'en', intent: 'enso' }).ok).toBe(true);
    expect(verifyAnswer('Um valor alto de focos está associado a menor umidade.', TOOLS, { lang: 'pt', intent: 'forecast' }).failures.map((f) => f.code)).toEqual(['ASSOCIATION_NOT_IN_TOOLS']);
    const offTopic = 'El Niño (n = 4): média 9084,1. Amostra pequena (n < 5). É uma associação, não causa. Para queima controlada é preciso plano de queima e aceiro.';
    expect(verifyAnswer(offTopic, [enso], { lang: 'pt', intent: 'enso' }).failures.map((f) => f.code)).toEqual(['BURN_TEXT_OUTSIDE_BURN_ANSWER']);
    const noDenial = BURN_SAFEGUARD.pt.replace('Esta resposta não autoriza nem recomenda queimar. ', '');
    expect(verifyAnswer(noDenial, TOOLS, { lang: 'pt', intent: 'burn' }).failures.map((f) => f.code)).toEqual(['BURN_WITHOUT_SAFEGUARD']);
  });

  it('parses numbers with the decimal mark of the language and treats a hyphen between years as a range', () => {
    expect(numbersInText('de 2003-2019: 1.303,8 e -0,25', 'pt').map((n) => n.value)).toEqual([2003, 2019, 1303.8, -0.25]);
    expect(numbersInText('P90 of 1,303.8 (Law 14.944/2024)', 'en').map((n) => n.value)).toEqual([1303.8]);
  });
});

describe('templates pass their own check', () => {
  it('forecast in pt and en, with the freshness notice', () => {
    for (const lang of ['pt', 'en'] as const) {
      const text = renderTemplate('forecast', TOOLS, lang);
      expect(verifyAnswer(text, TOOLS, { lang, intent: 'forecast' })).toEqual({ ok: true, failures: [] });
      const notices = noticesFor(TOOLS, lang);
      expect(notices).toHaveLength(1);
      expect(verifyAnswer(notices.join(' '), TOOLS, { lang, intent: 'notice' }).ok).toBe(true);
    }
  });

  it('answers "no data" when the tool has none, and the burn answer keeps the safeguard', () => {
    const none: ToolResult[] = [STATUS, { name: 'burn_context', result: { noData: true } }];
    const text = renderTemplate('burn', none, 'pt');
    expect(text).toContain('14.944/2024');
    expect(text).toContain('Sem dados');
    expect(verifyAnswer(text, none, { lang: 'pt', intent: 'burn' }).ok).toBe(true);
  });

  it('the last-resort text only lists tool values', () => {
    const text = verifiableOnly([STATUS, { name: 'mobilization', result: { year: 2026, month: 9, top: 5 } }], ['NUMBER_NOT_IN_TOOLS'], 'pt');
    expect(verifyAnswer(text, [STATUS, { name: 'mobilization', result: { year: 2026, month: 9, top: 5 } }], { lang: 'pt', intent: 'x' }).ok).toBe(true);
  });
});

describe('keyword router', () => {
  const places: Place[] = [
    { ibge: '5208707', name: 'Goiânia' },
    { ibge: '5205307', name: 'Cavalcante' },
    { ibge: '5208905', name: 'Goiás' },
    { ibge: '5200308', name: 'Alto Paraíso de Goiás' },
  ];
  const now = new Date('2026-11-15T12:00:00Z');
  const route = (question: string, ibge?: string) => routeQuestion({ question, ibge }, places, now);

  it('routes one question per capability and says why', () => {
    expect(route('Qual a temporada típica de fogo em Cavalcante?')).toMatchObject({ intent: 'stats', ibge: '5205307', lang: 'pt' });
    expect(route('Qual a previsão de focos para Goiânia em setembro de 2026?')).toMatchObject({ intent: 'forecast', ibge: '5208707', year: 2026, month: 9, months: 1 });
    expect(route('Como ficam os focos em Goiás em anos de El Niño?')).toMatchObject({ intent: 'enso', ibge: '52' });
    expect(route('Houve intervenção em Cavalcante?')).toMatchObject({ intent: 'intervention', ibge: '5205307' });
    expect(route('Quais municípios priorizar em setembro de 2026?')).toMatchObject({ intent: 'mobilization', year: 2026, month: 9 });
    expect(route('Posso fazer queima controlada em Cavalcante em agosto?')).toMatchObject({ intent: 'burn', ibge: '5205307', month: 8, year: 2027 });
    expect(route('Qual a previsão?').reason).toContain('keyword');
  });

  it('reads a window, the selected municipality, English, and places outside Goiás', () => {
    expect(route('forecast for Goiânia from August to October 2026')).toMatchObject({ month: 8, months: 3, lang: 'en' });
    expect(route('qual a previsão para o próximo mês?', '5205307')).toMatchObject({ ibge: '5205307', year: 2026, month: 12 });
    expect(route('previsão para 3550308')).toMatchObject({ outside: true, ibge: null });
    expect(findPlace('focos em Alto Paraíso de Goiás', places).place?.ibge).toBe('5200308');
    expect(route('bom dia')).toMatchObject({ intent: 'help' });
  });
});

describe('declared interventions', () => {
  const deps = {
    firstYear: 2001,
    lastYear: 2025,
    value: (y: number, _m: number) => (y <= 2022 ? 10 : 4),
    forecast: (_y: number, _m: number) => 9,
  };

  it('compares the same seasonal window before and after, with n', () => {
    const [i] = parseInterventions([{ ibge: '5205307', date: '2023-03-10', type: 'brigada (fixture de teste)', source: 'https://example.org/fixture', registeredBy: 'teste' }]);
    expect(compareIntervention(i!, deps)).toEqual({
      window: 'months 5-10',
      beforeMean: 60,
      beforeN: 3,
      afterMean: 24,
      afterN: 3,
      firstSeasonAfter: 2023,
      firstSeasonObserved: 24,
      firstSeasonForecast: 54,
    });
  });

  it('rejects a record without source or outside Goiás', () => {
    expect(parseInterventions([{ ibge: '3550308', date: '2023-03-10', type: 'x', source: 'y', registeredBy: 'z' }])).toEqual([]);
    expect(parseInterventions([{ ibge: '5205307', date: '2023-03-10', type: 'brigada' }])).toEqual([]);
  });
});

describe('LLM layer (fake HTTP client, no network)', () => {
  const calls: { body: string; headers: Record<string, string> }[] = [];
  const fake =
    (text: string): FetchLike =>
    async (_url, init) => {
      calls.push({ body: init.body, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) };
    };

  it('sends the cached system prompt, the small model for routing and only compact tool aggregates', async () => {
    const llm = createLlmClient({ provider: 'anthropic', apiKey: 'sk-ant-test-key-0000000000' }, fake('{"intent":"forecast","municipality":"Goiânia","year":2026,"month":9,"months":1}'));
    expect(await llm.route('previsão Goiânia setembro 2026')).toMatchObject({ intent: 'forecast', month: 9 });
    const body = JSON.parse(calls[0]!.body) as { model: string; max_tokens: number; system: { cache_control: { type: string } }[] };
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBeLessThanOrEqual(400);
    expect(body.system[0]!.cache_control.type).toBe('ephemeral');
    const big: ToolResult = { name: 'forecast', result: { blob: 'x'.repeat(5000) } };
    expect(toolsForModel([big]).length).toBeLessThan(MAX_TOOL_BYTES + 60);
  });

  it('an LLM answer with an invented number fails the same check', async () => {
    const llm = createLlmClient({ provider: 'anthropic', apiKey: 'sk-ant-test-key-0000000000' }, fake(GOOD_PT.replace('28,8', '99,9')));
    const text = await llm.write({ question: 'q', intent: 'forecast', lang: 'pt', tools: TOOLS });
    expect(verifyAnswer(text, TOOLS, { lang: 'pt', intent: 'forecast' }).ok).toBe(false);
  });

  it('never leaks the key in errors or logs', async () => {
    const failing: FetchLike = async () => {
      throw new Error('connect failed for key sk-ant-test-key-0000000000');
    };
    await expect(createLlmClient({ provider: 'anthropic', apiKey: 'sk-ant-test-key-0000000000' }, failing).route('x')).rejects.toThrow(/REDACTED/);
    expect(redactSecrets('x-api-key: sk-ant-api03-abcdefgh12345')).not.toContain('abcdefgh');
    expect(redactSecrets('x-goog-api-key: AIzaTESTtestTESTtestTESTtest0000')).not.toContain('TESTtest');
  });

  it('Gemini: key in a header (never in the URL), small model for routing, JSON answer parsed', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const gemini: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"intent":"enso","municipality":null,"year":null,"month":9,"months":1}' }] } }] }) };
    };
    const llm = createLlmClient({ provider: 'gemini', apiKey: 'AIzaTESTtestTESTtestTESTtest0000' }, gemini);
    expect(await llm.route('El Niño em setembro?')).toMatchObject({ intent: 'enso', month: 9 });
    expect(seen[0]!.url).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(seen[0]!.url).not.toContain('AIza');
    expect(seen[0]!.headers['x-goog-api-key']).toBe('AIzaTESTtestTESTtestTESTtest0000');
    const body = JSON.parse(seen[0]!.body) as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] };
    expect(body.systemInstruction.parts[0]!.text).toContain('Classify');
    await llm.write({ question: 'q', intent: 'enso', lang: 'pt', tools: TOOLS }).catch(() => undefined);
    expect(seen[1]!.url).toContain('/models/gemini-3.5-flash:generateContent');
    const empty: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }] }) });
    await expect(createLlmClient({ provider: 'gemini', apiKey: 'AIzaTESTtestTESTtestTESTtest0000' }, empty).route('x')).rejects.toThrow(/MAX_TOKENS/);
  });
});

describe('several LLM providers', () => {
  const route = '{"intent":"enso","municipality":null,"year":null,"month":9,"months":1}';

  it('OpenAI: bearer header, chat completions, JSON route parsed', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const openai: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: route } }] }) };
    };
    const llm = createLlmClient({ provider: 'openai', apiKey: 'sk-test-00000000000000000000', routerModel: 'my-small-model' }, openai);
    expect(await llm.route('El Niño?')).toMatchObject({ intent: 'enso' });
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-test-00000000000000000000');
    expect((JSON.parse(seen[0]!.body) as { model: string }).model).toBe('my-small-model');
    expect(redactSecrets('Bearer sk-test-00000000000000000000')).not.toContain('0000000000');
  });

  it('falls back to the next provider when the first fails, and fails only when all do', async () => {
    const down: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const up: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: route } }] }) });
    const gemini = createLlmClient({ provider: 'gemini', apiKey: 'AIzaTESTtestTESTtestTESTtest0000' }, down);
    const openai = createLlmClient({ provider: 'openai', apiKey: 'sk-test-00000000000000000000' }, up);
    const chain = createLlmChain([gemini, openai])!;
    expect(chain.provider).toBe('gemini');
    expect(await chain.route('x')).toMatchObject({ intent: 'enso' });
    await expect(createLlmChain([gemini, gemini])!.route('x')).rejects.toThrow(/LLM HTTP 500/);
    expect(createLlmChain([])).toBeNull();
  });
});
