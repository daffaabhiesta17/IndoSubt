import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FfprobeMediaProbe } from '../src/media/ffprobe.js';
import { FfmpegAudioExtractor } from '../src/media/audio-extractor.js';
import { SpawnProcessRunner } from '../src/media/process-runner.js';
import { TrustedMediaSourceResolver } from '../src/media/source-resolver.js';
import { parseAllowedMediaHosts, RemoteMediaUrlPolicy } from '../src/media/url-policy.js';
import { createApp, type AppOptions } from '../src/app.js';
import { OpenSubtitlesProvider } from '../src/subtitles/providers/opensubtitles.js';
import { FixtureSubtitleService, ProviderSubtitleService, type SubtitleService } from '../src/subtitles/service.js';
import { createStagingSynchronizationComposition } from '../src/subtitles/synchronization-staging-composition.js';

let optionsPromise: Promise<AppOptions> | undefined;

async function buildOptions(): Promise<AppOptions> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY?.trim();
  const provider = apiKey
    ? new OpenSubtitlesProvider({
        apiKey,
        userAgent: process.env.OPENSUBTITLES_USER_AGENT ?? 'IndoSync/0.1.0'
      })
    : undefined;
  const subtitleService: SubtitleService = provider
    ? new ProviderSubtitleService(provider, apiKey!)
    : new FixtureSubtitleService();

  const composition = await createStagingSynchronizationComposition(process.env, {
    provider: provider ?? {
      name: 'opensubtitles',
      search: async () => [],
      download: async () => ({ content: '', contentType: 'text/vtt; charset=utf-8' })
    },
    mediaProbe: new FfprobeMediaProbe({
      runner: new SpawnProcessRunner(),
      urlPolicy: new RemoteMediaUrlPolicy({ allowedHosts: parseAllowedMediaHosts(process.env.INDOSYNC_ALLOWED_MEDIA_HOSTS) })
    }),
    audioExtractor: new FfmpegAudioExtractor({
      runner: new SpawnProcessRunner(),
      urlPolicy: new RemoteMediaUrlPolicy({ allowedHosts: parseAllowedMediaHosts(process.env.INDOSYNC_ALLOWED_MEDIA_HOSTS) })
    }),
    sourceResolver: new TrustedMediaSourceResolver(
      new RemoteMediaUrlPolicy({ allowedHosts: parseAllowedMediaHosts(process.env.INDOSYNC_ALLOWED_MEDIA_HOSTS) })
    )
  });

  return {
    stagingSynchronization: composition?.integration,
    synchronizationDelivery: composition?.integration.delivery
  };
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (!optionsPromise) optionsPromise = buildOptions();
  const options = await optionsPromise;
  const app = createApp(undefined, options);
  app(request, response);
}
