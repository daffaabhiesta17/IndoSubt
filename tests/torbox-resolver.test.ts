import { describe, expect, it, vi } from 'vitest';
import { TorboxApiResolver } from '../src/subtitles/torbox-resolver.js';
import { ProviderError } from '../src/subtitles/provider.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('TorBox API resolver', () => {
  it('resolves the largest video file of a matching torrent into an HTTP download URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: [
          {
            id: 81017823,
            hash: 'abc',
            name: 'The Matrix 1999 1080p x264',
            files: [
              { id: 0, name: 'matrix.mkv', size: 100 },
              { id: 1, name: 'sample.mp4', size: 10 }
            ]
          }
        ]
      }))
      .mockResolvedValueOnce(jsonResponse({
        d: [{ id: 'tt0133093', l: 'The Matrix', y: 1999 }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: 'https://nexus-198.apac.tb-cdn.pw/dld/abc'
      }));
    const resolver = new TorboxApiResolver('key', { fetchImplementation: fetchMock as typeof fetch });
    const url = await resolver.resolve('tt0133093', 'The.Matrix.1999.1080p.mkv');
    expect(url).toBe('https://nexus-198.apac.tb-cdn.pw/dld/abc');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const second = fetchMock.mock.calls[2][0] as string;
    expect(second).toContain('/torrents/requestdl?');
    expect(second).toContain('token=key');
    expect(second).toContain('torrent_id=81017823');
    expect(second).toContain('file_id=0');
  });

  it('returns undefined when no torrent matches the IMDb id or filename', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: [{ id: 1, name: 'Some Other Show 2020 720p', files: [{ id: 0, name: 'a.mkv', size: 50 }] }]
      }))
      .mockResolvedValueOnce(jsonResponse({ d: [{ id: 'tt9999999', l: 'Totally Different', y: 2020 }] }));
    const resolver = new TorboxApiResolver('key', { fetchImplementation: fetchMock as typeof fetch });
    const url = await resolver.resolve('tt9999999', 'Totally.Different.Film.2020.1080p.mkv');
    expect(url).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips non-video files and returns undefined when only subs exist', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: [{ id: 1, name: 'The Matrix 1999', files: [{ id: 0, name: 'a.srt', size: 5 }] }]
      }))
      .mockResolvedValueOnce(jsonResponse({ d: [{ id: 'tt0133093', l: 'The Matrix', y: 1999 }] }));
    const resolver = new TorboxApiResolver('key', { fetchImplementation: fetchMock as typeof fetch });
    const url = await resolver.resolve('tt0133093');
    expect(url).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws configuration error when no API key is provided', () => {
    expect(() => new TorboxApiResolver('  ')).toThrow(ProviderError);
  });

  it('propagates HTTP failures as unavailable provider errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const resolver = new TorboxApiResolver('key', { fetchImplementation: fetchMock as typeof fetch });
    await expect(resolver.resolve('tt0133093')).rejects.toThrow(/HTTP 500/);
  });
});
