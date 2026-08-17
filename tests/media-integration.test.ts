import { describe, expect, it, vi } from 'vitest';
import { DefaultMediaInspectionService } from '../src/media/inspection-service.js';
import { TrustedMediaSourceResolver } from '../src/media/source-resolver.js';
import type { MediaProbe, MediaProbeResult } from '../src/media/types.js';
import { RemoteMediaUrlPolicy, type HostResolver } from '../src/media/url-policy.js';

function resolver(resolveHost?: HostResolver) {
  return new TrustedMediaSourceResolver(
    new RemoteMediaUrlPolicy({
      allowedHosts: ['media.example.com'],
      resolveHost:
        resolveHost ??
        vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    })
  );
}

describe('trusted media source resolver', () => {
  it('returns undefined when videoUrl is absent', async () => {
    await expect(resolver().resolve({ filename: 'movie.mkv' })).resolves.toBeUndefined();
  });

  it('resolves only a trusted remote URL', async () => {
    await expect(
      resolver().resolve({ videoUrl: 'https://media.example.com/movie.mp4' })
    ).resolves.toEqual({
      kind: 'remote-url',
      url: 'https://media.example.com/movie.mp4'
    });
  });

  it.each([
    'not a url',
    'file:///tmp/movie.mp4',
    'https://attacker.example/movie.mp4',
    'https://media.example.com:8080/movie.mp4',
    'https://user:pass@media.example.com/movie.mp4',
    'https://media.example.com/movie.mp4#fragment'
  ])('rejects invalid or forbidden source %s', async (videoUrl) => {
    await expect(resolver().resolve({ videoUrl })).rejects.toBeInstanceOf(Error);
  });

  it('rejects private and mixed DNS results', async () => {
    await expect(
      resolver(vi.fn().mockResolvedValue([{ address: '10.0.0.1', family: 4 }])).resolve({
        videoUrl: 'https://media.example.com/movie.mp4'
      })
    ).rejects.toMatchObject({ code: 'forbidden_source' });

    await expect(
      resolver(
        vi.fn().mockResolvedValue([
          { address: '93.184.216.34', family: 4 },
          { address: '192.168.1.1', family: 4 }
        ])
      ).resolve({ videoUrl: 'https://media.example.com/movie.mp4' })
    ).rejects.toMatchObject({ code: 'forbidden_source' });
  });
});

describe('media inspection service', () => {
  const result: MediaProbeResult = {
    durationMs: 10_000,
    hasAudio: true,
    audioStreams: [{ codec: 'aac', sampleRateHz: 48_000, channels: 2 }],
    container: 'mp4'
  };

  it('returns undefined and does not probe when no source exists', async () => {
    const mediaProbe: MediaProbe = { probe: vi.fn() };
    const service = new DefaultMediaInspectionService(resolver(), mediaProbe);
    await expect(service.inspect({})).resolves.toBeUndefined();
    expect(mediaProbe.probe).not.toHaveBeenCalled();
  });

  it('passes a resolved source to the probe and returns the result unchanged', async () => {
    const mediaProbe: MediaProbe = { probe: vi.fn().mockResolvedValue(result) };
    const service = new DefaultMediaInspectionService(resolver(), mediaProbe);
    await expect(
      service.inspect({ videoUrl: 'https://media.example.com/movie.mp4' })
    ).resolves.toBe(result);
    expect(mediaProbe.probe).toHaveBeenCalledWith({
      kind: 'remote-url',
      url: 'https://media.example.com/movie.mp4'
    });
  });

  it('propagates policy and probe failures', async () => {
    const mediaProbe: MediaProbe = {
      probe: vi.fn().mockRejectedValue(new Error('probe failed'))
    };
    const service = new DefaultMediaInspectionService(resolver(), mediaProbe);

    await expect(
      service.inspect({ videoUrl: 'https://attacker.example/movie.mp4' })
    ).rejects.toMatchObject({ code: 'forbidden_source' });
    await expect(
      service.inspect({ videoUrl: 'https://media.example.com/movie.mp4' })
    ).rejects.toThrow('probe failed');
  });
});
