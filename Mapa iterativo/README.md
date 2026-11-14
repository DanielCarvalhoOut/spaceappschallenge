# Mapa iterativo · Monitor Cinder (front-end autoral)

Mapa interativo de Goiás por município, escrito do zero pela equipe. Não reaproveita nada do mapa de referência que estava nesta pasta (aquele código era de terceiros e foi removido).

## Como abrir

Dê dois cliques em `index.html`. Não precisa de build nem de servidor:
- os scripts são clássicos (sem módulos ES), por isso funcionam via `file://`;
- a malha e os nomes dos municípios vêm em tempo de execução da API pública do IBGE (precisa de internet);
- se o backend do FireHub (`http://localhost:8787`) não responder, a tela entra em **DEMO** com valores sintéticos. A faixa amarela no topo deixa isso explícito.

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `index.html` | Estrutura da página e Content-Security-Policy (só scripts locais; conexões só com o IBGE e a API). |
| `mapa.css` | Visual próprio, temas escuro e claro, só fontes do sistema. |
| `config.js` | `window.FIREHUB_CONFIG`: endereço da API, URLs do IBGE, período. **Sem chaves.** |
| `i18n.js` | Textos em português (padrão) e inglês (botão `EN`/`PT`). Expõe `window.FireI18n`. |
| `mapa-engine.js` | Motor do mapa: projeção policônica (parâmetros do EPSG:5880), `Path2D` por município, câmera (roda suave ancorada no cursor, arraste com inércia, pinça no celular, voo de zoom ótimo de van Wijk & Nuij), hit-test, rótulos com contraste WCAG, rampas de cor em OKLab. Expõe `window.FireMap`. |
| `firehub-data.js` | Camada de dados: IBGE (malha e nomes), cliente da API do FireHub, fonte DEMO. Valida toda resposta. Expõe `window.FireData`. |
| `firehub-ui.js` | Controlador da tela: filtros, legenda, tooltip, busca, painel com padrão histórico, calendário, comparação MODIS × VIIRS × harmonizado, contexto (INPE/Embrapa/POWER) e CSV. |

## API do motor (`FireMap`)

```js
const map = FireMap.create(elemento, { lon0: -54, theme: 'dark', idProp: 'codarea' });
map.setGeometry(featureCollectionDoIBGE);    // retorna o nº de municípios
map.setNames(new Map([['5208707', 'Goiânia']]));
map.setValues({ '5208707': 2.1 }, { type: 'diverging', min: -3, max: 3 }); // ou { type: 'sequential', max }
map.on('hover', (h) => {});                  // { id, x, y } ou null
map.on('select', (id) => {});                // código IBGE ou null
map.select('5208707', { fly: true });
map.reset(); map.zoomBy(1.5); map.setTheme('light'); map.destroy();
```

## Contrato que o front espera do backend (TypeScript)

Todas as rotas são `GET`, JSON e públicas (sem chave no front). Código de município = IBGE de 7 dígitos.

| Rota | Resposta |
| --- | --- |
| `/api/meta` | `{ service: "firehub", dataKind: "firms_db"\|"synthetic", period: { firstYear, lastYear }, sources: [{ id, name, url, role }], validation: { mapePct, wapePct, pearsonR, biasPct } \| null }` |
| `/api/geo/municipalities?uf=52` | GeoJSON do IBGE em cache (opcional; se falhar, o front busca direto no IBGE) |
| `/api/map?year=2024&month=9&metric=anomaly\|count\|density` | `{ values: { "5208707": 2.1, ... } }` (`null` = sem dado) |
| `/api/municipalities/{ibge}/calendar` | `{ rows: [{ year, month, modis, viirs, harmonized, anomalyZ, daysMissing }] }` |
| `/api/municipalities/{ibge}/pattern` | `{ months: [{ month, mean, sharePct }], season: { months: [8,9,10], coveredPct, peakMonth } }` |
| `/api/municipalities/{ibge}/context?year=2024` | `{ items: [{ key, label, value, unit, source }] }` com `key` = `fonte.métrica` (ex.: `inpe_prodes.deforestation_km2`); o front traduz pela `key` e usa `label` como reserva |
| `/api/municipalities/{ibge}/calendar.csv` | CSV com proteção contra injeção de fórmula |
| `/api/projection?ibge=52\|52xxxxx&year&month` | `{ method, range: { p10, p50, p90, nYears }, analog: { p10, p50, p90, years } \| null, observed, hindcast }`; 503 sem histórico → o front calcula a mesma faixa com a série que já tem e avisa "sem retroteste" |
| `/api/area/history?lon&lat&radiusKm&source` | só as células dentro do círculo: `{ areaKm2, pctInState, rows, municipalities: [{ ibge, pctOfMunicipality }] }`; 503 → soma aproximada dos municípios tocados, com aviso |
| `/api/layers/cells?ibge=52xxxxx\|lon&lat&radiusKm&year&month&res=1000\|2000\|5000` | células da grade dentro do município ou do círculo: `{ res, total, yearsObserved, cells: [[lon, lat, célulasDiaNoMês, anosComFogo, últimoAno]] }`; a soma é o valor harmonizado da área no mês |
| `/api/layers/recurrence?west&south&east&north&from&to&res=1000` | `{ yearsObserved, columns, cells: [[lon, lat, anosComVizinhas, anos, últimoAno, mêsPico]], hitRate }` → camada FR (focos-raiz) |

Se mudar o endereço da API, atualize `config.js` **e** o `connect-src` do CSP em `index.html`.

Motor: `setPointLayer({ cellKm, classes: [{ color, cells: [[lon, lat]] }] })` projeta as células uma vez (um `Path2D` por classe) e `areaKm2(id)` dá a área do município para a densidade. Com nome `'detail'` (`setPointLayer(layer, 'detail')`), a camada é recortada pelo município (`clip: { kind: 'feature', id }`) ou pelo círculo (`clip: { kind: 'sphere' }`) e emite `cell` no hover. O evento `sphere` traz `lon`/`lat` do centro e `shares` (fração da área de cada município dentro do círculo). Fora do círculo o mapa fica esmaecido; dentro dele, as cores ficam cheias.

## Decisões de segurança e performance

- Nada vindo da rede vira HTML: todo texto entra com `textContent`; cores e tamanhos são números calculados.
- Respostas validadas (códigos `^\d{7}$`, números finitos, meses 1–12, anos 2000–2100); entradas inválidas são descartadas.
- `fetch` com timeout (`AbortController`), sem cookies (`credentials: 'omit'`) e `no-referrer`.
- Corrida de requisições: cada carga usa um número de sequência e descarta respostas antigas.
- Um único laço de `requestAnimationFrame`: vários eventos de mouse viram no máximo um desenho por quadro.
- **Durante o movimento** o mapa não é redesenhado: um bitmap em alta resolução da malha inteira é deslocado e escalado com `transform` de CSS (trabalho da placa de vídeo). Quando a câmera para, volta o desenho vetorial nítido com os nomes. Em zoom muito profundo, desenha vetores só do que está na tela.
- Cores e larguras de rótulo ficam em cache por município; a matemática de cor só roda quando valores ou tema mudam.
- Hit-test: filtro por caixa delimitadora e depois `isPointInPath` em unidades do mapa.

### Medição (Chrome sem GPU, tela 1400×860 com densidade 2, malha de 246 municípios e ~12 mil vértices)

| Ação | Antes (p95 por quadro) | Depois |
| --- | --- | --- |
| Arrastar | 33 ms | **16,7 ms (60 fps)** |
| Voltar para Goiás inteiro | 50 ms | **16,8 ms** |
| Zoom na roda | 33–50 ms | 33 ms (zoom profundo é vetorial) |
| Voo até um município | 50 ms | 33 ms |

Com aceleração de vídeo (navegador normal), os números tendem a ser melhores.

## Idioma

A interface abre em **português** (apresentação local). O botão `EN` troca tudo para inglês, inclusive meses, números e o atributo `lang`, e a escolha fica salva no navegador. Use o inglês para gravar o vídeo e as capturas da submissão, que precisam estar em inglês.

## Testes feitos

Playwright + Chrome com malha sintética do IBGE (36 polígonos, incluindo `MultiPolygon` e entradas maliciosas), nos modos DEMO e API simulada:
- pintura, tooltip, clique, painel (300 células no calendário), busca sem acento, clique no calendário, tema, métrica, idioma PT/EN, `Esc`;
- zero erros de JavaScript e zero violações de CSP;
- nomes com `<b>` e `<script>` aparecem como texto.

Fontes de dados citadas no rodapé: NASA FIRMS, IBGE, INPE (Programa Queimadas, PRODES/DETER), Embrapa SATVeg, NASA POWER.
