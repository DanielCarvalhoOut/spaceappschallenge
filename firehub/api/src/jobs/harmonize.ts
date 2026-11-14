import { logger } from '../core/logger.js';
import { store } from '../db/store.js';

export async function runHarmonize(): Promise<void> {
  await store.init();
  const { validation, inpeCheck } = store.ensureValidationArtifacts();
  logger.info({ validation, inpeCheck }, 'job:harmonize completed -> out/validation.json & out/inpe_check.json');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHarmonize().catch((err) => {
    logger.error({ err: String(err) }, 'job:harmonize failed');
    process.exit(1);
  });
}
