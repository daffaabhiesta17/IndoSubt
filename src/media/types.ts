export type MediaSource = { kind: 'remote-url'; url: string };

export interface MediaAudioStream {
  codec?: string;
  sampleRateHz?: number;
  channels?: number;
}

export interface MediaProbeResult {
  durationMs?: number;
  hasAudio: boolean;
  audioStreams: MediaAudioStream[];
  container?: string;
}

export interface MediaProbe {
  probe(source: MediaSource): Promise<MediaProbeResult>;
}

export type MediaProbeErrorCode =
  | 'invalid_source'
  | 'forbidden_source'
  | 'timeout'
  | 'process_failed'
  | 'output_too_large'
  | 'malformed_output';

export class MediaProbeError extends Error {
  constructor(
    public readonly code: MediaProbeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MediaProbeError';
  }
}
