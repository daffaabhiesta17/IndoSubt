import { describe, expect, it, vi } from 'vitest';
import type { SynchronizationResult, SynchronizationTask } from '../src/subtitles/synchronization-context.js';
import {
  UpstashSynchronizationResultStore,
  UpstashSynchronizationTaskStore,
  type UpstashRedisOptions
} from '../src/subtitles/upstash-synchronization-store.js';

const now = 1_000_000;

function task(status: SynchronizationTask['status'] = 'pending'): SynchronizationTask {
  return {
    id: 'task_123',
    mediaSource: { kind: 'remote-url', url: 'https://media.example.com/movie.mp4' },
    provider: 'opensubtitles', providerReference: '42', language: 'id', status,
    createdAt: now, expiresAt: now + 60_000
  };
}

function result(overrides: Partial<SynchronizationResult> = {}): SynchronizationResult {
  return {
    taskId: 'task_123',
    points: [{ sourceMs: 1_000, referenceMs: 2_000 }, { sourceMs: 3_000, referenceMs: 4_000 }],
    confidence: 0.9, method: 'preconstructed-test-result',
    createdAt: now, expiresAt: now + 30_000, ...overrides
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function options(fetchMock: ReturnType<typeof vi.fn>): UpstashRedisOptions {
  return { url: 'https://example.upstash.io', token: 'test-token', fetch: fetchMock as typeof fetch };
}

function commandAt(fetchMock: ReturnType<typeof vi.fn>, index = 0): string[] {
  return JSON.parse(fetchMock.mock.calls[index][1].body as string) as string[];
}

describe('Upstash durable synchronization stores', () => {
  it('creates isolated task and result keys with absolute Redis expiry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ result: 'OK' }))
      .mockResolvedValueOnce(response({ result: 'ok' }));
    await new UpstashSynchronizationTaskStore(options(fetchMock)).create(task());
    await new UpstashSynchronizationResultStore(options(fetchMock)).create(result());

    expect(commandAt(fetchMock, 0)).toEqual([
      'SET', 'indosync:synchronization:v1:task:task_123', JSON.stringify(task()),
      'NX', 'PXAT', String(task().expiresAt)
    ]);
    expect(commandAt(fetchMock, 1).slice(0, 5)).toEqual([
      'EVAL', expect.any(String), '2',
      'indosync:synchronization:v1:task:task_123',
      'indosync:synchronization:v1:result:task_123'
    ]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('rejects duplicate conditional creates', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ result: null }))
      .mockResolvedValueOnce(response({ result: 'duplicate' }));
    await expect(new UpstashSynchronizationTaskStore(options(fetchMock)).create(task()))
      .rejects.toThrow('already exists');
    await expect(new UpstashSynchronizationResultStore(options(fetchMock)).create(result()))
      .rejects.toThrow('already completed');
  });

  it('reads and validates independently namespaced task and result values', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ result: JSON.stringify(task()) }))
      .mockResolvedValueOnce(response({ result: JSON.stringify(result()) }))
      .mockResolvedValueOnce(response({ result: null }));
    const taskStore = new UpstashSynchronizationTaskStore(options(fetchMock));
    const resultStore = new UpstashSynchronizationResultStore(options(fetchMock));
    await expect(taskStore.get('task_123')).resolves.toEqual(task());
    await expect(resultStore.get('task_123')).resolves.toEqual(result());
    await expect(taskStore.get('missing')).resolves.toBeNull();
    expect(commandAt(fetchMock, 0)[1]).toContain(':task:task_123');
    expect(commandAt(fetchMock, 1)[1]).toContain(':result:task_123');
  });

  it('rejects malformed IDs before constructing Redis keys', async () => {
    const fetchMock = vi.fn();
    const taskStore = new UpstashSynchronizationTaskStore(options(fetchMock));
    const resultStore = new UpstashSynchronizationResultStore(options(fetchMock));
    await expect(taskStore.get('task:escape')).rejects.toThrow('id is invalid');
    await expect(resultStore.get('../task')).rejects.toThrow('id is invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses a Lua CAS for pending to processing', async () => {
    const processing = task('processing');
    const fetchMock = vi.fn().mockResolvedValue(response({ result: JSON.stringify(processing) }));
    const store = new UpstashSynchronizationTaskStore(options(fetchMock));
    await expect(store.transition?.('task_123', 'pending', 'processing', now)).resolves.toEqual(processing);
    const command = commandAt(fetchMock);
    expect(command[0]).toBe('EVAL');
    expect(command[1]).toContain("task.status ~= ARGV[2]");
    expect(command.slice(-4)).toEqual(['task_123', 'pending', 'processing', String(now)]);
  });

  it('atomically creates a result and transitions processing to completed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ result: 'ok' }));
    const store = new UpstashSynchronizationResultStore(options(fetchMock));
    await store.complete?.(task('processing'), result(), now);
    const command = commandAt(fetchMock);
    expect(command[0]).toBe('EVAL');
    expect(command[1]).toContain("redis.call('EXISTS', KEYS[2])");
    expect(command[1]).toContain("task.status = 'completed'");
    expect(command[2]).toBe('2');
    expect(command[3]).toContain(':task:task_123');
    expect(command[4]).toContain(':result:task_123');
  });

  it.each([
    ['duplicate', 'already completed'],
    ['wrong-task', 'does not match'],
    ['invalid-state:pending', 'state transition'],
    ['expired', 'not found'],
    ['invalid-expiry', 'outside the task lifetime']
  ])('maps atomic completion rejection %s to a controlled error', async (code, message) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ result: code }));
    await expect(new UpstashSynchronizationResultStore(options(fetchMock)).complete?.(
      task('processing'), result(), now
    )).rejects.toThrow(message);
  });

  it('does not expose credentials in Redis/server errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: 'secret backend detail' }));
    await expect(new UpstashSynchronizationTaskStore(options(fetchMock)).get('task_123'))
      .rejects.toThrow('command failed');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('requires explicit credentials and rejects insecure endpoints', () => {
    expect(() => UpstashSynchronizationTaskStore.fromEnvironment({})).toThrow('required');
    expect(() => new UpstashSynchronizationTaskStore({ url: 'http://example.com', token: 'x' }))
      .toThrow('HTTPS');
  });
});






