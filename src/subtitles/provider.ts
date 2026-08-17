import type { DownloadedSubtitle, SubtitleCandidate, SubtitleSearchRequest } from './types.js';

export interface SubtitleProvider {
  readonly name: string;
  search(request: SubtitleSearchRequest): Promise<SubtitleCandidate[]>;
  download(reference: string): Promise<DownloadedSubtitle>;
}

export type ProviderErrorCode =
  | 'missing_configuration'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'malformed_response'
  | 'invalid_subtitle';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
