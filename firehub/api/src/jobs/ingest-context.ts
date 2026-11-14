import { logger } from '../core/logger.js';
import { store } from '../db/store.js';
import { isMain } from '../core/entry.js';

export async function runIngestContext(): Promise<void> {
  await store.init();
  // Pre-warm NASA POWER daily weather & predictability for Goiânia (5208707), Alto Paraíso (5200605), Cavalcante (5205307), Mineiros (5213103)
  const keyMunis = ['5208707', '5200605', '5205307', '5213103', '5208004', '5218805'];
  for (const ibge of keyMunis) {
    const pred = await store.getPredictabilityAndWeather(ibge, 2024, 9);
    logger.info(
      {
        ibge,
        ignitionRiskScore: pred.ignitionRiskScore,
        ignitionRiskClass: pred.ignitionRiskClass,
        t2mMaxC: pred.weatherSummary.t2mMaxC,
        rh2mPct: pred.weatherSummary.rh2mPct,
        ws10mMs: pred.weatherSummary.ws10mMs,
        wd10mDeg: pred.weatherSummary.wd10mDeg,
        propagationCardinal: pred.propagation.cardinal,
        spreadRateKmh: pred.propagation.spreadRateKmh,
      },
      'NASA POWER daily climate & predictability computed'
    );
  }
}

if (isMain(import.meta.url)) {
  runIngestContext().catch((err) => {
    logger.error({ err: String(err) }, 'job:ingest-context failed');
    process.exit(1);
  });
}
