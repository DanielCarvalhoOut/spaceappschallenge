# Tema 8 · Contrato da API do app

API própria entre o front (`Mapa iterativo/`, JS puro) e o banco (`db/schema.sql`). Stack: **Node 22 + TypeScript + Fastify + pg + zod**, com jobs de ingestão no mesmo projeto (`monitor-cinder/api/src/jobs`). As rotas usadas pelo mapa estão em `IMPLEMENTACAO.md` §5 F3; as regras de validação abaixo continuam valendo.

## Decisões de arquitetura

- **O navegador nunca fala com o FIRMS.** A MAP_KEY fica no worker de ingestão (variável de ambiente ou secret store). A API do app só lê o banco com o papel `fire_api_ro`.
- **Leitura de agregados, não de pontos.** O calendário vem de `fire.calendar_monthly` (pré-calculado). Pontos brutos só no download em CSV, com limite.
- **Tudo validado na borda.** Caixa, datas, IDs e polígonos têm limites explícitos. Consultas sempre parametrizadas (nada de concatenar SQL).
- **Assíncrono de ponta a ponta.** I/O com `async/await` e streaming no CSV, para não carregar o resultado inteiro em memória.

## Endpoints

| Método | Rota | O que faz |
| --- | --- | --- |
| GET | `/api/regions?kind=uf\|municipio` | Lista regiões IBGE (id, código, nome). Sem geometria. |
| GET | `/api/regions/{id}/geometry` | GeoJSON simplificado da região (`ST_SimplifyPreserveTopology`) |
| POST | `/api/regions/custom` | Cria região desenhada pelo usuário (autenticado) |
| GET | `/api/calendar?regionId=&from=AAAA-MM&to=AAAA-MM&method=` | Calendário mensal: contagens MODIS, VIIRS, harmonizada, anomalia, dias sem satélite |
| GET | `/api/compare?regionId=&year=` | MODIS e VIIRS lado a lado por mês (base para mostrar a harmonização) |
| GET | `/api/hotspots.csv?bbox=&from=&to=&sensor=` | Download dos focos em CSV, em streaming |
| GET | `/api/meta/sources` | Sensores, período carregado, última atualização, método de harmonização e DOIs/links |

### Exemplo de resposta de `/api/calendar`

```json
{
  "region": { "id": 1, "name": "Goiás" },
  "method": "grid_cells",
  "calibration": { "from": 2012, "to": 2025 },
  "months": [
    { "year": 2024, "month": 8, "modis": 1210, "viirs": 3540, "harmonized": 3398.4,
      "baselineMean": 2650.1, "anomalyZ": 1.42, "daysMissing": 0 }
  ],
  "generatedAt": "2026-11-14T13:00:00Z"
}
```

Números ilustrativos, não são dados reais.

## Regras de validação (OWASP)

| Entrada | Regra |
| --- | --- |
| `regionId` | inteiro positivo; para região `custom`, só o dono lê (filtro por `owner_id` do token: evita IDOR) |
| `from`, `to` | formato `AAAA-MM`; entre 2000-11 e o mês atual; `to >= from`; no máximo 27 anos |
| `bbox` | 4 números, `oeste < leste`, `sul < norte`, dentro do Brasil; área máxima configurável (ex.: 5° × 5°) |
| `sensor` | lista fechada: `MODIS`, `VIIRS_SNPP`, `VIIRS_NOAA20`, `VIIRS_NOAA21` |
| `method` | lista fechada: `grid_cells`, `monthly_ratio`, `confidence_match` |
| Polígono custom | GeoJSON válido (`ST_IsValid`), até 20.000 vértices, área máxima, corpo até 1 MB |
| CSV exportado | limite de linhas (ex.: 200 mil); células que começam com `= + - @` ganham `'` na frente (CSV injection) |

- Erros com `ProblemDetails` (RFC 7807), sem stack trace nem SQL na resposta.
- Rate limiting por IP no download CSV e na criação de região.
- CORS só para o domínio do front.
- Logs sem MAP_KEY, sem token e sem o corpo do polígono.

## Ingestão (worker)

1. **Histórico:** para cada ano e sensor, baixar o CSV anual do Brasil, calcular o SHA-256, registrar em `fire.ingest_batch` e inserir só os pontos dentro do polígono de Goiás, com `ON CONFLICT ON CONSTRAINT hotspot_natural_ux DO NOTHING`. Use `COPY` para uma tabela temporária e depois `INSERT ... SELECT`.
2. **Recente:** a cada 3 horas, API de área NRT de 1 dia para a caixa de Goiás. Tratar HTTP 429 e 5xx com retry exponencial e respeitar 5.000 transações a cada 10 minutos.
3. **Faltantes:** consultar `/api/missing_data/` e preencher `days_missing` no calendário.
4. **Recalcular:** `REFRESH MATERIALIZED VIEW CONCURRENTLY fire.hotspot_cell_day`, depois os fatores e o calendário.
5. **NRT → SP:** quando o SP de um período chegar (2 a 3 meses depois), substituir as linhas NRT daquele período.
