# CLAUDE.md · Monitor Cinder (NASA Space Apps 2026, Goiânia)

Leia `IMPLEMENTACAO.md` antes de qualquer tarefa. Ele tem contexto, escopo, fases e critérios de pronto.

## Em uma frase
Monitor Cinder harmoniza os focos de calor MODIS e VIIRS (NASA FIRMS) de 2001 até hoje para Goiás e mostra, por município do IBGE, o padrão histórico de fogo, a anomalia do mês, alertas para gestores, contexto do INPE, da Embrapa e da NASA POWER, e uma previsão de focos por município e mês (validada contra climatologia e persistência) consultável por um agente conversacional. Desafio: "Harmonization of MODIS and VIIRS Hot Spots". Prazo: domingo 15/11/2026, 23h59 (meta: 22h).

## Stack
- Front: `Mapa iterativo/` — JavaScript puro + Canvas 2D, scripts clássicos, sem build. Já pronto e autoral; mudanças preservam a API `FireMap`/`FireData` e o contrato descrito no README da pasta.
- Back: `monitor-cinder/api/` — Node 22 + TypeScript strict, Fastify, `pg`, `zod`. Conectores em `src/connectors/` (um por fonte), rotas em `src/modules/`, jobs em `src/jobs/`.
- Banco: PostGIS. Aplicar `Tema_08_MODIS_VIIRS/db/schema.sql`, `schema_cinder.sql`, `schema_contexto.sql`, `schema_operacional.sql`, `schema_projecao.sql` e `schema_intervencao.sql`, nesta ordem (o `docker-compose.yml` já faz). Dados do Postgres no D:\ (ver `IMPLEMENTACAO.md` F2b).

## Regras
- Trabalho original: não recriar nem trazer de volta nada dos arquivos antigos de terceiros do mapa (`assets/`, `painel-original.html`).
- O FIRMS é a única base da harmonização e da anomalia. INPE, Embrapa e POWER são contexto e validação, nunca causa.
- **Previsão está no escopo** (decisão da equipe em 15/11): focos por município e mês, e agente conversacional (`POST /api/assistant`). Toda previsão mostrada traz **intervalo (P10–P90), período de treino e métrica de validação fora da amostra** (contra climatologia e persistência); toda probabilidade traz n e fonte. "forecast", "prediction" e "risk" são permitidos nesse contexto. A previsão é de ocorrência de focos por área e mês, nunca de comportamento do fogo (velocidade, direção, alcance).
- **Nunca atribuir causa.** "associated with" / "associado a" é permitido; "cause", "caused by" / "causado por" é proibido. INPE, Embrapa, POWER e ONI são contexto.
- O agente nunca autoriza nem recomenda acender fogo; resposta sobre queima controlada sempre remete ao órgão ambiental (Lei 14.944/2024) e ao Corpo de Bombeiros.
- Interface **bilíngue**: português por padrão (apresentação local) e inglês no botão `EN` (vídeo, capturas, júri global). Todo texto novo entra nos dois idiomas em `Mapa iterativo/i18n.js`. README do app e página do projeto em **inglês**.
- Segredos (`FIRMS_MAP_KEY`, `EMBRAPA_CONSUMER_KEY/SECRET`, `ANTHROPIC_API_KEY`) só em `monitor-cinder/api/.env` (fora do git; nunca como valor padrão no código). O front nunca chama FIRMS, Embrapa nem o LLM. Logger com redaction.
- TypeScript: sem `any`; zod em toda entrada HTTP e toda resposta externa; consultas parametrizadas; um endpoint = uma consulta (sem N+1); erros em problem+json sem stack; rate limit (mais restrito no CSV); CORS só para a origem do front; API com o papel `fire_api_ro`.
- Front: `textContent` sempre (nunca `innerHTML` com dado externo); CSP sem `unsafe-inline`; se mudar `apiBase` em `config.js`, atualizar o `connect-src` do `index.html`.
- Não altere tabelas sem atualizar os testes em `db/teste_*.sql`.
- Todo número mostrado na interface vem da API; todo número do pitch vem de um arquivo em `monitor-cinder/api/out/`.

## Onde está cada coisa
- Contrato do front ↔ API: `Mapa iterativo/README.md` e `IMPLEMENTACAO.md` §5 F3
- Fontes, URLs conferidas e papéis: `IMPLEMENTACAO.md` §4 e `Tema_08_MODIS_VIIRS/dados_apis_e_sensores.md`
- Banco e testes: `Tema_08_MODIS_VIIRS/db/`
- Agente e previsão: `CONFERENCIA.md` (o que existe, com evidência), `PLANO.md`, `DECISOES.md` e `IMPLEMENTACAO.md` §5 F6
