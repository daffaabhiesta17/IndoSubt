import type { SubtitleRequestMetadata } from '../subtitles/types.js';
import type { MediaSourceResolver } from './source-resolver.js';
import type { MediaProbe, MediaProbeResult } from './types.js';

export interface MediaInspectionService {
  inspect(metadata: SubtitleRequestMetadata): Promise<MediaProbeResult | undefined>;
}

export class DefaultMediaInspectionService implements MediaInspectionService {
  constructor(
    private readonly sourceResolver: MediaSourceResolver,
    private readonly mediaProbe: MediaProbe
  ) {}

  async inspect(metadata: SubtitleRequestMetadata): Promise<MediaProbeResult | undefined> {
    const source = await this.sourceResolver.resolve(metadata);
    if (!source) return undefined;
    return this.mediaProbe.probe(source);
  }
}
