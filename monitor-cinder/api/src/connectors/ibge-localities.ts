import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

/**
 * IBGE — Base de Localidades, Censo 2022 (public download, one shapefile per UF inside one zip).
 * Geographic reference ONLY: names and coordinates of vilas, povoados, lugarejos, núcleos and comunidades,
 * shown on the map when zoomed in and used to say "near which locality" a fire cell is. Never an input of the
 * harmonization, the anomaly or the projection.
 */
export const LOCALITIES_URL =
  'https://geoftp.ibge.gov.br/organizacao_do_territorio/estrutura_territorial/localidades/Localidades_do_Brasil/2022/Localidades_UFs_shp.zip';

export type LocalityKind = 'sede' | 'vila' | 'povoado' | 'lugarejo' | 'urbano' | 'rural' | 'agrovila' | 'quilombola' | 'indigena' | 'outra';
export interface Locality { id: string; ibge: string; name: string; kind: LocalityKind; kinds: LocalityKind[]; lon: number; lat: number }

/** IBGE category (CT_LOCALID) → our kind; the first listed wins when one locality has two categories. */
const KIND_OF: Record<string, LocalityKind> = {
  Cidade: 'sede', Vila: 'vila', Povoado: 'povoado', Lugarejo: 'lugarejo', 'Núcleo Urbano': 'urbano', 'Núcleo Rural': 'rural',
  'Agrovila do PA': 'agrovila', 'Localidade Quilombola': 'quilombola', 'Localidade Indígena': 'indigena', 'Outras Localidades': 'outra',
};
const PRIORITY: LocalityKind[] = ['sede', 'vila', 'povoado', 'quilombola', 'indigena', 'lugarejo', 'agrovila', 'rural', 'urbano', 'outra'];

/** One file out of a zip (stored or deflated), by exact name. Throws if absent or malformed. */
export function unzipEntry(zip: Buffer, name: string): Buffer {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const n = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20);
    const fl = zip.readUInt16LE(p + 28), el = zip.readUInt16LE(p + 30), cl = zip.readUInt16LE(p + 32), off = zip.readUInt32LE(p + 42);
    const entry = zip.subarray(p + 46, p + 46 + fl).toString('utf8');
    if (entry === name) {
      const lfl = zip.readUInt16LE(off + 26), lel = zip.readUInt16LE(off + 28);
      const data = zip.subarray(off + 30 + lfl + lel, off + 30 + lfl + lel + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
      throw new Error(`unsupported zip method ${method}`);
    }
    p += 46 + fl + el + cl;
  }
  throw new Error(`${name} not found in zip`);
}

/** dBASE III table → rows of trimmed strings (UTF-8, as the IBGE .cpg declares). */
export function parseDbf(buf: Buffer): Array<Record<string, string>> {
  const nrec = buf.readUInt32LE(4), hlen = buf.readUInt16LE(8), rlen = buf.readUInt16LE(10);
  const fields: Array<{ name: string; len: number }> = [];
  for (let o = 32; o < hlen - 1 && buf[o] !== 0x0d; o += 32) {
    fields.push({ name: buf.subarray(o, o + 11).toString('latin1').replace(/\0.*$/s, ''), len: buf[o + 16]! });
  }
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < nrec; i++) {
    let o = hlen + i * rlen;
    if (buf[o] === 0x2a) continue; // deleted record
    o += 1;
    const r: Record<string, string> = {};
    for (const f of fields) { r[f.name] = buf.subarray(o, o + f.len).toString('utf8').trim(); o += f.len; }
    rows.push(r);
  }
  return rows;
}

const Row = z.object({
  CD_MUN: z.string().regex(/^\d{7}$/),
  CD_LOCALID: z.string().regex(/^\d{7,15}$/),
  NM_LOCALID: z.string().min(1).max(150),
  CT_LOCALID: z.string().max(50),
  LAT_LOCALI: z.coerce.number().min(-34).max(6),
  LONG_LOCAL: z.coerce.number().min(-75).max(-28),
});

/** Localities of one UF out of the IBGE zip; one record per locality id (a quilombo that is also a povoado keeps both kinds). */
export function localitiesFromZip(zip: Buffer, ufSigla: string): Locality[] {
  const rows = parseDbf(unzipEntry(zip, `${ufSigla}/${ufSigla}_localidades_2022.dbf`));
  const byId = new Map<string, Locality>();
  for (const raw of rows) {
    const r = Row.safeParse(raw);
    if (!r.success) continue;
    const kind = KIND_OF[r.data.CT_LOCALID] ?? 'outra';
    const prev = byId.get(r.data.CD_LOCALID);
    if (prev) {
      if (!prev.kinds.includes(kind)) prev.kinds.push(kind);
      if (PRIORITY.indexOf(kind) < PRIORITY.indexOf(prev.kind)) prev.kind = kind;
      continue;
    }
    byId.set(r.data.CD_LOCALID, {
      id: r.data.CD_LOCALID, ibge: r.data.CD_MUN, name: r.data.NM_LOCALID.replace(/\s+/g, ' '), kind, kinds: [kind],
      lon: Math.round(r.data.LONG_LOCAL * 1e4) / 1e4, lat: Math.round(r.data.LAT_LOCALI * 1e4) / 1e4,
    });
  }
  return [...byId.values()];
}

const CacheSchema = z.object({
  source: z.string(), fetchedAt: z.string(), uf: z.string(),
  localities: z.array(z.object({
    id: z.string(), ibge: z.string(), name: z.string(), kind: z.enum(PRIORITY as [LocalityKind, ...LocalityKind[]]),
    kinds: z.array(z.enum(PRIORITY as [LocalityKind, ...LocalityKind[]])), lon: z.number(), lat: z.number(),
  })).max(20_000),
});
const cacheFile = (ufCode: string): string => path.join(config.dataDir, `ibge_localidades_${ufCode}.json`);

export function loadCachedLocalities(ufCode: string): Locality[] | null {
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(fs.readFileSync(cacheFile(ufCode), 'utf8')));
    return parsed.success ? parsed.data.localities : null;
  } catch {
    return null;
  }
}

/** Downloads the IBGE zip (~4 MB), keeps only the UF and caches it in data/ (the zip itself is not kept). */
export async function fetchLocalities(ufCode: string, ufSigla: string, signal: AbortSignal): Promise<Locality[]> {
  logger.info({ source: 'ibge_localidades', url: LOCALITIES_URL }, 'Fetching IBGE localities (Censo 2022)');
  const res = await fetch(LOCALITIES_URL, { signal, headers: { 'User-Agent': 'MonitorCinder/1.0 (NASA Space Apps 2026 Goiania)' } });
  if (!res.ok) throw new Error(`IBGE localities HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > 64 * 1024 * 1024) throw new Error('IBGE localities zip unexpectedly large');
  const zip = Buffer.from(await res.arrayBuffer());
  const localities = localitiesFromZip(zip, ufSigla);
  if (localities.length < 50) throw new Error(`only ${localities.length} localities parsed`);
  fs.writeFileSync(cacheFile(ufCode), JSON.stringify({ source: LOCALITIES_URL, fetchedAt: new Date().toISOString(), uf: ufCode, localities }));
  logger.info({ uf: ufSigla, n: localities.length }, 'IBGE localities cached');
  return localities;
}
