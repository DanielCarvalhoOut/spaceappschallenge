/**
 * job:forecast — temporal validation of the municipality × month forecast.
 *
 *   npm run job:forecast
 *
 * 1. Refreshes the ONI cache (NOAA CPC). If NOAA is unreachable, keeps the previous cache; with no cache the ONI
 *    features are 0 and the artifact says so. ONI values are never typed by hand.
 * 2. Trains on target years <= 2019, tests on 2020–2025 (never shuffled), against climatology and persistence.
 * 3. Writes out/forecast_validation.json (the only source of forecast numbers for the pitch and the assistant).
 */
import { oniConnector } from '../connectors/oni.js';
import { isMain } from '../core/entry.js';
import { logger } from '../core/logger.js';
import { resetForecastCache, writeForecastValidation } from '../db/forecast-service.js';
import { store } from '../db/store.js';

export async function runForecast(): Promise<void> {
  await store.init();
  try {
    await oniConnector.refreshCache();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ONI refresh failed; using the cached file if there is one');
  }
  resetForecastCache();
  const v = writeForecastValidation();
  logger.info(
    {
      dataKind: v.dataKind,
      trainPeriod: v.trainPeriod,
      testPeriod: v.testPeriod,
      nTrain: v.nTrain,
      nTest: v.nTest,
      mae: v.mae,
      skillVsClimatologyPct: v.skillVsClimatologyPct,
      brier: v.exceedance.brier,
      coverageP10P90Pct: v.coverageP10P90Pct,
      official: v.official,
    },
    'job:forecast completed -> out/forecast_validation.json'
  );
}

if (isMain(import.meta.url)) {
  runForecast().catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'job:forecast failed');
    process.exit(1);
  });
}
