import type { SubtitleSearchRequest } from './types.js';

const movieIdPattern = /^(tt\d+)$/;
const seriesIdPattern = /^(tt\d+):(\d+):(\d+)$/;

export function parseStremioSubtitleRequest(
  type: string,
  id: string
): SubtitleSearchRequest | undefined {
  if (type === 'movie') {
    const match = movieIdPattern.exec(id);
    return match ? { type: 'movie', imdbId: match[1] } : undefined;
  }

  if (type === 'series') {
    const match = seriesIdPattern.exec(id);
    if (!match) return undefined;

    const season = Number(match[2]);
    const episode = Number(match[3]);
    if (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1) {
      return undefined;
    }

    return { type: 'series', imdbId: match[1], season, episode };
  }

  return undefined;
}

export function openSubtitlesImdbId(imdbId: string): string {
  const digits = imdbId.slice(2);
  const normalized = digits.replace(/^0+(?=\d)/, '');
  return normalized;
}
