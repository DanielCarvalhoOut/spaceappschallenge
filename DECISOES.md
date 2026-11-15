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
