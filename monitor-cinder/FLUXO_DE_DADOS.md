# Monitor Cinder · Do satélite à tela

Documento interno (PT): como um foco de calor é detectado no espaço, como chega até nós, como o processamos e como aparece no mapa. Os números de validação citados vêm de `monitor-cinder/api/out/`.

```
 1. SATÉLITE           2. NASA (LANCE / FIRMS)          3. NOSSA API (seu computador)            4. TELA (navegador)
 ───────────           ───────────────────────          ─────────────────────────────            ──────────────────
 MODIS  (Terra, Aqua)  recebe os dados, roda o          baixa os focos de Goiás  ──►  data/      pede tudo à API
 VIIRS  (S-NPP,        algoritmo de fogo e publica      filtra · grade de 1 km      firms_goias  (localhost:8787)
         NOAA-20,      ─ NRT: em poucas horas           harmoniza os 4 sensores     _cells.json  e desenha mapa,
         NOAA-21)      ─ SP: versão definitiva,         calcula anomalia,                        painel, calendário,
 vê calor no           semanas/meses depois             calendário e projeção                    gráficos e downloads
 infravermelho         ─ FIRMS: CSV e API               responde em JSON / CSV
```

---

## 1. Como o satélite "vê" o fogo

Os satélites de órbita polar passam sobre Goiás algumas vezes por dia, sempre em horários parecidos, e medem a radiação da superfície em várias faixas do espectro.

| Sensor | Satélite | Em operação | Tamanho do pixel | Passagens (hora local, aprox.) |
|---|---|---|---|---|
| **MODIS** | Terra | 2000 → fim previsto em 2027 | 1 km | manhã (~10h30) e noite |
| **MODIS** | Aqua | 2002 → fim previsto em 2027 | 1 km | tarde (~13h30) e madrugada |
| **VIIRS** | Suomi NPP (S-NPP) | 2012 → 2/11/2026 (encerrado) | 375 m | tarde (~13h30) e madrugada |
| **VIIRS** | NOAA-20 | 2018 → hoje | 375 m | tarde e madrugada |
| **VIIRS** | NOAA-21 | 2023 → hoje | 375 m | tarde e madrugada |

**Como detecta:**
- Um fogo ativo emite muito mais energia no **infravermelho médio** (perto de 4 µm) do que o terreno em volta.
- O algoritmo compara esse canal com o **infravermelho termal** (perto de 11 µm) e com os pixels vizinhos.
- Se o pixel está bem mais quente que o entorno, vira um **foco de calor** (hotspot).
- **MODIS:** canais 21/22 (~4 µm) e 31 (~11 µm).
- **VIIRS:** bandas I4 (~3,7 µm) e I5 (~11,5 µm).

**Cada foco traz:**
- latitude e longitude do centro do pixel;
- data e hora da passagem;
- temperatura de brilho;
- potência radiativa do fogo (FRP, em MW);
- dia ou noite;
- **confiança**: baixa, nominal ou alta;
- nos arquivos definitivos, o **tipo** (0 = vegetação, 2 = fonte estática em terra, como indústria).

**Por que MODIS e VIIRS não são comparáveis diretamente:**
- O pixel do VIIRS (375 m) é cerca de 7 vezes menor em área que o do MODIS (1 km). Por isso o VIIRS enxerga fogos pequenos que o MODIS não vê.
- Um mesmo fogo grande aparece como vários pontos no VIIRS e como um só no MODIS.
- Contar focos brutos faria qualquer série "saltar" quando muda o satélite. Esse é exatamente o problema do desafio.

---

## 2. Como os dados chegam até nós

1. **Descida:** o satélite envia os dados brutos para estações em terra.
2. **Processamento na NASA:** o sistema LANCE roda o algoritmo de fogo e gera os focos.
   - **NRT (near real-time, quase tempo real):** sai em poucas horas. É provisório.
   - **SP (standard processing):** versão definitiva, com calibração final. Sai semanas a meses depois e substitui o NRT.
3. **Distribuição pelo NASA FIRMS** (Fire Information for Resource Management System). Usamos três portas de entrada:

| Porta do FIRMS | O que entrega | Como usamos |
|---|---|---|
| `api/data_availability` | Até que dia cada sensor tem dado SP e NRT | Para saber o que baixar e o que marcar como provisório |
| `api/area/csv/{chave}/{sensor}/{caixa}/{dias}` | Focos de uma caixa geográfica, em janelas de até 5 dias | Caixa de Goiás, sensor por sensor, do primeiro dia de cada satélite até ontem. Precisa da chave `FIRMS_MAP_KEY` |
| `data/country/{sensor}/{ano}/..._Brazil.csv` | Arquivo anual definitivo do Brasil inteiro | Reserva: se não houver chave ou a API recusar um ano |

- **O que é provisório hoje:** os dados de 1/8/2026 em diante ainda são NRT, e a tela os marca como **provisórios**.
- **Fim do S-NPP:** desde 2/11/2026 ele não envia mais dados, e o NOAA-20/21 assumem.

---

## 3. Como processamos (API Monitor Cinder)

Tudo roda na API (Node + TypeScript), no computador de quem roda o projeto. O navegador não calcula nada.

### 3.1 Montagem do índice local (`npm run job:build-cell-index`, ou automático no início)

1. **Baixa** os focos de Goiás dos 4 sensores, de 2001 até o último dia que o FIRMS serve. Os anos completos ficam em cache para sempre; o ano atual é renovado a cada 6 horas.
2. **Filtra a confiança:** fica só **nominal ou alta**.
3. **Recorta pelo estado:** fica só o que cai dentro de um município de Goiás (malha do IBGE).
4. **Coloca na grade de 1 km:** cada foco vai para uma célula de 1 km × 1 km de uma grade fixa (SIRGAS 2000 / Policônica, EPSG:5880). Guardamos, por célula, **os dias em que cada sensor viu fogo**.
5. **Remove fontes estáticas:** células onde a maioria dos focos é do tipo 2, ou que têm fogo em 8 ou mais meses do ano em 3 ou mais anos (indústria, chaminé, mineração).
6. **Grava** o resultado em `data/firms_goias_cells.json` (cerca de 25 MB). Se esse arquivo ficar mais de 3 dias atrasado, a API refaz tudo sozinha ao iniciar.

### 3.2 Harmonização (a cada consulta, em memória)

- **Unidade:** a **célula-dia de 1 km**. Uma célula com fogo num dia conta 1, não importa quantos pontos o sensor marcou. Isso neutraliza boa parte da diferença de resolução.
- **Escala comum:** a do **VIIRS S-NPP**.
- **Sensor de cada dia:** MODIS antes de 2012; S-NPP enquanto observa; NOAA-20 e depois NOAA-21 nas falhas do S-NPP e após o fim dele.
- **Fatores de conversão:** um por mês do ano, medidos só nos dias em que os dois sensores observaram. Foram calibrados em anos diferentes dos usados no teste:

| Ligação | Erro no teste (WAPE) | Correlação |
|---|---|---|
| MODIS → S-NPP | 12,4% | 0,981 |
| NOAA-20 → S-NPP | 2,5% | 1,000 |
| NOAA-21 → S-NPP | 3,0% | 0,999 |

### 3.3 Cálculos sobre a série harmonizada

- **Série mensal** por município, por círculo ou do estado, de 2001 até ontem.
- **Anomalia (z):** compara o mês com o mesmo mês dos anos anteriores. O mês em andamento é comparado com os mesmos dias dos anos anteriores.
- **Padrão histórico:** mediana e faixa P10–P90 do mês nos anos anteriores.
- **Meses incomuns:** anomalia ≥ +1,5σ e pelo menos 10 células-dia.
- **Projeção com faixa de incerteza validada:**
  - modelo diário binomial negativo, com 500 simulações a partir do último dia observado;
  - retroteste de 2015 a 2025 contra a média histórica;
  - só publica 15 dias (+18,7% de ganho) e 1 mês (+8,8%), os horizontes que ganharam dela.
- **Validação externa:** contra a estatística oficial do INPE (correlação mensal 0,955; mesmo sinal da anomalia em 92,9% dos meses incomuns).

### 3.4 O que a API entrega (rotas principais)

| Rota | Para quê |
|---|---|
| `/api/map` | Valor de cada município no mês (focos harmonizados, anomalia, densidade ou padrão típico) |
| `/api/municipalities/:ibge/calendar` e `/pattern` | Série mensal e temporada típica |
| `/api/daily` | O mês dia a dia, com o satélite de cada dia |
| `/api/layers/cells` e `/api/cell/detections` | Células de 1 km com fogo e os dias de detecção de cada uma |
| `/api/area/history` | Tudo isso só para o que está dentro de um círculo |
| `/api/projection/horizons` | Projeção de 15 dias e 1 mês com faixa validada |
| `/api/municipalities/:ibge/alerts` | Meses incomuns |
| `/api/area/fires.csv`, `/calendar.csv` | Downloads |
| `/api/localities` | Povoados do IBGE (só referência no mapa) |
| `/api/municipalities/:ibge/context` | Contexto: clima (NASA POWER) e vegetação (NASA ORNL DAAC), buscados na hora |

---

## 4. Como aparece na tela

O site (JavaScript puro + Canvas 2D) só pede à API e desenha a resposta.

| Na tela | De onde vem |
|---|---|
| **Cores do mapa** (cada município pintado pela métrica escolhida) | `/api/map` |
| **Legenda no topo** (rampa de cores e valores) | Calculada a partir dos mesmos valores de `/api/map` |
| **Seletor de período** (meses com dado, provisórios e futuros) | `/api/meta` (último dia observado, início do período provisório) |
| **Hover** (nome, valor, satélite; nas células de 1 km, lat/lon e povoado mais próximo) | `/api/map`, `/api/layers/cells`, `/api/localities` |
| **Painel lateral, aba Resumo** (focos do mês, anomalia, faixa esperada, próximos 15 dias, meses incomuns, downloads) | `/calendar`, `/projection`, `/projection/horizons`, `/alerts` |
| **Aba Projeção** | `/projection/horizons` |
| **Aba Histórico** (grade anos × meses e o mês dia a dia) | `/calendar`, `/api/daily` |
| **Aba Área** (células com fogo, dias de detecção, povoados) | `/api/layers/cells`, `/api/cell/detections`, `/api/localities` |
| **Aba Contexto** | `/context` |
| **Modo círculo** (desenhado ou por coordenada digitada) | As mesmas rotas, com `lon`, `lat` e `radiusKm`: conta só o que está dentro |
| **Mês futuro** (modo projeção, faixa "PROJEÇÃO" no topo do mapa) | `/api/map?metric=typical` e `/projection/horizons` |
| **Barra de escala** embaixo do mapa | Calculada no navegador a partir do zoom (não é dado) |

**Regras da tela:**
- Todo número mostrado vem da API.
- O que é NRT aparece como **provisório**.
- Clima e vegetação são **contexto**, nunca causa.
- A projeção sempre aparece com a sua faixa de incerteza.

---

## Fontes

- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)
- [Fim do Suomi NPP (NASA Earthdata)](https://www.earthdata.nasa.gov/data/alerts-outages/suomi-npp-observations-cease-november-2-2026)
- [Transição MODIS → VIIRS (LAADS DAAC)](https://ladsweb.modaps.eosdis.nasa.gov/learn/modis-to-viirs-transition/)
- Números de validação: `monitor-cinder/api/out/internal_checks.json`, `projection_validation.json`, `external_validation.json`
