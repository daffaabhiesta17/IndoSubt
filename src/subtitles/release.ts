export type ReleaseResolution = '480p' | '720p' | '1080p' | '2160p';
export type ReleaseSource = 'bluray' | 'web-dl' | 'webrip' | 'hdtv' | 'dvdrip';
export type ReleaseCodec = 'x264' | 'x265' | 'h264' | 'h265' | 'hevc' | 'av1';

export interface ReleaseFingerprint {
  normalized: string;
  tokens: readonly string[];
  resolution?: ReleaseResolution;
  source?: ReleaseSource;
  codec?: ReleaseCodec;
  season?: number;
  episode?: number;
  releaseGroup?: string;
}

const knownExtensions = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'm4v', 'webm', 'ts', 'srt', 'vtt', 'sub', 'ass', 'ssa'
]);
const genericGroupTokens = new Set([
  'bluray', 'web', 'webdl', 'webrip', 'hdtv', 'dvdrip', 'remux', 'x264', 'x265',
  'h264', 'h265', 'hevc', 'av1', 'aac', 'dts', 'truehd', 'atmos', 'hdr', 'dv',
  'dl', 'rip', 'ray', 'proper', 'repack', 'extended', 'internal', 'multi', 'dubbed', 'subbed'
]);

function stripKnownExtension(value: string): string {
  const match = /\.([\p{L}\p{N}]{2,5})$/u.exec(value.trim());
  return match && knownExtensions.has(match[1].toLowerCase())
    ? value.trim().slice(0, -match[0].length)
    : value.trim();
}

function normalizeSource(normalized: string): ReleaseSource | undefined {
  if (/\bblu[ -]?ray\b/.test(normalized)) return 'bluray';
  if (/\bweb[ -]?dl\b/.test(normalized)) return 'web-dl';
  if (/\bweb[ -]?rip\b/.test(normalized)) return 'webrip';
  if (/\bhdtv\b/.test(normalized)) return 'hdtv';
  if (/\bdvd[ -]?rip\b/.test(normalized)) return 'dvdrip';
  return undefined;
}

function normalizeCodec(normalized: string): ReleaseCodec | undefined {
  if (/\bx[ .-]?264\b/.test(normalized)) return 'x264';
  if (/\bx[ .-]?265\b/.test(normalized)) return 'x265';
  if (/\bh[ .-]?264\b/.test(normalized)) return 'h264';
  if (/\bh[ .-]?265\b/.test(normalized)) return 'h265';
  if (/\bhevc\b/.test(normalized)) return 'hevc';
  if (/\bav1\b/.test(normalized)) return 'av1';
  return undefined;
}

function extractReleaseGroup(base: string): string | undefined {
  // A final dash-delimited token is a useful release-group signal only when
  // it is compact, alphanumeric, and not itself common technical metadata.
  const match = /-([\p{L}\p{N}][\p{L}\p{N}._]{1,31})$/u.exec(base.trim());
  if (!match) return undefined;
  const group = match[1].toLowerCase().replace(/[._]+/g, '');
  if (group.length < 2 || genericGroupTokens.has(group) || /^\d+$/.test(group)) return undefined;
  return group;
}

export function parseRelease(filename: string | undefined): ReleaseFingerprint {
  if (!filename?.trim()) return { normalized: '', tokens: [] };

  const bounded = filename.slice(0, 4_096);
  const base = stripKnownExtension(bounded);
  const normalized = base
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const tokens = normalized ? normalized.split(' ') : [];
  const resolutionMatch = /\b(480p|720p|1080p|2160p)\b/.exec(normalized);
  const episodeMatch = /\bs(\d{1,2})[ ._-]*e(\d{1,3})\b/i.exec(base);

  return {
    normalized,
    tokens,
    resolution: resolutionMatch?.[1] as ReleaseResolution | undefined,
    source: normalizeSource(normalized),
    codec: normalizeCodec(normalized),
    season: episodeMatch ? Number(episodeMatch[1]) : undefined,
    episode: episodeMatch ? Number(episodeMatch[2]) : undefined,
    releaseGroup: extractReleaseGroup(base)
  };
}

export function resolutionFromVideoSize(value: string | undefined): ReleaseResolution | undefined {
  if (!value) return undefined;
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(value.trim());
  if (!match) return undefined;
  const height = Number(match[2]);
  if (height === 480) return '480p';
  if (height === 720) return '720p';
  if (height === 1080) return '1080p';
  if (height === 2160) return '2160p';
  return undefined;
}

