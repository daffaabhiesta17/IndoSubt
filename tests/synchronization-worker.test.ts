import { describe, expect, it, vi } from 'vitest';
import type { AudioArtifact } from '../src/media/audio-extractor.js';
import type { MediaProbeResult } from '../src/media/types.js';
import { approvedMappingFromResult } from '../src/subtitles/synchronization-result-provenance.js';
import type { SynchronizationEvidence } from '../src/subtitles/synchronization-evidence.js';
import type { SynchronizationTask } from '../src/subtitles/synchronization-context.js';
import {
  CalibratedSynchronizationWorker,
  type SynchronizationEvidenceEngine
} from '../src/subtitles/synchronization-worker.js';

const now = 1_000_000;
const task: SynchronizationTask = {
  id: 'task_123', mediaSource: { kind: 'remote-url', url: 'https://media.example/movie.mp4' },
  provider: 'opensubtitles', providerReference: '42', language: 'id', status: 'processing',
  createdAt: now - 1_000, expiresAt: now + 60_000
};
const media: MediaProbeResult = {
  durationMs: 60_288, hasAudio: true,
  audioStreams: [{ codec: 'flac', sampleRateHz: 16_000, channels: 1 }], container: 'flac'
};
const audio: AudioArtifact = {
  contentType: 'audio/wav', sampleRateHz: 16_000, channels: 1,
  durationMs: 60_288, bytes: new Uint8Array([1, 2, 3])
};
const vectors = [
  [2604, 1870], [12360, 12040], [19044, 20850], [26808, 27100],
  [32004, 33270], [38700, 37530], [50844, 49570], [57252, 56390]
] as const;
function evidence(values: readonly (readonly [number, number])[] = vectors): SynchronizationEvidence[] {
  return values.map(([sourceAnchorMs, referenceAnchorMs], index) => ({
    source: { cueIndex: index, startMs: Math.max(0, sourceAnchorMs - 100), endMs: sourceAnchorMs + 100 },
    reference: { startMs: Math.max(0, referenceAnchorMs - 100), endMs: referenceAnchorMs + 100 },
    sourceAnchorMs, referenceAnchorMs, confidence: 0.82, method: 'labse-monotonic-v2'
  }));
}
function setup(output = { evidence: evidence(), confidence: 0.82, method: 'labse-monotonic-v2' }) {
  const provider = {
    name: 'opensubtitles', search: vi.fn(),
    download: vi.fn().mockResolvedValue({
      content: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSatu',
      contentType: 'text/vtt; charset=utf-8' as const
    })
  };
  const mediaProbe = { probe: vi.fn().mockResolvedValue(media) };
  const audioExtractor = { extract: vi.fn().mockResolvedValue(audio) };
  const evidenceEngine: SynchronizationEvidenceEngine = { generate: vi.fn().mockResolvedValue(output) };
  const worker = new CalibratedSynchronizationWorker({
    provider, mediaProbe, audioExtractor, evidenceEngine, now: () => now
  });
  return { worker, provider, mediaProbe, audioExtractor, evidenceEngine };
}

describe('calibrated synchronization worker lifecycle', () => {
  it('runs acquisition through calibrated approval and preserves evidence/provenance', async () => {
    const context = setup();
    const result = await context.worker.process(structuredClone(task));
    expect(context.provider.download).toHaveBeenCalledWith('42');
    expect(context.mediaProbe.probe).toHaveBeenCalledWith(task.mediaSource);
    expect(context.audioExtractor.extract).toHaveBeenCalledWith(task.mediaSource, undefined);
    expect(context.evidenceEngine.generate).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: task.id }), cues: [{ text: 'Satu', startMs: 1_000, endMs: 2_000 }],
      media, audio
    }), undefined);
    expect(result.provenance).toMatchObject({ kind: 'calibrated-model-selection', state: 'approved' });
    expect(result.approvedMapping).toMatchObject({ model: 'offset-only', scale: 1, offsetMs: -527 });
    expect(result.evidence).toEqual(evidence());
    expect(result).not.toHaveProperty('mapping');
    expect(approvedMappingFromResult(result)).toEqual({ scale: 1, offsetMs: -527 });
  });

  it('returns calibrated rejection with no mapping and no legacy fallback', async () => {
    const context = setup({ evidence: evidence(vectors.slice(0, 3)), confidence: 0.75, method: 'labse-monotonic-v2' });
    const result = await context.worker.process(structuredClone(task));
    expect(result.provenance).toMatchObject({ kind: 'calibrated-model-selection', state: 'rejected' });
    expect(result).not.toHaveProperty('mapping');
    expect(result.approvedMapping).toBeUndefined();
    expect(approvedMappingFromResult(result)).toBeUndefined();
  });

  it('rejects invalid lifecycle inputs before model processing', async () => {
    const context = setup();
    await expect(context.worker.process({ ...task, status: 'pending' })).rejects.toThrow('processing');
    await expect(context.worker.process({ ...task, provider: 'other' })).rejects.toThrow('provider');
    await expect(context.worker.process({ ...task, expiresAt: now })).rejects.toThrow('expired');
    expect(context.evidenceEngine.generate).not.toHaveBeenCalled();
  });

  it('is deterministic across repeated invocations and does not mutate task or evidence', async () => {
    const generated = { evidence: evidence(), confidence: 0.82, method: 'labse-monotonic-v2' };
    const context = setup(generated);
    const originalTask = structuredClone(task);
    const first = await context.worker.process(task);
    const second = await context.worker.process(task);
    expect(first).toEqual(second);
    expect(task).toEqual(originalTask);
    expect(generated.evidence).toEqual(evidence());
    expect(context.evidenceEngine.generate).toHaveBeenCalledTimes(2);
  });

  it('fails closed on acquisition and malformed media instead of manufacturing evidence', async () => {
    const context = setup();
    context.provider.download.mockResolvedValueOnce({ content: 'not-vtt', contentType: 'text/vtt; charset=utf-8' });
    await expect(context.worker.process(structuredClone(task))).rejects.toThrow();
    context.mediaProbe.probe.mockResolvedValueOnce({ hasAudio: false, audioStreams: [] });
    await expect(context.worker.process(structuredClone(task))).rejects.toThrow('does not contain audio');
    context.mediaProbe.probe.mockResolvedValueOnce({ ...media, durationMs: undefined });
    await expect(context.worker.process(structuredClone(task))).rejects.toThrow('duration');
  });
});
