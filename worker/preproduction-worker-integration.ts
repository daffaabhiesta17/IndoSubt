import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioExtractor } from '../src/media/audio-extractor.js';
import type { MediaProbe } from '../src/media/types.js';
import type { SubtitleProvider } from '../src/subtitles/provider.js';
import type { SynchronizationTask } from '../src/subtitles/synchronization-context.js';
import { approvedMappingFromResult } from '../src/subtitles/synchronization-result-provenance.js';
import {
  CalibratedSynchronizationWorker,
  type SynchronizationEvidenceEngine
} from '../src/subtitles/synchronization-worker.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = 'indosync-asr-worker:feasibility';
const now = 1_000_000;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function runFixture(name: string, directory: string) {
  const fixture = path.resolve(root, directory);
  const outputDirectory = path.resolve(root, 'benchmark-output');
  const resultFile = `worker-${name}.json`;
  const resultPath = path.join(outputDirectory, resultFile);
  rmSync(resultPath, { force: true });

  const provider: SubtitleProvider = {
    name: 'fixture-provider',
    search: async () => [],
    download: async () => ({
      content: readFileSync(path.join(fixture, 'subtitle-id.vtt'), 'utf8'),
      contentType: 'text/vtt; charset=utf-8'
    })
  };
  const mediaProbe: MediaProbe = {
    probe: async () => {
      const parsed = JSON.parse(docker(
        'run', '--rm', '--entrypoint', 'ffprobe', '-v', `${fixture}:/fixture:ro`, image,
        '-v', 'error', '-show_entries',
        'format=duration,format_name:stream=codec_name,codec_type,sample_rate,channels',
        '-of', 'json', '/fixture/audio.wav'
      ));
      const streams = parsed.streams.filter((stream: any) => stream.codec_type === 'audio');
      return {
        durationMs: Math.round(Number(parsed.format.duration) * 1000),
        hasAudio: streams.length > 0,
        audioStreams: streams.map((stream: any) => ({
          codec: stream.codec_name,
          sampleRateHz: Number(stream.sample_rate),
          channels: stream.channels
        })),
        container: parsed.format.format_name
      };
    }
  };
  const audioExtractor: AudioExtractor = {
    extract: async () => {
      const bytes = execFileSync('docker', [
        'run', '--rm', '--entrypoint', 'ffmpeg', '-v', `${fixture}:/fixture:ro`, image,
        '-v', 'error', '-nostdin', '-i', '/fixture/audio.wav', '-map', '0:a:0',
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'
      ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
      return {
        contentType: 'audio/wav', sampleRateHz: 16_000, channels: 1,
        bytes: new Uint8Array(bytes)
      };
    }
  };
  const evidenceEngine: SynchronizationEvidenceEngine = {
    generate: async () => {
      docker(
        'run', '--rm', '--gpus', 'all', '--entrypoint', 'python',
        '-v', `${fixture}:/fixture:ro`,
        '-v', `${path.resolve(root, 'worker')}:/experiment:ro`,
        '-v', `${outputDirectory}:/output`, image,
        '/experiment/crosslingual_benchmark.py', '--fixture', '/fixture',
        '--output', `/output/${resultFile}`
      );
      const result = JSON.parse(readFileSync(resultPath, 'utf8'));
      return {
        evidence: result.evidence,
        confidence: Math.min(...result.evidence.map((item: any) => item.confidence)),
        method: 'labse-monotonic-v2'
      };
    }
  };
  const worker = new CalibratedSynchronizationWorker({
    provider, mediaProbe, audioExtractor, evidenceEngine, now: () => now
  });
  const task: SynchronizationTask = {
    id: `fixture_${name}`, mediaSource: { kind: 'remote-url', url: `https://fixture.invalid/${name}.wav` },
    provider: provider.name, providerReference: name, language: 'id', status: 'processing',
    createdAt: now - 1, expiresAt: now + 60_000
  };
  const first = await worker.process(structuredClone(task));
  const second = await worker.process(structuredClone(task));
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error(`${name} repeated invocation diverged.`);
  return {
    name,
    state: first.provenance?.kind === 'calibrated-model-selection' ? first.provenance.state : undefined,
    evidenceCount: first.evidence?.length,
    approvedMapping: first.approvedMapping,
    downstreamMapping: approvedMappingFromResult(first),
    deterministicRepeat: true,
    legacyMappingPresent: Object.prototype.hasOwnProperty.call(first, 'mapping')
  };
}

const results = [];
results.push(await runFixture('development', 'fixture/covost2-en-id'));
results.push(await runFixture('holdout', 'fixture/covost2-en-id-holdout'));
console.log(JSON.stringify(results, null, 2));
