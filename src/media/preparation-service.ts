import type { SubtitleRequestMetadata } from '../subtitles/types.js';
import type {
  AudioArtifact,
  AudioExtractionOptions,
  AudioExtractor
} from './audio-extractor.js';
import type { MediaSourceResolver } from './source-resolver.js';
import {
  MediaProbeError,
  type MediaProbe,
  type MediaProbeResult,
  type MediaSource
} from './types.js';

export interface PreparedMedia {
  source: MediaSource;
  probe: MediaProbeResult;
  audio: AudioArtifact;
}

export interface MediaPreparationService {
  prepare(
    metadata: SubtitleRequestMetadata,
    extractionOptions?: AudioExtractionOptions
  ): Promise<PreparedMedia | undefined>;
}

/**
 * Internal, opt-in orchestration boundary for media preparation.
 *
 * This service does not create synchronization points and is deliberately not
 * called by subtitle discovery or delivery routes.
 */
export class DefaultMediaPreparationService implements MediaPreparationService {
  constructor(
    private readonly sourceResolver: MediaSourceResolver,
    private readonly mediaProbe: MediaProbe,
    private readonly audioExtractor: AudioExtractor
  ) {}

  async prepare(
    metadata: SubtitleRequestMetadata,
    extractionOptions?: AudioExtractionOptions
  ): Promise<PreparedMedia | undefined> {
    const source = await this.sourceResolver.resolve(metadata);
    if (!source) return undefined;

    const probe = await this.mediaProbe.probe(source);
    if (!probe.hasAudio || probe.audioStreams.length === 0) {
      throw new MediaProbeError('invalid_source', 'Media source does not contain an audio stream.');
    }

    const audio = await this.audioExtractor.extract(source, extractionOptions);
    return { source, probe, audio };
  }
}
