# CONFERENCIA.md · o que existe de fato (fase 0, 15/11/2026, 09:26–09:35)

Cada linha tem evidência (`caminho:linha` ou saída de comando). Caminhos de código são relativos a `monitor-cinder/api/`; SQL, a `Tema_08_MODIS_VIIRS/db/`. O que não foi conferido está marcado como **não verificado**.

## Ambiente medido

- **PostGIS do projeto: fora do ar.** `docker ps -a` mostra só `firehub-postgis | Created` (nunca iniciado, nome antigo); a porta 5432 está ocupada pelo contêiner `republica_db`, de outro projeto. Nenhuma consulta foi feita ao banco: **todo número "do banco" está não verificado.**
- `out/validation.json:2` e `out/inpe_check.json:2` estão `"pending": true`; `out/projection_validation.json` não existe (`ls out/`).
- Sem o índice de células (`data/firms_goias_cells.json` ausente às 09:26), a API em memória serve **calendário sintético** (`src/db/store.ts:501-575`, `calendarKind = 'synthetic'` em `src/db/store.ts:457`).
- Ação tomada: `npm run job:build-cell-index -- --from=2001 --to=2025` em segundo plano desde 09:29 (FIRMS anual do Brasil, sem chave; `src/jobs/build-cell-index.ts:1-11`). Às 09:32 havia 3 anos MODIS em `data/firms_years/`. Conclusão do job: **não verificado** (ver DECISOES.md).
- Linha de base de qualidade: `npx tsc --noEmit` sai 0; `npx vitest run` → 8 testes passam, 10 pulados (os de banco, `src/tests/history.db.test.ts`).

## Tabela de capacidades

| Capacidade | Status | Evidência | O que falta |
| --- | --- | --- | --- |
| Série harmonizada (período e granularidade reais) | **Parcial** | Código pronto para série real por município × mês em células-dia de 1 km: VIIRS desde 2012, MODIS × fator mensal do estado antes (`src/core/cell-index.ts:1-8`, `src/db/store.ts:469-499`). Hoje em memória é sintética 2000-11→2025 (`src/db/store.ts:501-575`). Período real carregado: **não verificado** (job em andamento) | Terminar o `job:build-cell-index`; se falhar nos anos VIIRS (o conector lê o CSV inteiro em memória, `src/connectors/firms.ts:227`), a previsão roda sobre dados sintéticos e isso é dito na resposta |
| Estatística e anomalia | **Existe** | z por mês com base 2002–2024 (`src/db/store.ts:488-496`); padrão sazonal e época típica (`src/db/store.ts:637`, rotas `src/modules/routes.ts:223` e `:247`); P10/P50/P90 dos mesmos meses anteriores (`src/db/store.ts:1291`, `schema_projecao.sql:267`); versão no banco em `src/db/history.ts:71` e `:114` | Expor n e período-base junto de cada número; limiar P90 por município-mês |
| Modelo `ml-propensity.ts` / `train-ml.ts` | **Parcial** | Classificador de "surto" (não prevê contagem): `src/core/ml-propensity.ts:181`, alvo em `src/db/store.ts:240-243`. As variáveis de clima do treino são **geradas por RNG** (`src/db/store.ts:198-222`) e o calendário era sintético; logo `rocAuc 0.957` e `brierScore 0.0596` (`out/ml_propensity_model.json:215-216`) **não valem como validação**. Sem linha de base, sem intervalo | Substituir por previsão de contagem com climatologia e persistência como linhas de base, treinada só em dado real |
| `/api/projection` e suas métricas | **Parcial** | Rota em `src/modules/history-routes.ts:50`; faixa P10–P90 e análogos (`schema_projecao.sql:267`, `:280`); retroteste 2015–2025 (`schema_projecao.sql:311`); versão em memória `src/db/store.ts:1291`. Métricas reais: **não verificado** (`out/projection_validation.json` não existe; banco fora do ar) | É faixa histórica, não modelo com features; serve de linha de base (climatologia) |
| ONI (ENSO) | **Não existe** | `grep -rniE "\boni\b\|enso" src` e `db/*.sql` sem resultado. Fonte acessível: `curl https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt` → HTTP 200, 23.050 bytes, cabeçalho `SEAS YR TOTAL ANOM` | Conector `oni.ts` com zod e fixture; comparação de focos por fase com n |
| Intervenções declaradas | **Não existe** | `grep -rni intervention src db` sem resultado; nenhuma tabela em `db/schema*.sql` | Tabela `fire.intervention` + `teste_intervencao.sql` + comparação antes/depois |
| NASA POWER | **Parcial** | Conector diário com zod (`src/connectors/nasa-power.ts:35`, `:80`); tabela `fire.weather_daily_power` (`schema_operacional.sql:221`). Em disco só 5 arquivos de 3 municípios (`data/power_*.json`). Sem resposta em 20 s cai em série climatológica calculada (`src/db/store.ts:775-781`, `:821`) | Não há série mensal 2001–2025 dos 246 municípios → **não é feature confirmada** para o treino; serve de contexto pontual (vento, umidade) na capacidade 6, com aviso quando for a série calculada |
| MODIS MCD12Q1 (uso do solo) | **Parcial** | Conector (`src/connectors/modis-landcover.ts:103`), tabela `fire.cell_land_cover` (`schema_cinder.sql:152`). Em disco só 3 municípios, ano 2024 (`data/mcd12q1_*.json`); há valor de reserva fixo (`src/connectors/modis-landcover.ts:132`) | Sem cobertura dos 246 municípios → **não é feature confirmada**; contexto pontual |
| Vizinhança de municípios | **Parcial** | Centroide e geometria por município (`src/connectors/ibge.ts`, uso em `src/db/store.ts:191`). Não há tabela de adjacência | Vizinhos = k municípios de centroide mais próximo (calculado em memória) |
| Modelo de propagação | **Não existe** | `grep -rniE "spread\|propaga" src` sem resultado. `computeFirePredictability` (`src/core/analytics.ts:402`) é um índice meteorológico, não propagação (detalhe: não verificado) | Nada: fica fora do escopo; a capacidade 6 responde só com histórico e previsão por área |
| Chamada a LLM | **Não existe** | `package.json:25-32` sem SDK; `grep -rniE "anthropic\|claude\|llm" src` sem resultado; `.env` só tem PORT, HOST, CORS_ORIGIN, DATABASE_URL, FIRMS_MAP_KEY, GOIAS_BBOX (nomes listados, valores não exibidos) | Cliente Anthropic + **modo sem LLM** (obrigatório: não há chave) |
| Borda HTTP para o agente | **Parcial** | CORS só aceita `GET, OPTIONS` (`src/server.ts:18`); rate limit global 300/min (`src/server.ts:21-24`); erro em problem+json (`src/server.ts:33-49`) | Liberar `POST`, rate limit restrito na rota do agente, zod no corpo |

## Segredos

- `monitor-cinder/api/.env` **estava rastreado** (`git ls-files` o listava; `.gitignore` tinha a exceção `!monitor-cinder/api/.env`). Feito: `git rm --cached` e remoção da exceção; `git check-ignore -v` agora confirma que é ignorado.
- A mesma `FIRMS_MAP_KEY` estava como valor padrão em `src/config.ts` e em `.env.example` (comparação feita por script, sem exibir o valor) e já está no histórico (commit `9ddf939`). Removida dos dois arquivos. **A chave precisa ser rotacionada** em https://firms.modaps.eosdis.nasa.gov/api/map_key/.

## Padrões a reaproveitar de `SMA/trabalho` (somente leitura)

1. **Arquitetura: o código escolhe cada aresta, não o LLM.** Workflow condicional com funções puras (`entrega5/agente.py:185-224`); orquestrador autônomo descartado com motivo (`entrega5/regra_agente.md:34`).
2. **Papéis por nó:** `rotear` (0 token) → `buscar_*` → `montar_contexto` → `gerar` (único com LLM) → `validar` (sem LLM) → `encerrar` (`entrega5/regra_agente.md:83-92`); roteador por léxico e regex que devolve rota + motivo (`entrega5/comum_agente.py:121-140`).
3. **Ciclo de decisão:** gerar → validar → gerar, no máximo 2 tentativas, contador no estado (`entrega5/agente.py:194-200`); verificador com códigos fixos de recusa (`entrega5/comum_agente.py:252-296`); se nada passa, sai marcado "NÃO VALIDADO" (`entrega5/comum_agente.py:373`).
4. **Documentação:** regra registrada antes de rodar, lacunas marcadas e alternativas descartadas com motivo (`entrega4/regra_escolha_fluxo.md:3`, `entrega5/regra_agente.md:3`); seção "ajustes feitos olhando resultado" (`entrega4/README.md:222`).
5. **Testes de encanamento sem modelo e sem rede**, com dublês (`entrega4/teste_plumbing_fluxo.py:2-3`, `entrega5/teste_plumbing_agente.py:117`); desenvolvimento escolhe, teste só relata (`entrega4/regra_escolha_fluxo.md:90`).
