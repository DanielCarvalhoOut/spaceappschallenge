import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { localitiesFromZip, parseDbf, unzipEntry } from '../connectors/ibge-localities.js';

/** Minimal dBASE III writer for the test (character fields only). */
function dbf(fields: Array<[string, number]>, rows: string[][]): Buffer {
  const hlen = 32 + 32 * fields.length + 1, rlen = 1 + fields.reduce((a, [, l]) => a + l, 0);
  const b = Buffer.alloc(hlen + rlen * rows.length + 1, 0x20);
  b.fill(0, 0, hlen);
  b[0] = 3; b.writeUInt32LE(rows.length, 4); b.writeUInt16LE(hlen, 8); b.writeUInt16LE(rlen, 10);
  fields.forEach(([name, len], i) => { const o = 32 + 32 * i; b.write(name, o, 'latin1'); b[o + 11] = 0x43; b[o + 16] = len; });
  b[hlen - 1] = 0x0d;
  rows.forEach((r, i) => { let o = hlen + i * rlen; b[o] = 0x20; o++; r.forEach((v, j) => { b.write(v, o, 'utf8'); o += fields[j]![1]; }); });
  b[b.length - 1] = 0x1a;
  return b;
}
/** Minimal zip writer (deflate) for the test. */
function zip(files: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const [name, data] of files) {
    const comp = zlib.deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const FIELDS: Array<[string, number]> = [['CD_MUN', 7], ['CT_LOCALID', 50], ['CD_LOCALID', 15], ['NM_LOCALID', 150], ['LAT_LOCALI', 12], ['LONG_LOCAL', 12]];
const ROWS = [
  ['5218003', 'Cidade', '5218003', 'Porangatu', '-13.4411', '-49.1472'],
  ['5218003', 'Povoado', '521800300005', 'Estreito', '-13.4140', '-49.0526'],
  ['5205307', 'Localidade Quilombola', '520530700001', 'Comunidade Quilombola São Domingos', '-13.5779', '-47.6281'],
  ['5205307', 'Povoado', '520530700001', 'Comunidade Quilombola São Domingos', '-13.5779', '-47.6281'],
  ['5205307', 'Povoado', 'x', 'invalid id row', '-13.5', '-47.6'],
];

describe('IBGE localities (map reference only)', () => {
  it('reads the UF dbf out of the zip, keeps one record per locality and both kinds', () => {
    const z = zip([['GO/GO_localidades_2022.dbf', dbf(FIELDS, ROWS)], ['GO/GO_localidades_2022.cpg', Buffer.from('UTF-8')]]);
    expect(unzipEntry(z, 'GO/GO_localidades_2022.cpg').toString()).toBe('UTF-8');
    expect(parseDbf(unzipEntry(z, 'GO/GO_localidades_2022.dbf'))).toHaveLength(5);
    const l = localitiesFromZip(z, 'GO');
    expect(l).toHaveLength(3); // invalid id dropped, duplicated id merged
    const q = l.find((x) => x.id === '520530700001')!;
    expect(q.kind).toBe('povoado');
    expect(q.kinds.sort()).toEqual(['povoado', 'quilombola']);
    expect(l.find((x) => x.name === 'Estreito')).toMatchObject({ ibge: '5218003', kind: 'povoado', lat: -13.414, lon: -49.0526 });
  });
  it('fails clearly when the UF is not in the zip', () => {
    expect(() => localitiesFromZip(zip([['MT/MT_localidades_2022.dbf', dbf(FIELDS, ROWS)]]), 'GO')).toThrow(/not found/);
  });
});
