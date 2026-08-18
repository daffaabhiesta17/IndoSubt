import type { ProcessRunner } from './process-runner.js';
import type { RemoteMediaUrlPolicy } from './url-policy.js';
import { MediaProbeError, type MediaSource } from './types.js';

export interface AudioExtractionOptions {
  startMs?: number;
  sampleRateHz?: number;
  channels?: number;
  maxDurationMs?: number;
  maxOutputBytes?: number;
}

export interface AudioArtifact {
  contentType: 'audio/wav' | 'audio/pcm';
  sampleRateHz: number;
  channels: number;
  durationMs?: number;
  bytes: Uint8Array;
}

export interface AudioExtractor {
  extract(source: MediaSource, options?: AudioExtractionOptions): Promise<AudioArtifact>;
}

export interface FfmpegAudioExtractorOptions {
  runner: ProcessRunner;
  urlPolicy: RemoteMediaUrlPolicy;
  executable?: string;
  timeoutMs?: number;
  networkReadTimeoutUs?: number;
  defaultSampleRateHz?: number;
  defaultChannels?: number;
  defaultMaxDurationMs?: number;
  defaultMaxOutputBytes?: number;
}

export class FfmpegAudioExtractor implements AudioExtractor {
  private readonly runner: ProcessRunner;
  private readonly urlPolicy: RemoteMediaUrlPolicy;
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly networkReadTimeoutUs: number;
  private readonly defaultSampleRateHz: number;
  private readonly defaultChannels: number;
  private readonly defaultMaxDurationMs: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(options: FfmpegAudioExtractorOptions) {
    this.runner = options.runner;
    this.urlPolicy = options.urlPolicy;
    this.executable = options.executable ?? 'ffmpeg';
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, 'timeout');
    this.networkReadTimeoutUs = positiveInteger(
      options.networkReadTimeoutUs ?? 5_000_000,
      'network read timeout'
    );
    this.defaultSampleRateHz = positiveInteger(
      options.defaultSampleRateHz ?? 16_000,
      'sample rate'
    );
    this.defaultChannels = boundedInteger(options.defaultChannels ?? 1, 1, 2, 'channels');
    this.defaultMaxDurationMs = boundedInteger(
      options.defaultMaxDurationMs ?? 120_000,
      1,
      300_000,
      'maximum duration'
    );
    this.defaultMaxOutputBytes = positiveInteger(
      options.defaultMaxOutputBytes ?? 4_000_000,
      'maximum output size'
    );
  }

  async extract(
    source: MediaSource,
    options: AudioExtractionOptions = {}
  ): Promise<AudioArtifact> {
    const startMs = nonNegativeInteger(options.startMs ?? 0, 'start time');
    const sampleRateHz = boundedInteger(
      options.sampleRateHz ?? this.defaultSampleRateHz,
      8_000,
      48_000,
      'sample rate'
    );
    const channels = boundedInteger(options.channels ?? this.defaultChannels, 1, 2, 'channels');
    const maxDurationMs = boundedInteger(
      options.maxDurationMs ?? this.defaultMaxDurationMs,
      1,
      300_000,
      'maximum duration'
    );
    if (!Number.isSafeInteger(startMs + maxDurationMs)) {
      throw new Error('Audio extraction window must remain within the safe integer range.');
    }
    const maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? this.defaultMaxOutputBytes,
      44,
      16_000_000,
      'maximum output size'
    );

    const validated = await this.urlPolicy.validate(source.url);
    const result = await this.runner.run(
      this.executable,
      this.argumentsFor(validated.url.toString(), startMs, sampleRateHz, channels, maxDurationMs),
      { timeoutMs: this.timeoutMs, maxOutputBytes }
    );

    if (result.exitCode !== 0) {
      throw new MediaProbeError('process_failed', 'ffmpeg could not extract bounded audio.');
    }
    const bytes = result.stdoutBytes;
    if (!bytes) {
      throw new MediaProbeError('malformed_output', 'ffmpeg did not return valid WAV audio.');
    }
    const durationMs = parseWaveDuration(bytes, sampleRateHz, channels);
    if (durationMs > maxDurationMs) {
      throw new MediaProbeError(
        'malformed_output',
        'ffmpeg WAV duration exceeded the requested extraction bound.'
      );
    }

    return {
      contentType: 'audio/wav',
      sampleRateHz,
      channels,
      durationMs,
      bytes: new Uint8Array(bytes)
    };
  }

  private argumentsFor(
    url: string,
    startMs: number,
    sampleRateHz: number,
    channels: number,
    maxDurationMs: number
  ): string[] {
    return [
      '-v',
      'error',
      '-nostdin',
      '-protocol_whitelist',
      'http,https,tcp,tls',
      '-rw_timeout',
      String(this.networkReadTimeoutUs),
      '-follow_redirects',
      '0',
      '-i',
      url,
      // Output seeking decodes up to the requested timestamp, but provides the
      // timestamp precision required by future synchronization evidence.
      '-ss',
      formatDurationSeconds(startMs),
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-ac',
      String(channels),
      '-ar',
      String(sampleRateHz),
      '-t',
      formatDurationSeconds(maxDurationMs),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1'
    ];
  }
}

function parseWaveDuration(
  bytes: Uint8Array,
  expectedSampleRateHz: number,
  expectedChannels: number
): number {
  if (bytes.byteLength < 44 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') {
    throw new MediaProbeError('malformed_output', 'ffmpeg did not return valid WAV audio.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let formatFound = false;
  let dataBytes: number | undefined;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset);
    const declaredSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const remaining = bytes.byteLength - dataStart;
    const chunkSize = declaredSize === 0xffffffff ? remaining : declaredSize;
    if (chunkSize > remaining) {
      throw new MediaProbeError('malformed_output', 'ffmpeg returned a truncated WAV artifact.');
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new MediaProbeError('malformed_output', 'ffmpeg returned malformed WAV format metadata.');
      }
      const audioFormat = view.getUint16(dataStart, true);
      const channels = view.getUint16(dataStart + 2, true);
      const sampleRateHz = view.getUint32(dataStart + 4, true);
      const byteRate = view.getUint32(dataStart + 8, true);
      const blockAlign = view.getUint16(dataStart + 12, true);
      const bitsPerSample = view.getUint16(dataStart + 14, true);
      if (
        audioFormat !== 1 ||
        channels !== expectedChannels ||
        sampleRateHz !== expectedSampleRateHz ||
        bitsPerSample !== 16 ||
        blockAlign !== channels * 2 ||
        byteRate !== sampleRateHz * blockAlign
      ) {
        throw new MediaProbeError('malformed_output', 'ffmpeg WAV format does not match the request.');
      }
      formatFound = true;
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
      break;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  if (!formatFound || dataBytes === undefined || dataBytes === 0) {
    throw new MediaProbeError('malformed_output', 'ffmpeg WAV artifact is incomplete.');
  }

  const durationMs = Math.round(
    (dataBytes / (expectedChannels * 2 * expectedSampleRateHz)) * 1_000
  );
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new MediaProbeError('malformed_output', 'ffmpeg WAV duration is invalid.');
  }
  return durationMs;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + 4));
}

function formatDurationSeconds(durationMs: number): string {
  const millisecondsValue = BigInt(durationMs);
  const seconds = millisecondsValue / 1_000n;
  const milliseconds = millisecondsValue % 1_000n;
  if (milliseconds === 0n) return seconds.toString();
  return `${seconds}.${milliseconds.toString().padStart(3, '0')}`;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Audio extraction ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Audio extraction ${label} must be a positive safe integer.`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Audio extraction ${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

