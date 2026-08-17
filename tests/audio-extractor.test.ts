import { describe, expect, it, vi } from 'vitest';
import {
  FfmpegAudioExtractor,
  type AudioExtractionOptions
} from '../src/media/audio-extractor.js';
import type { ProcessRunner, ProcessRunResult } from '../src/media/process-runner.js';
import { RemoteMediaUrlPolicy } from '../src/media/url-policy.js';

function waveBytes(
  sampleRateHz = 16_000,
  channels = 1,
  sampleFrames = 16
): Uint8Array {
  const dataSize = sampleFrames * channels * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from('RIFF'), 0);
  view.setUint32(4, 36 + dataSize, true);
  bytes.set(Buffer.from('WAVE'), 8);
  bytes.set(Buffer.from('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  bytes.set(Buffer.from('data'), 36);
  view.setUint32(40, dataSize, true);
  return bytes;
}

function setup(result?: Partial<ProcessRunResult>) {
  const runner: ProcessRunner = {
    run: vi.fn().mockResolvedValue({
      stdout: '',
      stdoutBytes: waveBytes(),
      stderr: '',
      exitCode: 0,
      ...result
    })
  };
  const urlPolicy = new RemoteMediaUrlPolicy({
    allowedHosts: ['media.example.com'],
    resolveHost: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  });
  return {
    runner,
    extractor: new FfmpegAudioExtractor({
      runner,
      urlPolicy,
      executable: 'ffmpeg-test'
    })
  };
}

async function extract(options?: AudioExtractionOptions) {
  const context = setup();
  const artifact = await context.extractor.extract(
    { kind: 'remote-url', url: 'https://media.example.com/movie.mp4?x=$(cmd);whoami' },
    options
  );
  return { ...context, artifact };
}

describe('bounded ffmpeg audio extractor', () => {
  it('extracts mono 16 kHz WAV with bounded defaults', async () => {
    const { artifact, runner } = await extract();
    expect(artifact).toEqual({
      contentType: 'audio/wav',
      sampleRateHz: 16_000,
      channels: 1,
      durationMs: 1,
      bytes: waveBytes()
    });

    const [executable, args, runOptions] = vi.mocked(runner.run).mock.calls[0];
    expect(executable).toBe('ffmpeg-test');
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args[args.indexOf('-ar') + 1]).toBe('16000');
    expect(args[args.indexOf('-t') + 1]).toBe('120.000');
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('http,https,tcp,tls');
    expect(args[args.indexOf('-follow_redirects') + 1]).toBe('0');
    expect(args.at(-1)).toBe('pipe:1');
    expect(runOptions).toEqual({ timeoutMs: 15_000, maxOutputBytes: 4_000_000 });
  });

  it('keeps the untrusted URL as one literal process argument', async () => {
    const { runner } = await extract();
    const args = vi.mocked(runner.run).mock.calls[0][1];
    const inputIndex = args.indexOf('-i');
    expect(args[inputIndex + 1]).toBe(
      'https://media.example.com/movie.mp4?x=$(cmd);whoami'
    );
    expect(args.filter((arg) => arg.includes('$(cmd)'))).toHaveLength(1);
  });

  it('supports bounded custom extraction options', async () => {
    const context = setup({ stdoutBytes: waveBytes(8_000, 2) });
    const artifact = await context.extractor.extract(
      { kind: 'remote-url', url: 'https://media.example.com/movie.mp4' },
      {
        sampleRateHz: 8_000,
        channels: 2,
        maxDurationMs: 5_000,
        maxOutputBytes: 200_000
      }
    );
    const runner = context.runner;
    expect(artifact).toMatchObject({ sampleRateHz: 8_000, channels: 2, durationMs: 2 });
    const args = vi.mocked(runner.run).mock.calls[0][1];
    expect(args[args.indexOf('-t') + 1]).toBe('5.000');
    expect(vi.mocked(runner.run).mock.calls[0][2].maxOutputBytes).toBe(200_000);
  });

  it.each([
    { sampleRateHz: 7_999 },
    { sampleRateHz: 48_001 },
    { channels: 0 },
    { channels: 3 },
    { maxDurationMs: 0 },
    { maxDurationMs: 300_001 },
    { maxOutputBytes: 0 }
  ])('rejects unsafe extraction options %o', async (options) => {
    const { extractor, runner } = setup();
    await expect(
      extractor.extract(
        { kind: 'remote-url', url: 'https://media.example.com/movie.mp4' },
        options
      )
    ).rejects.toBeInstanceOf(Error);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects forbidden sources before process execution', async () => {
    const { extractor, runner } = setup();
    await expect(
      extractor.extract({ kind: 'remote-url', url: 'file:///tmp/audio.wav' })
    ).rejects.toMatchObject({ code: 'invalid_source' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('maps process failure to a safe error', async () => {
    const { extractor } = setup({ exitCode: 1 });
    await expect(
      extractor.extract({ kind: 'remote-url', url: 'https://media.example.com/movie.mp4' })
    ).rejects.toMatchObject({ code: 'process_failed' });
  });

  it('rejects malformed or missing WAV bytes', async () => {
    for (const stdoutBytes of [undefined, new Uint8Array(44), new Uint8Array(10)]) {
      const { extractor } = setup({ stdoutBytes });
      await expect(
        extractor.extract({ kind: 'remote-url', url: 'https://media.example.com/movie.mp4' })
      ).rejects.toMatchObject({ code: 'malformed_output' });
    }
  });

  it('propagates runner timeout and output-limit errors', async () => {
    const urlPolicy = new RemoteMediaUrlPolicy({
      allowedHosts: ['media.example.com'],
      resolveHost: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    });

    for (const code of ['timeout', 'output_too_large'] as const) {
      const runner: ProcessRunner = {
        run: vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }))
      };
      const extractor = new FfmpegAudioExtractor({ runner, urlPolicy });
      await expect(
        extractor.extract({ kind: 'remote-url', url: 'https://media.example.com/movie.mp4' })
      ).rejects.toMatchObject({ code });
    }
  });

  it('copies process output into an independent audio artifact', async () => {
    const original = waveBytes();
    const { extractor } = setup({ stdoutBytes: original });
    const artifact = await extractor.extract({
      kind: 'remote-url',
      url: 'https://media.example.com/movie.mp4'
    });
    artifact.bytes[0] = 0;
    expect(original[0]).toBe('R'.charCodeAt(0));
  });
});



