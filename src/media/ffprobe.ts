import type { ProcessRunner } from './process-runner.js';
import type { RemoteMediaUrlPolicy } from './url-policy.js';
import {
  MediaProbeError,
  type MediaAudioStream,
  type MediaProbe,
  type MediaProbeResult,
  type MediaSource
} from './types.js';

export interface FfprobeMediaProbeOptions {
  runner: ProcessRunner;
  urlPolicy: RemoteMediaUrlPolicy;
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  probeSizeBytes?: number;
  analyzeDurationUs?: number;
  networkReadTimeoutUs?: number;
}

interface FfprobeStream {
  codec_type?: unknown;
  codec_name?: unknown;
  sample_rate?: unknown;
  channels?: unknown;
}

interface FfprobeFormat {
  duration?: unknown;
  format_name?: unknown;
}

interface FfprobeOutput {
  streams?: unknown;
  format?: unknown;
}

export class FfprobeMediaProbe implements MediaProbe {
  private readonly runner: ProcessRunner;
  private readonly urlPolicy: RemoteMediaUrlPolicy;
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly probeSizeBytes: number;
  private readonly analyzeDurationUs: number;
  private readonly networkReadTimeoutUs: number;

  constructor(options: FfprobeMediaProbeOptions) {
    this.runner = options.runner;
    this.urlPolicy = options.urlPolicy;
    this.executable = options.executable ?? 'ffprobe';
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 8_000, 'timeout');
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1_048_576, 'output limit');
    this.probeSizeBytes = positiveInteger(options.probeSizeBytes ?? 5_000_000, 'probe size');
    this.analyzeDurationUs = positiveInteger(
      options.analyzeDurationUs ?? 5_000_000,
      'analyze duration'
    );
    this.networkReadTimeoutUs = positiveInteger(
      options.networkReadTimeoutUs ?? 5_000_000,
      'network read timeout'
    );
  }

  async probe(source: MediaSource): Promise<MediaProbeResult> {
    const validated = await this.urlPolicy.validate(source.url);
    const args = this.argumentsFor(validated.url.toString());
    const result = await this.runner.run(this.executable, args, {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes
    });

    if (result.exitCode !== 0) {
      throw new MediaProbeError('process_failed', 'ffprobe could not inspect the media source.');
    }

    return parseFfprobeOutput(result.stdout);
  }

  private argumentsFor(url: string): string[] {
    return [
      '-v',
      'error',
      '-of',
      'json',
      '-show_entries',
      'format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels',
      '-probesize',
      String(this.probeSizeBytes),
      '-analyzeduration',
      String(this.analyzeDurationUs),
      '-rw_timeout',
      String(this.networkReadTimeoutUs),
      '-protocol_whitelist',
      'http,https,tcp,tls',
      '-follow_redirects',
      '0',
      url
    ];
  }
}

export function parseFfprobeOutput(output: string): MediaProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new MediaProbeError('malformed_output', 'ffprobe returned malformed JSON.');
  }

  if (!isRecord(parsed)) {
    throw new MediaProbeError('malformed_output', 'ffprobe output must be an object.');
  }

  const payload = parsed as FfprobeOutput;
  if (payload.streams !== undefined && !Array.isArray(payload.streams)) {
    throw new MediaProbeError('malformed_output', 'ffprobe streams output is malformed.');
  }
  if (payload.format !== undefined && !isRecord(payload.format)) {
    throw new MediaProbeError('malformed_output', 'ffprobe format output is malformed.');
  }

  const streams = payload.streams ?? [];
  if (streams.some((stream) => !isRecord(stream))) {
    throw new MediaProbeError('malformed_output', 'ffprobe stream entry is malformed.');
  }
  const audioStreams = streams
    .filter((stream) => stream.codec_type === 'audio')
    .map(parseAudioStream);
  const format = payload.format as FfprobeFormat | undefined;

  return {
    durationMs: parseDurationMs(format?.duration),
    hasAudio: audioStreams.length > 0,
    audioStreams,
    container: nonEmptyString(format?.format_name)
  };
}

function parseAudioStream(stream: Record<string, unknown>): MediaAudioStream {
  return {
    codec: nonEmptyString(stream.codec_name),
    sampleRateHz: positiveSafeInteger(stream.sample_rate),
    channels: positiveSafeInteger(stream.channels)
  };
}

function parseDurationMs(value: unknown): number | undefined {
  if (value === undefined || value === 'N/A') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new MediaProbeError('malformed_output', 'ffprobe duration is malformed.');
  }
  const seconds = Number(value);
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(milliseconds)) {
    throw new MediaProbeError('malformed_output', 'ffprobe duration is malformed.');
  }
  return milliseconds;
}

function positiveSafeInteger(value: unknown): number | undefined {
  if (value === undefined || value === 'N/A') return undefined;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MediaProbeError('malformed_output', 'ffprobe audio metadata is malformed.');
  }
  return parsed;
}

function nonEmptyString(value: unknown): string | undefined {
  if (value === undefined || value === 'N/A') return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new MediaProbeError('malformed_output', 'ffprobe text metadata is malformed.');
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Media probe ${label} must be a positive safe integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

