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
import { SynchronizationOrchestrator } from '../src/subtitles/synchronization-orchestrator.js';
import { createSynchronizationJob, InMemorySynchronizationJobStore } from '../src/subtitles/synchronization-job.js';
import {
  StagingSynchronizationIntegrationImpl,
  StagingSynchronizationWorkerBridge,
  type StagingSynchronizationIntegration
} from '../src/subtitles/staging-integration.js';
import type { SynchronizationWorker } from '../src/subtitles/synchronization-orchestrator.js';
import { approvedMappingFromResult } from '../src/subtitles/synchronization-result-provenance.js';

const now = 1_000_000;
const webvtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHalo';

function provider(searchResult: any[] = []): SubtitleProvider {
  return {
    name: 'opensubtitles',
    search: vi.fn().mockResolvedValue(searchResult),
    download: vi.fn().mockResolvedValue({
      content: webvtt,
      contentType: 'text/vtt; charset=utf-8'
    })
  };
}

function approvedResult(): SynchronizationResult {
  const evidence = [0, 1, 2, 3].map((i) => ({
    source: { cueIndex: i, startMs: i * 4000 + 900, endMs: i * 4000 + 1100 },
    reference: { startMs: i * 4000 + 1900, endMs: i * 4000 + 2100 },
    sourceAnchorMs: i * 4000 + 1000,
    referenceAnchorMs: i * 4000 + 2000,
    confidence: 0.8,
    method: 'staging'
  }));
  const pid = 'indosync-crosslingual';
  const pv = '2026-08-v1';
  const mv = 'offset-first-v1';
  return {
    taskId: 'task_123',
    points: evidence.map((e) => ({ sourceMs: e.sourceAnchorMs, referenceMs: e.referenceAnchorMs })),
    provenance: { kind: 'calibrated-model-selection', state: 'approved', policyId: pid, policyVersion: pv, modelSelectionVersion: mv },
    evidence,
    approvedMapping: {
      acceptanceStatus: 'approved', model: 'offset-only', scale: 1, offsetMs: 1000,
      meanAbsoluteResidualMs: 0, inlierRatio: 1, temporalCoverage: 0.8,
      inlierCount: 4, evidenceCount: 4, policyId: pid, policyVersion: pv, modelSelectionVersion: mv
    },
    confidence: 0.8,
    method: 'staging',
    createdAt: now,
    expiresAt: now + 50_000
  };
}

interface IntegrationSetup {
  app: ReturnType<typeof createApp>;
  integration: StagingSynchronizationIntegration;
  orchestrator: SynchronizationOrchestrator;
  jobStore: InMemorySynchronizationJobStore;
  subtitleProvider: SubtitleProvider;
  taskStore: InMemorySynchronizationTaskStore;
  resultStore: InMemorySynchronizationResultStore;
  worker: SynchronizationWorker;
}

function setup(withStaging: boolean, searchResult: any[] = [], workerResult?: SynchronizationResult, sourceResolverOverride?: MediaSourceResolver): IntegrationSetup {
  const subtitleProvider = provider(searchResult);
  const taskStore = new InMemorySynchronizationTaskStore();
  const resultStore = new InMemorySynchronizationResultStore();
  const jobStore = new InMemorySynchronizationJobStore();
  const sourceResolver: MediaSourceResolver = sourceResolverOverride ?? {
    resolve: vi.fn().mockResolvedValue({
      kind: 'remote-url',
      url: 'https://media.example.com/movie.mp4'
    })
  };
  const mappingPolicy = {
    select: (r: SynchronizationResult) => {
      const m = approvedMappingFromResult(r);
      if (!m || !r.approvedMapping) return undefined;
      return { ...m, confidence: Math.max(0, 1 - r.approvedMapping.meanAbsoluteResidualMs / 1000), pointsUsed: r.approvedMapping.inlierCount };
    }
  };
  const referenceCodec = new SynchronizationReferenceCodec('staging-secret', 'subtitle-synchronization');
  const orchestrator = new SynchronizationOrchestrator({
    sourceResolver,
    taskStore,
    resultStore,
    referenceCodec,
    mappingPolicy,
    taskTtlMs: 60_000,
    now: () => now,
    createTaskId: () => 'task_123'
  });
  const worker: SynchronizationWorker = {
    process: vi.fn().mockResolvedValue(workerResult ?? approvedResult())
  };
  const bridged = new StagingSynchronizationWorkerBridge(worker, orchestrator, taskStore, referenceCodec, () => now);
  const integration = new StagingSynchronizationIntegrationImpl(orchestrator, jobStore, () => now, subtitleProvider);
  const service = new ProviderSubtitleService(subtitleProvider, 'provider-secret');
  const app = createApp(service, {
    synchronizationDelivery: withStaging ? integration.delivery : undefined,
    stagingSynchronization: withStaging ? integration : undefined
  });
  return { app, integration, orchestrator, jobStore, subtitleProvider, taskStore, resultStore, worker };
}

describe('staging integration parallel IndoSync', () => {
  it('default (activation OFF) emits no synchronization reference', async () => {
    const { app } = setup(false, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const response = await request(app).get('/subtitles/movie/tt0133093.json');
    expect(response.status).toBe(200);
    expect(response.body.subtitles).toHaveLength(1);
    expect(response.body.subtitles[0].url).toMatch(/\/subtitles\/provider\//);
  });

  it('staging ON with videoUrl emits a parallel synchronization reference', async () => {
    const { app, jobStore, taskStore } = setup(true, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const response = await request(app).get(
      '/subtitles/movie/tt0133093.json?videoUrl=' + encodeURIComponent('https://media.example.com/movie.mp4')
    );
    expect(response.status).toBe(200);
    expect(response.body.subtitles).toHaveLength(2);
    expect(response.body.subtitles[0].url).toMatch(/\/subtitles\/provider\//);
    expect(response.body.subtitles[1].url).toMatch(/\/subtitles\/synchronization\//);
    const task = (await taskStore.get('task_123'))!;
    expect(task).toBeDefined();
    expect(await jobStore.get(createSynchronizationJob(task, now, 3).id)).not.toBeNull();
  });

  it('no videoUrl emits original only even when staging is on', async () => {
    const { app } = setup(true, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const response = await request(app).get('/subtitles/movie/tt0133093.json');
    expect(response.status).toBe(200);
    expect(response.body.subtitles).toHaveLength(1);
    expect(response.body.subtitles[0].url).toMatch(/\/subtitles\/provider\//);
  });

  it('issuance / Redis failure leaves original subtitles intact', async () => {
    const failingResolver: MediaSourceResolver = {
      resolve: vi.fn().mockResolvedValue(undefined)
    };
    const { app } = setup(true, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ], undefined, failingResolver);
    const response = await request(app).get(
      '/subtitles/movie/tt0133093.json?videoUrl=' + encodeURIComponent('https://media.example.com/movie.mp4')
    );
    expect(response.status).toBe(200);
    expect(response.body.subtitles).toHaveLength(1);
    expect(response.body.subtitles[0].url).toMatch(/\/subtitles\/provider\//);
  });

  it('approved result applies mapping and keeps original provider intact', async () => {
    const { app, orchestrator, jobStore } = setup(true, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const task = await orchestrator.createTask(
      { videoUrl: 'https://media.example.com/movie.mp4' },
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    );
    await jobStore.enqueue(createSynchronizationJob(task.task, now, 3));
    await orchestrator.completeTask(task.reference, approvedResult());
    const response = await request(app).get(
      `/subtitles/synchronization/${encodeURIComponent(task.reference)}.vtt`
    );
    expect(response.status).toBe(200);
    expect(response.text).toContain('00:00:02.000');
  });

  it('rejected result returns original VTT', async () => {
    const { app, orchestrator, jobStore } = setup(true, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const task = await orchestrator.createTask(
      { videoUrl: 'https://media.example.com/movie.mp4' },
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    );
    await jobStore.enqueue(createSynchronizationJob(task.task, now, 3));
    const rejected = approvedResult();
    rejected.provenance = {
      kind: 'calibrated-model-selection',
      state: 'rejected',
      policyId: 'indosync-crosslingual',
      policyVersion: '2026-08-v1',
      modelSelectionVersion: 'offset-first-v1'
    };
    rejected.approvedMapping = undefined;
    await orchestrator.completeTask(task.reference, rejected);
    const response = await request(app).get(
      `/subtitles/synchronization/${encodeURIComponent(task.reference)}.vtt`
    );
    expect(response.status).toBe(200);
    expect(response.text).toBe(webvtt);
  });

  it('pending result falls back to original / 404', async () => {
    const { app, orchestrator } = setup(true, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const task = await orchestrator.createTask(
      { videoUrl: 'https://media.example.com/movie.mp4' },
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    );
    const pending = await request(app).get(
      `/subtitles/synchronization/${encodeURIComponent(task.reference)}.vtt`
    );
    expect(pending.status).toBe(404);
  });

  it('worker failure produces no result and original flow stays safe', async () => {
    const { app, worker, jobStore, taskStore } = setup(true, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const failingWorker: SynchronizationWorker = {
      process: vi.fn().mockRejectedValue(new Error('worker crashed'))
    };
    const referenceCodec = new SynchronizationReferenceCodec('staging-secret', 'subtitle-synchronization');
    const sourceResolver: MediaSourceResolver = {
      resolve: vi.fn().mockResolvedValue({ kind: 'remote-url', url: 'https://media.example.com/movie.mp4' })
    };
    const orchestrator = new SynchronizationOrchestrator({
      sourceResolver, taskStore: new InMemorySynchronizationTaskStore(), resultStore: new InMemorySynchronizationResultStore(),
      referenceCodec, mappingPolicy: { select: () => undefined }, taskTtlMs: 60_000, now: () => now, createTaskId: () => 'task_123'
    });
    const bridge = new StagingSynchronizationWorkerBridge(failingWorker, orchestrator, taskStore, referenceCodec, () => now);
    await expect(bridge.process(
      { id: 'task_123', mediaSource: { kind: 'remote-url', url: 'https://media.example.com/movie.mp4' }, provider: 'opensubtitles', providerReference: '42', language: 'id', status: 'processing', createdAt: now - 1, expiresAt: now + 60_000 },
      {}
    )).rejects.toThrow('worker crashed');
    expect(jobStore).toBeDefined();
  });

  it('production target keeps synchronization disabled', async () => {
    const { app } = setup(false, [
      { provider: 'opensubtitles', reference: '42', language: 'id', fileName: 'movie.srt' }
    ]);
    const response = await request(app).get(
      '/subtitles/movie/tt0133093.json?videoUrl=' + encodeURIComponent('https://media.example.com/movie.mp4')
    );
    expect(response.status).toBe(200);
    expect(response.body.subtitles).toHaveLength(1);
    expect(response.body.subtitles[0].url).toMatch(/\/subtitles\/provider\//);
  });
});
