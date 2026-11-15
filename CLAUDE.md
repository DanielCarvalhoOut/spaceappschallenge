# CLAUDE.md · Monitor Cinder (NASA Space Apps 2026, Goiânia)

Leia `IMPLEMENTACAO.md` antes de qualquer tarefa. Ele tem contexto, escopo, fases e critérios de pronto.

## Em uma frase
Monitor Cinder harmoniza os focos de calor MODIS e VIIRS (NASA FIRMS) de 2001 até hoje para Goiás e mostra, por município do IBGE, o padrão histórico de fogo, a anomalia do mês, alertas para gestores, validação externa com o INPE, contexto da NASA POWER e do NASA ORNL DAAC (MODIS), aviso de fogo agora (GOES-19, opcional) e uma previsão de focos por município e mês (validada contra climatologia e persistência) consultável por um agente conversacional. Desafio: "Harmonization of MODIS and VIIRS Hot Spots". Prazo: domingo 15/11/2026, 23h59 (meta: 22h).

## Stack
- Front: `Mapa iterativo/` — JavaScript puro + Canvas 2D, scripts clássicos, sem build. Já pronto e autoral; mudanças preservam a API `FireMap`/`FireData` e o contrato descrito no README da pasta.
- Back: `monitor-cinder/api/` — Node 22 + TypeScript strict, Fastify, `pg`, `zod`. Conectores em `src/connectors/` (um por fonte), rotas em `src/modules/`, jobs em `src/jobs/`.
- Banco: PostGIS. Aplicar `Tema_08_MODIS_VIIRS/db/schema.sql`, `schema_cinder.sql`, `schema_contexto.sql`, `schema_operacional.sql`, `schema_projecao.sql` e `schema_intervencao.sql`, nesta ordem (o `docker-compose.yml` já faz). Dados do Postgres no D:\ (ver `IMPLEMENTACAO.md` F2b).

## Regras
- Trabalho original: não recriar nem trazer de volta nada dos arquivos antigos de terceiros do mapa (`assets/`, `painel-original.html`).
- O FIRMS é a única base da harmonização e da anomalia. O GOES-19 (NOAA) só alimenta o aviso de fogo agora, opcional, e nunca entra na série harmonizada. INPE (validação), NASA POWER, NASA ORNL DAAC (contexto: clima, NDVI e uso do solo) e ONI são contexto, nunca causa.
- Projeção diária só como "projeção com faixa de incerteza validada" (PT) / "projection with a validated uncertainty band" (EN): modelo diário binomial negativo, retroteste 2015–2025 contra a climatologia, e só se publica o horizonte com ganho (skill > 0); sem ganho, mostra-se a climatologia.
- **Previsão mensal e agente estão no escopo** (decisão da equipe em 15/11): focos por município e mês, e agente conversacional (`POST /api/assistant`). Toda previsão mostrada traz **intervalo (P10–P90), período de treino e métrica de validação fora da amostra** (contra climatologia e persistência); toda probabilidade traz n e fonte. "forecast", "prediction" e "risk" são permitidos nesse contexto. A previsão é de ocorrência de focos por área e mês, nunca de comportamento do fogo (velocidade, direção, alcance).
- **Nunca atribuir causa.** "associated with" / "associado a" é permitido; "cause", "caused by" / "causado por" é proibido.
- O agente nunca autoriza nem recomenda acender fogo; resposta sobre queima controlada sempre remete ao órgão ambiental (Lei 14.944/2024) e ao Corpo de Bombeiros.
- Interface **bilíngue**: português por padrão (apresentação local) e inglês no botão `EN` (vídeo, capturas, júri global). Todo texto novo entra nos dois idiomas em `Mapa iterativo/i18n.js`. README do app e página do projeto em **inglês**.
- Segredos (`FIRMS_MAP_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) só em `monitor-cinder/api/.env` (nunca como valor padrão no código, nunca em URL). O `.env` está rastreado no git **temporariamente**, para os testes da equipe; sai do git e a MAP_KEY é trocada depois da entrega. O front nunca chama FIRMS, POWER, ORNL DAAC nem o LLM (só a nossa API e, como reserva, o IBGE). Logger com redaction.
- LLM do agente: **Gemini** (`GEMINI_API_KEY`; `gemini-3.5-flash-lite` roteia, `gemini-3.5-flash` só redige ENSO e intervenções). Também aceita `OPENAI_API_KEY` e `ANTHROPIC_API_KEY`: a ordem vem de `LLM_PROVIDERS` e o seguinte é a reserva quando o primeiro falha. Sem chave, o agente roda sem LLM. Resposta de queima controlada é sempre texto fixo, nunca do modelo. Tudo que o modelo escreve passa pela conferência determinística.
- Série da previsão e do agente: PostGIS (`fire.calendar_monthly`) quando o histórico tem MODIS e VIIRS; senão o índice em memória (cadeia de satélites). Depois de mudar a série, rodar `npm run job:forecast`.
- TypeScript: sem `any`; zod em toda entrada HTTP e toda resposta externa; consultas parametrizadas; um endpoint = uma consulta (sem N+1); erros em problem+json sem stack; rate limit (mais restrito no CSV); CORS só para a origem do front; API com o papel `fire_api_ro`.
- Front: tela = mapa + painel lateral de detalhes ao lado (abas Resumo, Projeção, Histórico, Área, Contexto), com botão no rodapé do painel para abrir os mesmos detalhes em tela cheia (modal) e voltar; hover rico. Sem seleção, o mapa ocupa a largura toda. O círculo conta só o que está dentro dele (sem estimativa por município inteiro).
- Front: `textContent` sempre (nunca `innerHTML` com dado externo); CSP sem `unsafe-inline`; se mudar `apiBase` em `config.js`, atualizar o `connect-src` do `index.html`.
- Não altere tabelas sem atualizar os testes em `db/teste_*.sql`.
- Todo número mostrado na interface vem da API; todo número do pitch vem de um arquivo em `monitor-cinder/api/out/`.

## Onde está cada coisa
- Contrato do front ↔ API: `Mapa iterativo/README.md` e `IMPLEMENTACAO.md` §5 F3
- Fontes, URLs conferidas e papéis: `IMPLEMENTACAO.md` §4 e `Tema_08_MODIS_VIIRS/dados_apis_e_sensores.md`
- Banco e testes: `Tema_08_MODIS_VIIRS/db/`
- Agente e previsão: `CONFERENCIA.md` (o que existe, com evidência), `PLANO.md`, `DECISOES.md` e `IMPLEMENTACAO.md` §5 F6
