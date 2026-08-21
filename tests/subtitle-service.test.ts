import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ProviderError, type SubtitleProvider } from '../src/subtitles/provider.js';
import type { SubtitleCandidateRanker } from '../src/subtitles/ranker.js';
import { ProviderSubtitleService } from '../src/subtitles/service.js';
import type {
  DownloadedSubtitle,
  SubtitleCandidate,
  SubtitleRequestContext
} from '../src/subtitles/types.js';

function mockProvider(overrides: Partial<SubtitleProvider> = {}): SubtitleProvider {
  return {
    name: 'opensubtitles',
    search: vi.fn().mockResolvedValue([]),
    download: vi.fn().mockResolvedValue({
      content: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHalo',
      contentType: 'text/vtt; charset=utf-8'
    } satisfies DownloadedSubtitle),
    ...overrides
  };
}

const candidate: SubtitleCandidate = {
  provider: 'opensubtitles',
  reference: '42',
  language: 'id',
  fileName: 'release.id.srt'
};

describe('Phase 2A subtitle service and Stremio mapping', () => {
  it('maps provider candidates to signed IndoSync URLs and lang ind', async () => {
    const provider = mockProvider({ search: vi.fn().mockResolvedValue([candidate]) });
    const app = createApp(new ProviderSubtitleService(provider, 'test-signing-secret'));

    const response = await request(app).get('/subtitles/movie/tt0133093.json');
    expect(response.status).toBe(200);
    expect(response.body.subtitles[0]).toMatchObject({
      id: 'opensubtitles-42',
      lang: 'ind'
    });
    expect(response.body.subtitles[0].url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/subtitles\/provider\/42\.[A-Za-z0-9_-]+\.vtt$/
    );
    expect(response.body.subtitles[0].url).not.toContain('test-signing-secret');
    expect(response.body.subtitles).toHaveLength(3);
    expect(response.body.subtitles[1].url).toMatch(/\/subtitles\/shift\/-2000\//);
    expect(response.body.subtitles[2].url).toMatch(/\/subtitles\/shift\/2000\//);
  });

  it('supports the Stremio runtime route without .json and with filename metadata', async () => {
    const search = vi.fn().mockResolvedValue([candidate]);
    const provider = mockProvider({ search });
    const app = createApp(new ProviderSubtitleService(provider, 'test-signing-secret'));

    const response = await request(app)
      .get('/subtitles/movie/tt0133093')
      .query({ filename: 'The.Matrix.1999.1080p.mkv' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.subtitles).toHaveLength(3);
    expect(response.body.subtitles[0]).toMatchObject({
      id: 'opensubtitles-42',
      lang: 'ind'
    });
    expect(response.body.subtitles[0].url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/subtitles\/provider\/42\.[A-Za-z0-9_-]+\.vtt$/
    );
    expect(search).toHaveBeenCalledWith({ type: 'movie', imdbId: 'tt0133093' });
  });

  it('supports series runtime requests and treats filename only as inert metadata', async () => {
    const search = vi.fn().mockResolvedValue([candidate]);
    const provider = mockProvider({ search });
    const app = createApp(new ProviderSubtitleService(provider, 'test-signing-secret'));

    const response = await request(app)
      .get('/subtitles/series/tt0944947:1:3')
      .query({ filename: '../../provider/999.vtt' });

    expect(response.status).toBe(200);
    expect(response.body.subtitles[0]).toMatchObject({ lang: 'ind' });
    expect(search).toHaveBeenCalledWith({
      type: 'series',
      imdbId: 'tt0944947',
      season: 1,
      episode: 3
    });
    expect(provider.download).not.toHaveBeenCalled();
  });
  it('supports filename in the Stremio extra path segment', async () => {
    const search = vi.fn().mockResolvedValue([candidate]);
    const provider = mockProvider({ search });
    const app = createApp(new ProviderSubtitleService(provider, 'test-signing-secret'));

    const response = await request(app).get(
      '/subtitles/movie/tt0133093/filename=The.Matrix.1999.mkv'
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.subtitles[0]).toMatchObject({
      id: 'opensubtitles-42',
      lang: 'ind'
    });
    expect(search).toHaveBeenCalledWith({ type: 'movie', imdbId: 'tt0133093' });
    expect(provider.download).not.toHaveBeenCalled();
  });

  it('supports videoSize and multiple bounded metadata fields in an extra segment', async () => {
    const search = vi.fn().mockResolvedValue([candidate]);
    const provider = mockProvider({ search });
    const app = createApp(new ProviderSubtitleService(provider, 'test-signing-secret'));

    const videoSizeResponse = await request(app).get(
      '/subtitles/movie/tt0133093/videoSize=1920x1080'
    );
    const multipleResponse = await request(app).get(
      '/subtitles/movie/tt0133093/filename=movie.mkv&videoSize=1920x1080&unknown=value'
    );

    expect(videoSizeResponse.status).toBe(200);
    expect(videoSizeResponse.body.subtitles[0]).toMatchObject({ lang: 'ind' });
    expect(multipleResponse.status).toBe(200);
    expect(multipleResponse.body.subtitles[0]).toMatchObject({ lang: 'ind' });
    expect(search).toHaveBeenCalledTimes(2);
    expect(provider.download).not.toHaveBeenCalled();
  });

  it('supports series IDs with a filename extra path segment', async () => {
    const search = vi.fn().mockResolvedValue([candidate]);
    const provider = mockProvider({ search });
    const app = createApp(new ProviderSubtitleService(provider, 'test-signing-secret'));

    const response = await request(app).get(
      '/subtitles/series/tt0944947:1:3/filename=episode.mkv'
    );

    expect(response.status).toBe(200);
    expect(response.body.subtitles[0]).toMatchObject({ lang: 'ind' });
    expect(search).toHaveBeenCalledWith({
      type: 'series',
      imdbId: 'tt0944947',
      season: 1,
      episode: 3
    });
    expect(provider.download).not.toHaveBeenCalled();
  });

  it('never treats traversal-like extra paths as subtitle file access', async () => {
    const search = vi.fn().mockResolvedValue([candidate]);
    const provider = mockProvider({ search });
    const app = createApp(new ProviderSubtitleService(provider, 'test-signing-secret'));

    const response = await request(app).get(
      '/subtitles/movie/tt0133093/%2E%2E%2F%2E%2E%2Fprovider%2F999.vtt'
    );

    expect(response.headers['content-type']).not.toContain('text/vtt');
    expect(response.text).not.toContain('WEBVTT');
    expect(provider.download).not.toHaveBeenCalled();
  });
  it('allow-lists filename/videoSize metadata and ignores unknown extras', async () => {
    const rank = vi.fn(
      (candidates: readonly SubtitleCandidate[], context: SubtitleRequestContext) => [...candidates]
    );
    const ranker: SubtitleCandidateRanker = { rank };
    const provider = mockProvider({ search: vi.fn().mockResolvedValue([candidate]) });
    const app = createApp(
      new ProviderSubtitleService(provider, 'secret', { warn: vi.fn() }, ranker)
    );

    const response = await request(app).get(
      '/subtitles/movie/tt0133093/filename=Movie.1080p.mkv&videoSize=1920x1080&unknown=ignored'
    );

    expect(response.status).toBe(200);
    expect(rank).toHaveBeenCalledWith([candidate], {
      media: { type: 'movie', imdbId: 'tt0133093' },
      metadata: { filename: 'Movie.1080p.mkv', videoSize: '1920x1080' }
    });
  });

  it('calls provider search once, never downloads, and ranks before selecting five', async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      ...candidate,
      reference: String(index + 1),
      fileName: `Movie.Release.${index + 1}.srt`
    }));
    const search = vi.fn().mockResolvedValue(candidates);
    const provider = mockProvider({ search });
    const rank = vi.fn((items: readonly SubtitleCandidate[]) => [
      items[6],
      items[5],
      ...items.slice(0, 5)
    ]);
    const app = createApp(
      new ProviderSubtitleService(provider, 'secret', { warn: vi.fn() }, { rank })
    );

    const response = await request(app).get(
      '/subtitles/movie/tt0133093/filename=Movie.Release.7.mkv'
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0][0]).toHaveLength(7);
    expect(provider.download).not.toHaveBeenCalled();
    expect(response.body.subtitles.map((item: { id: string }) => item.id).slice(0, 5)).toEqual([
      'opensubtitles-7',
      'opensubtitles-6',
      'opensubtitles-1',
      'opensubtitles-2',
      'opensubtitles-3'
    ]);
    expect(response.body.subtitles).toHaveLength(7);
    expect(response.body.subtitles[5].url).toMatch(/\/subtitles\/shift\/-2000\//);
    expect(response.body.subtitles[6].url).toMatch(/\/subtitles\/shift\/2000\//);
    expect(response.body.subtitles.every((item: { lang: string }) => item.lang === 'ind')).toBe(true);
  });

  it('preserves provider order in service when filename metadata is absent', async () => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([
        { ...candidate, reference: '2', fileName: 'B.srt' },
        { ...candidate, reference: '1', fileName: 'A.srt' }
      ])
    });
    const app = createApp(new ProviderSubtitleService(provider, 'secret'));

    const response = await request(app).get('/subtitles/movie/tt0133093.json');
    expect(response.body.subtitles.map((item: { id: string }) => item.id).slice(0, 2)).toEqual([
      'opensubtitles-2',
      'opensubtitles-1'
    ]);
    expect(response.body.subtitles).toHaveLength(4);
  });

  it('keeps fixture fallback behavior with metadata present', async () => {
    const { FixtureSubtitleService } = await import('../src/subtitles/service.js');
    const app = createApp(new FixtureSubtitleService());
    const response = await request(app).get(
      '/subtitles/movie/tt0133093/filename=Movie.1080p.mkv'
    );

    expect(response.status).toBe(200);
    expect(response.body.subtitles[0]).toMatchObject({
      id: 'indosync-static-indonesian-v1',
      lang: 'ind'
    });
  });
  it('returns a safe empty result when provider fails', async () => {
    const logger = { warn: vi.fn() };
    const provider = mockProvider({
      search: vi.fn().mockRejectedValue(new ProviderError('unauthorized', 'do not leak details'))
    });
    const app = createApp(new ProviderSubtitleService(provider, 'secret', logger));

    const response = await request(app).get('/subtitles/movie/tt0133093.json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ subtitles: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      '[IndoSync] Subtitle provider search failed (unauthorized).'
    );
  });

  it('downloads WebVTT through a valid signed reference', async () => {
    const provider = mockProvider({ search: vi.fn().mockResolvedValue([candidate]) });
    const service = new ProviderSubtitleService(provider, 'secret');
    const app = createApp(service);
    const search = await request(app).get('/subtitles/movie/tt0133093.json');
    const pathname = new URL(search.body.subtitles[0].url).pathname;

    const response = await request(app).get(pathname);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/vtt');
    expect(response.text).toContain('WEBVTT');
    expect(provider.download).toHaveBeenCalledWith('42');
  });

  it('rejects unsigned download references without calling provider', async () => {
    const provider = mockProvider();
    const app = createApp(new ProviderSubtitleService(provider, 'secret'));
    const response = await request(app).get('/subtitles/provider/42.invalid.vtt');

    expect(response.status).toBe(404);
    expect(provider.download).not.toHaveBeenCalled();
  });

  it.each([
    ['unauthorized', 502],
    ['rate_limited', 429],
    ['timeout', 504]
  ] as const)('maps download error %s to safe HTTP %s', async (code, status) => {
    const provider = mockProvider({
      search: vi.fn().mockResolvedValue([candidate]),
      download: vi.fn().mockRejectedValue(
        new ProviderError(code, 'provider detail must not leak', code === 'rate_limited' ? 7 : undefined)
      )
    });
    const app = createApp(new ProviderSubtitleService(provider, 'secret'));
    const search = await request(app).get('/subtitles/movie/tt0133093.json');
    const pathname = new URL(search.body.subtitles[0].url).pathname;
    const response = await request(app).get(pathname);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: 'Subtitle is temporarily unavailable.' });
    expect(JSON.stringify(response.body)).not.toContain('provider detail');
    if (code === 'rate_limited') expect(response.headers['retry-after']).toBe('7');
  });
});



