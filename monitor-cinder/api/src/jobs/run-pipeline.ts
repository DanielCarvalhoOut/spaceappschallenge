import { runBuildCalendar } from './build-calendar.js';
import { runHarmonize } from './harmonize.js';
import { runIngestContext } from './ingest-context.js';
import { runIngestFirms } from './ingest-firms.js';
import { runLoadRegions } from './load-regions.js';
import { runTrainMl } from './train-ml.js';

async function main(): Promise<void> {
  await runLoadRegions();
  await runIngestFirms();
  await runHarmonize();
  await runBuildCalendar();
  await runTrainMl();
  await runIngestContext();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
