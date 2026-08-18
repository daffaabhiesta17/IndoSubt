import { describe, expect, it } from 'vitest';
import {
  synchronizationPointsFromEvidence,
  validateSynchronizationEvidence,
  type SynchronizationEvidence
} from '../src/subtitles/synchronization-evidence.js';
import { estimateSynchronization } from '../src/subtitles/synchronization.js';

function evidence(
  overrides: Partial<SynchronizationEvidence> = {}
): SynchronizationEvidence {
  return {
    source: { cueIndex: 1, startMs: 1_000, endMs: 2_000 },
    reference: { startMs: 2_000, endMs: 3_000 },
    sourceAnchorMs: 1_500,
    referenceAnchorMs: 2_500,
    confidence: 0.9,
    method: 'verified-alignment',
    ...overrides
  };
}

describe('synchronization evidence', () => {
  it('validates provenance and projects evidence into estimator-compatible points', () => {
    const items = [
      evidence(),
      evidence({
        source: { cueIndex: 2, startMs: 5_000, endMs: 6_000 },
        reference: { startMs: 6_000, endMs: 7_000 },
        sourceAnchorMs: 5_500,
        referenceAnchorMs: 6_500
      })
    ];

    const points = synchronizationPointsFromEvidence(items);
    expect(points).toEqual([
      { sourceMs: 1_500, referenceMs: 2_500 },
      { sourceMs: 5_500, referenceMs: 6_500 }
    ]);
    expect(estimateSynchronization(points)).toMatchObject({
      scale: 1,
      offsetMs: 1_000,
      pointsUsed: 2
    });
  });

  it('rejects empty evidence', () => {
    expect(() => validateSynchronizationEvidence([])).toThrow('At least one');
    expect(() => synchronizationPointsFromEvidence([])).toThrow('At least one');
  });

  it.each([
    evidence({ source: { cueIndex: -1, startMs: 1_000, endMs: 2_000 } }),
    evidence({ source: { cueIndex: 1, startMs: -1, endMs: 2_000 } }),
    evidence({ source: { cueIndex: 1, startMs: 2_000, endMs: 2_000 } }),
    evidence({ reference: { startMs: 3_000, endMs: 2_000 } }),
    evidence({ sourceAnchorMs: Number.NaN }),
    evidence({ referenceAnchorMs: Number.MAX_SAFE_INTEGER + 1 }),
    evidence({ confidence: Number.NaN }),
    evidence({ confidence: -0.1 }),
    evidence({ confidence: 1.1 }),
    evidence({ method: ' ' }),
    evidence({ method: 'x'.repeat(65) })
  ])('rejects invalid evidence %#', (item) => {
    expect(() => validateSynchronizationEvidence([item])).toThrow();
  });

  it('rejects anchors outside their provenance intervals', () => {
    expect(() =>
      validateSynchronizationEvidence([evidence({ sourceAnchorMs: 999 })])
    ).toThrow('source anchor');
    expect(() =>
      validateSynchronizationEvidence([evidence({ referenceAnchorMs: 3_001 })])
    ).toThrow('reference anchor');
  });

  it('rejects non-monotonic cue and timeline evidence', () => {
    const first = evidence();
    const later = evidence({
      source: { cueIndex: 2, startMs: 5_000, endMs: 6_000 },
      reference: { startMs: 6_000, endMs: 7_000 },
      sourceAnchorMs: 5_500,
      referenceAnchorMs: 6_500
    });

    expect(() =>
      validateSynchronizationEvidence([
        first,
        { ...later, source: { ...later.source, cueIndex: 0 } }
      ])
    ).toThrow('strictly monotonic');
    expect(() =>
      validateSynchronizationEvidence([
        first,
        {
          ...later,
          source: { ...later.source, startMs: 1_000, endMs: 2_000 },
          sourceAnchorMs: 1_500
        }
      ])
    ).toThrow('strictly monotonic');
    expect(() =>
      validateSynchronizationEvidence([
        first,
        {
          ...later,
          reference: { ...later.reference, startMs: 2_000, endMs: 3_000 },
          referenceAnchorMs: 2_500
        }
      ])
    ).toThrow('strictly monotonic');
  });
});
