import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/subtitles/provider.js';
import { OpenSubtitlesProvider } from '../src/subtitles/providers/opensubtitles.js';
import type { SubtitleSearchRequest } from '../src/subtitles/types.js';

const movie: SubtitleSearchRequest = { type: 'movie', imdbId: 'tt0133093' };
const series: SubtitleSearchRequest = {
  type: 'series',
  imdbId: 'tt0944947',
  season: 1,
  episode: 3
};

function searchItem(language = 'id', season = 1, episode = 3) {
  return {
    attributes: {
      language,
      feature_details: { season_number: season, episode_number: episode },
      files: [{ file_id: 42, file_name: 'release.id.srt' }]
    }
  };
}

function provider(fetchImplementation: typeof fetch) {
  return new OpenSubtitlesProvider({
    apiKey: 'unit-test-key',
    fetchImplementation,
    timeoutMs: 20
  });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

describe('OpenSubtitlesProvider', () => {
  it('requires a consumer API key', () => {
    expect(() => new OpenSubtitlesProvider({ apiKey: ' ' })).toThrowError(
      expect.objectContaining({ code: 'missing_configuration' })
    );
  });

  it('searches movies by normalized IMDb ID and Indonesian language', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [searchItem()] }));
    const result = await provider(fetchMock).search(movie);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/subtitles');
    expect(url.searchParams.get('imdb_id')).toBe('133093');
    expect(url.searchParams.get('languages')).toBe('id');
    expect(url.searchParams.has('season_number')).toBe(false);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      'Api-Key': 'unit-test-key',
      'User-Agent': 'IndoSync/0.1.0'
    });
    expect(result[0]).toMatchObject({ reference: '42', language: 'id' });
  });

  it('maps season/episode and excludes another episode or language', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: [searchItem('en'), searchItem('id', 1, 2), searchItem('id', 1, 3)] })
    );
    const result = await provider(fetchMock).search(series);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('season_number')).toBe('1');
    expect(url.searchParams.get('episode_number')).toBe('3');
    expect(result).toHaveLength(1);
    expect(result[0].language).toBe('id');
  });

  it('returns no candidates for no-result responses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [] }));
    await expect(provider(fetchMock).search(movie)).resolves.toEqual([]);
  });

  it.each([401, 403])('maps HTTP %s to unauthorized', async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, status));
    await expect(provider(fetchMock).search(movie)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('maps HTTP 429 and preserves Retry-After without retrying', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '12' }));
    await expect(provider(fetchMock).search(movie)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 12
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps timeout and network failures safely', async () => {
    const timeoutFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(provider(timeoutFetch).search(movie)).rejects.toMatchObject({ code: 'timeout' });

    const networkFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret network detail'));
    await expect(provider(networkFetch).search(movie)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects malformed JSON and malformed provider structures', async () => {
    const badJson = vi.fn<typeof fetch>().mockResolvedValue(new Response('{', { status: 200 }));
    await expect(provider(badJson).search(movie)).rejects.toMatchObject({
      code: 'malformed_response'
    });

    const badShape = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: null }));
    await expect(provider(badShape).search(movie)).rejects.toMatchObject({
      code: 'malformed_response'
    });
  });

  it('uses the documented download flow and validates WebVTT', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          link: 'https://dl.opensubtitles.com/file/temporary',
          file_name: 'subtitle.vtt'
        })
      )
      .mockResolvedValueOnce(
        new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHalo', {
          headers: { 'Content-Type': 'text/vtt' }
        })
      );

    const result = await provider(fetchMock).download('42');
    const downloadRequest = fetchMock.mock.calls[0];
    expect(String(downloadRequest[0])).toBe('https://api.opensubtitles.com/api/v1/download');
    expect(downloadRequest[1]?.method).toBe('POST');
    expect(JSON.parse(String(downloadRequest[1]?.body))).toEqual({
      file_id: 42,
      sub_format: 'webvtt'
    });
    expect(result.content).toContain('WEBVTT');
  });

  it('rejects invalid WebVTT and untrusted temporary URLs', async () => {
    const untrusted = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ link: 'https://attacker.example/subtitle.vtt' }));
    await expect(provider(untrusted).download('42')).rejects.toMatchObject({
      code: 'malformed_response'
    });

    const invalidVtt = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ link: 'https://dl.opensubtitles.com/file/temporary' }))
      .mockResolvedValueOnce(new Response('not a subtitle'));
    await expect(provider(invalidVtt).download('42')).rejects.toMatchObject({
      code: 'invalid_subtitle'
    });
  });
});
