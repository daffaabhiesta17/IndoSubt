import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError, type SubtitleProvider } from './provider.js';
import {
  DeterministicSubtitleCandidateRanker,
  type SubtitleCandidateRanker
} from './ranker.js';
import { parseStremioSubtitleRequest } from './stremio-id.js';
import type {
  DownloadedSubtitle,
  SubtitleRequestContext,
  SubtitleRequestMetadata,
  SubtitleResponse
} from './types.js';
import {
  transformWebVtt,
  type WebVttTimestampMapping
} from './webvtt.js';

export interface SubtitleService {
  search(
    type: string,
    id: string,
    origin: string,
    metadata?: SubtitleRequestMetadata
  ): Promise<SubtitleResponse>;

  download(reference: string): Promise<DownloadedSubtitle>;
}

/**
 * Supplies a known timestamp mapping for a provider subtitle reference.
 *
 * Phase 3B does not calculate synchronization parameters. A caller that has
 * already determined a mapping can provide it through this interface.
 */
export interface SubtitleTimestampMappingResolver {
  resolve(
    providerReference: string
  ): WebVttTimestampMapping | Promise<WebVttTimestampMapping>;
}

const identityTimestampMappingResolver: SubtitleTimestampMappingResolver = {
  resolve: () => ({ scale: 1, offsetMs: 0 })
};

export class ProviderSubtitleService implements SubtitleService {
  constructor(
    private readonly provider: SubtitleProvider,
    private readonly referenceSecret: string,
    private readonly logger: Pick<Console, 'warn'> = console,
    private readonly ranker: SubtitleCandidateRanker =
      new DeterministicSubtitleCandidateRanker(),
    private readonly timestampMappingResolver: SubtitleTimestampMappingResolver =
      identityTimestampMappingResolver
  ) {
    if (!referenceSecret) {
      throw new Error('A reference signing secret is required.');
    }
  }

  async search(
    type: string,
    id: string,
    origin: string,
    metadata: SubtitleRequestMetadata = {}
  ): Promise<SubtitleResponse> {
    const media = parseStremioSubtitleRequest(type, id);

    if (!media) {
      return { subtitles: [] };
    }

    const context: SubtitleRequestContext = {
      media,
      metadata
    };

    try {
      const candidates = await this.provider.search(media);
      const rankedCandidates = this.ranker.rank(candidates, context);

      return {
        subtitles: rankedCandidates.slice(0, 5).map((candidate) => {
          const publicReference = this.signReference(
            candidate.reference
          );

          return {
            id: `${candidate.provider}-${candidate.reference}`,
            url: `${origin}/subtitles/provider/${encodeURIComponent(
              publicReference
            )}.vtt`,
            lang: 'ind'
          };
        })
      };
    } catch (error) {
      const code =
        error instanceof ProviderError
          ? error.code
          : 'unavailable';

      this.logger.warn(
        `[IndoSync] Subtitle provider search failed (${code}).`
      );

      return {
        subtitles: []
      };
    }
  }

  async download(
    publicReference: string
  ): Promise<DownloadedSubtitle> {
    const providerReference =
      this.verifyReference(publicReference);

    const subtitle =
      await this.provider.download(providerReference);

    if (!isWebVttSubtitle(subtitle)) {
      return subtitle;
    }

    const mapping =
      await this.timestampMappingResolver.resolve(
        providerReference
      );

    return {
      ...subtitle,
      content: transformWebVtt(
        subtitle.content,
        mapping
      )
    };
  }

  private signReference(reference: string): string {
    return `${reference}.${this.signature(reference)}`;
  }

  private verifyReference(
    publicReference: string
  ): string {
    const separator =
      publicReference.lastIndexOf('.');

    if (separator < 1) {
      throw new ProviderError(
        'not_found',
        'Invalid subtitle reference.'
      );
    }

    const reference =
      publicReference.slice(0, separator);

    const received =
      publicReference.slice(separator + 1);

    const expected =
      this.signature(reference);

    const receivedBytes =
      Buffer.from(received);

    const expectedBytes =
      Buffer.from(expected);

    if (
      receivedBytes.length !==
        expectedBytes.length ||
      !timingSafeEqual(
        receivedBytes,
        expectedBytes
      )
    ) {
      throw new ProviderError(
        'not_found',
        'Invalid subtitle reference.'
      );
    }

    return reference;
  }

  private signature(
    reference: string
  ): string {
    return createHmac(
      'sha256',
      this.referenceSecret
    )
      .update(
        `${this.provider.name}:${reference}`
      )
      .digest('base64url')
      .slice(0, 22);
  }
}

export class FixtureSubtitleService
  implements SubtitleService
{
  async search(
    type: string,
    id: string,
    origin: string
  ): Promise<SubtitleResponse> {
    if (
      !parseStremioSubtitleRequest(type, id)
    ) {
      return {
        subtitles: []
      };
    }

    return {
      subtitles: [
        {
          id: 'indosync-static-indonesian-v1',
          url: `${origin}/subtitles/indosync-id.vtt`,
          lang: 'ind'
        }
      ]
    };
  }

  async download(): Promise<DownloadedSubtitle> {
    throw new ProviderError(
      'missing_configuration',
      'A subtitle provider is not configured.'
    );
  }
}

function isWebVttSubtitle(
  subtitle: DownloadedSubtitle
): subtitle is DownloadedSubtitle {
  return subtitle.contentType
    .toLowerCase()
    .startsWith('text/vtt');
}
