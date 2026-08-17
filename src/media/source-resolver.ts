import type { SubtitleRequestMetadata } from '../subtitles/types.js';
import type { MediaSource } from './types.js';
import type { RemoteMediaUrlPolicy } from './url-policy.js';

export interface MediaSourceResolver {
  resolve(metadata: SubtitleRequestMetadata): Promise<MediaSource | undefined>;
}

export class TrustedMediaSourceResolver implements MediaSourceResolver {
  constructor(private readonly urlPolicy: RemoteMediaUrlPolicy) {}

  async resolve(metadata: SubtitleRequestMetadata): Promise<MediaSource | undefined> {
    if (!metadata.videoUrl) return undefined;
    const validated = await this.urlPolicy.validate(metadata.videoUrl);
    return { kind: 'remote-url', url: validated.url.toString() };
  }
}
