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
  videoHost?: string;
}

export interface SynchronizationJobObserver {
  record(observation: Readonly<SynchronizationJobObservation>): void | Promise<void>;
}

export const disabledSynchronizationJobObserver: SynchronizationJobObserver = {
  record: () => undefined
};

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export const consoleSynchronizationJobObserver: SynchronizationJobObserver = {
  record: (observation) => {
    console.log(JSON.stringify({
      event: observation.event,
      jobId: observation.jobId,
      attempt: observation.attempt,
      resultState: observation.resultState,
      failureCategory: observation.failureCategory,
      evidenceCount: observation.evidenceCount,
      selectedModel: observation.selectedModel,
      residualMs: observation.residualMs,
      videoHost: observation.videoHost ?? hostFromUrl((observation as unknown as { videoUrl?: string }).videoUrl)
    }));
  }
};
