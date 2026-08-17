import { describe, expect, it, vi } from 'vitest';
import type { AudioArtifact, AudioExtractor } from '../src/media/audio-extractor.js';
import { DefaultMediaPreparationService } from '../src/media/preparation-service.js';
import type { MediaSourceResolver } from '../src/media/source-resolver.js';
import type { MediaProbe, MediaProbeResult, MediaSource } from '../src/media/types.js';

const source: MediaSource = {
  kind: 'remote-url',
  url: 'https://media.example.com/movie.mp4'
};

const probeResult: MediaProbeResult = {
  durationMs: 10_000,
  hasAudio: true,
  audioStreams: [{ codec: 'aac', sampleRateHz: 48_000, channels: 2 }],
  container: 'mp4'
};

const audioArtifact: AudioArtifact = {
  contentType: 'audio/wav',
  sampleRateHz: 16_000,
  channels: 1,
  durationMs: 5_000,
  bytes: new Uint8Array([1, 2, 3])
};

function setup(overrides: {
  resolve?: ReturnType<typeof vi.fn>;
  probe?: ReturnType<typeof vi.fn>;
  extract?: ReturnType<typeof vi.fn>;
} = {}) {
  const resolve = overrides.resolve ?? vi.fn().mockResolvedValue(source);
  const probe = overrides.probe ?? vi.fn().mockResolvedValue(probeResult);
  const extract = overrides.extract ?? vi.fn().mockResolvedValue(audioArtifact);
  const sourceResolver: MediaSourceResolver = { resolve };
  const mediaProbe: MediaProbe = { probe };
  const audioExtractor: AudioExtractor = { extract };
  return {
    resolve,
    probe,
    extract,
    service: new DefaultMediaPreparationService(sourceResolver, mediaProbe, audioExtractor)
  };
}

describe('Phase 4C internal media preparation orchestration', () => {
  it('returns undefined without a media source and does no media work', async () => {
    const context = setup({ resolve: vi.fn().mockResolvedValue(undefined) });
    await expect(context.service.prepare({ filename: 'movie.mkv' })).resolves.toBeUndefined();
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.extract).not.toHaveBeenCalled();
  });

  it('resolves, probes, validates audio, and extracts in order', async () => {
    const calls: string[] = [];
    const context = setup({
      resolve: vi.fn().mockImplementation(async () => {
        calls.push('resolve');
        return source;
      }),
      probe: vi.fn().mockImplementation(async () => {
        calls.push('probe');
        return probeResult;
      }),
      extract: vi.fn().mockImplementation(async () => {
        calls.push('extract');
        return audioArtifact;
      })
    });

    await expect(
      context.service.prepare(
        { videoUrl: source.url },
        { sampleRateHz: 16_000, channels: 1, maxDurationMs: 5_000 }
      )
    ).resolves.toEqual({ source, probe: probeResult, audio: audioArtifact });
    expect(calls).toEqual(['resolve', 'probe', 'extract']);
    expect(context.probe).toHaveBeenCalledWith(source);
    expect(context.extract).toHaveBeenCalledWith(source, {
      sampleRateHz: 16_000,
      channels: 1,
      maxDurationMs: 5_000
    });
  });

  it.each([
    { hasAudio: false, audioStreams: [] },
    { hasAudio: true, audioStreams: [] }
  ])('rejects no-audio probe result %o without extraction', async (audioState) => {
    const context = setup({
      probe: vi.fn().mockResolvedValue({ ...probeResult, ...audioState })
    });
    await expect(context.service.prepare({ videoUrl: source.url })).rejects.toMatchObject({
      code: 'invalid_source',
      message: 'Media source does not contain an audio stream.'
    });
    expect(context.extract).not.toHaveBeenCalled();
  });

  it('propagates resolver rejection before probing or extraction', async () => {
    const rejection = Object.assign(new Error('forbidden'), { code: 'forbidden_source' });
    const context = setup({ resolve: vi.fn().mockRejectedValue(rejection) });
    await expect(context.service.prepare({ videoUrl: 'https://attacker.example/movie' })).rejects.toBe(
      rejection
    );
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.extract).not.toHaveBeenCalled();
  });

  it('propagates probe failure without extracting', async () => {
    const failure = Object.assign(new Error('probe failure'), { code: 'process_failed' });
    const context = setup({ probe: vi.fn().mockRejectedValue(failure) });
    await expect(context.service.prepare({ videoUrl: source.url })).rejects.toBe(failure);
    expect(context.extract).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'output_too_large', 'process_failed', 'malformed_output'])(
    'propagates controlled extraction failure %s',
    async (code) => {
      const failure = Object.assign(new Error(code), { code });
      const context = setup({ extract: vi.fn().mockRejectedValue(failure) });
      await expect(context.service.prepare({ videoUrl: source.url })).rejects.toBe(failure);
    }
  );

  it('returns the exact source, probe result, and artifact without mutation', async () => {
    const context = setup();
    const result = await context.service.prepare({ videoUrl: source.url });
    expect(result?.source).toBe(source);
    expect(result?.probe).toBe(probeResult);
    expect(result?.audio).toBe(audioArtifact);
  });
});
