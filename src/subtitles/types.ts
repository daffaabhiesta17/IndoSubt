export type SubtitleSearchRequest =
  | { type: 'movie'; imdbId: string }
  | { type: 'series'; imdbId: string; season: number; episode: number };

export interface SubtitleRequestMetadata {
  filename?: string;
  videoSize?: string;
  videoUrl?: string;
}

export interface SubtitleRequestContext {
  media: SubtitleSearchRequest;
  metadata: SubtitleRequestMetadata;
}

export interface SubtitleCandidate {
  provider: string;
  reference: string;
  language: 'id';
  fileName: string;
  format?: string;
}

export interface DownloadedSubtitle {
  content: string;
  contentType: 'text/vtt; charset=utf-8';
  fileName?: string;
}

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: 'ind';
}

export interface SubtitleResponse {
  subtitles: StremioSubtitle[];
}

