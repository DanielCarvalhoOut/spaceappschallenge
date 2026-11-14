# Tema 8 · APIs, sensores e fluxo de dados

Conferido em 14/11/2026. Tudo abaixo é da NASA, salvo onde indicado.

## 1. Sensores da NASA que dá para usar

### Núcleo: focos de calor (FIRMS)

| Sensor | Satélite | Pixel do foco | Período no FIRMS | Papel no projeto |
| --- | --- | --- | --- | --- |
| MODIS | Terra e Aqua | ~1 km | 2000 a hoje | Série longa; base do histórico 2000 a 2011 |
| VIIRS | Suomi-NPP | ~375 m | 2012 a hoje | Referência moderna; calibra o MODIS em 2012 a 2025 |
| VIIRS | NOAA-20 | ~375 m | 2018 a hoje | Segunda passagem VIIRS; reforça a série recente |
| VIIRS | NOAA-21 | ~375 m | recente (NRT e SP na API) | Terceira passagem; só para dados atuais |
| OLI | Landsat 8/9 | 30 m | NRT | **Não serve:** só EUA e Canadá |

Notas:

- O MODIS está no fim da vida útil; o VIIRS dá continuidade à passagem da tarde (Aqua), e não há substituto direto para a da manhã (Terra). Isso reforça a importância de harmonizar agora.
- Cada foco é o centro de um pixel marcado pelo algoritmo como contendo um ou mais fogos, não "um incêndio".

### Complementares (opcionais, também da NASA)

| Produto | O que é | Para que serve aqui |
| --- | --- | --- |
| **MCD64A1** (MODIS Burned Area) | Área queimada mensal, grade de 500 m, desde nov/2000 (LP DAAC) | Validar a harmonização: focos contra área realmente queimada |
| **NASA POWER** | Clima diário por ponto ou região: chuva (`PRECTOTCORR`), umidade (`RH2M`), temperatura (`T2M`), vento (`WS2M`); sem chave | Contexto de risco no calendário ("mês seco e acima da média") |
| **GIBS / Worldview** | Camadas de imagem em WMTS, incluindo "Fires and Thermal Anomalies" MODIS e VIIRS | Mapa de fundo e camada visual sem baixar dados |
| **Static Thermal Anomalies** (FIRMS, experimental) | Locais de calor persistente (indústria, etc.) | Filtrar falsos focos fixos |

Referência não-NASA útil para conferência: o BDQueimadas do INPE (Brasil). Se usar, liste em "Other References".

## 2. APIs e endpoints

### FIRMS

| Serviço | URL | Chave | Retorna |
| --- | --- | --- | --- |
| Resumo anual por país | `https://firms.modaps.eosdis.nasa.gov/data/country/{pasta}/{ano}/{pasta}_{ano}_Brazil.csv` (`modis`, `viirs-snpp`, `viirs-jpss1`) | Não | CSV do Brasil inteiro no ano |
| Área | `/api/area/csv/{MAP_KEY}/{SOURCE}/{oeste,sul,leste,norte}/{1-5}/{AAAA-MM-DD}` | Sim | CSV dos focos da caixa |
| País | `/api/country/csv/{MAP_KEY}/{SOURCE}/BRA/{1-5}/{AAAA-MM-DD}` | Sim | CSV do país; **aparecia como indisponível** em 14/11 |
| Disponibilidade | `/api/data_availability/csv/{MAP_KEY}/{SENSOR ou ALL}` | Sim | Datas disponíveis de cada produto (NRT e SP) |
| Dados faltantes | `/api/missing_data/` | Sim | Datas sem dado de satélite |
| Pegadas KML | `/api/kml_fire_footprints/` | Sim | Contorno dos pixels em KML |
| Chave | `/api/map_key/` | — | Pedido da MAP_KEY gratuita por e-mail |

- `SOURCE`: `MODIS_NRT`, `MODIS_SP`, `VIIRS_SNPP_NRT`, `VIIRS_SNPP_SP`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA20_SP`, `VIIRS_NOAA21_NRT`, `VIIRS_NOAA21_SP`.
- **NRT** sai em cerca de 3 horas; **SP** (processamento padrão) tem atraso de 2 a 3 meses, mas é mais preciso. Para o histórico use SP (os arquivos anuais); para o "agora" use NRT.
- Limite: 5.000 transações a cada 10 minutos por chave. Pedidos de vários dias contam como mais de uma.
- `/api/missing_data/` é importante: um mês com dias sem satélite não pode virar "mês com poucos focos" no calendário.

### Outras

| API | URL base | Chave |
| --- | --- | --- |
| NASA POWER (diário) | `https://power.larc.nasa.gov/api/temporal/daily/point` | Não |
| GIBS WMTS | `https://gibs.earthdata.nasa.gov/wmts/` | Não |
| MCD64A1 | LP DAAC / Earthdata (`https://data.lpdaac.earthdatacloud.nasa.gov/`) | Login Earthdata (gratuito) |

## 3. Fluxo de dados proposto

1. **Carga histórica (uma vez):** baixar os CSV anuais do Brasil (MODIS 2000 a 2025, VIIRS S-NPP 2012 a 2025), filtrar Goiás pelo polígono do IBGE e carregar em `fire.hotspot`. Guardar hash e URL de cada arquivo em `fire.ingest_batch`.
2. **Atualização (agendada):** a cada 3 horas, chamar a API de área (NRT) para a caixa de Goiás com 1 dia e inserir de forma idempotente.
3. **Harmonização:** calcular os fatores em `fire.harmonization_factor` a partir de 2012 a 2025 e gerar o calendário em `fire.calendar_monthly`.
4. **App:** a API própria (`contrato_api.md`) lê só do banco. Nenhuma chamada do navegador vai direto ao FIRMS, então a MAP_KEY nunca sai do servidor.

O esquema está em `db/schema.sql`.

## Fontes

- [FIRMS API](https://firms.modaps.eosdis.nasa.gov/api/), [API de área](https://firms.modaps.eosdis.nasa.gov/api/area/), [data_availability](https://firms.modaps.eosdis.nasa.gov/api/data_availability/)
- [FAQ do FIRMS](https://www.earthdata.nasa.gov/data/tools/firms/faq) e [página do FIRMS no Earthdata](https://www.earthdata.nasa.gov/learn/find-data/near-real-time/firms)
- [FIRMS AGU 2024 (NTRS)](https://ntrs.nasa.gov/api/citations/20240015102/downloads/FIRMS%20AGU%202024.pdf): fim do MODIS e continuidade pelo VIIRS
- [MCD64A1 no Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD64A1) e [MODIS Burned Area](https://modis-land.gsfc.nasa.gov/burn.html)
- [NASA POWER API](https://power.larc.nasa.gov/docs/services/api/)
- [Worldview e GIBS](https://www.earthdata.nasa.gov/topics/human-dimensions/wildfires/near-real-time-data)
