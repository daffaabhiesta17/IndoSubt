import { parseRelease, resolutionFromVideoSize, type ReleaseFingerprint } from './release.js';
import type { SubtitleCandidate, SubtitleRequestContext } from './types.js';

export interface SubtitleCandidateRanker {
  rank(
    candidates: readonly SubtitleCandidate[],
    context: SubtitleRequestContext
  ): SubtitleCandidate[];
}

const technicalTokens = new Set([
  '480p', '720p', '1080p', '2160p', 'bluray', 'blu', 'ray', 'web', 'dl', 'webrip',
  'hdtv', 'dvdrip', 'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'aac', 'dts',
  'mkv', 'mp4', 'srt', 'vtt'
]);

function genericOverlap(video: ReleaseFingerprint, candidate: ReleaseFingerprint): number {
  const candidateTokens = new Set(candidate.tokens);
  let matches = 0;
  for (const token of new Set(video.tokens)) {
    if (token.length < 3 || technicalTokens.has(token)) continue;
    if (candidateTokens.has(token)) matches += 1;
  }
  return Math.min(matches, 5);
}

function scoreCandidate(
  video: ReleaseFingerprint,
  candidate: ReleaseFingerprint,
  context: SubtitleRequestContext
): number {
  if (!candidate.normalized) return 0;

  if (
    context.media.type === 'series' &&
    candidate.season !== undefined &&
    candidate.episode !== undefined &&
    (candidate.season !== context.media.season || candidate.episode !== context.media.episode)
  ) {
    return -10_000;
  }

  let score = 0;
  if (video.normalized && video.normalized === candidate.normalized) score += 1_000;

  if (
    video.releaseGroup &&
    candidate.releaseGroup &&
    video.releaseGroup === candidate.releaseGroup
  ) {
    score += 240;
  }
  if (video.source && video.source === candidate.source) score += 80;

  const expectedResolution = video.resolution ?? resolutionFromVideoSize(context.metadata.videoSize);
  if (expectedResolution && expectedResolution === candidate.resolution) score += 50;
  if (video.codec && video.codec === candidate.codec) score += 35;

  // Generic title/token overlap is intentionally capped and lower than any
  // release-group or technical fingerprint signal.
  score += genericOverlap(video, candidate) * 4;
  return score;
}

export class DeterministicSubtitleCandidateRanker implements SubtitleCandidateRanker {
  rank(
    candidates: readonly SubtitleCandidate[],
    context: SubtitleRequestContext
  ): SubtitleCandidate[] {
    if (!context.metadata.filename?.trim()) return [...candidates];

    const video = parseRelease(context.metadata.filename);
    return candidates
      .map((candidate, index) => ({
        candidate,
        index,
        score: scoreCandidate(video, parseRelease(candidate.fileName), context)
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ candidate }) => candidate);
  }
}
