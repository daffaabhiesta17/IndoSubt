import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { MediaSourceResolver } from '../src/media/source-resolver.js';
import type { SubtitleProvider } from '../src/subtitles/provider.js';
import { ProviderSubtitleService } from '../src/subtitles/service.js';
import {
  InMemorySynchronizationResultStore,
  InMemorySynchronizationTaskStore,
  SynchronizationReferenceCodec,
  type SynchronizationResult
} from '../src/subtitles/synchronization-context.js';
import { OrchestratedSynchronizationSubtitleDelivery } from '../src/subtitles/synchronization-delivery.js';
import {
  SynchronizationOrchestrator,
  type SynchronizationMappingPolicy
} from '../src/subtitles/synchronization-orchestrator.js';
import { createCachedSynchronizationTaskId } from '../src/subtitles/synchronization-job.js';

const now = 1_000_000;
const webvtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHalo';
const cachedTaskId = createCachedSynchronizationTaskId('opensubtitles', '42', 'https://media.example.com/movie.mp4');

function provider(): SubtitleProvider {
  return {
    name: 'opensubtitles',
    search: vi.fn().mockResolvedValue([]),
    download: vi.fn().mockResolvedValue({
      content: webvtt,
      contentType: 'text/vtt; charset=utf-8'
    })
  };
}

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

function setup(mappingEnabled: boolean) {
  const subtitleProvider = provider();
  const taskStore = new InMemorySynchronizationTaskStore();
  const resultStore = new InMemorySynchronizationResultStore();
  const sourceResolver: MediaSourceResolver = {
    resolve: vi.fn().mockResolvedValue({
      kind: 'remote-url',
      url: 'https://media.example.com/movie.mp4'
    })
  };
  const mappingPolicy: SynchronizationMappingPolicy | undefined = mappingEnabled
    ? { select: (stored) => stored.mapping }
    : undefined;
  const orchestrator = new SynchronizationOrchestrator({
    sourceResolver,
    taskStore,
    resultStore,
    referenceCodec: new SynchronizationReferenceCodec('test-secret', 'subtitle-vtt'),
    mappingPolicy,
    taskTtlMs: 60_000,
    now: () => now
  });
  const delivery = new OrchestratedSynchronizationSubtitleDelivery(
    subtitleProvider,
    orchestrator
  );
  const service = new ProviderSubtitleService(subtitleProvider, 'provider-secret');
  const app = createApp(service, { synchronizationDelivery: delivery });
  return { app, orchestrator, subtitleProvider };
}

async function taskReference(orchestrator: SynchronizationOrchestrator): Promise<string> {
  return (
    await orchestrator.createTask(
      { videoUrl: 'https://media.example.com/movie.mp4' },
      {
        provider: 'opensubtitles',
        reference: '42',
        language: 'id',
        fileName: 'movie.id.srt'
      }
    )
  ).reference;
}

describe('opt-in synchronization subtitle delivery', () => {
  it('does not expose the synchronization route in default production composition', async () => {
    const response = await request(createApp(new ProviderSubtitleService(provider(), 'secret'))).get(
      '/subtitles/synchronization/anything.vtt'
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ subtitles: [] });
  });

  it('preserves existing provider delivery while synchronization is disabled', async () => {
    const subtitleProvider = provider();
    const service = new ProviderSubtitleService(subtitleProvider, 'secret');
    const app = createApp(service);
    const searchProvider = subtitleProvider.search as ReturnType<typeof vi.fn>;
    searchProvider.mockResolvedValue([
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const search = await request(app).get('/subtitles/movie/tt0133093.json');
    const response = await request(app).get(new URL(search.body.subtitles[0].url).pathname);
    expect(response.status).toBe(200);
    expect(response.text).toBe(webvtt);
  });

  it('serves original subtitle for a pending task (Opsi A fallback)', async () => {
    const context = setup(false);
    const reference = await taskReference(context.orchestrator);
    const pending = await request(context.app).get(
      `/subtitles/synchronization/${encodeURIComponent(reference)}.vtt`
    );
    expect(pending.status).toBe(200);
    expect(pending.text).toBe(webvtt);
    expect(context.subtitleProvider.download).toHaveBeenCalledWith('42');

    await context.orchestrator.completeTask(reference, result());
    const completed = await request(context.app).get(
      `/subtitles/synchronization/${encodeURIComponent(reference)}.vtt`
    );
    expect(completed.status).toBe(200);
    expect(completed.text).toBe(webvtt);
  });

  it('applies an explicitly enabled mapping from a completed validated result', async () => {
    const context = setup(true);
    const reference = await taskReference(context.orchestrator);
    await context.orchestrator.completeTask(reference, result());
    const response = await request(context.app).get(
      `/subtitles/synchronization/${encodeURIComponent(reference)}.vtt`
    );
    expect(response.status).toBe(200);
    expect(response.text).toContain('00:00:02.000 --> 00:00:03.000');
    expect(context.subtitleProvider.download).toHaveBeenCalledWith('42');
  });

  it.each(['tampered', 'wrong-purpose', 'unknown'])(
    'rejects %s synchronization references without leaking details',
    async (kind) => {
      const context = setup(true);
      const valid = await taskReference(context.orchestrator);
      const reference =
        kind === 'tampered'
          ? valid.replace(cachedTaskId, 'task_999')
          : kind === 'wrong-purpose'
            ? new SynchronizationReferenceCodec('test-secret', 'worker').issue({
    taskId: cachedTaskId,
                expiresAt: now + 60_000
              })
            : new SynchronizationReferenceCodec('test-secret', 'subtitle-vtt').issue({
                taskId: 'unknown',
                expiresAt: now + 60_000
              });
      const response = await request(context.app).get(
        `/subtitles/synchronization/${encodeURIComponent(reference)}.vtt`
      );
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toEqual({ error: 'Subtitle is temporarily unavailable.' });
    }
  );
});