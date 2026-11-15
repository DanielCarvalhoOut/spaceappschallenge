import { ibgeConnector } from '../connectors/ibge.js';
import { logger } from '../core/logger.js';
import { isMain } from '../core/entry.js';

export async function runLoadRegions(): Promise<number> {
  const munis = await ibgeConnector.loadMunicipalities('52');
  logger.info({ uf: '52', count: munis.size }, 'job:load-regions completed (Goiás IBGE municipalities)');
  return munis.size;
}

if (isMain(import.meta.url)) {
  runLoadRegions().catch((err) => {
    logger.error({ err: String(err) }, 'job:load-regions failed');
    process.exit(1);
  });
}
