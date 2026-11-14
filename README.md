# Space Apps 2026 · Goiânia

**Foco da equipe: tema 8, [Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/)**, projeto **FireHub** (decisão final de 14/11/2026, 14h11).

Prazo de submissão: **domingo, 15/11/2026, 23h59 no horário do evento local** ("Submit for Judging").

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `Tema_08_MODIS_VIIRS/` | **Foco (FireHub).** Dados do FIRMS, harmonização, banco testado (PostGIS) com padrão histórico, anomalia e alertas, contrato da API e catálogo |
| `Mapa iterativo/` | **Front do FireHub, autoral** (JS puro + Canvas): mapa de Goiás por município do IBGE, painel com calendário e padrão histórico. Abre com dois cliques; sem API entra em modo DEMO |
| `IMPLEMENTACAO.md` / `CLAUDE.md` | Guia de implementação (back em TypeScript, conectores NASA/IBGE/INPE/Embrapa) e regras para o Claude Code |
| `00_Geral/` | Kit de decisão, regras de entrega e recursos dos desafios, vencedores globais de 2025 (PDFs) |

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
