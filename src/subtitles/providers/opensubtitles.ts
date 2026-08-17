import { ProviderError, type SubtitleProvider } from '../provider.js';
import { openSubtitlesImdbId } from '../stremio-id.js';
import type { DownloadedSubtitle, SubtitleCandidate, SubtitleSearchRequest } from '../types.js';
import { validateWebVtt } from '../webvtt.js';

const defaultBaseUrl = 'https://api.opensubtitles.com/api/v1';
const defaultTimeoutMs = 5_000;
const defaultMaxSubtitleBytes = 5 * 1024 * 1024;

interface OpenSubtitlesProviderOptions {
  apiKey: string;
  userAgent?: string;
  fetchImplementation?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxSubtitleBytes?: number;
}

interface SearchFeatureDetails {
  season_number?: unknown;
  episode_number?: unknown;
}

interface SearchAttributes {
  language?: unknown;
  feature_details?: SearchFeatureDetails;
  files?: unknown;
}

interface SearchItem {
  attributes?: SearchAttributes;
}

interface DownloadResponse {
  link?: unknown;
  file_name?: unknown;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function statusError(response: Response): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError('unauthorized', 'OpenSubtitles rejected the configured credentials.');
  }
  if (response.status === 404) {
    return new ProviderError('not_found', 'OpenSubtitles resource was not found.');
  }
  if (response.status === 429) {
    return new ProviderError(
      'rate_limited',
      'OpenSubtitles rate limit was reached.',
      retryAfter(response)
    );
  }
  return new ProviderError('unavailable', `OpenSubtitles returned HTTP ${response.status}.`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class OpenSubtitlesProvider implements SubtitleProvider {
  readonly name = 'opensubtitles';
  private readonly apiKey: string;
  private readonly userAgent: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxSubtitleBytes: number;

  constructor(options: OpenSubtitlesProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new ProviderError('missing_configuration', 'OpenSubtitles API key is not configured.');
    }

    this.apiKey = options.apiKey;
    this.userAgent = options.userAgent?.trim() || 'IndoSync/0.1.0';
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.baseUrl = options.baseUrl ?? defaultBaseUrl;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maxSubtitleBytes = options.maxSubtitleBytes ?? defaultMaxSubtitleBytes;
  }

  async search(request: SubtitleSearchRequest): Promise<SubtitleCandidate[]> {
    const url = new URL(`${this.baseUrl}/subtitles`);
    url.searchParams.set('imdb_id', openSubtitlesImdbId(request.imdbId));
    url.searchParams.set('languages', 'id');
    if (request.type === 'series') {
      url.searchParams.set('season_number', String(request.season));
      url.searchParams.set('episode_number', String(request.episode));
    }

    const response = await this.request(url, {
      method: 'GET',
      headers: this.apiHeaders()
    });
    if (!response.ok) throw statusError(response);

    const payload = await this.readJson(response);
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ProviderError('malformed_response', 'OpenSubtitles search response is malformed.');
    }

    const candidates: SubtitleCandidate[] = [];
    for (const rawItem of payload.data) {
      const item = rawItem as SearchItem;
      const attributes = item?.attributes;
      if (!attributes || attributes.language !== 'id' || !Array.isArray(attributes.files)) continue;

      if (request.type === 'series') {
        const details = attributes.feature_details;
        if (
          Number(details?.season_number) !== request.season ||
          Number(details?.episode_number) !== request.episode
        ) {
          continue;
        }
      }

      for (const rawFile of attributes.files) {
        if (!isRecord(rawFile)) continue;
        const fileId = rawFile.file_id;
        const fileName = rawFile.file_name;
        if (!Number.isSafeInteger(fileId) || Number(fileId) <= 0 || typeof fileName !== 'string') continue;

        candidates.push({
          provider: this.name,
          reference: String(fileId),
          language: 'id',
          fileName,
          format: fileName.split('.').pop()?.toLowerCase()
        });
      }
    }

    return candidates;
  }

  async download(reference: string): Promise<DownloadedSubtitle> {
    if (!/^[1-9]\d*$/.test(reference)) {
      throw new ProviderError('not_found', 'Invalid OpenSubtitles file reference.');
    }

    const response = await this.request(`${this.baseUrl}/download`, {
      method: 'POST',
      headers: { ...this.apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: Number(reference), sub_format: 'webvtt' })
    });
    if (!response.ok) throw statusError(response);

    const payload = (await this.readJson(response)) as DownloadResponse;
    if (!isRecord(payload) || typeof payload.link !== 'string') {
      throw new ProviderError('malformed_response', 'OpenSubtitles download response is malformed.');
    }

    const downloadUrl = new URL(payload.link);
    if (
      downloadUrl.protocol !== 'https:' ||
      !(downloadUrl.hostname === 'opensubtitles.com' || downloadUrl.hostname.endsWith('.opensubtitles.com'))
    ) {
      throw new ProviderError('malformed_response', 'OpenSubtitles returned an untrusted download URL.');
    }

    // Temporary links are fetched server-side so the consumer key is never exposed to Stremio.
    const subtitleResponse = await this.request(downloadUrl, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent }
    });
    if (!subtitleResponse.ok) throw statusError(subtitleResponse);

    const declaredLength = Number(subtitleResponse.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxSubtitleBytes) {
      throw new ProviderError('invalid_subtitle', 'Subtitle file exceeds the allowed size.');
    }

    const bytes = await subtitleResponse.arrayBuffer();
    if (bytes.byteLength > this.maxSubtitleBytes) {
      throw new ProviderError('invalid_subtitle', 'Subtitle file exceeds the allowed size.');
    }

    try {
      return {
        content: validateWebVtt(new TextDecoder().decode(bytes)),
        contentType: 'text/vtt; charset=utf-8',
        fileName: typeof payload.file_name === 'string' ? payload.file_name : undefined
      };
    } catch {
      throw new ProviderError('invalid_subtitle', 'OpenSubtitles did not return valid WebVTT.');
    }
  }

  private apiHeaders(): Record<string, string> {
    return { 'Api-Key': this.apiKey, 'User-Agent': this.userAgent };
  }

  private async request(input: string | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImplementation(input, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (isAbortError(error) || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new ProviderError('timeout', 'OpenSubtitles request timed out.');
      }
      throw new ProviderError('unavailable', 'OpenSubtitles request failed.');
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ProviderError('malformed_response', 'OpenSubtitles returned malformed JSON.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
