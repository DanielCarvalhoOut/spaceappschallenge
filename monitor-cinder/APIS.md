# Monitor Cinder · APIs utilizadas e onde cada uma entra

Documento interno (PT). Levantado direto do código: `monitor-cinder/api/src/connectors/`, `src/jobs/`, `src/db/store.ts` e `Mapa iterativo/cinder-data.js`, em 15/11/2026.

**Regra de arquitetura:** o navegador só fala com a **nossa API** e, como reserva, com o **IBGE**. FIRMS, INPE, NASA POWER e ORNL DAAC são chamados **só pelo servidor**. A chave do FIRMS nunca sai do `.env`.

```
Navegador (Mapa iterativo) ──▶ API Monitor Cinder (localhost:8787) ──▶ FIRMS · IBGE · INPE · NASA POWER · ORNL DAAC
          └──────────── reserva: IBGE (malhas e nomes) ────────────┘
```

---

## 1. APIs externas

### 1.1 NASA FIRMS: base de tudo (focos de calor)

| Endpoint | Para que serve | Onde no código | Quando roda |
|---|---|---|---|
| `firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{KEY}/ALL` | Descobre até que dia cada sensor tem dados definitivos (SP) e quase em tempo real (NRT) | `connectors/firms.ts` → `job:build-cell-index` | Na montagem do índice e no início da API, se o índice estiver atrasado mais de 3 dias |
| `firms.modaps.eosdis.nasa.gov/data/country/{sensor}/{ano}/{sensor}_{ano}_Brazil.csv` | Arquivo anual definitivo do Brasil, por sensor (MODIS, VIIRS S-NPP, NOAA-20, NOAA-21) | `firms.ts` → `job:build-cell-index` e `job:ingest-firms-history` | Montagem do histórico 2001 → hoje |
| `firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SENSOR}/{bbox}/{dias}` | Focos recentes (NRT) recortados para Goiás, em janelas, para os meses que ainda não estão no arquivo definitivo | `firms.ts` → `job:build-cell-index` | Atualização dos dados recentes (provisórios desde 01/08/2026) |

**Função na aplicação:** é a única fonte da **harmonização**, da **anomalia**, do **calendário**, das **células de 1 km**, do **círculo** e da **projeção**. O resultado vai para `data/firms_goias_cells.json` (ou para o PostGIS).

### 1.2 IBGE: geografia

| Endpoint | Para que serve | Onde | Quando |
|---|---|---|---|
| `servicodados.ibge.gov.br/api/v3/malhas/estados/52?intrarregiao=municipio&formato=application/vnd.geo+json` | Polígonos dos 246 municípios de Goiás | `connectors/ibge.ts` (API) e `cinder-data.js` (reserva no front) | Início da API e carregamento do mapa |
| `servicodados.ibge.gov.br/api/v1/localidades/estados/52/municipios?view=nivelado` | Nomes, códigos e microrregiões dos municípios | `ibge.ts` e `cinder-data.js` | Mesmo momento |
| `servicodados.ibge.gov.br/api/v3/malhas/paises/BR?intrarregiao=UF` | Contorno do Brasil e das UFs (botão BR) | `cinder-data.js` | Ao abrir o mapa |
| `geoftp.ibge.gov.br/.../Localidades_do_Brasil/2022/Localidades_UFs_shp.zip` | 1.400 localidades de GO do Censo 2022 (sede, vila, povoado, lugarejo, aglomerados rurais, quilombola, indígena) | `connectors/ibge-localities.ts` (lê o `.dbf` de dentro do zip) | Primeiro início da API; depois fica em cache em `data/ibge_localidades_52.json` |

**Função na aplicação:**
- recorta os focos por município;
- desenha o mapa;
- dá nome às áreas e serve a busca;
- mostra os **povoados no zoom** e o **povoado mais próximo** de cada célula com fogo.

É **só referência geográfica**: nenhum dado do IBGE entra no cálculo do fogo.

### 1.3 INPE Programa Queimadas: validação externa

| Endpoint | Para que serve | Onde | Quando |
|---|---|---|---|
| `data.inpe.br/queimadas/estatisticas/media/estatistica/paises/brasil.json` | Focos mensais por estado (satélite de referência AQUA) | `connectors/inpe-stats.ts` → `job:validate` | Só quando a equipe roda `npm run job:validate` |

**Função na aplicação:** prova independente de que a série harmonizada está certa. Resultados:
- correlação mensal r = 0,955;
- 92,9% de concordância no sinal da anomalia.

Os resultados ficam em `out/external_validation.json` e `out/inpe_goias_reference.json`. **Não entra em nenhum cálculo mostrado no mapa.**

### 1.3b NOAA GOES-19: aviso de fogo agora (opcional, ativado pelo usuário)

| Endpoint | Para que serve | Onde | Quando |
|---|---|---|---|
| `noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=ABI-L2-FDCF/AAAA/DDD/HH/` | Lista as varreduras de fogo (disco inteiro) da última hora | `connectors/goes-fdc.ts` | A cada 10 min, só se houver alguma área monitorada |
| `noaa-goes19.s3.amazonaws.com/ABI-L2-FDCF/.../OR_ABI-L2-FDCF-...nc` | Arquivo NetCDF (~2 MB): máscara de fogo e potência; lemos só a janela de Goiás e as categorias confiáveis (10, 11, 30, 31) | `goes-fdc.ts` (h5wasm) | Idem |

**Função na aplicação:** aviso antecipado para quem ativa. Um pixel só vira aviso se aparece em 2 de 3 varreduras (~20–30 min). O aviso traz o contexto histórico (nossa série) e depois é confirmado ou não pelo VIIRS (FIRMS NRT). **Nunca entra na série harmonizada.**

### 1.4 NASA POWER: contexto climático

| Endpoint | Para que serve | Onde | Quando |
|---|---|---|---|
| `power.larc.nasa.gov/api/temporal/daily/point` | Clima diário no centro do município (MERRA-2): temperatura máxima (T2M_MAX), umidade (RH2M), chuva (PRECTOTCORR) e vento (WS10M) de junho a setembro do ano escolhido | `connectors/nasa-power.ts` → `store.getContextItems` → `/api/municipalities/:ibge/context` | Ao abrir a aba **Contexto** |

**Função na aplicação:** só **contexto** ("como estava a seca naquele ano"). Nunca aparece como causa.

### 1.5 NASA ORNL DAAC (MODIS Land): contexto de vegetação e uso do solo

| Endpoint | Para que serve | Onde | Quando |
|---|---|---|---|
| `modis.ornl.gov/rst/api/v1/MOD13Q1/subset` | NDVI de setembro (MODIS 250 m) no centro do município | `connectors/ornl-modis.ts` → `/context` | Aba **Contexto** |
| `modis.ornl.gov/rst/api/v1/MCD12Q1/subset` | % de área agrícola (classificação IGBP, 500 m) | `connectors/ornl-modis.ts` → `/context` | Aba **Contexto** |

**Função na aplicação:** só **contexto** (vegetação verde e fração agrícola).

---

## 2. A nossa API (Monitor Cinder, Fastify, porta 8787)

Todas as rotas validam a entrada com zod e respondem erro em problem+json. As rotas que o front usa:

| Rota | O que entrega | Onde aparece na interface |
|---|---|---|
| `GET /api/meta` | Estado da API, fonte dos dados (índice ou PostGIS), último dia observado, início do período provisório | Selo do topo, seletor de período, aviso "provisório" |
| `GET /api/geo/municipalities?uf=52` | Malha e nomes dos municípios (vindos do IBGE) | Desenho do mapa, busca |
| `GET /api/map?year&month&metric` | Valor de cada município no mês: anomalia (z), células-dia, densidade ou padrão típico | Cores do mapa, legenda, hover |
| `GET /api/municipalities/:ibge/calendar` | Série mensal 2001 → hoje, harmonizada, com o satélite de cada mês e o z | Aba **Histórico** (ano → meses), gráfico, KPIs |
| `GET /api/municipalities/:ibge/pattern` | Temporada típica (mediana e faixa por mês) | Abas **Resumo** e **Histórico** |
| `GET /api/daily?ibge\|circle&year&month` | Valor de cada dia do mês e o satélite do dia | Calendário diário da aba **Histórico** |
| `GET /api/municipalities/:ibge/calendar.csv` | A mesma série em CSV (protegida contra injeção de fórmula; 20 pedidos por minuto) | Botão **Série mensal (CSV)** |
| `GET /api/area/fires.csv?ibge\|lon&lat&radiusKm&year&month` | Células de 1 km com detecção no mês: centro, células-dia, dias e satélite, povoado mais próximo (20 pedidos por minuto) | Botão **Focos do mês (CSV)** |
| `POST /api/watch`, `DELETE /api/watch/:id`, `GET /api/watch/:id/alerts`, `GET /api/goes/status`, `POST /api/goes/run` | Liga/desliga o aviso para uma área, lista os avisos (GOES-19 persistente, contexto, confirmação VIIRS), estado da última varredura, "verificar agora" | Bloco **Aviso de fogo agora** na aba Resumo, notificações |
| `GET /api/municipalities/:ibge/alerts` | Meses incomuns (anomalia ≥ +1,5σ e ≥ 10 células-dia) | Bloco **Meses incomuns** na aba Resumo |
| `GET /api/projection?ibge&year&month` | Faixa esperada do mês (P10–P50–P90 dos anos anteriores) e o retroteste | Aba **Resumo** ("faixa esperada"), modo projeção |
| `GET /api/projection/horizons?ibge\|circle` | Projeção com faixa validada: 15 dias e 1 mês (publicados); amanhã e semestre só se tiverem ganho | Aba **Projeção**, faixa do modo projeção |
| `GET /api/area/history?lon&lat&radius` | Histórico **só das células dentro do círculo** | Modo **Círculo** (Esfera) |
| `GET /api/layers/cells?ibge\|circle&year&month` | Células de 1 km com fogo no mês (valor, centro em lat/lon) | Camada de detalhe no mapa, aba **Área** |
| `GET /api/layers/recurrence` | Em quantos anos cada célula queimou | Camada de recorrência (focos que se repetem) |
| `GET /api/cell/detections?lon&lat&res&year&month` | Dias exatos de detecção numa célula e o satélite de cada um | Aba **Área** (ao clicar numa célula), hover da célula |
| `GET /api/localities[?ibge]` | Localidades do IBGE: nome, tipo, lat/lon | Povoados no zoom, "povoado mais próximo" |
| `GET /api/municipalities/:ibge/context?year` | Itens de contexto (NASA POWER, NDVI e uso do solo do ORNL DAAC) | Aba **Contexto** |
| `GET /api/validation` | Números de validação calculados (não digitados) | Não é chamada pelo front; serve para conferência e para o júri |

## 3. Limpeza feita em 15/11

- **Removido do código:** conectores Embrapa SATVeg (nunca chamava a Embrapa), INPE TerraBrasilis/PRODES-DETER (nunca ligado; tinha um valor fixo de reserva) e BDQueimadas por município (repetia o `inpe-stats.ts`).
- **Removido da API:** as rotas antigas `/api/ml/model`, `/resources`, `/root-fires`, `/predictability`, `/agro-score`, `/b2b-risk`, `/intelligence` e `/api/firms/area`, e as métricas `propensity` e `agro_score`. Junto saíram o modelo de ML, a escala de recursos, o score agrícola e a busca de focos em tempo real ao iniciar a API.
- **Rodapé:** agora cita "Validação externa: INPE (Programa Queimadas)" e "Vegetação e uso do solo: NASA ORNL DAAC (MODIS MOD13Q1, MCD12Q1)".
- **CSP do front:** sem `power.larc.nasa.gov`, porque quem chama a NASA POWER é a API.
- **Chave:** a chave do FIRMS saiu do `.env.example` e do valor padrão do `config.ts`.
