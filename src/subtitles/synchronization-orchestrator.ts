import type { MediaSourceResolver } from '../media/source-resolver.js';
import type { SubtitleCandidate, SubtitleRequestMetadata } from './types.js';
import type { SynchronizationMapping } from './synchronization.js';
import {
  createSynchronizationTaskId,
  SynchronizationReferenceCodec,
  type SynchronizationResult,
  type SynchronizationResultStore,
  type SynchronizationTask,
  type SynchronizationTaskStore,
  validateSynchronizationResult
} from './synchronization-context.js';

export interface SynchronizationWorker {
  process(task: SynchronizationTask): Promise<SynchronizationResult>;
}

export interface SynchronizationMappingPolicy {
  select(result: SynchronizationResult, now: number): SynchronizationMapping | undefined;
}

/** Default-off until evidence-quality thresholds are configured and approved. */
export class DisabledSynchronizationMappingPolicy implements SynchronizationMappingPolicy {
  select(): undefined {
    return undefined;
  }
}

export interface SynchronizationOrchestratorOptions {
  sourceResolver: MediaSourceResolver;
  taskStore: SynchronizationTaskStore;
  resultStore: SynchronizationResultStore;
  referenceCodec: SynchronizationReferenceCodec;
  mappingPolicy?: SynchronizationMappingPolicy;
  taskTtlMs?: number;
  now?: () => number;
  createTaskId?: () => string;
}

export interface CreatedSynchronizationTask {
  task: SynchronizationTask;
  reference: string;
}

export class SynchronizationOrchestrator {
  private readonly sourceResolver: MediaSourceResolver;
  private readonly taskStore: SynchronizationTaskStore;
  private readonly resultStore: SynchronizationResultStore;
  private readonly referenceCodec: SynchronizationReferenceCodec;
  private readonly mappingPolicy: SynchronizationMappingPolicy;
  private readonly taskTtlMs: number;
  private readonly now: () => number;
  private readonly createTaskId: () => string;

  constructor(options: SynchronizationOrchestratorOptions) {
    this.sourceResolver = options.sourceResolver;
    this.taskStore = options.taskStore;
    this.resultStore = options.resultStore;
    this.referenceCodec = options.referenceCodec;
    this.mappingPolicy = options.mappingPolicy ?? new DisabledSynchronizationMappingPolicy();
    this.taskTtlMs = positiveSafeInteger(options.taskTtlMs ?? 10 * 60_000, 'task TTL');
    this.now = options.now ?? Date.now;
    this.createTaskId = options.createTaskId ?? createSynchronizationTaskId;
  }

  async createTask(
    metadata: SubtitleRequestMetadata,
    candidate: SubtitleCandidate
  ): Promise<CreatedSynchronizationTask> {
    const source = await this.sourceResolver.resolve(metadata);
    if (!source) throw new Error('Synchronization task requires a trusted media source.');
    const createdAt = this.currentTime();
    const expiresAt = createdAt + this.taskTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error('Synchronization task expiry overflowed.');
    const task: SynchronizationTask = {
      id: this.createTaskId(),
      mediaSource: structuredClone(source),
      provider: candidate.provider,
      providerReference: candidate.reference,
      language: candidate.language,
      status: 'pending',
      createdAt,
      expiresAt
    };
    await this.taskStore.create(task);
    return {
      task: structuredClone(task),
      reference: this.referenceCodec.issue({ taskId: task.id, expiresAt })
    };
  }

  verifyReference(reference: string): { taskId: string; expiresAt: number } {
    return this.referenceCodec.verify(reference, this.currentTime());
  }

  async getTask(reference: string): Promise<SynchronizationTask | null> {
    const verified = this.verifyReference(reference);
    const task = await this.taskStore.get(verified.taskId);
    if (!task || task.expiresAt !== verified.expiresAt || task.expiresAt <= this.currentTime()) {
      return null;
    }
    return task;
  }

  async completeTask(reference: string, result: SynchronizationResult): Promise<void> {
    const task = await this.requireTask(reference);
    if (result.taskId !== task.id) throw new Error('Synchronization result task does not match.');
    validateSynchronizationResult(result);
    if (result.expiresAt > task.expiresAt || result.expiresAt <= this.currentTime()) {
      throw new Error('Synchronization result expiry is outside the task lifetime.');
    }
    await this.persistCompletion(task, result);
  }

  async process(reference: string, worker: SynchronizationWorker): Promise<SynchronizationResult> {
    const task = await this.requireTask(reference);
    if (task.status !== 'pending') throw new Error('Synchronization task is not pending.');
    const processingTask = this.taskStore.transition
      ? await this.taskStore.transition(task.id, 'pending', 'processing', this.currentTime())
      : { ...task, status: 'processing' as const };
    if (!this.taskStore.transition) await this.taskStore.update(processingTask);
    const result = await worker.process(structuredClone(processingTask));
    await this.completeProcessingTask(processingTask, result);
    return structuredClone(result);
  }

  async getResult(reference: string): Promise<SynchronizationResult | null> {
    const task = await this.getTask(reference);
    if (!task) return null;
    const result = await this.resultStore.get(task.id);
    if (!result || result.expiresAt <= this.currentTime()) return null;
    validateSynchronizationResult(result);
    return result;
  }

  async getMapping(reference: string): Promise<SynchronizationMapping | undefined> {
    const result = await this.getResult(reference);
    return result ? this.mappingPolicy.select(result, this.currentTime()) : undefined;
  }

  private async completeProcessingTask(
    task: SynchronizationTask,
    result: SynchronizationResult
  ): Promise<void> {
    if (result.taskId !== task.id) throw new Error('Synchronization result task does not match.');
    validateSynchronizationResult(result);
    if (result.expiresAt > task.expiresAt || result.expiresAt <= this.currentTime()) {
      throw new Error('Synchronization result expiry is outside the task lifetime.');
    }
    await this.persistCompletion(task, result);
  }

  private async persistCompletion(
    task: SynchronizationTask,
    result: SynchronizationResult
  ): Promise<void> {
    if (this.resultStore.complete) {
      await this.resultStore.complete(task, result, this.currentTime());
      return;
    }
    if (await this.resultStore.get(task.id)) throw new Error('Synchronization task is already completed.');
    await this.resultStore.create(result);
    await this.taskStore.update({ ...task, status: 'completed' });
  }
  private async requireTask(reference: string): Promise<SynchronizationTask> {
    const task = await this.getTask(reference);
    if (!task) throw new Error('Synchronization task was not found.');
    return task;
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Current time is invalid.');
    return value;
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Synchronization ${label} must be a positive safe integer.`);
  }
  return value;
}

