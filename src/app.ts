import express, { type Request } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAddon } from './addon.js';
import { ProviderError } from './subtitles/provider.js';
import { OpenSubtitlesProvider } from './subtitles/providers/opensubtitles.js';
import {
  FixtureSubtitleService,
  ProviderSubtitleService,
  type SubtitleService
} from './subtitles/service.js';
import type { SynchronizationSubtitleDelivery } from './subtitles/synchronization-delivery.js';
import type { StagingSynchronizationIntegration } from './subtitles/staging-integration.js';
import { transformWebVtt } from './subtitles/webvtt.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(currentDirectory, '../public');
const maxExtraLength = 4_096;
const maxExtraFields = 16;
const maxExtraFieldLength = 1_024;
const maxVideoUrlLength = 2_048;

function requestOrigin(request: Request): string {
  const protocol = request.header('x-forwarded-proto') ?? request.protocol;
  const host = request.header('x-forwarded-host') ?? request.header('host');

  if (!host) {
    throw new Error('Host header is required to build subtitle URL.');
  }

  return `${protocol}://${host}`;
}

function firstParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function subtitleExtra(request: express.Request): Record<string, string> {
  const extra: Record<string, string> = {};
  const pathExtra = firstParameter(request.params.extra);

  if (pathExtra && pathExtra.length <= maxExtraLength) {
    let fields = 0;
    for (const [key, value] of new URLSearchParams(pathExtra)) {
      if (fields >= maxExtraFields) break;
      if (!key || key.length > maxExtraFieldLength) continue;
      extra[key] = value.slice(0, maxExtraFieldLength);
      fields += 1;
    }
  }

  const filename = request.query.filename;
  if (typeof filename === 'string') {
    extra.filename = filename.slice(0, maxExtraFieldLength);
  }

  const videoUrl = request.query.videoUrl;
  if (typeof videoUrl === 'string') {
    extra.videoUrl = videoUrl.slice(0, maxVideoUrlLength);
  }

  // Only known metadata crosses the HTTP boundary. Values remain inert here;
  // URL validation and DNS checks belong to TrustedMediaSourceResolver.
  return Object.fromEntries(
    Object.entries(extra)
      .filter(([key]) => key === 'filename' || key === 'videoSize' || key === 'videoUrl')
      .map(([key, value]) => [
        key,
        key === 'videoUrl' ? value.slice(0, maxVideoUrlLength) : value
      ])
  );
}

function serviceFromEnvironment(): SubtitleService {
  const apiKey = process.env.OPENSUBTITLES_API_KEY?.trim();
  if (!apiKey) {
    return new FixtureSubtitleService();
  }

  return new ProviderSubtitleService(
    new OpenSubtitlesProvider({
      apiKey,
      userAgent: process.env.OPENSUBTITLES_USER_AGENT ?? 'IndoSync/0.1.0'
    }),
    apiKey
  );
}

export interface AppOptions {
  synchronizationDelivery?: SynchronizationSubtitleDelivery;
  stagingSynchronization?: StagingSynchronizationIntegration;
}

export function createApp(
  subtitleService: SubtitleService = serviceFromEnvironment(),
  options: AppOptions = {}
) {
  const app = express();

  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }

    next();
  });

  app.use(express.static(publicDirectory));

  app.get('/manifest.json', (request, response) => {
    const addon = createAddon(requestOrigin(request), subtitleService);
    response.json(addon.manifest);
  });

  const handleSubtitleRequest = async (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction
  ) => {
    try {
      const addon = createAddon(requestOrigin(request), subtitleService);
      // Stremio extras are bounded metadata only. They are never interpreted
      // as paths, URLs, provider file IDs, or signed download references.
      const extra = subtitleExtra(request);
      const type = firstParameter(request.params.type) ?? '';
      const id = firstParameter(request.params.id) ?? '';
      const videoHost = (() => {
        try {
          return extra.videoUrl ? new URL(extra.videoUrl).hostname : undefined;
        } catch {
          return undefined;
        }
      })();
      console.log(JSON.stringify({
        event: 'stremio_subtitle_request',
        type,
        id,
        hasVideoUrl: Boolean(extra.videoUrl),
        videoHost,
        stagingOn: Boolean(options.stagingSynchronization)
      }));
      const result = await addon.get('subtitles', type, id, extra);
      const origin = requestOrigin(request);
      const primary = result.subtitles[0];
      const providerMatch = primary
        ? /\/subtitles\/provider\/(.+)\.vtt$/.exec(new URL(primary.url).pathname)
        : undefined;
      if (primary && providerMatch) {
        result.subtitles.push(
          {
            id: `${primary.id}-shift-minus-2000`,
            url: `${origin}/subtitles/shift/-2000/${providerMatch[1]}.vtt`,
            lang: 'ind'
          },
          {
            id: `${primary.id}-shift-plus-2000`,
            url: `${origin}/subtitles/shift/2000/${providerMatch[1]}.vtt`,
            lang: 'ind'
          }
        );
      }
      if (options.stagingSynchronization) {
        // IndoSync is an additive, asynchronous parallel subtitle reference.
        // Issuance is a fast Upstash write only; the GPU evidence engine runs
        // in a separate worker. Failures here must never alter the existing
        // OpenSubtitles response.
        const reference = await options.stagingSynchronization.issue(
          {
            filename: extra.filename,
            videoSize: extra.videoSize,
            videoUrl: extra.videoUrl
          },
          result.subtitles[0]
        );
        if (reference) {
          result.subtitles.push({
            id: `indosync-sync-${reference}`,
            url: `${origin}/subtitles/synchronization/${encodeURIComponent(reference)}.vtt`,
            lang: 'ind'
          });
        }
      }
      response.json(result);
    } catch (error) {
      next(error);
    }
  };

  app.get('/subtitles/:type/:id.json', handleSubtitleRequest);

  if (options.synchronizationDelivery) {
    app.get('/subtitles/synchronization/:reference.vtt', async (request, response) => {
      try {
        const subtitle = await options.synchronizationDelivery!.download(request.params.reference);
        response.type(subtitle.contentType).send(subtitle.content);
      } catch (error) {
        sendSubtitleError(response, error);
      }
    });
  }

  app.get('/subtitles/provider/:reference.vtt', async (request, response) => {
    try {
      const subtitle = await subtitleService.download(request.params.reference);
      response.type(subtitle.contentType).send(subtitle.content);
    } catch (error) {
      sendSubtitleError(response, error);
    }
  });

  app.get('/subtitles/shift/:offsetMs/:reference.vtt', async (request, response) => {
    try {
      const offsetMs = Number(request.params.offsetMs);
      if (!Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > 10_000) {
        response.status(400).json({ error: 'Invalid subtitle shift.' });
        return;
      }
      const subtitle = await subtitleService.download(request.params.reference);
      response.type(subtitle.contentType).send(transformWebVtt(subtitle.content, { offsetMs }));
    } catch (error) {
      sendSubtitleError(response, error);
    }
  });

  // Some Stremio clients omit `.json` and may serialize subtitle extras as
  // one query-string-shaped path segment. Keep these aliases after the signed
  // provider route so they cannot shadow or broaden subtitle file access.
  app.get('/subtitles/:type/:id/:extra', handleSubtitleRequest);
  app.get('/subtitles/:type/:id', handleSubtitleRequest);

  return app;
}


function sendSubtitleError(response: express.Response, error: unknown): void {
  const providerError = error instanceof ProviderError ? error : undefined;
  if (providerError?.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(providerError.retryAfterSeconds));
  }
  const status =
    providerError?.code === 'not_found' || providerError?.code === 'invalid_subtitle'
      ? 404
      : providerError?.code === 'rate_limited'
        ? 429
        : providerError?.code === 'timeout'
          ? 504
          : 502;
  response.status(status).json({ error: 'Subtitle is temporarily unavailable.' });
}

export const app = createApp();

// Vercel's Express preset discovers src/app.ts and requires the Express app
// itself to be the module's default export.
export default app;

