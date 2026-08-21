import { ProviderError } from './provider.js';

export interface TorboxResolver {
  resolve(imdbId: string, filename?: string): Promise<string | undefined>;
}

interface TorboxFile {
  id?: number;
  name?: string;
  short_name?: string;
  size?: number;
}

interface TorboxTorrent {
  id?: number;
  hash?: string;
  name?: string;
  files?: TorboxFile[];
}

export class TorboxApiResolver implements TorboxResolver {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    apiKey: string,
    options: { baseUrl?: string; fetchImplementation?: typeof fetch } = {}
  ) {
    if (!apiKey.trim()) {
      throw new ProviderError('missing_configuration', 'TORBOX_API_KEY is not configured.');
    }
    this.apiKey = apiKey.trim();
    this.baseUrl = options.baseUrl ?? 'https://api.torbox.app/v1/api';
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async resolve(imdbId: string, filename?: string): Promise<string | undefined> {
    const torrents = await this.listTorrents();
    const title = await this.lookupTitle(imdbId);
    const matched = pickTorrent(torrents, imdbId, filename, title);
    if (!matched) return undefined;
    const file = pickVideoFile(matched.files ?? []);
    if (!file) return undefined;
    const fileId = typeof file.id === 'number' ? file.id : 0;
    const url = await this.requestDownload(matched.id!, fileId);
    return url;
  }

  private async lookupTitle(imdbId: string): Promise<{ title: string; year?: number } | undefined> {
    try {
      const response = await this.fetchImplementation(
        `https://v2.sg.media-imdb.com/suggestion/t/${encodeURIComponent(imdbId)}.json`,
        { headers: { 'User-Agent': 'IndoSync/0.1.0' } }
      );
      if (!response.ok) return undefined;
      const payload = (await response.json()) as { d?: { id?: string; l?: string; y?: number }[] };
      const entry = (payload.d ?? []).find((item) => item.id === imdbId);
      if (!entry?.l) return undefined;
      return { title: entry.l, year: typeof entry.y === 'number' ? entry.y : undefined };
    } catch {
      return undefined;
    }
  }

  private async listTorrents(): Promise<TorboxTorrent[]> {
    const response = await this.request('/torrents/mylist', { Authorization: `Bearer ${this.apiKey}` });
    if (!response.success) return [];
    const data = response.data;
    if (!Array.isArray(data)) return [];
    return data as TorboxTorrent[];
  }

  private async requestDownload(torrentId: number, fileId: number): Promise<string | undefined> {
    const params = new URLSearchParams({
      token: this.apiKey,
      torrent_id: String(torrentId),
      file_id: String(fileId)
    });
    const response = await this.request(`/torrents/requestdl?${params.toString()}`);
    return typeof response.data === 'string' ? response.data : undefined;
  }

  private async request(path: string, headers: Record<string, string> = {}): Promise<{ success: boolean; data: unknown }> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, { headers });
    if (!response.ok) {
      throw new ProviderError('unavailable', `TorBox API returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as { success?: boolean; data?: unknown; detail?: unknown };
    return { success: payload.success === true, data: payload.data };
  }
}

function pickTorrent(
  torrents: TorboxTorrent[],
  imdbId: string,
  filename?: string,
  title?: { title: string; year?: number }
): TorboxTorrent | undefined {
  const imdbDigits = imdbId.replace(/^tt0*/, '').replace(/^tt/, '');
  const titleTokens = filename
    ? normalizeTokens(filename)
    : title
      ? normalizeTokens(title.title)
      : [];
    const yearToken = title?.year ? String(title.year) : undefined;
    let best: TorboxTorrent | undefined;
    let bestScore = -1;
    for (const torrent of torrents) {
      const name = (torrent.name ?? '').toLowerCase();
      let score = nameScore(name, imdbId, imdbDigits);
      if (titleTokens.length > 0) {
        const fileNames = (torrent.files ?? []).map((f) => `${f.name ?? ''} ${f.short_name ?? ''}`.toLowerCase());
        const fileOverlap = fileNames.reduce((max, fn) => Math.max(max, tokenOverlap(fn, titleTokens)), 0);
        score = Math.max(score, fileOverlap);
      }
      if (yearToken && score > 0 && name.includes(yearToken)) score = Math.max(score, 3);
      if (score > bestScore) {
        bestScore = score;
        best = torrent;
      }
    }
    return bestScore >= (titleTokens.length > 0 ? 1 : 2) ? best : undefined;
  }

function normalizeTokens(value: string): string[] {
  const cleaned = value
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|mov|m4v|webm|ts|srt|vtt)$/, '')
    .replace(/[._\-()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(' ').filter((token) => token.length >= 4 && !/^\d+$/.test(token));
}

function tokenOverlap(text: string, tokens: string[]): number {
  const textTokens = new Set(text.split(/[ ._\-()\[\]]+/).filter((token) => token.length >= 4));
  let matches = 0;
  for (const token of tokens) {
    if (textTokens.has(token)) matches += 1;
  }
  return matches;
}

function nameScore(name: string, imdbId: string, imdbDigits: string): number {
  if (name.includes(imdbId.toLowerCase())) return 10;
  if (name.includes(imdbDigits)) return 6;
  return 0;
}

function pickVideoFile(files: TorboxFile[]): TorboxFile | undefined {
  const videos = files.filter((file) => /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(file.name ?? file.short_name ?? ''));
  if (videos.length === 0) return undefined;
  videos.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  return videos[0];
}
