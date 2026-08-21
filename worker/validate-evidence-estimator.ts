import { readFileSync } from 'node:fs';
import { synchronizationPointsFromEvidence } from '../src/subtitles/synchronization-evidence.js';
import { estimateSynchronization } from '../src/subtitles/synchronization.js';
for (const file of ['benchmark-output/calibration-development-v2.json', 'benchmark-output/calibration-holdout.json']) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const points = synchronizationPointsFromEvidence(result.evidence);
  console.log(JSON.stringify({ file, pointCount: points.length, estimator: estimateSynchronization(points) }));
}
