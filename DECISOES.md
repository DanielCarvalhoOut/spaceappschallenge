# DECISOES.md · agente e previsão (branch `feat/agente-previsao`)

Uma linha por decisão: **decisão** — motivo — alternativa descartada.

## Fase 0 (15/11, 09:26–09:35)

- **D01 · Rodar `job:build-cell-index` (FIRMS real, sem PostGIS) em segundo plano** — o calendário em memória era sintético e previsão sobre dado sintético não valida nada — descartado: subir o PostGIS e carregar o histórico (porta 5432 ocupada por outro projeto; carga longa demais para o prazo).
- **D02 · [BLOQUEADO: PostGIS do projeto fora do ar]** — contêiner `firehub-postgis` só "Created", porta ocupada — alternativa usada: modo em memória da API; nenhum número desta entrega vem do banco.
- **D03 · Tirar a `FIRMS_MAP_KEY` do valor padrão de `config.ts` e do `.env.example`** — regra "segredo só no .env"; a chave era a mesma do `.env` rastreado — descartado: deixar como está (vazaria de novo a cada clone).
- **D04 · Remover a exceção `!monitor-cinder/api/.env` do `.gitignore` junto com o `git rm --cached`** — sem isso o arquivo voltaria no próximo `git add` — descartado: só `rm --cached`.
- **D05 · POWER e MCD12Q1 ficam fora das features do treino** — só há cache de 3 municípios; não são "confirmadas" — descartado: baixar 246 séries do POWER agora (custa minutos do prazo e não garante cobertura).
- **D06 · Vizinhos = k municípios de centroide mais próximo** — não há tabela de adjacência e o centroide já existe — descartado: adjacência exata por geometria.
- **D07 · Modo sem LLM é o caminho padrão da demo** — não há `ANTHROPIC_API_KEY` no `.env` — descartado: pedir a chave agora (o chat tem de funcionar nos dois modos de qualquer forma).

### Autochecagem da fase 0

- Toda linha da tabela de `CONFERENCIA.md` tem evidência ou "não verificado": **passou** (12 linhas; 4 trechos marcados "não verificado").
- `CLAUDE.md` e `IMPLEMENTACAO.md` refletem a regra nova: **passou** (`CLAUDE.md:16-18`; `IMPLEMENTACAO.md` "Escopo travado", "Vocabulário" e §5 F6).
- `.env` fora do índice do git: **passou** (`git check-ignore -v monitor-cinder/api/.env` → `.gitignore:1`).

## Fase 1 (15/11, 09:38–09:41)

- **D08 · Intervenções lidas de um arquivo de cadastro quando não há banco** — PostGIS fora do ar; a tabela e o teste SQL ficam escritos — descartado: bloquear a capacidade 4 inteira.
- **D09 · Intervalo P10–P90 por quantis dos resíduos de treino** — simples, sem suposição de distribuição e calculável em memória — descartado: regressão quantílica (mais código, mesmo prazo).

### Autochecagem da fase 1

- Todo passo tem critério testável: **passou** (12 passos, coluna "Critério de pronto"; o passo 9 declara o que não é verificável sem chave e o 10 o que não roda sem banco).
- Usa só o que a fase 0 confirmou: **passou** (features do passo 3 = sazonalidade, lags, vizinhos e ONI; POWER e MCD12Q1 ficam fora do treino, conforme D05).
- A soma dos minutos cabe no tempo restante: **passou** (125 min planejados; 142 min restantes às 09:38).

## Fase 2 (15/11, 09:45–10:10)

- **D10 · Série real completa em memória** — o FIRMS parou de responder por ~8 min (VIIRS 2015–2024 falharam na 1ª rodada) e voltou; a 2ª rodada do `job:build-cell-index` baixou tudo: MODIS 2001–2025 e VIIRS S-NPP 2012–2025, `dataThrough = 2025-12-31` — descartado: seguir com MODIS × fator para 2015–2024.
- **D11 · Fator mensal calibrado só nos anos com os dois sensores carregados (`factorYears`) e VIIRS só nos anos carregados** — com carga parcial o fator saía enviesado para baixo e os anos sem VIIRS viravam zero falso (`src/jobs/build-cell-index.ts`, `src/core/cell-index.ts`, `src/db/store.ts`) — descartado: exigir carga completa para subir a API.
- **D12 · Modelo = regressão ridge em log1p, features: climatologia, lag 12 e 24 meses, total do ano anterior, vizinhos (5 centroides mais próximos, lag 12), ONI defasado 3 meses e sua interação, seno/cosseno do mês** — só features confirmadas na fase 0, treina em segundos, sem dependência nova — descartado: reaproveitar `ml-propensity.ts` (classificador treinado com clima gerado por RNG).
- **D13 · Horizonte: a previsão usa FIRMS até dezembro do ano anterior** — é a defasagem real do arquivo anual (dado até 31/12/2025); além de um ano após o último ano carregado, cai na climatologia com aviso — descartado: lag de 1 mês (não existiria para nenhum mês de 2026).
- **D14 · Oficial só se o modelo vencer a climatologia como média (linha de base pedida) e como mediana (mais exigente)** — a média é penalizada por contagens assimétricas; reportar só contra ela inflaria o ganho — descartado: comparar só com a média.
- **D15 · Probabilidade de "mês acima do P90": a oficial é a frequência climatológica** — o calibrador do modelo (isotônico, treino ≤ 2019) teve Brier 0,1120 contra 0,1110 da climatologia: não superou, então vale a regra "use a climatologia" — descartado: servir a probabilidade do modelo.
- **D16 · Rota `GET /api/forecast` e `GET /api/forecast/validation` já nesta fase** — é a saída pedida (valor, intervalo, probabilidade, métrica) e vira ferramenta do agente — descartado: deixar só o arquivo.
- **D17 · Fase do ENSO por mês: ONI ≥ +0,5 El Niño, ≤ −0,5 La Niña** — simples e reproduzível — descartado: episódios oficiais do CPC (exigem 5 trimestres seguidos).

### Resultado (out/forecast_validation.json, série real FIRMS, 246 municípios)

| Teste 2020–2025 (n = 17.712) | Modelo | Climatologia (média) | Persistência | Climatologia (mediana) |
| --- | --- | --- | --- | --- |
| MAE, células-dia por município-mês | 5,292 | 6,683 | 7,600 | 5,582 |
| MAE na seca (mai–out) | 9,103 | 11,812 | 13,131 | — |
| Brier, mês acima do P90 (taxa-base 12,7 %) | 0,1120 | 0,1110 | 0,1992 | — |
| Cobertura do intervalo P10–P90 | 83,1 % | 84,0 % | — | — |

Treino: anos-alvo 2003–2019 (dados desde 2001), n = 50.184. Ganho de MAE: 20,8 % sobre a climatologia média e 5,2 % sobre a mediana. **Valor previsto oficial: modelo. Probabilidade oficial: climatologia.** Calibração da probabilidade servida (climatológica): faixas 0–5 % → 9,3 % observado; 5–15 % → 12,7 %; 15–30 % → 21,6 %.

### Autochecagem da fase 2

- `forecast_validation.json` existe: **passou** (`monitor-cinder/api/out/forecast_validation.json`, `computedAt 2026-11-15T13:07:18Z`, `dataKind: firms_index`).
- Traz as métricas das duas linhas de base: **passou** (`mae.climatology 6.683`, `mae.persistence 7.6`, `exceedance.brier.climatology 0.111`, `.persistence 0.1992`).
- O treino não usou anos do teste: **passou** (`trainPeriod.to = 2019`; `validateForecast` lança erro se alguma linha de treino passar de `trainTo`; teste "the fitted model does not change when the test years change" em `src/tests/forecast.test.ts`).
- Extra: `npx tsc --noEmit` sai 0; `npx vitest run` → 18 passam, 10 pulados (banco); `GET /api/meta` → `dataKind: firms_index`; `GET /api/forecast` responde 200 / 400 / 404 em problem+json.
