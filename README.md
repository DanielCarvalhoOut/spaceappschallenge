# Space Apps 2026 · Goiânia

**Foco da equipe: tema 8, [Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/)**, projeto **Monitor Cinder** (decisão final de 14/11/2026, 14h11).

Prazo de submissão: **domingo, 15/11/2026, 23h59 no horário do evento local** ("Submit for Judging").

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `Tema_08_MODIS_VIIRS/` | **Foco (Monitor Cinder).** Dados do FIRMS, harmonização, banco testado (PostGIS) com padrão histórico, anomalia e alertas, contrato da API e catálogo |
| `monitor-cinder/` | **App do Monitor Cinder.** [`README.md`](monitor-cinder/README.md) em inglês para o júri (o que faz, como harmoniza, provas, como rodar). `api/` é o back (Node 22 + TypeScript); `api/out/` guarda as provas geradas por código (`npm run job:validate`) |
| `Mapa iterativo/` | **Front do Monitor Cinder, autoral** (JS puro + Canvas): mapa de Goiás em largura total, detalhes em janela com abas (Resumo, Projeção, Histórico, Área, Contexto), hover com resumo e análise por círculo que conta só o que está dentro dele. Todos os números vêm da API (histórico real do NASA FIRMS, 2001 até ontem); sem API mostra só os contornos |
| `IMPLEMENTACAO.md` / `CLAUDE.md` | Guia de implementação (back em TypeScript, conectores NASA/IBGE/INPE/Embrapa) e regras para o Claude Code |
| `00_Geral/` | Kit de decisão, regras de entrega e recursos dos desafios, vencedores globais de 2025 (PDFs) |

## Números do pitch (todos saem de `monitor-cinder/api/out/`)

- Harmonização por satélite, testada fora da amostra: MODIS→S-NPP 12,4 % de erro (r 0,981); NOAA-20→S-NPP 2,5 %; NOAA-21→S-NPP 3,0 % (`internal_checks.json`).
- Contra o INPE (satélite de referência, cadeia independente): correlação mensal 0,955 em 286 meses; mesma direção da anomalia em 92,9 % dos meses fora do normal (`external_validation.json`).
- Projeção com faixa de incerteza validada em 2021–2025: 15 dias +18,7 % sobre a climatologia, 87,5 % dentro da faixa; mês +8,8 %, 90 %; 6 meses e chance diária sem ganho, por isso não aparecem (`projection_validation.json`).
- Por município o erro é maior (mediana 68,6 %, `internal_checks.json`): o número forte é o do estado.

## Versões online (atualizadas)

- [Kit de decisão do tema](https://claude.ai/artifact/Nmt98CLucUKPaSMMkHHYfW)
- [Entregas e recursos de todos os desafios](https://claude.ai/artifact/6tcJ86tPgfVNKDsbpJdM83)
- [Vencedores globais anteriores](https://claude.ai/artifact/RnRWisXs9jj9EMbeTJtGUk)
- [Catálogo FIRMS do tema 8](https://claude.ai/artifact/BYWy51WCLNtykaxGv2rF5u)

Os PDFs são uma cópia de 14/11/2026. Se os docs online mudarem, os PDFs ficam desatualizados.

## Regras que eliminam a equipe (resumo)

- Todos os membros no mesmo evento local, no máximo 6.
- Tudo em inglês. Vídeo pode ser falado em português, com legenda em inglês.
- Demo: vídeo de até 30 s **ou** até 7 slides.
- Links públicos, sem login.
- Pelo menos um dado ou recurso da NASA (aqui: FIRMS como núcleo; NASA POWER e, se der tempo, MCD12Q1 como contexto). INPE, IBGE e Embrapa entram como fontes complementares.
- IA permitida como ferramenta, não para gerar a ideia; imagem e vídeo gerados por IA com marca d'água; código gerado por IA declarado.

Fonte: [Project Submission Guide](https://www.spaceappschallenge.org/resources/project-submission-guide/) e [Judging & Awards Guide](https://www.spaceappschallenge.org/resources/judging-awards-guide/).

## Repositório

O `.gitignore` já ignora `.env` e `data/raw/`: nunca suba a MAP_KEY do FIRMS, o token da Embrapa nem os CSV brutos do Brasil (dezenas a centenas de MB por ano). Suba só o recorte de Goiás e o SHA-256 de cada arquivo de origem.
