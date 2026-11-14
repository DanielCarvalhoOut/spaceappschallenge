import { logger } from '../core/logger.js';
import { store } from '../db/store.js';
import { isMain } from '../core/entry.js';

export async function runIngestFirms(): Promise<{ rawCount: number; clusterCount: number }> {
  await store.init();
  const { rawHotspots, clusters } = await store.loadLiveFirmsSnapshot(true);
  logger.info(
    {
      rawCount: rawHotspots.length,
      deduplicatedClusters: clusters.length,
      deduplicationPct:
        rawHotspots.length > 0
          ? Math.round(((rawHotspots.length - clusters.length) / rawHotspots.length) * 1000) / 10
          : 0,
    },
    'job:ingest-firms completed (MODIS 1km + VIIRS 375m + LANDSAT 30m -> DBSCAN/H3 deduplication)'
  );
  return { rawCount: rawHotspots.length, clusterCount: clusters.length };
}

if (isMain(import.meta.url)) {
  runIngestFirms().catch((err) => {
    logger.error({ err: String(err) }, 'job:ingest-firms failed');
    process.exit(1);
  });
}
