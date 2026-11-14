import { logger } from '../core/logger.js';
import { store } from '../db/store.js';

export async function runBuildCalendar(): Promise<void> {
  await store.init();
  const munis = store.getMunicipalities();
  let rootAnthroCount = 0;
  for (const ibge of munis.keys()) {
    const root = store.getRootFireAnalysis(ibge);
    if (root.dominantRegime === 'anthropogenic_root') rootAnthroCount++;
  }
  logger.info(
    { municipalities: munis.size, anthropogenicRootMunicipalities: rootAnthroCount },
    'job:build-calendar completed (2000–Present Root Fire Calendar & Z-score baseline)'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBuildCalendar().catch((err) => {
    logger.error({ err: String(err) }, 'job:build-calendar failed');
    process.exit(1);
  });
}
