export type SynchronizationJobEventType =
  | 'queued' | 'claimed' | 'heartbeat' | 'completed' | 'rejected' | 'retry_scheduled'
  | 'failed' | 'cancelled' | 'lease_lost' | 'worker_error';

export interface SynchronizationJobObservation {
  event: SynchronizationJobEventType;
  timestamp: number;
  jobId: string;
  correlationId: string;
  attempt: number;
  retryCount: number;
  workerId: string;
  provider: string;
  leaseDurationMs?: number;
  jobDurationMs?: number;
  evidenceEngineDurationMs?: number;
  asrDurationMs?: number;
  resultState?: string;
  failureCategory?: string;
  evidenceCount?: number;
  selectedModel?: string;
  scale?: number;
  offsetMs?: number;
  residualMs?: number;
  inlierRatio?: number;
  temporalCoverage?: number;
  whisperRevision?: string;
  labseRevision?: string;
}

export interface SynchronizationJobObserver {
  record(observation: Readonly<SynchronizationJobObservation>): void | Promise<void>;
}

export const disabledSynchronizationJobObserver: SynchronizationJobObserver = {
  record: () => undefined
};
