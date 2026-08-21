import { FfprobeMediaProbe } from './media/ffprobe.js';
import { FfmpegAudioExtractor } from './media/audio-extractor.js';
import { SpawnProcessRunner } from './media/process-runner.js';
import { TrustedMediaSourceResolver } from './media/source-resolver.js';
import { parseAllowedMediaHosts, RemoteMediaUrlPolicy } from './media/url-policy.js';
import { OpenSubtitlesProvider } from './subtitles/providers/opensubtitles.js';
import { consoleSynchronizationJobObserver } from './subtitles/synchronization-job-observability.js';
import { createStagingSynchronizationComposition } from './subtitles/synchronization-staging-composition.js';

const apiKey = process.env.OPENSUBTITLES_API_KEY?.trim();
if (!apiKey) {
  throw new Error('OPENSUBTITLES_API_KEY is required to run the synchronization poller.');
}

const runner = new SpawnProcessRunner();
const urlPolicy = new RemoteMediaUrlPolicy({
  allowedHosts: parseAllowedMediaHosts(process.env.INDOSYNC_ALLOWED_MEDIA_HOSTS)
});
const composition = await createStagingSynchronizationComposition(process.env, {
  provider: new OpenSubtitlesProvider({
    apiKey,
    userAgent: process.env.OPENSUBTITLES_USER_AGENT ?? 'IndoSync/0.1.0'
  }),
  mediaProbe: new FfprobeMediaProbe({ runner, urlPolicy }),
  audioExtractor: new FfmpegAudioExtractor({ runner, urlPolicy }),
  sourceResolver: new TrustedMediaSourceResolver(urlPolicy),
  observer: consoleSynchronizationJobObserver
});

if (!composition) {
  throw new Error('Staging synchronization is not enabled in this environment.');
}

const controller = new AbortController();
process.on('SIGINT', () => {
  composition.runner.requestShutdown();
  controller.abort();
});
process.on('SIGTERM', () => {
  composition.runner.requestShutdown();
  controller.abort();
});

console.log(JSON.stringify({
  event: 'poller_started',
  environment: composition.environment,
  namespace: composition.namespace
}));
await composition.store.recoverStale(Date.now());
await composition.runner.runPolling(controller.signal);
