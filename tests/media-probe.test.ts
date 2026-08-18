import { describe, expect, it, vi } from 'vitest';
import { FfprobeMediaProbe, parseFfprobeOutput } from '../src/media/ffprobe.js';
import type { ProcessRunner } from '../src/media/process-runner.js';
import { RemoteMediaUrlPolicy } from '../src/media/url-policy.js';

function setup(stdout: string, exitCode = 0) {
  const runner: ProcessRunner = {
    run: vi.fn().mockResolvedValue({ stdout, stderr: '', exitCode })
  };
  const urlPolicy = new RemoteMediaUrlPolicy({
    allowedHosts: ['media.example.com'],
    resolveHost: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  });
  return {
    runner,
    probe: new FfprobeMediaProbe({ runner, urlPolicy, executable: 'ffprobe-test' })
  };
}

describe('ffprobe media probe', () => {
  it('parses duration, container, and audio metadata', async () => {
    const { probe } = setup(
      JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 6 }
        ],
        format: { duration: '123.456', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }
      })
    );

    await expect(
      probe.probe({ kind: 'remote-url', url: 'https://media.example.com/movie.mp4' })
    ).resolves.toEqual({
      durationMs: 123_456,
      hasAudio: true,
      audioStreams: [{ codec: 'aac', sampleRateHz: 48_000, channels: 6 }],
      container: 'mov,mp4,m4a,3gp,3g2,mj2'
    });
  });

  it('supports media without audio', () => {
    expect(
      parseFfprobeOutput(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'h264' }],
          format: { duration: '10', format_name: 'matroska,webm' }
        })
      )
    ).toEqual({
      durationMs: 10_000,
      hasAudio: false,
      audioStreams: [],
      container: 'matroska,webm'
    });
  });

  it('allows unavailable optional metadata', () => {
    expect(parseFfprobeOutput(JSON.stringify({ streams: [], format: {} }))).toEqual({
      durationMs: undefined,
      hasAudio: false,
      audioStreams: [],
      container: undefined
    });
  });

  it.each(['not-json', 'null', '[]', '{"streams":{}}', '{"format":[]}'])(
    'rejects malformed ffprobe output %s',
    (output) => {
      expect(() => parseFfprobeOutput(output)).toThrowError(
        expect.objectContaining({ code: 'malformed_output' })
      );
    }
  );

  it('rejects malformed entries inside the stream array', () => {
    expect(() =>
      parseFfprobeOutput(JSON.stringify({ streams: [null], format: {} }))
    ).toThrowError(expect.objectContaining({ code: 'malformed_output' }));
  });

  it('parses multiple audio streams without dropping their order', () => {
    expect(
      parseFfprobeOutput(
        JSON.stringify({
          streams: [
            { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
            { codec_type: 'audio', codec_name: 'ac3', sample_rate: '48000', channels: 6 }
          ],
          format: { duration: '5' }
        })
      ).audioStreams
    ).toEqual([
      { codec: 'aac', sampleRateHz: 48_000, channels: 2 },
      { codec: 'ac3', sampleRateHz: 48_000, channels: 6 }
    ]);
  });

  it('rejects malformed audio and duration metadata', () => {
    expect(() =>
      parseFfprobeOutput(
        JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: 'not-a-number' }] })
      )
    ).toThrowError(expect.objectContaining({ code: 'malformed_output' }));
    expect(() => parseFfprobeOutput(JSON.stringify({ format: { duration: '-1' } }))).toThrowError(
      expect.objectContaining({ code: 'malformed_output' })
    );
  });

  it('uses bounded ffprobe arguments and keeps the URL as one literal argument', async () => {
    const { probe, runner } = setup(JSON.stringify({ streams: [], format: {} }));
    const url = 'https://media.example.com/movie.mp4?name=x;whoami&other=$(cmd)';
    await probe.probe({ kind: 'remote-url', url });

    expect(runner.run).toHaveBeenCalledTimes(1);
    const [executable, args, options] = vi.mocked(runner.run).mock.calls[0];
    expect(executable).toBe('ffprobe-test');
    expect(args.at(-1)).toBe(url);
    expect(args).toContain('-protocol_whitelist');
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('http,https,tcp,tls');
    expect(args).toContain('-follow_redirects');
    expect(args[args.indexOf('-follow_redirects') + 1]).toBe('0');
    expect(args).toContain('-probesize');
    expect(args).toContain('-analyzeduration');
    expect(args).toContain('-rw_timeout');
    expect(options).toEqual({ timeoutMs: 8_000, maxOutputBytes: 1_048_576 });
  });

  it('maps non-zero ffprobe exits to a safe error', async () => {
    const { probe } = setup('', 1);
    await expect(
      probe.probe({ kind: 'remote-url', url: 'https://media.example.com/movie.mp4' })
    ).rejects.toMatchObject({ code: 'process_failed' });
  });

  it('does not invoke the runner when URL validation fails', async () => {
    const { probe, runner } = setup('{}');
    await expect(
      probe.probe({ kind: 'remote-url', url: 'http://127.0.0.1/private.mp4' })
    ).rejects.toMatchObject({ code: 'forbidden_source' });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

