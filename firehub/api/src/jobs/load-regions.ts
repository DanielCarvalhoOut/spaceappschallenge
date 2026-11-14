import { ibgeConnector } from '../connectors/ibge.js';
import { logger } from '../core/logger.js';

export async function runLoadRegions(): Promise<number> {
  const munis = await ibgeConnector.loadMunicipalities('52');
  logger.info({ uf: '52', count: munis.size }, 'job:load-regions completed (Goiás IBGE municipalities)');
  return munis.size;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoadRegions().catch((err) => {
    logger.error({ err: String(err) }, 'job:load-regions failed');
    process.exit(1);
  });
}
