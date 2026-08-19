import type { AudioExtractor } from '../media/audio-extractor.js';
import type { MediaProbe } from '../media/types.js';
import type { SubtitleProvider } from './provider.js';
import {
  ApprovedCalibratedSynchronizationMappingPolicy,
  auditCalibratedSynchronizationReadiness,
  readCalibratedSynchronizationActivation,
  type ActivationReadinessAudit
} from './synchronization-activation.js';
import { SynchronizationJobRunner } from './synchronization-job.js';
import type { SynchronizationJobObserver } from './synchronization-job-observability.js';
import { EvidenceEngineProcessAdapter } from './synchronization-evidence-engine-process.js';
import { CalibratedSynchronizationWorker } from './synchronization-worker.js';
import { UpstashSynchronizationJobStore } from './upstash-synchronization-job-store.js';

export interface StagingSynchronizationComposition {
  environment: 'staging';
  namespace: string;
  worker: CalibratedSynchronizationWorker;
  store: UpstashSynchronizationJobStore;
  runner: SynchronizationJobRunner;
  mappingPolicy: ApprovedCalibratedSynchronizationMappingPolicy;
  readiness: ActivationReadinessAudit;
}
export interface StagingSynchronizationDependencies {
  provider: SubtitleProvider;
  mediaProbe: MediaProbe;
  audioExtractor: AudioExtractor;
  observer?: SynchronizationJobObserver;
  now?: () => number;
}

/** Factory is never imported by app.ts; disabled/production environments return no composition. */
export async function createStagingSynchronizationComposition(
  environment: NodeJS.ProcessEnv,
  dependencies: StagingSynchronizationDependencies
): Promise<StagingSynchronizationComposition | undefined> {
  const config = readCalibratedSynchronizationActivation(environment);
  if (!config.enabled || config.activation !== 'staging' || config.runtimeEnvironment !== 'staging') return undefined;
  const command = environment.INDOSYNC_EVIDENCE_ENGINE_COMMAND!.trim();
  const args = environment.INDOSYNC_EVIDENCE_ENGINE_ARGS?.trim()
    ? JSON.parse(environment.INDOSYNC_EVIDENCE_ENGINE_ARGS) as string[]
    : [];
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new Error('Evidence engine args are invalid.');
  const engine = new EvidenceEngineProcessAdapter({ command, args });
  const worker = new CalibratedSynchronizationWorker({ ...dependencies, evidenceEngine: engine });
  const store = new UpstashSynchronizationJobStore({
    url: environment.KV_REST_API_URL!, token: environment.KV_REST_API_TOKEN!,
    keyPrefix: config.namespace!
  });
  const mappingPolicy = new ApprovedCalibratedSynchronizationMappingPolicy();
  const readiness = await auditCalibratedSynchronizationReadiness(config, true);
  if (readiness.status !== 'ready') throw new Error(`Staging synchronization is not ready: ${readiness.reasons.join(',')}`);
  return {
    environment: 'staging', namespace: config.namespace!, worker, store,
    runner: new SynchronizationJobRunner(
      store, worker, environment.INDOSYNC_SYNCHRONIZATION_WORKER_ID ?? 'staging_worker',
      dependencies.now ?? Date.now, undefined, { observer: dependencies.observer }
    ),
    mappingPolicy, readiness
  };
}
