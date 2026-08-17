import { describe, expect, it } from 'vitest';
import { parseRelease, resolutionFromVideoSize } from '../src/subtitles/release.js';

describe('release filename parser', () => {
  it('removes known media and subtitle extensions', () => {
    expect(parseRelease('Movie.Release.mkv').normalized).toBe('movie release');
    expect(parseRelease('Movie.Release.srt').normalized).toBe('movie release');
  });

  it.each([
    ['Movie.Release.1080p.mkv', 'movie release 1080p'],
    ['Movie_Release_1080p.mkv', 'movie release 1080p'],
    ['Movie Release 1080p.mkv', 'movie release 1080p']
  ])('normalizes separators in %s', (filename, normalized) => {
    expect(parseRelease(filename).normalized).toBe(normalized);
  });

  it.each(['480p', '720p', '1080p', '2160p'] as const)(
    'recognizes resolution %s',
    (resolution) => {
      expect(parseRelease(`Movie.${resolution}.mkv`).resolution).toBe(resolution);
    }
  );

  it.each([
    ['BluRay', 'bluray'],
    ['Blu-Ray', 'bluray'],
    ['WEB-DL', 'web-dl'],
    ['WEBRip', 'webrip'],
    ['HDTV', 'hdtv'],
    ['DVDRip', 'dvdrip']
  ] as const)('recognizes source %s', (token, source) => {
    expect(parseRelease(`Movie.${token}.mkv`).source).toBe(source);
  });

  it.each([
    ['x264', 'x264'],
    ['x265', 'x265'],
    ['H264', 'h264'],
    ['H265', 'h265'],
    ['HEVC', 'hevc'],
    ['AV1', 'av1']
  ] as const)('recognizes codec %s', (token, codec) => {
    expect(parseRelease(`Movie.${token}.mkv`).codec).toBe(codec);
  });

  it('supports Unicode filenames', () => {
    expect(parseRelease('Laskar.Pelangi.2008.1080p.mkv').tokens).toContain('laskar');
    expect(parseRelease('映画.1080p.mkv').tokens).toContain('映画');
  });

  it('handles empty and long filenames safely', () => {
    expect(parseRelease('').normalized).toBe('');
    expect(parseRelease(undefined).tokens).toEqual([]);
    expect(parseRelease(`${'a'.repeat(10_000)}.mkv`).normalized.length).toBeLessThanOrEqual(4_096);
  });

  it('treats traversal-like input as plain text', () => {
    const parsed = parseRelease('../../provider/999.vtt');
    expect(parsed.normalized).toBe('provider 999');
    expect(parsed.tokens).toEqual(['provider', '999']);
  });

  it('extracts season, episode, and only a confident final release group', () => {
    const parsed = parseRelease('Show.S01E03.1080p.WEB-DL-GROUP.mkv');
    expect(parsed).toMatchObject({ season: 1, episode: 3, releaseGroup: 'group' });
    expect(parseRelease('Movie.1080p-WEB-DL.mkv').releaseGroup).toBeUndefined();
  });

  it('recognizes resolution-shaped videoSize without treating bytes as resolution', () => {
    expect(resolutionFromVideoSize('1920x1080')).toBe('1080p');
    expect(resolutionFromVideoSize('1048576000')).toBeUndefined();
  });
});
