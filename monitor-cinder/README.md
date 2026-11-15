# Monitor Cinder · API, forecast and assistant

Backend of Monitor Cinder (NASA Space Apps 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots"): a harmonized
MODIS + VIIRS hotspot series for the 246 municipalities of Goiás, Brazil, with historical pattern, anomaly, a validated
monthly forecast and a conversational assistant that only says what it can verify.

**AI-assisted code:** parts of this repository (forecast, assistant, tests and documentation) were written with Claude
Code and reviewed by the team. The idea, the scope and the decisions are the team's.

## Run

```bash
cd monitor-cinder/api
npm install
cp .env.example .env                                   # keys are optional; never commit .env
npm run job:build-cell-index -- --from=2001 --to=2025  # NASA FIRMS yearly archives → data/ (no key, ~40 min)
npm run job:forecast                                   # ONI (NOAA CPC) + temporal validation → out/forecast_validation.json
npm run start                                          # API on http://localhost:8787
npm run typecheck && npm test
```

Open `Mapa iterativo/index.html` through a static server (see `.claude/launch.json`) and use the **Assistant** button.
Without `GEMINI_API_KEY` the assistant runs in no-LLM mode (keyword routing + text templates).

With PostGIS (`docker compose up -d`, then `job:db-load-regions`, `job:ingest-firms-history`, `job:build-history`),
the forecast and the assistant read `fire.calendar_monthly` instead of the in-memory index, as long as the database has
both sensors loaded. Run `npm run job:forecast` again after changing the series: the validation file must describe the
series being served, otherwise `/api/forecast` answers 503.

## Forecast (`GET /api/forecast?ibge=&year=&month=`)

- Target: harmonized hotspot cell-days (1 km) per municipality and month. It forecasts **occurrence per area and month,
  not fire behaviour** (speed, direction, reach).
- Features: seasonality, hotspot lags (12 and 24 months, previous-year total), neighbours (5 nearest centroids), ONI
  lagged 3 months. Ridge regression on log1p. NASA POWER and MCD12Q1 are not features (not loaded for all municipalities).
- Temporal validation, never shuffled: trained on target years 2003–2019, tested on 2020–2025 (n = 17,712).

| Test 2020–2025 (PostGIS series) | Model | Climatology (mean) | Persistence | Climatology (median) |
| --- | --- | --- | --- | --- |
| MAE (cell-days per municipality-month) | 5.284 | 6.763 | 7.600 | 5.598 |
| MAE in the dry season (May–Oct) | 9.093 | 11.988 | 13.131 | — |
| Brier score, month above its P90 | 0.1135 | 0.1125 | 0.2017 | — |
| Coverage of the P10–P90 interval | 83.1 % | 84.0 % | — | — |

The model is the official value (it beats climatology as mean and as median: 21.9 % and 5.6 % lower MAE). **The
probability of a month above its P90 did not beat climatology, so the climatological frequency is the official
probability.** Every number above comes from `api/out/forecast_validation.json`; nothing is typed by hand. The same
validation on the in-memory cell index (no database) gave 5.292 / 6.683 / 7.600: the two pipelines agree.

Harmonization error on held-out years (`api/out/validation.json`, calibrated 2012–2019, tested 2020–2025, state level,
72 months): WAPE 14.1 %, Pearson 0.978, bias +3.7 %. Per municipality the error is much larger (median WAPE 65.9 %,
n = 217): small counts are noisy, and the app says so.

## Assistant (`POST /api/assistant`)

Body: `{ "question": string (3–500), "ibge"?: "52xxxxx", "lang"?: "pt" | "en" }`. Rate limit: 12 requests per minute.

1. **Route** — keywords, or the small model when `GEMINI_API_KEY` is set (`gemini-3.5-flash-lite`), pick one intent:
   historical statistics, forecast, ENSO comparison, declared interventions, mobilization ranking, controlled-burn
   context.
2. **Tools** — read-only aggregates of at most ~2 KB, each with n, base period and source.
3. **Write** — a text template; the larger model (`gemini-3.5-flash`, thinking off, low `maxOutputTokens`) only for
   multi-source answers (ENSO, interventions). A controlled-burn answer is always the fixed template, never a model.
   The system prompt goes first and never changes, so the provider can cache the prefix. Three providers are supported: `GEMINI_API_KEY`,
   `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. `LLM_PROVIDERS` (default `gemini,openai,anthropic`) sets the order among
   the keys that are set; when the first fails, the next answers. Model names can be overridden per provider
   (`*_ROUTER_MODEL`, `*_WRITER_MODEL`). Only Gemini was tested with a real key.
4. **Check (deterministic, zero tokens)** — every number must exist in a tool result; every forecast needs interval,
   training period and metric; every probability needs n and source; no causal sentence; no fire-behaviour claim; a
   controlled-burn answer must deny authorisation, cite Lei 14.944/2024, the environmental agency and the Fire
   Department; a group with n < 5 needs a small-sample warning; an association may be stated only when a tool reports
   one. Two failures → the template, then only the verifiable facts. Each check is logged in
   `api/out/logs/assistant_decisions.jsonl`.

With an LLM key, the question and the tool aggregates of that answer are sent to the provider (Google). Nothing else
leaves the server; the key travels in a header and is redacted from logs.

Answers are cached by (municipality, intent, period, language). Data older than 24 h is flagged. Outside Goiás the
answer is "no data".

## Limits

- With PostGIS up and both sensors loaded, forecast and assistant read `fire.calendar_monthly`; otherwise they fall
  back to the in-memory FIRMS cell index. The intervention registry is still read from `api/seed/interventions.json`,
  not from `fire.intervention`.
- The free Gemini tier answers 429 under load; the assistant then serves the template answer.
- The FIRMS yearly archive ends on 2025-12-31, so a forecast uses hotspots up to December of the previous year. More
  than one year past the last loaded year, the answer is the climatology.
- ENSO phase is a monthly threshold on ONI (±0.5), not CPC's official episodes. Context and association only.
- The intervention registry (`api/seed/interventions.json`) starts empty; before/after is an association, not an effect.
- The Gemini path was tested with real calls on 15/11/2026; the Anthropic path only with a fake HTTP client.

## Sources

NASA FIRMS (MODIS C6.1, VIIRS S-NPP 375 m), NASA POWER, NOAA CPC Oceanic Niño Index, IBGE municipal mesh.
