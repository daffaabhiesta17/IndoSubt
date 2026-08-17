import { describe, expect, it } from 'vitest';
import { DeterministicSubtitleCandidateRanker } from '../src/subtitles/ranker.js';
import type {
  SubtitleCandidate,
  SubtitleRequestContext,
  SubtitleSearchRequest
} from '../src/subtitles/types.js';

const ranker = new DeterministicSubtitleCandidateRanker();
const movieMedia: SubtitleSearchRequest = { type: 'movie', imdbId: 'tt0133093' };

function context(filename?: string, media = movieMedia): SubtitleRequestContext {
  return { media, metadata: filename === undefined ? {} : { filename } };
}

function candidate(reference: string, fileName: string): SubtitleCandidate {
  return { provider: 'opensubtitles', reference, language: 'id', fileName };
}

function references(candidates: SubtitleCandidate[]): string[] {
  return candidates.map((item) => item.reference);
}

describe('deterministic release-aware candidate ranker', () => {
  it('ranks an exact normalized release filename first', () => {
    const input = [
      candidate('other', 'The.Matrix.1999.720p.WEBRip.x265-OTHER.srt'),
      candidate('exact', 'The.Matrix.1999.1080p.BluRay.x264.DTS-GROUP.srt')
    ];
    expect(
      references(ranker.rank(input, context('The.Matrix.1999.1080p.BluRay.x264.DTS-GROUP.mkv')))
    ).toEqual(['exact', 'other']);
  });

  it('ranks release-group match above generic resolution overlap', () => {
    const input = [
      candidate('generic', 'Different.Movie.1080p.BluRay.x264-OTHER.srt'),
      candidate('group', 'Different.Movie.720p.WEBRip.x265-GROUP.srt')
    ];
    expect(references(ranker.rank(input, context('Movie.1080p.BluRay.x264-GROUP.mkv')))[0]).toBe(
      'group'
    );
  });

  it.each([
    ['source', 'Movie.720p.BluRay.x265-A.srt', 'Movie.720p.WEBRip.x265-B.srt', 'Movie.BluRay.mkv'],
    ['codec', 'Movie.720p.WEBRip.x264-A.srt', 'Movie.720p.WEBRip.x265-B.srt', 'Movie.x264.mkv'],
    ['resolution', 'Movie.1080p.WEBRip.x265-A.srt', 'Movie.720p.WEBRip.x265-B.srt', 'Movie.1080p.mkv']
  ])('%s match contributes to ranking', (_, matching, other, video) => {
    const input = [candidate('other', other), candidate('matching', matching)];
    expect(references(ranker.rank(input, context(video)))[0]).toBe('matching');
  });

  it('does not let generic technical tokens dominate a release-group match', () => {
    const input = [
      candidate('technical', 'Unrelated.1080p.BluRay.x264.DTS-OTHER.srt'),
      candidate('group', 'Unrelated.480p.HDTV.AV1-GROUP.srt')
    ];
    expect(
      references(ranker.rank(input, context('Title.1080p.BluRay.x264.DTS-GROUP.mkv')))[0]
    ).toBe('group');
  });

  it('preserves provider order for ties', () => {
    const input = [candidate('1', 'Alpha.srt'), candidate('2', 'Beta.srt')];
    expect(references(ranker.rank(input, context('No.Match.mkv')))).toEqual(['1', '2']);
  });

  it('preserves provider order when filename is absent or empty', () => {
    const input = [candidate('1', 'B.srt'), candidate('2', 'A.srt')];
    expect(references(ranker.rank(input, context()))).toEqual(['1', '2']);
    expect(references(ranker.rank(input, context('  ')))).toEqual(['1', '2']);
  });

  it('handles a candidate without a runtime fileName safely', () => {
    const missing = { ...candidate('missing', 'placeholder'), fileName: undefined } as unknown as SubtitleCandidate;
    expect(() => ranker.rank([missing, candidate('valid', 'Movie.1080p.srt')], context('Movie.mkv')))
      .not.toThrow();
  });

  it('penalizes a detected series season/episode mismatch', () => {
    const series: SubtitleSearchRequest = {
      type: 'series',
      imdbId: 'tt0944947',
      season: 1,
      episode: 3
    };
    const input = [
      candidate('wrong', 'Show.S01E02.1080p-GROUP.srt'),
      candidate('right', 'Show.S01E03.720p-OTHER.srt')
    ];
    expect(references(ranker.rank(input, context('Show.S01E03.1080p-GROUP.mkv', series)))[0]).toBe(
      'right'
    );
  });

  it('is pure, deterministic, and does not mutate input', () => {
    const input = [candidate('2', 'Movie.720p.srt'), candidate('1', 'Movie.1080p.srt')];
    const original = references(input);
    const first = references(ranker.rank(input, context('Movie.1080p.mkv')));
    const second = references(ranker.rank(input, context('Movie.1080p.mkv')));
    expect(first).toEqual(second);
    expect(references(input)).toEqual(original);
  });
});
