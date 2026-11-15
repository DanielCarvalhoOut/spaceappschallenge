# CLAUDE.md · Monitor Cinder (NASA Space Apps 2026, Goiânia)

Leia `IMPLEMENTACAO.md` antes de qualquer tarefa. Ele tem contexto, escopo, fases e critérios de pronto.

## Em uma frase
Monitor Cinder harmoniza os focos de calor MODIS e VIIRS (NASA FIRMS) de 2001 até hoje para Goiás e mostra, por município do IBGE, o padrão histórico de fogo, a anomalia do mês, alertas para gestores, validação externa com o INPE e contexto da NASA POWER e do NASA ORNL DAAC (MODIS). Desafio: "Harmonization of MODIS and VIIRS Hot Spots". Prazo: domingo 15/11/2026, 23h59 (meta: 22h).

## Stack
- Front: `Mapa iterativo/` — JavaScript puro + Canvas 2D, scripts clássicos, sem build. Já pronto e autoral; mudanças preservam a API `FireMap`/`FireData` e o contrato descrito no README da pasta.
- Back: `monitor-cinder/api/` — Node 22 + TypeScript strict, Fastify, `pg`, `zod`. Conectores em `src/connectors/` (um por fonte), rotas em `src/modules/`, jobs em `src/jobs/`.
- Banco: PostGIS. Aplicar `Tema_08_MODIS_VIIRS/db/schema.sql`, `schema_cinder.sql`, `schema_contexto.sql`, `schema_operacional.sql` e `schema_projecao.sql`, nesta ordem (o `docker-compose.yml` já faz). Dados do Postgres no D:\ (ver `IMPLEMENTACAO.md` F2b).

## Regras
- Trabalho original: não recriar nem trazer de volta nada dos arquivos antigos de terceiros do mapa (`assets/`, `painel-original.html`).
- O FIRMS é a única base da harmonização e da anomalia. O GOES-19 (NOAA) só alimenta o aviso de fogo agora, opcional, e nunca entra na série harmonizada. INPE (validação), NASA POWER e NASA ORNL DAAC (contexto: clima, NDVI e uso do solo) nunca são causa.
- Projeção só como "projeção com faixa de incerteza validada" (PT) / "projection with a validated uncertainty band" (EN): modelo diário binomial negativo, retroteste 2015–2025 contra a climatologia, e só se publica o horizonte com ganho (skill > 0); sem ganho, mostra-se a climatologia. Use "historical pattern", "anomaly", "typical fire season", "context". Nunca "forecast", "prediction", "risk" ou "cause".
- Interface **bilíngue**: português por padrão (apresentação local) e inglês no botão `EN` (vídeo, capturas, júri global). Todo texto novo entra nos dois idiomas em `Mapa iterativo/i18n.js`. README do app e página do projeto em **inglês**.
- Segredos (`FIRMS_MAP_KEY`) só em `monitor-cinder/api/.env`. O front nunca chama FIRMS, POWER nem ORNL DAAC (só a nossa API e, como reserva, o IBGE). Logger com redaction.
- TypeScript: sem `any`; zod em toda entrada HTTP e toda resposta externa; consultas parametrizadas; um endpoint = uma consulta (sem N+1); erros em problem+json sem stack; rate limit (mais restrito no CSV); CORS só para a origem do front; API com o papel `fire_api_ro`.
- Front: tela = mapa + painel lateral de detalhes ao lado (abas Resumo, Projeção, Histórico, Área, Contexto), com botão no rodapé do painel para abrir os mesmos detalhes em tela cheia (modal) e voltar; hover rico. Sem seleção, o mapa ocupa a largura toda. O círculo conta só o que está dentro dele (sem estimativa por município inteiro).
- Front: `textContent` sempre (nunca `innerHTML` com dado externo); CSP sem `unsafe-inline`; se mudar `apiBase` em `config.js`, atualizar o `connect-src` do `index.html`.
- Não altere tabelas sem atualizar os testes em `db/teste_*.sql`.
- Todo número mostrado na interface vem da API; todo número do pitch vem de um arquivo em `monitor-cinder/api/out/`.

## Onde está cada coisa
- Contrato do front ↔ API: `Mapa iterativo/README.md` e `IMPLEMENTACAO.md` §5 F3
- Fontes, URLs conferidas e papéis: `IMPLEMENTACAO.md` §4 e `Tema_08_MODIS_VIIRS/dados_apis_e_sensores.md`
- Banco e testes: `Tema_08_MODIS_VIIRS/db/`
