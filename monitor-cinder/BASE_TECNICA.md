# Monitor Cinder · Base técnica para perguntas do júri

Documento interno da equipe (PT). Cada número aqui vem de um arquivo em `monitor-cinder/api/out/`, gerado por `npm run job:validate` em 15/11/2026 (índice com dados até 14/11/2026). Se o índice for refeito, rode o job de novo e atualize este arquivo.

---

## 1. O projeto em 30 segundos

**Desafio:** "Harmonization of MODIS and VIIRS Hot Spots" (NASA Space Apps 2026).

**O que fazemos:** juntamos os focos de calor de quatro sensores da NASA/NOAA (MODIS, VIIRS S-NPP, VIIRS NOAA-20 e VIIRS NOAA-21), de 2001 até ontem, numa **única série comparável** para Goiás. Em cima dela, mostramos por município:

- o padrão histórico de fogo;
- a anomalia do mês;
- um calendário (ano → mês → dia);
- a área com fogo, com os povoados mais próximos;
- uma projeção com faixa de incerteza validada.

**Por que importa agora:**
- O S-NPP parou de entregar dados em **2/11/2026**.
- O MODIS para em **2027** (Terra em fev/2027, Aqua em set/2027, segundo o LAADS DAAC).
- Sem harmonização, quem compara anos diferentes compara sensores diferentes e enxerga "aumentos" ou "quedas" que são só troca de satélite.

---

## 2. Fontes de dados e o papel de cada uma

| Fonte | O que usamos | Papel |
|---|---|---|
| **NASA FIRMS** (MODIS C6.1, VIIRS 375 m S-NPP / NOAA-20 / NOAA-21) | Arquivos anuais por país (arquivo + NRT) | **Única base** da harmonização, da anomalia e da projeção |
| **IBGE** — malhas municipais | Limites e nomes dos 246 municípios de GO | Geografia |
| **IBGE** — Base de Localidades do Censo 2022 | 1.400 pontos em GO (sede, vila, povoado, lugarejo, aglomerados rurais, quilombola, indígena…) | Só referência no mapa (zoom) e "povoado mais próximo" |
| **INPE** — Programa Queimadas | Estatística mensal por estado (satélite de referência AQUA) | **Validação externa** e contexto; nunca entra no cálculo |
| **INPE** PRODES/DETER, **Embrapa** SATVeg, **NASA POWER** | Desmatamento, vegetação, clima | Contexto; nunca é apresentado como causa |

**Regra de linguagem:** dizemos "padrão histórico", "anomalia", "temporada típica", "contexto" e "projeção com faixa de incerteza validada". Nunca dizemos "previsão", "risco" ou "causa".

---

## 3. Como a harmonização funciona

### 3.1 Unidade: célula-dia de 1 km

- Cada foco cai numa **célula de 1 km × 1 km** de uma grade fixa em SIRGAS 2000 / Policônica do Brasil (EPSG:5880). É a mesma grade da função `fire.cell_key()` do banco.
- Contamos **células-dia**: uma célula com fogo num dia vale 1, não importa quantos focos o sensor marcou nela.

**Por que essa unidade:**
- O VIIRS (375 m) marca vários pixels para o mesmo fogo, e o MODIS (1 km) marca um.
- Contar focos brutos inflaria o VIIRS cerca de 3×. A célula-dia de 1 km neutraliza boa parte dessa diferença de resolução.
- A unidade é a mesma para todos os sensores, então dá para somar e comparar.

### 3.2 Limpeza

- Só entram focos de **confiança nominal ou alta**.
- Removemos **fontes estáticas**: células em que mais da metade dos focos tem o tipo 2 do FIRMS (indústria, gás, vulcão). É a mesma regra de `fire.build_static_cells`.
- Só entram focos dentro dos municípios de Goiás.

### 3.3 Cadeia de satélites (todos na escala do S-NPP)

```
MODIS (2001–2011) ──fator──▶ S-NPP (2012 → 2/11/2026) ◀──fator── NOAA-20 / NOAA-21 (lacunas do S-NPP e depois do fim)
```

- **Referência:** o S-NPP, porque é o VIIRS com a série mais longa.
- **Escolha do sensor de cada dia:**
  - antes do S-NPP, MODIS;
  - com o S-NPP observando, S-NPP;
  - quando o S-NPP falha ou depois que ele acabou, NOAA-20 e, em seguida, NOAA-21.
- **Fatores:** um **fator por mês do ano** (12 fatores por ligação), medido **só nos dias em que os dois sensores observaram**. O fator é mensal porque a relação MODIS/VIIRS muda com a estação: no fim da seca há mais focos pequenos que o MODIS não enxerga.
- **Fatores MODIS→S-NPP:** de 0,86 (março) a 3,46 (novembro).
- **Fatores NOAA-20 e NOAA-21:** todos perto de 1 (0,91–1,09), o que é esperado, porque é o mesmo instrumento.

### 3.4 Calibração separada do teste (para não "colar")

| Ligação | Calibra em | Testa em | Meses de teste | WAPE | r de Pearson | Viés |
|---|---|---|---|---|---|---|
| MODIS → S-NPP | 2012–2019 | 2020–2025 | 72 | **12,4%** | **0,981** | +2,0% |
| NOAA-20 → S-NPP | 2018–2023 | 2024–2025 | 24 | **2,5%** | 1,000 | +1,3% |
| NOAA-21 → S-NPP | 2023–2025 | 2026 | 10 | **3,0%** | 0,999 | −1,9% |

WAPE = erro absoluto total ÷ total observado. Os anos de teste não entram no cálculo do fator.

**Resposta curta para o júri:** "No nível do estado, o MODIS convertido erra 12% em relação ao que o VIIRS viu de fato, em anos que o modelo não conheceu. Entre os VIIRS, o erro é de 2 a 3%."

### 3.5 Limite honesto: escala municipal

- **Número:** no nível do **município**, o WAPE mediano MODIS→S-NPP é **68,6%** (217 municípios; p90 = 109,5%).
- **Motivo:** em município pequeno, poucos fogos fazem a conta oscilar muito, e o MODIS simplesmente não vê fogos pequenos que o VIIRS vê. Nenhum fator recupera um fogo que o sensor não detectou.
- **Como tratamos:**
  - antes de 2012, o número municipal é uma estimativa na escala VIIRS, e a interface indica o satélite de cada dia;
  - a anomalia (z) compara o município com ele mesmo, o que reduz o efeito;
  - o círculo conta só as células dentro dele.

### 3.6 Conferência contábil

A soma das células de cada município bate com o valor mensal harmonizado do município:

- 246 municípios × 311 meses;
- diferença máxima de **2,8 células-dia**;
- limite de arredondamento de 12,3.

O teste passou.

---

## 4. Validação externa com o INPE

- **Fonte:** estatística oficial do INPE Queimadas para Goiás (satélite de referência AQUA, `data.inpe.br/…/brasil.json`), período **2003-01 a 2026-10**.
- **Ressalva de unidade:** o INPE conta focos do AQUA e nós contamos células-dia na escala VIIRS. As unidades são diferentes por construção, então medimos **correlação, ordenação e sinal da anomalia**, não igualdade.

| Teste | Resultado |
|---|---|
| Correlação mensal (log), 286 meses | **r = 0,955** (harmonizado) · 0,991 (MODIS bruto) |
| Correlação anual, 23 anos | **Pearson 0,954 · Spearman 0,849** |
| Meses incomuns no INPE em que concordamos no sinal da anomalia | **79 de 85 (92,9%)**; correlação dos z = 0,797 |
| 2026: razão nossa/INPE dentro da faixa histórica 2013–2025 | **7 de 10 meses** (fora: mar, set, out) |

**Por que o MODIS bruto correlaciona mais com o INPE:** porque o INPE usa o AQUA, que tem o mesmo sensor MODIS. Isso é esperado e mostra que os dados de entrada estão certos. O harmonizado está na escala VIIRS, que vê mais fogo pequeno, e mesmo assim mantém r ≈ 0,95.

**Setembro e outubro de 2026 fora da faixa:** a nossa razão subiu. Hipóteses plausíveis, não provadas:
- desde 1/8/2026 os dados são **NRT provisórios** (o FIRMS ainda vai trocá-los pelo arquivo definitivo);
- a troca do S-NPP pelo NOAA-20/21 no fim da série.

A interface marca esse período como **provisório**.

---

## 5. Anomalia

- **z** = (valor do mês − média do mesmo mês nos anos anteriores) ÷ desvio-padrão. É calculado por município e para o estado.
- **Mês em andamento** (ex.: novembro/2026): comparamos os dias 1..D com **os mesmos dias** de 2002–2024, não com o mês inteiro. Exemplo: novembro/2026 até o dia 14 → Goiás em **−0,71σ**; 235 municípios com z; Porangatu em −0,74.
- **Leitura:** é "acima ou abaixo do padrão histórico", e não "perigoso".

---

## 6. Projeção com faixa de incerteza validada

**Modelo:** binomial negativo diário, com link log, ajustado no histórico diário inteiro da área (2001 → ontem; 9.419 dias no estado).
- **Variáveis:** sazonalidade (seno/cosseno anual e semestral) e memória recente (log do dia anterior, médias de 7 e 30 dias).
- **Dispersão:** θ = 3.
- **Simulação:** 500 trajetórias diárias a partir do último dia observado; a faixa é P10–P90 das trajetórias.

**Retroteste (hindcast) honesto, em 3 etapas:**
1. Ajuste só com dados **até 2014**.
2. **Calibração da largura da faixa** em origens de 2015–2020, com alvo de 80% de cobertura P10–P90. Um fator `widen` alarga a faixa na escala log1p sem mexer na mediana.
3. **Teste** em origens de 2021–2025.

**Métrica:** CRPS skill contra a **climatologia** (mesma janela do calendário em todos os anos anteriores). Skill > 0 significa que o modelo ganha da média histórica.

| Horizonte | Skill (CRPS) | Cobertura P10–P90 (bruta → calibrada) | Publicado? |
|---|---|---|---|
| Amanhã (dia 1) | −5,6% | — | **Não** |
| Próximos 15 dias | **+18,7%** | 62,5% → **87,5%** (×1,9) | **Sim** |
| Próximo mês | **+8,8%** | 55,8% → **90,0%** (×2,1) | **Sim** |
| Próximo semestre | −19,9% | 68,3% → 87,5% | **Não**: mostramos a climatologia |

- **Regra:** só publicamos o horizonte com skill > 0. Sem ganho, a interface mostra o padrão histórico (climatologia) no lugar.
- **Meses futuros no seletor de período:** o mapa entra em "modo projeção" (faixa no topo, legenda "padrão histórico do mês") e a métrica fica travada de propósito. Não existe "anomalia" de um mês que ainda não aconteceu.

---

## 7. Interface (front)

- **Tecnologia:** JavaScript puro + Canvas 2D, sem framework e sem build, com motor de mapa próprio (`mapa-engine.js`).
- **Tela:** mapa + **painel lateral** com abas Resumo · Projeção · Histórico · Área · Contexto. Um botão no rodapé abre o painel em tela cheia.
- **Hover rico:** município, z, valor, satélite. Nas células de 1 km mostra também lat/lon e os povoados mais próximos.
- **Modos:** Município ou **Círculo** (raio livre; conta só as células dentro do círculo).
- **Histórico:** calendário ano → 12 meses → dias, com o satélite de cada dia.
- **Área:** lista as células com fogo do mês, com lat/lon, povoado mais próximo (km) e os dias exatos de detecção por satélite.
- **Povoados do IBGE:** aparecem com o zoom. Só referência; não entram em nenhum cálculo.
- **Idiomas:** bilíngue PT/EN (botão EN), com textos em `i18n.js`.

---

## 8. Back-end e ferramentas

| Camada | Ferramenta |
|---|---|
| API | Node 22 + **TypeScript strict** (sem `any`), **Fastify**, **zod** em toda entrada HTTP e resposta externa |
| Banco (opcional) | PostgreSQL + **PostGIS** (schemas em `Tema_08_MODIS_VIIRS/db/`) |
| Sem banco (modo usado na demo) | Índice de células em JSON (`data/firms_goias_cells.json`, versão 2), montado por `job:build-cell-index` a partir dos mesmos arquivos do FIRMS |
| Testes | **Vitest** (API) e Playwright (teste de fumaça da interface com dados fixos) |
| Logs | pino com redaction da chave do FIRMS |

**Comandos:**
```bash
cd monitor-cinder/api
npm start                    # API em http://localhost:8787
npm test                     # testes
npm run job:build-cell-index # baixa o FIRMS e monta o índice
npm run job:validate         # regenera os arquivos de evidência em out/
npx serve "../../Mapa iterativo" -l 3000   # front
```

**Rotas principais:** `/api/meta`, `/api/map`, `/api/municipalities/:ibge/calendar|pattern|context|calendar.csv`, `/api/daily`, `/api/area/history`, `/api/layers/cells`, `/api/layers/recurrence`, `/api/cell/detections`, `/api/localities`, `/api/projection`, `/api/projection/horizons`, `/api/validation`.

**Atualização automática:** ao iniciar, se o último dia do índice estiver mais de 3 dias atrasado, a API refaz o índice. A janela do FIRMS que falhar é pulada, e o ano fica marcado como incompleto em vez de derrubar tudo.

---

## 9. Testes automatizados

Resultado atual: **25 testes passando + 10 pulados** (os 10 precisam de PostGIS ligado: `npm run test:db`).

| Arquivo | O que prova |
|---|---|
| `index.test.ts` | Cadeia de satélites: fatores recuperados com erro zero num caso sintético conhecido; a escala não "salta" na troca MODIS → S-NPP → NOAA-20; círculo e recorrência usam a mesma cadeia; o calendário diário soma o mês e nomeia o satélite; as células listam os dias reais de detecção; o mês em andamento é comparado com os mesmos dias dos anos anteriores |
| `projection-model.test.ts` | O CRPS se comporta como deve; o modelo recupera sazonalidade e memória de um processo conhecido; o hindcast ganha da climatologia com cobertura honesta; o `widen` mantém a mediana; a projeção parte do último dia observado e nunca mostra número sem faixa |
| `inpe-stats.test.ts` | Soma os biomas do estado, ignora outros estados e meses nulos, rejeita payload inválido (zod) |
| `ibge-localities.test.ts` | Lê o `.dbf` de dentro do zip do IBGE, uma linha por localidade, erro claro se faltar a UF |
| `cors.test.ts` | Aceita o front local em qualquer porta de localhost; em produção, só a origem configurada |
| `pipeline.test.ts` | URL do FIRMS com a chave mascarada no log, normalização MODIS/VIIRS, proteção contra injeção de fórmula no CSV. *Também contém testes de módulos antigos (ML, recursos, score agrícola) que estão **desligados** na API (respondem 503) e não aparecem na interface.* |
| `history.db.test.ts` (PostGIS) | Ingestão idempotente, normalização, erro de harmonização medido (não digitado), calendário VIIRS desde 2012, círculo conta só o que está dentro, células de um município somam o valor mensal |

**Além dos testes unitários:**
- `job:validate` refaz **todas** as métricas das seções 3, 4 e 6 contra os dados reais e grava os resultados em `out/`;
- o teste de fumaça da interface (Playwright) clica no mapa, percorre as abas, o calendário, o modo projeção, o círculo e os povoados, e alterna entre painel lateral e tela cheia.

---

## 10. Segurança (resumo)

- **Chaves:** a chave do FIRMS fica só no `.env` da API. O front nunca chama FIRMS nem Embrapa e não vê chave nenhuma.
- **Entradas:** todas validadas com zod; consultas parametrizadas; erros em problem+json sem stack trace.
- **Rede e navegador:** rate limit (mais restrito no CSV); CORS só para a origem do front; CSP sem `unsafe-inline`.
- **Dados externos na tela:** sempre por `textContent`; nunca `innerHTML`.
- **Status no MVP:** a equipe priorizou funcionalidade. A rotação de chaves fica para depois.

---

## 11. Perguntas prováveis e respostas curtas

**"Por que não usar só o VIIRS?"**
O VIIRS começa em 2012. Para ter 25 anos de padrão histórico (e anomalia confiável), precisamos do MODIS de 2001–2011 convertido para a mesma escala.

**"Por que o S-NPP é a referência, se ele acabou?"**
Porque é o VIIRS com a série mais longa (2012–2026) e a que mais se sobrepõe aos outros três sensores. O NOAA-20 e o NOAA-21 são trazidos para a escala dele com erro de 2–3%, e a série continua sem quebra.

**"Como vocês sabem que está certo?"**
Por três provas independentes:
- teste interno em anos que o modelo não viu (WAPE de 12,4% / 2,5% / 3,0%);
- validação externa contra o INPE (r = 0,955; 92,9% de concordância no sinal da anomalia);
- conferência contábil célula ↔ município (diferença máxima de 2,8 células-dia).

**"Isso prevê incêndio?"**
Não. É uma projeção com faixa de incerteza, validada contra a média histórica. Só mostramos 15 dias e 1 mês, porque só esses ganham da climatologia. Amanhã e o semestre não ganham, então não publicamos.

**"Por que o modelo de projeção é tão simples?"**
De propósito: é transparente, roda em segundos, e o retroteste mostra o ganho real. Um modelo mais complexo sem validação seria pior para quem decide.

**"E desmatamento ou clima, causam o fogo?"**
Mostramos como contexto (INPE, Embrapa, NASA POWER). Não afirmamos causa, e nada disso entra no cálculo.

**"Funciona para outros estados?"**
Sim. Tudo é parametrizado por UF (FIRMS por país, recortado pelos municípios do IBGE). Bastam a malha e as localidades da UF e refazer o índice.

**"Os dados de 2026 são definitivos?"**
Desde 1/8/2026 são NRT (quase em tempo real), marcados como provisórios na tela. O FIRMS substitui o NRT pelo arquivo definitivo depois de alguns meses.

**"O que acontece quando o MODIS acabar em 2027?"**
Nada quebra: o MODIS já só é usado para 2001–2011. A série atual vem dos VIIRS, e o NOAA-21 segue até a próxima geração JPSS.

**"Usaram IA?"**
O código foi escrito com ajuda de um assistente de IA (Claude, da Anthropic), dirigido e revisado pela equipe. A ideia, as perguntas e as decisões são da equipe. *Pendente:* se o logo foi gerado por IA, ajustar a frase do README, que hoje diz que nenhuma imagem gerada por IA é usada.

---

## 12. Fontes oficiais citáveis

- NASA FIRMS: https://firms.modaps.eosdis.nasa.gov/
- Fim do S-NPP (NASA Earthdata): https://www.earthdata.nasa.gov/data/alerts-outages/suomi-npp-observations-cease-november-2-2026
- Transição para usuários do FIRMS: https://www.earthdata.nasa.gov/news/blog/transitioning-from-suomi-npp-viirs-omps-what-firms-users-need-know
- Fim do MODIS (LAADS DAAC): https://ladsweb.modaps.eosdis.nasa.gov/learn/modis-to-viirs-transition/
- INPE Queimadas, estatísticas: https://data.inpe.br/queimadas/estatisticas/media/estatistica/paises/brasil.json
- IBGE Localidades 2022: https://geoftp.ibge.gov.br/organizacao_do_territorio/estrutura_territorial/localidades/Localidades_do_Brasil/2022/

**Arquivos de evidência no repositório:** `monitor-cinder/api/out/internal_checks.json`, `projection_validation.json`, `external_validation.json`, `inpe_goias_reference.json`.
