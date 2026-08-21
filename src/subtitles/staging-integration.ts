import type { SubtitleProvider } from './provider.js';
import type { SubtitleCandidate, SubtitleRequestMetadata } from './types.js';
import type { SynchronizationSubtitleDelivery } from './synchronization-delivery.js';
import { OrchestratedSynchronizationSubtitleDelivery } from './synchronization-delivery.js';
import type { SynchronizationWorker, SynchronizationWorkerContext } from './synchronization-orchestrator.js';
import { SynchronizationOrchestrator } from './synchronization-orchestrator.js';
import { createSynchronizationJob, type SynchronizationJobStore } from './synchronization-job.js';
import type {
  SynchronizationReferenceCodec,
  SynchronizationResult,
  SynchronizationTask,
  SynchronizationTaskStore
} from './synchronization-context.js';
import type { TorboxResolver } from './torbox-resolver.js';

export interface StagingSynchronizationIntegration {
  readonly delivery: SynchronizationSubtitleDelivery;
  issue(
    metadata: SubtitleRequestMetadata,
    imdbId: string | undefined,
    subtitle: Readonly<{ id: string; url: string; lang: string }> | undefined
  ): Promise<string | undefined>;
}

/**
 * Staging-only, additive IndoSync integration boundary.
 *
 * It never replaces the OpenSubtitles flow. Issuance is asynchronous (only
 * fast Upstash writes, no GPU inference) and delivery falls back to the
 * original subtitle unless an approved mapping is present.
 */
export class StagingSynchronizationIntegrationImpl implements StagingSynchronizationIntegration {
  readonly delivery: SynchronizationSubtitleDelivery;

  private readonly torboxResolver?: TorboxResolver;

  constructor(
    private readonly orchestrator: SynchronizationOrchestrator,
    private readonly jobStore: SynchronizationJobStore,
    private readonly now: () => number,
    provider: SubtitleProvider,
    torboxResolver?: TorboxResolver
  ) {
    this.delivery = new OrchestratedSynchronizationSubtitleDelivery(provider, orchestrator);
    this.torboxResolver = torboxResolver;
  }

  async issue(
    metadata: SubtitleRequestMetadata,
    imdbId: string | undefined,
    subtitle: Readonly<{ id: string; url: string; lang: string }> | undefined
  ): Promise<string | undefined> {
    let videoUrl = metadata.videoUrl;
    const host = (() => { try { return videoUrl ? new URL(videoUrl).hostname : undefined; } catch { return undefined; } })();
    console.log(JSON.stringify({ event: 'indosync_issue', hasVideoUrl: !!videoUrl, videoHost: host, subtitleId: subtitle?.id, filename: metadata.filename }));
    if (!subtitle) return undefined;
    const candidate = synchronizationCandidate(subtitle);
    if (!candidate) return undefined;
    if (!videoUrl && this.torboxResolver && imdbId) {
      try {
        const resolved = await this.torboxResolver.resolve(imdbId, metadata.filename);
        if (resolved) {
          videoUrl = resolved;
          console.log(JSON.stringify({ event: 'indosync_torbox_resolved', imdbId }));
        } else {
          console.log(JSON.stringify({ event: 'indosync_torbox_nomatch', imdbId }));
        }
      } catch (error) {
        console.log(JSON.stringify({ event: 'indosync_torbox_error', error: error instanceof Error ? error.message : String(error) }));
      }
    }
    if (!videoUrl) return undefined;
    const enriched: SubtitleRequestMetadata = { ...metadata, videoUrl };
    try {
      const { task, reference } = await this.orchestrator.createTask(enriched, candidate);
      const job = createSynchronizationJob(task, this.currentTime(), 3);
      await this.jobStore.enqueue(job);
      return reference;
    } catch {
      // Issuance must never break the existing OpenSubtitles response.
      return undefined;
    }
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Current time is invalid.');
    return value;
  }
}

/**
 * Bridges the job queue execution (SynchronizationJobRunner) with the task /
 * result stores read by OrchestratedSynchronizationSubtitleDelivery.
 *
 * After the calibrated worker produces a result, this bridge persists it into
 * the orchestrator result store (and marks the task completed) so that
 * approvedMapping is actually available at /subtitles/synchronization/:ref.vtt.
 */
export class StagingSynchronizationWorkerBridge implements SynchronizationWorker {
  constructor(
    private readonly inner: SynchronizationWorker,
    private readonly orchestrator: SynchronizationOrchestrator,
    private readonly taskStore: SynchronizationTaskStore,
    private readonly referenceCodec: SynchronizationReferenceCodec,
    private readonly now: () => number
  ) {}

  async process(
    task: SynchronizationTask,
    context: SynchronizationWorkerContext = {}
  ): Promise<SynchronizationResult> {
    const result = await this.inner.process(structuredClone(task), context);
    const reference = this.referenceCodec.issue({ taskId: task.id, expiresAt: task.expiresAt });
    const now = this.currentTime();
    try {
      if (this.taskStore.transition) {
        await this.taskStore.transition(task.id, 'pending', 'processing', now);
      } else {
        await this.taskStore.update({ ...structuredClone(task), status: 'processing' });
      }
    } catch {
      // Already processing or equivalent; completion below validates the real state.
    }
    try {
      await this.orchestrator.completeTask(reference, result);
    } catch (error) {
      const existing = await this.orchestrator.getResult(reference);
      if (!existing) throw error;
    }
    return result;
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Current time is invalid.');
    return value;
  }
}

function synchronizationCandidate(subtitle: Readonly<{ id: string; url: string; lang: string }>): SubtitleCandidate | undefined {
  const separator = subtitle.id.indexOf('-');
  if (separator < 1) return undefined;
  const provider = subtitle.id.slice(0, separator);
  const reference = subtitle.id.slice(separator + 1);
  if (!provider || !reference) return undefined;
  return { provider, reference, language: 'id', fileName: reference };
}
