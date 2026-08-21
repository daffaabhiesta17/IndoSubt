import { createStagingSynchronizationComposition } from './subtitles/synchronization-staging-composition.js';

const composition = await createStagingSynchronizationComposition(process.env, {
  provider: { name: 'opensubtitles', search: async () => [], download: async () => ({ content: '', contentType: 'text/vtt; charset=utf-8' }) } as any,
  mediaProbe: { probe: async () => ({ durationMs: 0, hasAudio: true, audioStreams: [] }) } as any,
  audioExtractor: { extract: async () => ({ contentType: 'audio/wav', sampleRateHz: 16000, channels: 1, bytes: new Uint8Array() }) } as any,
  sourceResolver: { resolve: async () => undefined } as any
});

if (!composition) {
  console.log('Staging not enabled — check env');
  process.exit(1);
}

console.log(JSON.stringify({ event: 'logs_started', namespace: composition.namespace }));
setInterval(async () => {
  try {
    const idx = await composition.store.indexMembers();
    const queued = idx.queued.length;
    const processing = idx.processing.length;
    if (queued === 0 && processing === 0) {
      console.log(JSON.stringify({ at: new Date().toISOString(), queued, processing }));
      return;
    }
    for (const id of [...idx.queued, ...idx.processing].slice(0, 5)) {
      const job = await composition.store.get(id);
      if (!job) continue;
      let host: string | undefined;
      try { host = new URL(job.task.mediaSource.url).hostname; } catch { host = job.task.mediaSource.url.slice(0, 40); }
      console.log(JSON.stringify({
        at: new Date().toISOString(),
        jobId: job.id.slice(0, 8),
        state: job.state,
        attempt: job.attempt,
        videoHost: host
      }));
    }
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}, 3000);
