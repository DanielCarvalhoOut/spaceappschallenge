/**
 * job:goes-check — reads the newest GOES-19 fire scan (NOAA open data) and lists the confident fire pixels in Goiás.
 *
 *   npm run job:goes-check
 *
 * A quick live test of the "fire notice now" feed; it does not touch the harmonized series.
 */
import { fetchScan, latestKeys } from '../connectors/goes-fdc.js';
import { isMain } from '../core/entry.js';
import { logger } from '../core/logger.js';
import { store } from '../db/store.js';

export async function runGoesCheck(): Promise<number> {
  await store.init();
  const [key] = (await latestKeys(1)).slice(-1);
  if (!key) throw new Error('No GOES-19 FDCF file in the last 3 hours');
  const scan = await fetchScan(key, [-53.3, -19.55, -45.85, -12.35], (lon, lat) => store.municipalityAt(lon, lat) !== null);
  logger.info({ key, scanStart: scan.scanStart, detections: scan.detections.length }, 'job:goes-check completed');
  for (const d of scan.detections.slice(0, 20)) {
    const ibge = store.municipalityAt(d.lon, d.lat);
    console.log(`${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}  mask ${d.mask}  FRP ${d.frpMw ?? '–'} MW  ${ibge ? store.getMunicipality(ibge)?.name : ''}`);
  }
  return scan.detections.length;
}

if (isMain(import.meta.url)) {
  runGoesCheck().catch((err) => {
    logger.error({ err: String(err) }, 'job:goes-check failed');
    process.exit(1);
  });
}
