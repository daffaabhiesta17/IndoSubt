import { describe, expect, it } from 'vitest';
import {
  InMemorySynchronizationResultStore,
  InMemorySynchronizationTaskStore,
  SynchronizationReferenceCodec,
  validateSynchronizationResult,
  type SynchronizationResult,
  type SynchronizationTask
} from '../src/subtitles/synchronization-context.js';

const now = 1_000_000;

function task(overrides: Partial<SynchronizationTask> = {}): SynchronizationTask {
  return {
    id: 'task_123',
    mediaSource: { kind: 'remote-url', url: 'https://media.example.com/movie.mp4' },
    provider: 'opensubtitles',
    providerReference: '42',
    language: 'id',
    status: 'pending',
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides
  };
}

function result(overrides: Partial<SynchronizationResult> = {}): SynchronizationResult {
  return {
    taskId: 'task_123',
    points: [
      { sourceMs: 1_000, referenceMs: 2_000 },
      { sourceMs: 5_000, referenceMs: 6_000 }
    ],
    confidence: 0.9,
    method: 'fixture-alignment',
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides
  };
}

describe('synchronization context stores', () => {
  it('creates and retrieves an isolated task copy', async () => {
    const store = new InMemorySynchronizationTaskStore();
    const original = task();
    await store.create(original);
    original.status = 'rejected';
    expect(await store.get('task_123')).toEqual(task());
    expect(await store.get('missing')).toBeNull();
    await expect(store.create(task())).rejects.toThrow('already exists');
  });

  it('stores and retrieves an isolated result copy', async () => {
    const store = new InMemorySynchronizationResultStore();
    const original = result();
    await store.create(original);
    original.confidence = 0;
    expect(await store.get('task_123')).toEqual(result());
    expect(await store.get('missing')).toBeNull();
  });
});

describe('versioned synchronization references', () => {
  it('round-trips an opaque task id with purpose and expiry binding', () => {
    const codec = new SynchronizationReferenceCodec('secret', 'subtitle-vtt');
    const encoded = codec.issue({ taskId: 'task_123', expiresAt: now + 10_000 });
    expect(encoded).toMatch(/^v2\./);
    expect(encoded).not.toContain('media.example.com');
    expect(codec.verify(encoded, now)).toEqual({ taskId: 'task_123', expiresAt: now + 10_000 });
  });

  it('rejects tampering, expiry, and wrong purpose', () => {
    const codec = new SynchronizationReferenceCodec('secret', 'subtitle-vtt');
    const encoded = codec.issue({ taskId: 'task_123', expiresAt: now + 10_000 });
    const tampered = encoded.replace('task_123', 'task_999');
    expect(() => codec.verify(tampered, now)).toThrow('Invalid synchronization reference');
    expect(() => codec.verify(encoded, now + 10_000)).toThrow('expired');
    expect(() => new SynchronizationReferenceCodec('secret', 'worker').verify(encoded, now)).toThrow(
      'purpose'
    );
  });
});

describe('synchronization result validation', () => {
  it('accepts monotonic evidence and a finite linear mapping', () => {
    expect(() =>
      validateSynchronizationResult(
        result({ mapping: { scale: 1, offsetMs: 1_000, confidence: 0.9, pointsUsed: 2 } })
      )
    ).not.toThrow();
  });

  it.each([
    { confidence: Number.NaN },
    { confidence: -0.1 },
    { confidence: 1.1 },
    { points: [{ sourceMs: 1_000, referenceMs: 2_000 }, { sourceMs: 1_000, referenceMs: 3_000 }] },
    { points: [{ sourceMs: 1_000, referenceMs: 2_000 }, { sourceMs: 2_000, referenceMs: 1_000 }] },
    { mapping: { scale: 0, offsetMs: 0, confidence: 1, pointsUsed: 2 } },
    { mapping: { scale: 1, offsetMs: Number.POSITIVE_INFINITY, confidence: 1, pointsUsed: 2 } },
    { mapping: { scale: 1, offsetMs: 0, confidence: 2, pointsUsed: 2 } }
  ])('rejects invalid synchronization results %o', (override) => {
    expect(() => validateSynchronizationResult(result(override as Partial<SynchronizationResult>))).toThrow();
  });
});