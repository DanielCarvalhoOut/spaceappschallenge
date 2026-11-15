# Monitor Cinder · Guia de implementação

Documento de contexto e execução para quem vai codar (pessoas e Claude Code). Leia inteiro antes de começar.

> **Stack decidida em 14/11:** front em **JavaScript puro + Canvas 2D** (pasta `Mapa iterativo/`, já pronta e autoral). Backend em **TypeScript (Node 22)**, modular. Banco PostgreSQL 16 + PostGIS. Fontes: **NASA FIRMS (núcleo)**, IBGE (municípios), INPE e NASA POWER (contexto e validação).

> **Atualização 15/11:** os conectores Embrapa SATVeg, INPE TerraBrasilis (PRODES/DETER) e BDQueimadas por município foram removidos (nunca chegaram a funcionar). NDVI e uso do solo vêm do **NASA ORNL DAAC** (MOD13Q1, MCD12Q1, `connectors/ornl-modis.ts`); o INPE entra só como validação externa (`connectors/inpe-stats.ts`). Os módulos antigos de ML, risco, recursos e score agrícola também saíram. As seções abaixo que citam esses itens ficam como registro do plano original.

## 1. Contexto

- **Evento:** NASA Space Apps Challenge 2026, evento local de Goiânia.
- **Prazo:** "Submit for Judging" até **domingo, 15/11/2026, 23h59** (hora local). **Meta interna: enviar às 22h.**
- **Desafio:** [Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/) (tema 8). O desafio pede:
  1. harmonizar os focos de calor MODIS (desde 2000) e VIIRS (desde 2012) numa série única;
  2. um app web em que o usuário escolhe região e período, vê um **calendário de queimadas** do início dos anos 2000 até hoje e baixa análises e CSV.
- **Projeto:** **Monitor Cinder**, uma plataforma de padrões históricos de fogo para Goiás. Ela mostra o que é "normal" em cada município ao longo de 25 anos e avisa os gestores quando o mês atual foge do padrão.

### Posicionamento

| Já existe | Não existe, e o Monitor Cinder entrega |
| --- | --- |
| INPE/BDQueimadas: série histórica com **um** satélite de referência (MODIS do Aqua), em fim de vida | Série **harmonizada MODIS + VIIRS** de 2001 até hoje, com o erro da harmonização medido e **conferida contra a série do INPE** |
| Painel do Fogo (Censipam): tempo real, frentes de fogo, risco e vento do dia. Ele mesmo recomenda buscar séries históricas em outro lugar | **Padrão histórico** por município (época típica de fogo, pico), **anomalia** do mês, **alerta** para gestores e **contexto** (desmatamento, vegetação, clima) |

**Frase do pitch:** "O painel operacional diz onde está o fogo agora. O Monitor Cinder diz se este mês está fora do normal em 25 anos, para cada município de Goiás."

### Escopo travado

| Entra (MVP) | Fica de fora (só como "próximos passos" no pitch) |
| --- | --- |
| Série harmonizada (MODIS 2001–2025 + VIIRS S-NPP 2012–2025), recorte de Goiás | Modelo de propagação / comportamento do fogo (velocidade, direção, alcance) |
| **Previsão de focos por município e mês** (decisão da equipe em 15/11), com intervalo P10–P90, período de treino e métrica fora da amostra contra climatologia e persistência; **agente conversacional** (`POST /api/assistant`) | Autorizar ou recomendar queima: o agente só dá contexto e remete ao órgão ambiental |
| Mapa por município, calendário (anos × meses), comparação MODIS × VIIRS × harmonizado | **Atribuir causa** ao fogo: o contexto (PRODES, NDVI, vento) aparece ao lado, nunca como explicação |
| Padrão sazonal, época típica de fogo, anomalia (z) | Taxa de combustão por vegetação e ciclo de vida |
| Alertas para gestores (**entrega simulada** na demo) | Estimativa de recursos e suprimentos |
| Validação externa com a série de referência do INPE | Tempo real, risco do dia (já existem no Painel do Fogo e no INPE) |
| Contexto anual: NDVI e uso do solo (NASA ORNL DAAC · MODIS), vento e chuva (NASA POWER) | Login, perfis, gamificação |
| Download CSV, página "Method & limits" | |

**Vocabulário na interface e no pitch:** "historical pattern", "anomaly", "typical fire season", "context". Desde 15/11, "forecast", "prediction", "probability" e "risk" são permitidos **só** para a previsão de focos por município e mês, e **toda previsão mostrada traz intervalo (P10–P90), período de treino e métrica de validação fora da amostra**; toda probabilidade traz n e fonte. **Nunca** "cause" / "caused by" / "causado por": use "associated with" / "associado a".

## 2. Regras não negociáveis

1. **Trabalho original.** Ao submeter, a equipe declara que o trabalho é original.
   - A pasta `Mapa iterativo/` foi **reescrita do zero** em 14/11. Os arquivos antigos de terceiros (`assets/`, `painel-original.html`) **precisam ser apagados** e nunca podem ir para o repositório.
   - Todo recurso de terceiros (bibliotecas npm, dados) vai em "References".
2. **Idioma.** A página do projeto, o README do repositório e os slides da submissão vão em **inglês**; o vídeo pode ser em português **com legenda em inglês**. A interface é **bilíngue**: abre em português (apresentação local) e o botão `EN` muda tudo para inglês. Grave o vídeo e as capturas da submissão com a interface em inglês.
3. **Segredos:** `FIRMS_MAP_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` e `ANTHROPIC_API_KEY` ficam só em `monitor-cinder/api/.env` (rastreado temporariamente para os testes da equipe; sai do git e a MAP_KEY é trocada depois da entrega). Nenhuma chave como valor padrão no código. O front nunca chama FIRMS. Nenhuma URL com chave é gravada em banco ou log (o `CHECK` de `fire.ingest_batch` barra a MAP_KEY).
4. **Dado da NASA é o núcleo.** O FIRMS é obrigatório e é a única base da harmonização e da anomalia. INPE é conferência; NASA POWER, ORNL DAAC e ONI são contexto.
5. **Uso de IA declarado** no README ("AI-assisted code") e na página do projeto.
6. **Padrões técnicos:**
   - **TypeScript:** `strict: true`, `noUncheckedIndexedAccess`, sem `any`. Toda entrada HTTP e toda resposta de API externa validada com `zod`. `async/await` em todo I/O; streams para arquivos grandes.
   - **Banco:** consultas sempre parametrizadas (`pg` com `$1`), nunca concatenação. A API usa o papel `fire_api_ro`; os jobs usam um papel de ingestão separado. Sem N+1: cada endpoint é 1 consulta (ou poucas, fixas).
   - **Front (JS puro):** nada da rede vira HTML (`textContent` sempre), CSP sem `unsafe-inline`, respostas validadas, `fetch` com timeout.
   - **OWASP:** validar na borda (códigos IBGE `^\d{7}$`, ano 2000–2100, mês 1–12); erro no formato `application/problem+json` sem stack trace; rate limit global e mais restrito no CSV; CORS só para a origem do front; logs sem segredos nem dados de contato.

## 3. Estrutura do repositório

```
SpaceApps2026/
├─ CLAUDE.md                     regras curtas para o Claude Code (lido automaticamente)
├─ IMPLEMENTACAO.md              este documento
├─ README.md                     índice da pasta (o README final do app vai em inglês)
├─ 00_Geral/                     PDFs de apoio (regras de entrega, vencedores)
├─ Tema_08_MODIS_VIIRS/          pesquisa: dados, APIs, contrato, banco testado
│  ├─ db/schema.sql              núcleo: sensores, lotes, focos particionados, grade 1 km, fatores, calendário
│  ├─ db/schema_cinder.sql      padrão sazonal, época de fogo, anomalia, alertas, vegetação (MCD12Q1)
│  ├─ db/schema_contexto.sql     série de referência do INPE, contexto anual (PRODES/DETER, SATVeg, POWER)
│  └─ db/teste_*.sql             testes (rodar na ordem da seção 5, F0)
├─ Mapa iterativo/               FRONT PRONTO (JS puro + Canvas, autoral). Ver o README da pasta
└─ monitor-cinder/                      ← código novo
   ├─ docker-compose.yml         PostGIS local
   └─ api/                       backend TypeScript (API + jobs de ingestão)
```

### 3.1 Backend modular (`monitor-cinder/api/`)

```
monitor-cinder/api/
├─ package.json  tsconfig.json  .env.example  vitest.config.ts
└─ src/
   ├─ server.ts                 Fastify: CORS restrito, rate limit, headers de segurança, handler de erro (problem+json)
   ├─ config.ts                 lê e valida o .env com zod; falha na subida se faltar algo obrigatório
   ├─ db/pool.ts                pg.Pool (API: fire_api_ro; jobs: papel de ingestão)
   ├─ core/                     tipos (IbgeCode, YearMonth), validadores zod, erros, logger (pino com redaction)
   ├─ connectors/               UM ARQUIVO POR FONTE, todos com a mesma interface (abaixo)
   │  ├─ firms.ts               NASA FIRMS: CSV anual por país (sem chave) + API de área e missing_data (MAP_KEY)
   │  ├─ ibge.ts                malha de municípios + nomes
   │  ├─ inpe-queimadas.ts      arquivo anual do satélite de referência (focos_br_ref_AAAA.zip)
   │  ├─ inpe-terrabrasilis.ts  WFS PRODES Cerrado e DETER Cerrado
   │  ├─ embrapa-satveg.ts      AgroAPI SATVeg (token OAuth2) → série NDVI/EVI de um ponto
   │  └─ nasa-power.ts          POWER mensal por ponto (WS10M, WD10M, PRECTOTCORR)
   ├─ modules/                  rotas HTTP por domínio: routes.ts + repository.ts (SQL) + schema.ts (zod)
   │  ├─ meta/  geo/  map/  municipalities/
   └─ jobs/                     CLIs: `npm run job:<nome>` (idempotentes, com log de contagens)
      ├─ load-regions.ts        IBGE → fire.region (UF + 246 municípios)
      ├─ ingest-firms.ts        CSV anual em streaming → recorte GO → COPY → ON CONFLICT DO NOTHING
      ├─ harmonize.ts           fator mensal + validação 2012–2019 / 2020–2025 → out/validation.json
      ├─ build-calendar.ts      calendar_monthly + refresh_baseline + evaluate_alerts
      ├─ ingest-inpe-ref.ts     série do INPE por município e mês → fire.inpe_reference_monthly
      └─ ingest-context.ts      PRODES/DETER, SATVeg e POWER → fire.context_yearly
```

Interface comum dos conectores (desenho nosso):

```ts
export interface SourceConnector<TQuery, TRecord> {
  readonly id: 'firms' | 'ibge' | 'inpe_queimadas' | 'inpe_terrabrasilis' | 'embrapa_satveg' | 'nasa_power';
  readonly license: string;               // vai para /api/meta e para "References"
  fetch(query: TQuery, signal: AbortSignal): AsyncIterable<TRecord>;   // streaming, já validado com zod
}
```

- Cada conector: timeout, até 3 tentativas com espera exponencial só em erro de rede/5xx, `User-Agent` identificando o projeto, e **nenhuma chave em log** (redaction no logger).
- Um conector nunca escreve no banco; quem escreve é o job. Assim dá para testar cada fonte com fixture, sem rede.
- Bibliotecas sugeridas: `fastify`, `@fastify/cors`, `@fastify/rate-limit`, `zod`, `pg`, `pg-copy-streams`, `csv-parse`, `yauzl` (zip do INPE), `pino`; testes com `vitest` e `@testcontainers/postgresql`.

## 4. Dados

| Fonte | Endpoint (conferido em 14/11) | Papel no Monitor Cinder |
| --- | --- | --- |
| **NASA FIRMS** CSV anual por país, sem login | `https://firms.modaps.eosdis.nasa.gov/data/country/{modis\|viirs-snpp}/{ano}/{pasta}_{ano}_Brazil.csv` | **Núcleo.** Histórico 2001–2025 (MODIS) e 2012–2025 (VIIRS) |
| NASA FIRMS API de área (MAP_KEY) | `/api/area/csv/{MAP_KEY}/{SOURCE}/{oeste,sul,leste,norte}/{1-5}/{AAAA-MM-DD}` e `/api/missing_data/` | Ano corrente (opcional) e `days_missing` |
| **IBGE** malha | `https://servicodados.ibge.gov.br/api/v3/malhas/estados/52?intrarregiao=municipio&formato=application/vnd.geo+json&qualidade=minima` → 246 features, `properties.codarea` (7 dígitos), Polygon/MultiPolygon, CORS aberto | Unidade espacial (recorte, mapa) |
| IBGE nomes | `https://servicodados.ibge.gov.br/api/v1/localidades/estados/52/municipios?view=nivelado` → `municipio-id`, `municipio-nome`, `microrregiao-nome`… | Nomes e busca |
| **INPE** Programa Queimadas, satélite de referência | `https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/anual/Brasil_sat_ref/focos_br_ref_{2003..2025}.zip` (lista conferida) | **Validação externa**: nossos focos MODIS do Aqua × série oficial (`fire.inpe_vs_firms`) |
| INPE focos diários | `https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/` | Opcional: mês corrente |
| **INPE TerraBrasilis** (WFS OGC) | `https://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&request=GetFeature&typeNames=prodes-cerrado-nb:yearly_deforestation&outputFormat=application/json&bbox=-53.25,-19.50,-45.90,-12.39,EPSG:4326` (camadas conferidas: `prodes-cerrado-nb:yearly_deforestation`, `deter-cerrado-nb:deter_cerrado`) | Contexto: km² desmatados por município e ano (interseção no PostGIS). Conferir atributos com `DescribeFeatureType` antes |
| **Embrapa** AgroAPI SATVeg | Token OAuth2 (Consumer Key/Secret da loja AgroAPI) e recurso `/series` da API SATVeg (NDVI/EVI de MOD13Q1/MYD13Q1, 16 dias). Conferir rota e parâmetros no "API Console" da loja | Contexto: NDVI médio da seca (jun–set) num ponto representativo do município. **Exige cadastro; cota limitada** → buscar só para municípios consultados, com cache |
| **NASA POWER** | `https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=WS10M,WD10M,PRECTOTCORR&community=AG&longitude={lon}&latitude={lat}&start={ano}&end={ano}&format=JSON` (resposta conferida) | Contexto: vento e chuva da estação seca. Grade de ~0,5°: um ponto por município basta |
| MODIS MCD12Q1 v6.1 (opcional) | LP DAAC / Earthdata (login gratuito) | Vegetação por célula. **Não usar para medir mudança entre anos** |

Colunas do FIRMS, diferenças MODIS × VIIRS e tamanhos: ver `Tema_08_MODIS_VIIRS/README.md` e `catalogo_firms_tema8.html`.

## 5. Fases, com critério de pronto

### F0 · Ambiente (sáb, até 16h)

- `monitor-cinder/docker-compose.yml` com `postgis/postgis:16-3.4`. Na subida, aplicar nesta ordem: `schema.sql`, `schema_cinder.sql`, `schema_contexto.sql`.
- `monitor-cinder/api`: `npm init`, TypeScript strict, Fastify respondendo `/api/meta` com `{ service: "monitor-cinder", … }`.
- **Pronto quando:** os testes `teste_schema.sql` → `teste_cinder.sql` → `teste_contexto.sql` rodam sem erro num banco vazio, e o front em `Mapa iterativo/index.html` troca a faixa "DEMO" por "Live API".

### F1 · Ingestão de Goiás (sáb, 16h–20h)

1. `job:load-regions`: malha e nomes do IBGE → `fire.region` (UF `52` e 246 municípios). `ST_Multi(ST_MakeValid(...))`, SRID 4326.
2. `job:ingest-firms`: para cada sensor e ano, baixar o CSV anual **em streaming**, SHA-256, registrar em `fire.ingest_batch` (URL sem chave).
   - Filtro 1: caixa de Goiás (oeste −53,25, sul −19,50, leste −45,90, norte −12,39). Filtro 2: polígono do estado (no banco).
   - Mapear: `brightness`/`bright_ti4` → `brightness_k`; `bright_t31`/`bright_ti5` → `brightness2_k`; `confidence` → `confidence_raw` e `fire.normalize_confidence`.
   - `COPY` para tabela temporária + `INSERT … ON CONFLICT ON CONSTRAINT hotspot_natural_ux DO NOTHING`.
   - CSV bruto em `data/raw/` (fora do git).
3. **Pronto quando:** há focos de 2001–2025 (MODIS) e 2012–2025 (VIIRS); rodar de novo não duplica; contagem por ano em log.

> **Ponto de corte às 20h:** se travar, usar só 2012–2025 nos dois sensores.

### F2 · Harmonização e validação (sáb, 20h–24h)

1. `REFRESH MATERIALIZED VIEW fire.hotspot_cell_day` (primeira vez sem `CONCURRENTLY`). Só confiança nominal ou alta.
2. Fator por município e mês do ano: **soma das células-dia VIIRS ÷ soma das células-dia MODIS** no período de calibração → `fire.harmonization_factor` (`method='monthly_ratio'`).
3. **Validação com dados separados:** calibrar 2012–2019, testar 2020–2025 (MODIS convertido × VIIRS real). Métricas: erro absoluto percentual médio por mês, Pearson e viés → `monitor-cinder/api/out/validation.json`. **É o número central do pitch.**
4. Recalibrar com 2012–2025 e preencher `fire.calendar_monthly` (2012+ = VIIRS; 2001–2011 = MODIS × fator; `modis_count`/`viirs_count` sempre que existirem). Depois `fire.refresh_baseline(region, 'monthly_ratio', 2002, 2024)` e `fire.evaluate_alerts`.
5. `job:ingest-inpe-ref` (2012–2025 basta): contar focos do arquivo de referência por município e mês → `fire.inpe_reference_monthly`. Salvar `fire.inpe_vs_firms` de Goiás em `out/inpe_check.json`.
6. **Pronto quando:** `validation.json` e `inpe_check.json` existem e o calendário de cada município tem 2001–2025 com anomalia.

> Se o erro for alto nos meses chuvosos (poucos focos), não esconder: mostrar o erro por mês em "Method & limits".

### F2a · Sem banco: a API baixa o histórico real sozinha

Sem PostGIS e sem `data/firms_goias_cells.json`, o `npm run dev` começa a baixar o histórico do NASA FIRMS em segundo plano (`job:build-cell-index`): API de área com a `FIRMS_MAP_KEY` (só a caixa de Goiás, MODIS_SP 2001–2025 e VIIRS_SNPP_SP 2012–2025, janelas de 5 dias, cerca de 2 900 requisições) e o arquivo anual do Brasil como reserva. Cada ano fica em `data/firms_years/`, então reiniciar não baixa de novo. Enquanto isso, `/api/meta` informa `dataKind: "loading"` com o progresso e as rotas de dados respondem 503. Ao terminar, calendários, mapa, faixa esperada (com retroteste calculado), círculo exato, células, focos-raiz e `out/validation.json` (erro 2012–2019 → 2020–2025) saem dos focos reais.

Não existe mais dado sintético: sem semeadura de focos, sem tabela fixa de clima e sem DEMO no front. Os blocos A–D, o mapa de propensão e o score agro respondem 503 até serem refeitos com entradas reais.

### F2b · Histórico real, faixa esperada e focos-raiz (`schema_projecao.sql`)

Mantém a normalização de F2 (confiança → célula-dia de 1 km → fator mensal VIIRS ÷ MODIS) e acrescenta, tudo calculado no banco a partir do FIRMS:

- **Fator com encolhimento:** `w = MODIS/(MODIS+30)` puxa o fator do município para o do estado quando há poucos focos. Fontes fixas (FIRMS `type=2` ou ≥8 meses distintos em ≥3 anos) ficam fora (`fire.static_cell`).
- **Erro da harmonização:** calibra 2012–2019, testa 2020–2025 (WAPE, MAPE nos meses com ≥10, Pearson, viés), no estado e por município (mediana e p90) → `out/validation.json`.
- **Faixa esperada pelo histórico** (não é previsão): P10/P50/P90 dos mesmos meses dos anos anteriores (`all` = 2002→ano−1 ou `recent10`), e anos análogos (acumulado jan→mês−1 mais parecido). O método mostrado é escolhido por **retroteste** 2015–2025 (cobertura P10–P90 entre 70 e 90 %, depois menor erro da mediana). Os análogos só aparecem se baterem a faixa → `out/projection_validation.json`.
- **Focos-raiz:** anos com fogo por célula (1 km harmonizado; 500 m só VIIRS 2012+), com vizinhança 3×3. Acerto testado no último ano carregado (janela de 10 anos, ≥5 anos com fogo).
- **Raio exato:** só as células cujo centro está dentro do círculo. Mínimo de 5 km com 1 km e de 1 km com VIIRS 500 m.
- **Densidade** por 1.000 km² no `/api/map?metric=density`.

Rotas novas (zod, problem+json, 503 enquanto não houver histórico): `GET /api/validation`, `GET /api/projection?ibge=&year=&month=`, `GET /api/area/history?lon=&lat=&radiusKm=&source=`, `GET /api/layers/recurrence?west=&south=&east=&north=&from=&to=&month=&source=&res=`, `GET /api/layers/cells?ibge=` ou `?lon=&lat=&radiusKm=` + `&year=&month=&res=` (células de 1, 2 ou 5 km dentro do município ou do círculo; a soma é o valor harmonizado da área no mês, conferido em `teste_projecao.sql`). `/api/meta` informa `dataKind: firms_db | firms_index | loading | none` e `chain` (último dia observado, início do NRT provisório, validação de cada elo MODIS→S-NPP, NOAA-20→S-NPP, NOAA-21→S-NPP). `GET /api/projection/horizons?ibge=` ou `?lon=&lat=&radiusKm=`: modelo diário binomial negativo (sazonalidade + lags 1/7/30 dias), simulado para 15 dias, meses e 6 meses; retroteste 2015–2025 (CRPS e Brier contra a climatologia, cobertura P10–P90) gravado em `out/projection_validation.json`; horizonte sem ganho mostra a climatologia. A faixa é calibrada com os erros das origens de 2015–2020 (alargamento em log1p até 80 % de cobertura) e pontuada só em 2021–2025. `npm run job:validate` grava a prova em `out/`: `internal_checks.json` (elos da cadeia, soma dos municípios = estado, retroteste calibrado), `projection_validation.json` e `external_validation.json` (série do satélite de referência do INPE/AQUA para Goiás, baixada de `data.inpe.br`: correlação mensal e anual, sinal da anomalia e 2026 já em NOAA-20/21); o INPE é só validação, nunca entrada.

**Rodar (Windows, dados no D:\\):** o C: não tem espaço para o histórico. No Docker Desktop, *Settings → Resources → Advanced → Disk image location* → `D:\DockerData`, *Apply & restart*. Não montar `PGDATA` direto numa pasta NTFS, porque o Postgres recusa as permissões. Depois, em `monitor-cinder/`:

```powershell
docker compose up -d                      # aplica 01…05_schema_projecao.sql num volume novo
# volume antigo (sem o 05)? aplicar à mão:
# Get-Content ..\Tema_08_MODIS_VIIRS\db\schema_projecao.sql | docker exec -i monitor-cinder-postgis psql -U cinder -d cinder
cd api
npm run job:db-load-regions               # IBGE → fire.region (UF 52 + 246 municípios)
npm run job:ingest-firms-history -- --from=2001 --to=2025          # FIRMS SP; pula anos já carregados
npm run job:build-history                 # grades, fatores, calendários, retroteste, out/*.json
npm run test:db                           # com TEST_DATABASE_URL apontando para um banco descartável
```

Sem FIRMS carregado, `out/validation.json` fica `{"pending": true}` e a interface mostra DEMO. Nunca digitar números nesses arquivos.

### F3 · API (sáb 22h – dom 13h)

Contrato que o front já consome (detalhes no `Mapa iterativo/README.md`):

| Método | Rota | Fonte no banco |
| --- | --- | --- |
| GET | `/api/meta` | fontes, licenças, período carregado, `validation.json`, `inpe_check.json` |
| GET | `/api/geo/municipalities?uf=52` | GeoJSON simplificado (`ST_SimplifyPreserveTopology`), `properties.codarea`, `Cache-Control` longo |
| GET | `/api/map?year=&month=&metric=anomaly\|count` | `fire.calendar_monthly` de todos os municípios → `{ values: { ibge: número\|null } }` (1 consulta) |
| GET | `/api/municipalities/{ibge}/calendar` | `fire.calendar_monthly` → `rows[{ year, month, modis, viirs, harmonized, anomalyZ, daysMissing }]` |
| GET | `/api/municipalities/{ibge}/pattern` | `fire.seasonal_pattern` + `fire.fire_season` |
| GET | `/api/municipalities/{ibge}/context?year=` | `fire.context_yearly` ⨝ `fire.context_metric` → `items[{ key, label, value, unit, source }]`, com `key = source \|\| '.' \|\| metric` (o front traduz pela `key`) |
| GET | `/api/municipalities/{ibge}/alerts` | `fire.alert_event` (colunas liberadas) |
| GET | `/api/municipalities/{ibge}/calendar.csv` | streaming; células que começam com `= + - @ \t \r` recebem prefixo `'` |

- Rotas que recebem `{ibge}` traduzem o código para `region_id` numa só consulta (`WHERE kind='municipio' AND ibge_code=$1`); código inexistente → 404 problem+json.
- **Pronto quando:** todos os endpoints respondem com dados reais de Goiás e há um teste de integração por endpoint (incluindo entradas inválidas → 400).

### F4 · Front (já pronto; ajustes até dom 17h)

- Pasta `Mapa iterativo/`: interface em português (botão `EN` para inglês), mapa fluido (movimento por bitmap com transform de CSS, roda suave, inércia, pinça, voo de zoom), mapa por município com anomalia ou contagem, tooltip, clique com zoom, busca sem acento (`/`), tema claro/escuro, painel com padrão histórico, época típica, calendário clicável (muda o mês do mapa), comparação MODIS × VIIRS × harmonizado, contexto e CSV. Link compartilhável via `#y=…&m=…&ibge=…`.
- Falta: página "Method & limits" (fontes, fórmula do fator, `validation.json` e `inpe_check.json` em tabela, o que o app não faz) e lista de alertas no painel.
- Publicação: servir a pasta como estática (mesmo domínio da API facilita o CSP). Ao mudar `apiBase` em `config.js`, atualizar o `connect-src` no `index.html`.

### F5 · Entrega (dom 17h–22h)

- Deploy: banco (Supabase ou VM), API e front num link público, testados em janela anônima.
- README do repositório **em inglês**: o que é, como rodar, fontes, método, limites e "AI-assisted code".
- Vídeo de até 30 s com legenda em inglês: problema (MODIS no fim da vida) → mapa → calendário → anomalia e alerta → número da validação.
- Página do projeto: NASA Data (FIRMS, POWER, ORNL DAAC MOD13Q1/MCD12Q1) e References (IBGE, INPE, bibliotecas; Painel do Fogo e BDQueimadas como trabalhos relacionados).
- **Submit for Judging às 22h.**

### F6 · Previsão e agente conversacional (dom, manhã; branch `feat/agente-previsao`)

Decisão da equipe em 15/11: a previsão entra no escopo. O estado real de cada peça está em `CONFERENCIA.md`, os passos em `PLANO.md` e as decisões em `DECISOES.md`.

- **Previsão de focos por município e mês.** Treino até 2019, teste em 2020–2025, sem embaralhar anos. Linhas de base: climatologia (média do mesmo mês) e persistência (mesmo mês do ano anterior). Métricas: MAE e, para "mês acima do P90", Brier score e calibração → `monitor-cinder/api/out/forecast_validation.json`. **Se o modelo não superar a climatologia, a climatologia é a previsão oficial**, e isso é dito na interface.
- **Toda previsão mostrada** traz valor, intervalo P10–P90, probabilidade de ficar acima do P90, período de treino e métrica de validação fora da amostra. É previsão de **ocorrência de focos por área e mês**, nunca de comportamento do fogo.
- **Agente (`POST /api/assistant`)**: chama a própria API como ferramentas somente leitura; o LLM recebe só agregados (≈2 KB por chamada). Roteamento com modelo pequeno, redação multi-fonte com modelo maior, e **modo sem LLM** (palavras-chave + texto preenchido) quando não há `ANTHROPIC_API_KEY`.
- **Conferência determinística antes de cada resposta** (zero tokens): todo número existe na saída de uma ferramenta; toda previsão tem intervalo, treino e métrica; nenhuma frase atribui causa; falhou duas vezes → responde só o verificável e diz o que faltou. Cada conferência vai para um log de decisões.
- **Salvaguardas:** nunca autoriza nem recomenda acender fogo (Lei 14.944/2024, órgão ambiental de Goiás, plano de queima, aceiro, Corpo de Bombeiros); dado com mais de 24 h de defasagem é sinalizado; fora de Goiás ou sem dado → "sem dados".

## 6. O mapa (já implementado)

Ver `Mapa iterativo/README.md`. Resumo das decisões:

- Projeção policônica (parâmetros do EPSG:5880, meridiano −54°) escrita por nós; caminhos projetados uma vez em `Path2D`; zoom e arraste mudam só a matriz do canvas.
- Hit-test: caixa delimitadora + `isPointInPath` em unidades do mapa.
- Duas camadas de canvas: base (preenchimento, bordas, rótulos) e destaque (hover e seleção).
- Cores interpoladas em OKLab; rótulos com contraste WCAG; rampa divergente para anomalia e logarítmica para contagem.
- Sem a API, entra em modo **DEMO** com valores sintéticos e faixa amarela explícita.

## 7. Testes e verificação

- **Banco:** `teste_schema.sql`, `teste_cinder.sql`, `teste_contexto.sql`, `teste_projecao.sql` (dados sintéticos com resposta conhecida) + um teste com amostra real de Goiás conferida contra o CSV original.
- **Conectores:** cada um com fixture local (sem rede): CSV do FIRMS, zip do INPE, GeoJSON do IBGE e do WFS, JSON do SATVeg e do POWER; inclui resposta malformada → erro tratado.
- **Jobs:** idempotência (rodar duas vezes, mesma contagem) e recorte (nenhum foco fora do polígono de GO).
- **API:** integração com Testcontainers (PostGIS); entradas inválidas → 400 problem+json; CSV com célula `=cmd` sai com `'`.
- **Front:** já testado com Playwright (DEMO e API simulada, sem erros de JS nem violações de CSP). Repetir com a API real.
- **Números do pitch:** todo número dito no vídeo sai de um arquivo em `monitor-cinder/api/out/`.

## 8. Pendências conhecidas

- Tamanhos dos CSV do FIRMS conferidos só em parte dos anos.
- O mesmo fogo pode cair em 2 células de 1 km: declarar nos limites.
- SATVeg: rota exata e cota atual precisam ser conferidas no portal AgroAPI depois do cadastro; sem token, o contexto mostra só PRODES/DETER e POWER.
- PRODES/DETER: conferir os atributos das camadas (`DescribeFeatureType`) e se o WFS limita o número de feições por requisição (paginar com `startIndex`).
- MCD12Q1 exige Earthdata e raster: só se sobrar tempo no domingo.
- Nome "Monitor Cinder": conferir se já existe produto com esse nome antes de fixá-lo no pitch.
