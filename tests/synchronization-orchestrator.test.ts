import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySynchronizationResultStore,
  InMemorySynchronizationTaskStore,
  SynchronizationReferenceCodec,
  type SynchronizationResult
} from '../src/subtitles/synchronization-context.js';
import {
  SynchronizationOrchestrator,
  type SynchronizationMappingPolicy,
  type SynchronizationWorker
} from '../src/subtitles/synchronization-orchestrator.js';
import { createCachedSynchronizationTaskId } from '../src/subtitles/synchronization-job.js';

const now = 1_000_000;
const source = { kind: 'remote-url', url: 'https://media.example.com/movie.mp4' } as const;
const cachedTaskId = createCachedSynchronizationTaskId('opensubtitles', '42', source.url);
const metadata = { videoUrl: source.url };
const candidate = {
  provider: 'opensubtitles',
  reference: '42',
  language: 'id' as const,
  fileName: 'movie.id.srt'
};

function result(overrides: Partial<SynchronizationResult> = {}): SynchronizationResult {
  return {
    taskId: cachedTaskId,
    points: [
      { sourceMs: 1_000, referenceMs: 2_000 },
      { sourceMs: 5_000, referenceMs: 6_000 }
    ],
    mapping: { scale: 1, offsetMs: 1_000, confidence: 1, pointsUsed: 2 },
    confidence: 1,
    method: 'preconstructed-test-result',
    createdAt: now,
    expiresAt: now + 30_000,
    ...overrides
  };
}

function setup(options: { purpose?: string; mappingPolicy?: SynchronizationMappingPolicy } = {}) {
  const taskStore = new InMemorySynchronizationTaskStore();
  const resultStore = new InMemorySynchronizationResultStore();
  const codec = new SynchronizationReferenceCodec('test-secret', options.purpose ?? 'subtitle-vtt');
  const sourceResolver = { resolve: vi.fn().mockResolvedValue(source) };
  const orchestrator = new SynchronizationOrchestrator({
    sourceResolver,
    taskStore,
    resultStore,
    referenceCodec: codec,
    mappingPolicy: options.mappingPolicy,
    taskTtlMs: 60_000,
    now: () => now
  });
  return { orchestrator, taskStore, resultStore, codec, sourceResolver };
}

describe('opt-in synchronization orchestration lifecycle', () => {
  it('rejects task creation when the trusted source resolver has no source', async () => {
    const context = setup();
    context.sourceResolver.resolve = vi.fn().mockResolvedValue(undefined);
    await expect(context.orchestrator.createTask({}, candidate)).rejects.toThrow(
      'requires a trusted media source'
    );
     expect(await context.taskStore.get(cachedTaskId)).toBeNull();
  });

  it('propagates source policy rejection before storing a task', async () => {
    const context = setup();
    context.sourceResolver.resolve = vi.fn().mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 'forbidden_source' })
    );
    await expect(context.orchestrator.createTask(metadata, candidate)).rejects.toMatchObject({
      code: 'forbidden_source'
    });
     expect(await context.taskStore.get(cachedTaskId)).toBeNull();
  });

  it('reuses the same cached task for the same video and subtitle pair', async () => {
    const { orchestrator } = setup();
    const first = await orchestrator.createTask(metadata, candidate);
    const second = await orchestrator.createTask(metadata, candidate);
    expect(second.task.id).toBe(first.task.id);
    expect(second.reference).toBe(first.reference);
  });

  it('creates an opaque task reference without embedding media or provider data', async () => {
    const { orchestrator } = setup();
    const created = await orchestrator.createTask(metadata, candidate);
    expect(created.task).toMatchObject({
      id: cachedTaskId,
      mediaSource: source,
      provider: 'opensubtitles',
      providerReference: '42',
      status: 'pending'
    });
    expect(created.reference).not.toContain(source.url);
    expect(created.reference).not.toContain('opensubtitles');
    expect(await orchestrator.getTask(created.reference)).toEqual(created.task);
  });

  it('processes a preconstructed test result through a fake worker', async () => {
    const { orchestrator } = setup();
    const { reference } = await orchestrator.createTask(metadata, candidate);
    const worker: SynchronizationWorker = { process: vi.fn().mockResolvedValue(result()) };
    await expect(orchestrator.process(reference, worker)).resolves.toEqual(result());
    expect(worker.process).toHaveBeenCalledWith(expect.objectContaining({ id: cachedTaskId }));
    await expect(orchestrator.getResult(reference)).resolves.toEqual(result());
    await expect(orchestrator.getTask(reference)).resolves.toMatchObject({ status: 'completed' });
  });

  it('keeps mapping selection disabled by default', async () => {
    const { orchestrator } = setup();
    const { reference } = await orchestrator.createTask(metadata, candidate);
    await orchestrator.completeTask(reference, result());
    await expect(orchestrator.getMapping(reference)).resolves.toBeUndefined();
  });

  it('allows an injected test policy to select an already-validated mapping', async () => {
    const mappingPolicy: SynchronizationMappingPolicy = {
      select: vi.fn((value) => value.mapping)
    };
    const { orchestrator } = setup({ mappingPolicy });
    const { reference } = await orchestrator.createTask(metadata, candidate);
    await orchestrator.completeTask(reference, result());
    await expect(orchestrator.getMapping(reference)).resolves.toEqual(result().mapping);
  });

  it('rejects tampered, expired, wrong-purpose, and unknown references', async () => {
    const { orchestrator } = setup();
    const { reference } = await orchestrator.createTask(metadata, candidate);
    await expect(orchestrator.getTask(reference.replace(cachedTaskId, 'task_999'))).rejects.toThrow();

    const expiredCodec = new SynchronizationReferenceCodec('test-secret', 'subtitle-vtt');
    const expired = expiredCodec.issue({ taskId: cachedTaskId, expiresAt: now });
    await expect(orchestrator.getTask(expired)).rejects.toThrow('expired');

    const wrongPurpose = new SynchronizationReferenceCodec('test-secret', 'worker').issue({
      taskId: cachedTaskId,
      expiresAt: now + 60_000
    });
    await expect(orchestrator.getTask(wrongPurpose)).rejects.toThrow('purpose');

    const unknown = new SynchronizationReferenceCodec('test-secret', 'subtitle-vtt').issue({
      taskId: 'unknown',
      expiresAt: now + 60_000
    });
    await expect(orchestrator.getTask(unknown)).resolves.toBeNull();
  });

  it('rejects wrong-task, expired, malformed, and duplicate results', async () => {
    const { orchestrator } = setup();
    const { reference } = await orchestrator.createTask(metadata, candidate);
    await expect(orchestrator.completeTask(reference, result({ taskId: 'other' }))).rejects.toThrow(
      'does not match'
    );
    await expect(orchestrator.completeTask(reference, result({ expiresAt: now }))).rejects.toThrow();
    await expect(
      orchestrator.completeTask(reference, result({ confidence: Number.NaN }))
    ).rejects.toThrow();
    await expect(
      orchestrator.completeTask(
        reference,
        result({ points: [{ sourceMs: 2_000, referenceMs: 3_000 }, { sourceMs: 1_000, referenceMs: 4_000 }] })
      )
    ).rejects.toThrow('monotonic');

    await orchestrator.completeTask(reference, result());
    await expect(orchestrator.completeTask(reference, result())).rejects.toThrow('already completed');
  });

  it('isolates task and result values returned to callers', async () => {
    const { orchestrator } = setup();
    const created = await orchestrator.createTask(metadata, candidate);
    created.task.status = 'rejected';
    expect((await orchestrator.getTask(created.reference))?.status).toBe('pending');

    const stored = result();
    await orchestrator.completeTask(created.reference, stored);
    stored.confidence = 0;
    const retrieved = await orchestrator.getResult(created.reference);
    expect(retrieved?.confidence).toBe(1);
    if (retrieved) retrieved.confidence = 0;
    expect((await orchestrator.getResult(created.reference))?.confidence).toBe(1);
  });
});