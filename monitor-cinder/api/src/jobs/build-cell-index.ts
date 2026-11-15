/**
 * job:build-cell-index — real FIRMS cells for Goiás without PostGIS.
 *
 *   npm run job:build-cell-index -- --from=2001 --to=2025
 *
 * Reads the FIRMS yearly country archives (Brazil, no MAP_KEY; MODIS_SP and VIIRS_SNPP_SP, the two sensors of the
 * harmonized series), keeps nominal/high confidence inside Goiás municipalities, and writes data/firms_goias_cells.json:
 * days with fire per 1 km cell (EPSG:5880 grid, same as fire.cell_key), the state's monthly VIIRS ÷ MODIS factor
 * (2012–2025, like fire.compute_harmonization) and without static sources (same rule as fire.build_static_cells).
 * Each yearly file is cached under data/firms_years/ so a rerun only downloads the missing years.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { firmsConnector, type FirmsQuery } from '../connectors/firms.js';
import { ibgeConnector, pointInMunicipality } from '../connectors/ibge.js';
import { CELL_INDEX_FILE, cellOf, dayNumber, fromPolyconic, type CellIndex, type IndexCell } from '../core/cell-index.js';
import { isMain } from '../core/entry.js';
import { logger } from '../core/logger.js';

type ArchiveSensor = 'MODIS_SP' | 'VIIRS_SNPP_SP';
const FIRST_YEAR: Record<ArchiveSensor, number> = { MODIS_SP: 2000, VIIRS_SNPP_SP: 2012 };

/** Compact per-year file: [lon, lat, day, fireType(−1 = none)] of nominal/high detections in the Goiás box. */
type YearRows = [number, number, number, number][];

function parseArgs(argv: string[]): { from: number; to: number } {
  const get = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const from = Number(get('from') ?? 2001);
  const to = Number(get('to') ?? 2025);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 2000 || to < from || to > 2100) throw new Error('Invalid --from/--to');
  return { from, to };
}

async function loadYear(sensor: ArchiveSensor, year: number): Promise<YearRows | null> {
  if (year < FIRST_YEAR[sensor]) return null;
  const dir = path.join(config.dataDir, 'firms_years');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sensor}_${year}_goias.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as YearRows;
  // CINDER_OFFLINE=1: rebuild the index from the years already cached, without calling FIRMS.
  if (process.env.CINDER_OFFLINE === '1') return null;

  const query: FirmsQuery = { mode: 'country_archive', sensor, year, bbox: config.bbox };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20 * 60 * 1000);
  const rows: YearRows = [];
  try {
    for await (const r of firmsConnector.fetch(query, ctrl.signal)) {
      if (r.confidenceNorm < 1) continue; // nominal or high, like fire.hotspot_cell_day
      rows.push([r.longitude, r.latitude, dayNumber(r.acqDate), r.fireType ?? -1]);
    }
  } finally {
    clearTimeout(timer);
  }
  fs.writeFileSync(file, JSON.stringify(rows));
  logger.info({ sensor, year, rows: rows.length }, 'FIRMS year cached (Goiás box)');
  return rows;
}

interface Acc { gx: number; gy: number; ibge: string; m: Set<number>; v: Set<number>; typed: number; staticTyped: number }

export async function runBuildCellIndex(from: number, to: number): Promise<void> {
  const munis = [...(await ibgeConnector.loadMunicipalities('52')).values()];
  const muniOfCell = new Map<string, string | null>();
  const findMuni = (lon: number, lat: number): string | null => {
    for (const m of munis) if (pointInMunicipality(lat, lon, m)) return m.ibgeCode;
    return null;
  };

  const acc = new Map<string, Acc>();
  const loaded: { MODIS: number[]; VIIRS: number[] } = { MODIS: [], VIIRS: [] };
  for (const sensor of ['MODIS_SP', 'VIIRS_SNPP_SP'] as ArchiveSensor[]) {
    for (let year = from; year <= to; year++) {
      let rows: YearRows | null = null;
      try {
        rows = await loadYear(sensor, year);
      } catch (err) {
        logger.warn({ sensor, year, err: err instanceof Error ? err.message : String(err) }, 'year skipped');
        continue;
      }
      if (!rows) continue;
      (sensor === 'MODIS_SP' ? loaded.MODIS : loaded.VIIRS).push(year);
      for (const [lon, lat, day, type] of rows) {
        const [gx, gy] = cellOf(lon, lat);
        const key = `${gx}:${gy}`;
        let a = acc.get(key);
        if (!a) {
          let ibge = muniOfCell.get(key);
          if (ibge === undefined) {
            // A cell belongs to the municipality that contains its centre (approximation of fire.cell_region).
            const [clon, clat] = fromPolyconic((gx + 0.5) * 1000, (gy + 0.5) * 1000);
            ibge = findMuni(clon, clat);
            muniOfCell.set(key, ibge);
          }
          if (!ibge) continue;
          a = { gx, gy, ibge, m: new Set(), v: new Set(), typed: 0, staticTyped: 0 };
          acc.set(key, a);
        }
        (sensor === 'MODIS_SP' ? a.m : a.v).add(day);
        if (type >= 0) { a.typed++; if (type === 2) a.staticTyped++; }
      }
    }
  }

  // Static sources: fire in 8+ distinct months of a year in 3+ years, or mostly FIRMS type = 2.
  let removed = 0;
  for (const [key, a] of acc) {
    const monthsByYear = new Map<number, Set<number>>();
    for (const d of [...a.m, ...a.v]) {
      const dt = new Date(d * 86_400_000);
      const y = dt.getUTCFullYear();
      if (!monthsByYear.has(y)) monthsByYear.set(y, new Set());
      monthsByYear.get(y)!.add(dt.getUTCMonth());
    }
    const yearRound = [...monthsByYear.values()].filter((s) => s.size >= 8).length >= 3;
    const typedStatic = a.typed > 0 && a.staticTyped / a.typed > 0.5;
    if (yearRound || typedStatic) { acc.delete(key); removed++; }
  }

  // State monthly factor: Σ VIIRS cell-days ÷ Σ MODIS cell-days over 2012–2025 (fire.compute_harmonization default),
  // counting only the years loaded for BOTH sensors: a year with MODIS but no VIIRS file would bias the factor down.
  const factorYears = loaded.VIIRS.filter((y) => y >= 2012 && y <= 2025 && loaded.MODIS.includes(y));
  const inFactor = new Set(factorYears);
  const sumV = new Array<number>(12).fill(0), sumM = new Array<number>(12).fill(0);
  for (const a of acc.values()) {
    for (const d of a.v) { const dt = new Date(d * 86_400_000); if (inFactor.has(dt.getUTCFullYear())) sumV[dt.getUTCMonth()]!++; }
    for (const d of a.m) { const dt = new Date(d * 86_400_000); if (inFactor.has(dt.getUTCFullYear())) sumM[dt.getUTCMonth()]!++; }
  }
  const monthlyFactors = sumM.map((m, i) => (m > 0 ? Math.round((sumV[i]! / m) * 1000) / 1000 : null));

  const cells: IndexCell[] = [...acc.values()].map((a) => [
    a.gx, a.gy, a.ibge, [...a.m].sort((p, q) => p - q), [...a.v].sort((p, q) => p - q),
  ]);
  const index: CellIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    source: 'NASA FIRMS yearly country archives (Brazil): MODIS_SP, VIIRS_SNPP_SP',
    yearsLoaded: loaded,
    factorYears,
    monthlyFactors,
    staticCellsRemoved: removed,
    cells,
  };
  fs.writeFileSync(path.join(config.dataDir, CELL_INDEX_FILE), JSON.stringify(index));
  logger.info({ cells: cells.length, staticCellsRemoved: removed, monthlyFactors, factorYears, years: loaded }, 'job:build-cell-index completed');
}

if (isMain(import.meta.url)) {
  const { from, to } = parseArgs(process.argv.slice(2));
  runBuildCellIndex(from, to).catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'job:build-cell-index failed');
    process.exit(1);
  });
}
