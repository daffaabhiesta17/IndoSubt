import { describe, expect, it } from 'vitest';
import { openSubtitlesImdbId, parseStremioSubtitleRequest } from '../src/subtitles/stremio-id.js';

describe('Stremio subtitle ID parsing', () => {
  it('parses movie IMDb IDs and normalizes them for OpenSubtitles', () => {
    expect(parseStremioSubtitleRequest('movie', 'tt0133093')).toEqual({
      type: 'movie',
      imdbId: 'tt0133093'
    });
    expect(openSubtitlesImdbId('tt0133093')).toBe('133093');
  });

  it('parses exact series season and episode', () => {
    expect(parseStremioSubtitleRequest('series', 'tt0944947:1:3')).toEqual({
      type: 'series',
      imdbId: 'tt0944947',
      season: 1,
      episode: 3
    });
  });

  it('rejects malformed or incomplete IDs', () => {
    expect(parseStremioSubtitleRequest('movie', '123')).toBeUndefined();
    expect(parseStremioSubtitleRequest('series', 'tt0944947')).toBeUndefined();
    expect(parseStremioSubtitleRequest('series', 'tt0944947:0:1')).toBeUndefined();
    expect(parseStremioSubtitleRequest('other', 'tt0133093')).toBeUndefined();
  });
});
