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
Without `ANTHROPIC_API_KEY` the assistant runs in no-LLM mode (keyword routing + text templates); it is the default.

## Forecast (`GET /api/forecast?ibge=&year=&month=`)

- Target: harmonized hotspot cell-days (1 km) per municipality and month. It forecasts **occurrence per area and month,
  not fire behaviour** (speed, direction, reach).
- Features: seasonality, hotspot lags (12 and 24 months, previous-year total), neighbours (5 nearest centroids), ONI
  lagged 3 months. Ridge regression on log1p. NASA POWER and MCD12Q1 are not features (not loaded for all municipalities).
- Temporal validation, never shuffled: trained on target years 2003–2019, tested on 2020–2025 (n = 17,712).

| Test 2020–2025 | Model | Climatology (mean) | Persistence | Climatology (median) |
| --- | --- | --- | --- | --- |
| MAE (cell-days per municipality-month) | 5.292 | 6.683 | 7.600 | 5.582 |
| Brier score, month above its P90 | 0.1120 | 0.1110 | 0.1992 | — |
| Coverage of the P10–P90 interval | 83.1 % | 84.0 % | — | — |

The model is the official value (it beats climatology as mean and as median). **The probability of a month above its
P90 did not beat climatology, so the climatological frequency is the official probability.** Every number above comes
from `api/out/forecast_validation.json`; nothing is typed by hand.

## Assistant (`POST /api/assistant`)

Body: `{ "question": string (3–500), "ibge"?: "52xxxxx", "lang"?: "pt" | "en" }`. Rate limit: 12 requests per minute.

1. **Route** — keywords (or `claude-haiku-5-5` when a key is set) pick one intent: historical statistics, forecast,
   ENSO comparison, declared interventions, mobilization ranking, controlled-burn context.
2. **Tools** — read-only aggregates of at most ~2 KB, each with n, base period and source.
3. **Write** — a text template; `claude-sonnet-5-5` only for multi-source answers (ENSO, interventions, burn context),
   with prompt caching on the system prompt and low `max_tokens`.
4. **Check (deterministic, zero tokens)** — every number must exist in a tool result; every forecast needs interval,
   training period and metric; every probability needs n and source; no causal sentence; no fire-behaviour claim; a
   controlled-burn answer must cite Lei 14.944/2024, the environmental agency and the Fire Department and never
   authorise or recommend burning. Two failures → only the verifiable facts. Each check is logged in
   `api/out/logs/assistant_decisions.jsonl`.

Answers are cached by (municipality, intent, period, language). Data older than 24 h is flagged. Outside Goiás the
answer is "no data".

## Limits

- PostGIS was offline when this was built: the API serves the in-memory FIRMS cell index. `db/teste_intervencao.sql`
  was written but not run yet.
- The FIRMS yearly archive ends on 2025-12-31, so a forecast uses hotspots up to December of the previous year. More
  than one year past the last loaded year, the answer is the climatology.
- ENSO phase is a monthly threshold on ONI (±0.5), not CPC's official episodes. Context and association only.
- The intervention registry (`api/seed/interventions.json`) starts empty; before/after is an association, not an effect.
- The LLM path was tested with a fake HTTP client only (no key available).

## Sources

NASA FIRMS (MODIS C6.1, VIIRS S-NPP 375 m), NASA POWER, NOAA CPC Oceanic Niño Index, IBGE municipal mesh.
