import { FfprobeMediaProbe } from './media/ffprobe.js';
import { FfmpegAudioExtractor } from './media/audio-extractor.js';
import { SpawnProcessRunner } from './media/process-runner.js';
import { TrustedMediaSourceResolver } from './media/source-resolver.js';
import { parseAllowedMediaHosts, RemoteMediaUrlPolicy } from './media/url-policy.js';
import { createApp } from './app.js';
import { OpenSubtitlesProvider } from './subtitles/providers/opensubtitles.js';
import { FixtureSubtitleService, ProviderSubtitleService } from './subtitles/service.js';
import { createStagingSynchronizationComposition } from './subtitles/synchronization-staging-composition.js';

const port = Number(process.env.PORT ?? 3000);
const apiKey = process.env.OPENSUBTITLES_API_KEY?.trim();
const subtitleService = apiKey
  ? new ProviderSubtitleService(
      new OpenSubtitlesProvider({
        apiKey,
        userAgent: process.env.OPENSUBTITLES_USER_AGENT ?? 'IndoSync/0.1.0'
      }),
      apiKey
    )
  : new FixtureSubtitleService();

const processRunner = new SpawnProcessRunner();
const urlPolicy = new RemoteMediaUrlPolicy({
  allowedHosts: parseAllowedMediaHosts(process.env.INDOSYNC_ALLOWED_MEDIA_HOSTS)
});
const composition = await createStagingSynchronizationComposition(process.env, {
  provider: apiKey
    ? new OpenSubtitlesProvider({
        apiKey,
        userAgent: process.env.OPENSUBTITLES_USER_AGENT ?? 'IndoSync/0.1.0'
      })
    : { name: 'opensubtitles', search: async () => [], download: async () => ({ content: '', contentType: 'text/vtt; charset=utf-8' }) },
  mediaProbe: new FfprobeMediaProbe({ runner: processRunner, urlPolicy }),
  audioExtractor: new FfmpegAudioExtractor({ runner: processRunner, urlPolicy }),
  sourceResolver: new TrustedMediaSourceResolver(urlPolicy)
});

const app = createApp(subtitleService, {
  stagingSynchronization: composition?.integration,
  synchronizationDelivery: composition?.integration.delivery
});

app.listen(port, () => {
  console.log(JSON.stringify({
    event: 'server_started',
    url: `http://localhost:${port}`,
    stagingOn: Boolean(composition)
  }));
});
