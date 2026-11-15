# Tema 8 · Harmonization of MODIS and VIIRS Hot Spots

[Página oficial](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/) · Nível: Avançado, Intermediário · **Foco da equipe: Monitor Cinder** (decisão final de 14/11, 14h11)

## Arquivos desta pasta

| Arquivo | Conteúdo |
| --- | --- |
| `catalogo_firms_tema8.html` | Catálogo navegável dos dados do FIRMS, com montador de links |
| `firms_dataset_tema8.json` | Mesmos dados em JSON |
| `dados_apis_e_sensores.md` | Sensores da NASA utilizáveis, todas as APIs (FIRMS, POWER, GIBS, MCD64A1) e o fluxo de dados |
| `db/schema.sql` | Banco PostgreSQL + PostGIS focado no tema: focos particionados por ano, grade de harmonização, fatores e calendário |
| `db/teste_schema.sql` | Teste funcional do banco (rodado em PostgreSQL 16 + PostGIS em 14/11/2026) |
| `db/schema_cinder.sql` | Extensão Monitor Cinder: padrão sazonal, época típica de fogo, anomalia, alertas para gestores, vegetação (MCD12Q1) |
| `db/teste_cinder.sql` | Teste da extensão com calendário sintético (rodado em 14/11/2026) |
| `db/schema_contexto.sql` | Série de referência do INPE (validação externa) e contexto anual (tabelas do plano original; o app atual busca o contexto na hora pela NASA POWER e pelo ORNL DAAC) |
| `db/teste_contexto.sql` | Teste do contexto, com casos negativos (fonte inválida, NaN, papel da API sem escrita) |
| `contrato_api.md` | Endpoints da API do app, regras de validação e o worker de ingestão |

## 1. O que o desafio pede (duas partes)

1. **Harmonizar** os focos de calor MODIS (desde 2000) e VIIRS (desde 2012) para que o sensor de origem deixe de importar.
2. **App web** que recebe os dados harmonizados: escolher região e período, ver o **calendário de queimadas** do início dos anos 2000 até hoje e baixar análises e visualizações.

Sugestões do texto oficial:

- Calendário com rampa de cores acessível: meses e anos com mais focos e como o fogo atual se compara aos anteriores.
- Download em CSV dos focos da busca.
- Mapa em que o usuário desenha a área ou digita latitude e longitude.
- Índices: anomalia em relação à média de vários anos, número de focos detectados.
- Público: alerta antecipado e resposta a emergências, cientistas, gestores de terra e bombeiros.

Recurso oficial único: **[FIRMS](https://firms.modaps.eosdis.nasa.gov/)** (Fire Information for Resource Management System).

Catálogo navegável dos dados, com montador de links: abra `catalogo_firms_tema8.html` no navegador ([versão online](https://claude.ai/artifact/BYWy51WCLNtykaxGv2rF5u)). Os mesmos dados em JSON: `firms_dataset_tema8.json`.

## 2. Dados do FIRMS (conferidos em 14/11/2026)

### Duas formas de acesso

| Acesso | O que entrega | Login | Uso no projeto |
| --- | --- | --- | --- |
| Resumo anual por país (CSV) | Todos os focos do Brasil num ano, por sensor | Não: baixou direto | Base histórica do calendário |
| [API de área](https://firms.modaps.eosdis.nasa.gov/api/area/) | Focos de uma caixa geográfica em 1 a 5 dias | MAP_KEY gratuita | Ano corrente e o "agora" do calendário |

**Arquivos anuais do Brasil** (padrão de URL conferido):

```
https://firms.modaps.eosdis.nasa.gov/data/country/modis/2024/modis_2024_Brazil.csv
https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/2024/viirs-snpp_2024_Brazil.csv
https://firms.modaps.eosdis.nasa.gov/data/country/viirs-jpss1/2024/viirs-jpss1_2024_Brazil.csv
```

| Sensor | Pasta na URL | Anos disponíveis | Tamanho conferido |
| --- | --- | --- | --- |
| MODIS (Terra e Aqua) | `modis` | 2000 (parcial) a 2025 | 11,6 MB em 2001; 42,6 MB em 2024 |
| VIIRS S-NPP | `viirs-snpp` | 2012 a 2025 | 69 MB (2025) a 154 MB (2024) |
| VIIRS NOAA-20 | `viirs-jpss1` | 2018 a 2025 | 69 MB (2018) a 163 MB (2024) |

- O arquivo de 2026 ainda não existe (404); o ano corrente vem da API.
- Os arquivos são do Brasil inteiro. O recorte de Goiás é um filtro por coordenada feito pela equipe (caixa ou, melhor, polígono do estado).
- Período de sobreposição para calibrar: **MODIS + VIIRS S-NPP de 2012 a 2025**.

**API de área:**

```
https://firms.modaps.eosdis.nasa.gov/api/area/csv/[MAP_KEY]/[SOURCE]/[oeste,sul,leste,norte]/[DIAS]/[AAAA-MM-DD]
```

- SOURCE: `MODIS_NRT`, `MODIS_SP`, `VIIRS_SNPP_NRT`, `VIIRS_SNPP_SP`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA20_SP`, `VIIRS_NOAA21_NRT`, `VIIRS_NOAA21_SP`.
- DIAS: de 1 a 5. A data é opcional; sem ela vêm os dados mais recentes.
- Limite: 5.000 transações a cada 10 minutos por MAP_KEY; pedidos maiores contam como mais de uma.
- A MAP_KEY vai no `.env`, nunca no repositório nem no front-end.

### Colunas

| MODIS | VIIRS | Significado |
| --- | --- | --- |
| latitude, longitude | latitude, longitude | Centro do pixel do foco |
| brightness | bright_ti4 | Temperatura de brilho (K): canal 21/22 no MODIS, banda I4 no VIIRS |
| bright_t31 | bright_ti5 | Temperatura de brilho de um segundo canal (K) |
| scan, track | scan, track | Tamanho do pixel leste-oeste e norte-sul; cresce na borda da faixa |
| acq_date, acq_time | acq_date, acq_time | Data e hora UTC (HHMM) da passagem |
| satellite | satellite | Terra/Aqua no MODIS; N (S-NPP) ou N20 no VIIRS |
| confidence | confidence | **MODIS: 0 a 100. VIIRS: l, n, h** (baixa, nominal, alta) |
| frp | frp | Potência radiativa do fogo (MW), indicador de intensidade |
| daynight | daynight | D ou N |
| type | type | Tipo do foco (fonte estática, vulcão etc.), só nos dados processados |
| version, instrument | version, instrument | Versão do produto e sensor |

Fonte das definições: [FAQ do FIRMS](https://www.earthdata.nasa.gov/data/tools/firms/faq).

## 3. Por que harmonizar (e caminhos possíveis)

Os dois sensores não são comparáveis direto:

- **Resolução:** pixel de cerca de 1 km no MODIS e cerca de 375 m no VIIRS. O VIIRS enxerga focos menores e conta o mesmo fogo em mais pixels.
- **Confiança:** escalas diferentes (0 a 100 contra l/n/h).
- **Horário de passagem e número de satélites:** mudam quantas detecções cada sensor faz por dia.

Caminhos a avaliar (nenhum foi testado ainda):

1. **Grade comum:** agregar os dois sensores numa mesma grade (por exemplo, células de 1 km por dia) e contar células com fogo, não pixels.
2. **Fator de conversão:** no período 2012 a 2025, calcular a razão VIIRS/MODIS por mês e região e aplicar aos anos só-MODIS (2000 a 2011).
3. **Filtro de confiança equivalente:** definir um corte do MODIS (por exemplo, ≥ 30) que se aproxime do "nominal + alta" do VIIRS.

Declarar o método escolhido e os limites dele no projeto conta a favor em Validity.

## 4. Matriz CSD

| Certezas | Suposições | Dúvidas |
| --- | --- | --- |
| FIRMS é o recurso oficial e tem CSV anual do Brasil sem login | Brigadista ou produtor do Cerrado goiano é o usuário final (o texto não diz isso) | Qual método de harmonização é defensável em 48 h? |
| Entrega: app web com região, período, calendário e CSV | Uma harmonização simples e declarada é aceita pelo júri | Conseguimos falar com brigadistas (Bombeiros, Prevfogo, brigada da UFG)? |
| O núcleo é tratamento de tabela e agregação mensal (back-end e SQL) | Muitas equipes de Goiânia vão escolher este tema | Que decisão real o calendário apoia (escala, aceiro, alerta)? |
| A palestrante usou este cenário (FIRMS, brigadistas, Goiás) como exemplo | "Este mês está acima do histórico" muda a decisão do brigadista | O que nos diferencia das outras equipes? |

Alerta da palestra de ideação: o calendário sozinho é um "visor de dados". O valor está na decisão que ele provoca.

## 5. Rascunho de MVP

| Campo | Proposta |
| --- | --- |
| Suposição a testar | O brigadista escolhe melhor onde reforçar a equipe ao ver a temporada atual contra o histórico |
| Formato | Notebook de harmonização com dados reais do FIRMS + uma tela com calendário e ranking de áreas |
| Teste | 5 pessoas escolhem onde mandar a equipe usando o protótipo, sem explicação prévia |
| Critério de sucesso | Pelo menos 4 de 5 acertam em menos de 2 minutos, sem ajuda |

Corte de escopo: faz de verdade o fluxo região → calendário → ranking e a harmonização; finge login e notificações; deixa de fora perfis, idiomas e otimização.

## 6. Primeiros passos sugeridos

- [ ] Baixar `modis_2024_Brazil.csv` e `viirs-snpp_2024_Brazil.csv` e filtrar Goiás, para ver o volume real e a diferença entre sensores.
- [ ] Pedir a MAP_KEY (gratuita) para o ano corrente.
- [ ] Escolher o método de harmonização e testar no período 2012 a 2025.
- [ ] Marcar conversa com pelo menos um brigadista ou gestor até domingo.
- [ ] Criar o repositório com `.gitignore` (`.env`, `data/raw/`).

## Referência de vencedor

Queñaris ganhou **Local Impact** em 2025 usando FIRMS num problema de uma região específica (Arequipa, Peru). Um recorte focado no Cerrado goiano poderia mirar uma categoria semelhante.
