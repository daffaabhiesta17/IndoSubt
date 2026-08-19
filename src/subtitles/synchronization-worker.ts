import type { AudioArtifact, AudioExtractionOptions, AudioExtractor } from '../media/audio-extractor.js';
import { MediaProbeError, type MediaProbe, type MediaProbeResult } from '../media/types.js';
import type { SubtitleProvider } from './provider.js';
import type { SynchronizationResult, SynchronizationTask } from './synchronization-context.js';
import type { SynchronizationEvidence } from './synchronization-evidence.js';
import type { SynchronizationWorker, SynchronizationWorkerContext } from './synchronization-orchestrator.js';
import { buildCalibratedSynchronizationResult } from './synchronization-worker-result.js';
import { parseWebVttCues, type WebVttCue } from './webvtt.js';

export interface SynchronizationEvidenceEngineInput {
  task: Readonly<SynchronizationTask>;
  cues: readonly WebVttCue[];
  media: Readonly<MediaProbeResult>;
  audio: Readonly<AudioArtifact>;
}

export interface SynchronizationEvidenceEngineOutput {
  evidence: readonly SynchronizationEvidence[];
  confidence: number;
  method: string;
  metrics?: Readonly<Record<string, number>>;
  models?: Readonly<{ whisperRevision?: string; labseRevision?: string }>;
}

/** Implemented by the separate VAD + ASR + LaBSE runtime, never by request handling. */
export interface SynchronizationEvidenceEngine {
  generate(input: SynchronizationEvidenceEngineInput, signal?: AbortSignal): Promise<SynchronizationEvidenceEngineOutput>;
}

export interface CalibratedSynchronizationWorkerOptions {
  provider: SubtitleProvider;
  mediaProbe: MediaProbe;
  audioExtractor: AudioExtractor;
  evidenceEngine: SynchronizationEvidenceEngine;
  extractionOptions?: Readonly<AudioExtractionOptions>;
  now?: () => number;
}

/**
 * Pre-production lifecycle boundary. It acquires real subtitle/media inputs and
 * delegates evidence discovery to the standalone model runtime. The only result
 * path is calibrated model selection; legacy estimation is not imported.
 */
export class CalibratedSynchronizationWorker implements SynchronizationWorker {
  private readonly now: () => number;

  constructor(private readonly options: CalibratedSynchronizationWorkerOptions) {
    this.now = options.now ?? Date.now;
  }

  async process(task: SynchronizationTask, context: SynchronizationWorkerContext = {}): Promise<SynchronizationResult> {
    this.validateTask(task);
    throwIfAborted(context.signal);

    const subtitle = await this.options.provider.download(task.providerReference);
    throwIfAborted(context.signal);
    if (!subtitle.contentType.toLowerCase().startsWith('text/vtt')) {
      throw new Error('Synchronization worker requires a WebVTT subtitle.');
    }
    const cues = parseWebVttCues(subtitle.content);
    if (cues.length === 0) throw new Error('Synchronization worker subtitle contains no cues.');

    const media = await this.options.mediaProbe.probe(task.mediaSource);
    throwIfAborted(context.signal);
    if (!media.hasAudio || media.audioStreams.length === 0) {
      throw new MediaProbeError('invalid_source', 'Synchronization media does not contain audio.');
    }
    const durationMs = media.durationMs;
    if (!Number.isSafeInteger(durationMs) || durationMs === undefined || durationMs <= 0) {
      throw new MediaProbeError('malformed_output', 'Synchronization media duration is required.');
    }

    const audio = await this.options.audioExtractor.extract(
      task.mediaSource,
      this.options.extractionOptions
    );
    throwIfAborted(context.signal);
    const generated = await this.options.evidenceEngine.generate({
      task: structuredClone(task),
      cues: structuredClone(cues),
      media: structuredClone(media),
      audio: structuredClone(audio)
    }, context.signal);
    context.reportMetrics?.({
      evidenceEngineDurationMs: generated.metrics?.totalSeconds !== undefined
        ? generated.metrics.totalSeconds * 1_000
        : undefined,
      asrDurationMs: generated.metrics?.asrSeconds !== undefined
        ? generated.metrics.asrSeconds * 1_000
        : undefined,
      whisperRevision: generated.models?.whisperRevision,
      labseRevision: generated.models?.labseRevision
    });
    const createdAt = this.currentTime();
    const output = buildCalibratedSynchronizationResult({
      taskId: task.id,
      evidence: generated.evidence,
      sourceDurationMs: durationMs,
      evidenceConfidence: generated.confidence,
      evidenceMethod: generated.method,
      createdAt,
      expiresAt: task.expiresAt
    });
    return output.result;
  }

  private validateTask(task: SynchronizationTask): void {
    const now = this.currentTime();
    if (task.status !== 'processing') {
      throw new Error('Synchronization worker requires a processing task.');
    }
    if (task.provider !== this.options.provider.name) {
      throw new Error('Synchronization worker provider does not match the task.');
    }
    if (task.expiresAt <= now) throw new Error('Synchronization worker task has expired.');
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Current time is invalid.');
    return value;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Synchronization worker was cancelled.', 'AbortError');
}
