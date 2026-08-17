import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { SubtitleProvider } from '../src/subtitles/provider.js';
import type { SubtitleCandidateRanker } from '../src/subtitles/ranker.js';
import { ProviderSubtitleService } from '../src/subtitles/service.js';
import type {
  DownloadedSubtitle,
  SubtitleCandidate,
  SubtitleRequestContext
} from '../src/subtitles/types.js';

const candidate: SubtitleCandidate = {
  provider: 'opensubtitles',
  reference: '42',
  language: 'id',
  fileName: 'movie.srt'
};

function setup() {
  const provider: SubtitleProvider = {
    name: 'opensubtitles',
    search: vi.fn().mockResolvedValue([candidate]),
    download: vi.fn().mockResolvedValue({
      content: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHalo',
      contentType: 'text/vtt; charset=utf-8'
    } satisfies DownloadedSubtitle)
  };
  const rank = vi.fn(
    (candidates: readonly SubtitleCandidate[], _context: SubtitleRequestContext) => [...candidates]
  );
  const ranker: SubtitleCandidateRanker = { rank };
  return {
    rank,
    app: createApp(new ProviderSubtitleService(provider, 'secret', { warn: vi.fn() }, ranker))
  };
}

describe('Phase 4B inert videoUrl metadata boundary', () => {
  it('accepts videoUrl from a query without performing network access', async () => {
    const { app, rank } = setup();
    const videoUrl = 'https://media.example.com/movie.mp4?token=value';
    const response = await request(app)
      .get('/subtitles/movie/tt0133093')
      .query({ videoUrl });

    expect(response.status).toBe(200);
    expect(rank).toHaveBeenCalledWith([candidate], {
      media: { type: 'movie', imdbId: 'tt0133093' },
      metadata: { videoUrl }
    });
  });

  it('accepts encoded videoUrl from the extra path segment', async () => {
    const { app, rank } = setup();
    const videoUrl = 'https://media.example.com/movie.mp4?token=value';
    const extra = new URLSearchParams({ videoUrl }).toString();
    const response = await request(app).get(`/subtitles/movie/tt0133093/${extra}`);

    expect(response.status).toBe(200);
    expect(rank.mock.calls[0][1].metadata).toEqual({ videoUrl });
  });

  it('allow-lists filename, videoSize, and videoUrl while ignoring unknown metadata', async () => {
    const { app, rank } = setup();
    const videoUrl = 'https://media.example.com/movie.mp4';
    const extra = new URLSearchParams({
      filename: 'movie.mkv',
      videoSize: '1920x1080',
      videoUrl,
      unknown: 'ignored'
    }).toString();
    const response = await request(app).get(`/subtitles/movie/tt0133093/${extra}`);

    expect(response.status).toBe(200);
    expect(rank.mock.calls[0][1].metadata).toEqual({
      filename: 'movie.mkv',
      videoSize: '1920x1080',
      videoUrl
    });
  });

  it('bounds an oversized videoUrl without resolving or fetching it', async () => {
    const { app, rank } = setup();
    const oversized = `https://media.example.com/${'a'.repeat(4_000)}`;
    const response = await request(app)
      .get('/subtitles/movie/tt0133093')
      .query({ videoUrl: oversized });

    expect(response.status).toBe(200);
    const metadata = rank.mock.calls[0][1].metadata;
    expect(metadata.videoUrl).toHaveLength(2_048);
    expect(metadata.videoUrl).toBe(oversized.slice(0, 2_048));
  });
});
