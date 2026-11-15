import { logger } from '../core/logger.js';
import { store } from '../db/store.js';
import { isMain } from '../core/entry.js';

export async function runTrainMl(): Promise<void> {
  await store.init();
  const model = store.trainOrLoadMlModel(true);
  logger.info(
    {
      modelType: model.modelType,
      trainPeriod: model.trainPeriod,
      testPeriod: model.testPeriod,
      trainSamples: model.trainSamples,
      testSamples: model.testSamples,
      metrics: model.metrics,
      topFeatures: model.featureImportances.slice(0, 5),
    },
    'job:train-ml completed -> out/ml_propensity_model.json'
  );
}

if (isMain(import.meta.url)) {
  runTrainMl().catch((err) => {
    logger.error({ err: String(err) }, 'job:train-ml failed');
    process.exit(1);
  });
}
