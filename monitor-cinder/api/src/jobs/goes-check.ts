/**
 * job:goes-check — reads the newest GOES-19 fire scan (NOAA open data) and lists the confident fire pixels in Goiás.
 *
 *   npm run job:goes-check            Goiás, confident classes only (what the notices use)
 *   npm run job:goes-check -- --brasil Brazil, every fire class (to check that pixels land in the right places)
 *
 * A quick live test of the "fire notice now" feed; it does not touch the harmonized series.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { GOES_BUCKET_URL, latestKeys, readFdc } from '../connectors/goes-fdc.js';
import { isMain } from '../core/entry.js';
import { logger } from '../core/logger.js';
import { store } from '../db/store.js';

export async function runGoesCheck(brasil = process.argv.includes('--brasil')): Promise<number> {
  await store.init();
  const [key] = (await latestKeys(1)).slice(-1);
  if (!key) throw new Error('No GOES-19 FDCF file in the last 3 hours');
  const dir = path.join(config.dataDir, 'goes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(key));
  const res = await fetch(`${GOES_BUCKET_URL}/${key}`);
  if (!res.ok) throw new Error(`GOES file HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  try {
    const box: [number, number, number, number] = brasil ? [-74, -34, -34, 5.5] : [-53.3, -19.55, -45.85, -12.35];
    const r = await readFdc(file, box, brasil
      ? { masks: new Set([10, 11, 12, 13, 14, 15, 30, 31, 32, 33, 34, 35]) }
      : { inside: (lon, lat) => store.municipalityAt(lon, lat) !== null });
    logger.info({ key, scanStart: r.scanStart, area: brasil ? 'Brasil (todas as classes)' : 'Goiás (classes confiáveis)', detections: r.detections.length }, 'job:goes-check completed');
    for (const d of r.detections.slice(0, 25)) {
      const ibge = store.municipalityAt(d.lon, d.lat);
      console.log(`${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}  classe ${d.mask}  FRP ${d.frpMw ?? '–'} MW  ${ibge ? store.getMunicipality(ibge)?.name : ''}`);
    }
    return r.detections.length;
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

if (isMain(import.meta.url)) {
  runGoesCheck().catch((err) => {
    logger.error({ err: String(err) }, 'job:goes-check failed');
    process.exit(1);
  });
}
