import { describe, expect, it } from 'vitest';
import {
  calibratedSynchronizationModelPolicy,
  selectSynchronizationModel
} from '../src/subtitles/synchronization-model-selection.js';
import { estimateSynchronization, type SynchronizationPoint } from '../src/subtitles/synchronization.js';

const development: SynchronizationPoint[] = [
  [2604, 1870], [12360, 12040], [19044, 20850], [26808, 27100],
  [32004, 33270], [38700, 37530], [50844, 49570], [57252, 56390]
].map(([sourceMs, referenceMs]) => ({ sourceMs, referenceMs }));

const holdout: SynchronizationPoint[] = [
  [1548, 1830], [6252, 5200], [12540, 13770], [20532, 20940], [27852, 28720],
  [33228, 34170], [38844, 37760], [45072, 44270], [51612, 50440]
].map(([sourceMs, referenceMs]) => ({ sourceMs, referenceMs }));

describe('calibrated synchronization model selection', () => {
  it.each([
    {
      label: 'development', points: development, durationMs: 60_288,
      expected: { offsetMs: -527, residual: 678.7142857142857, inlierRatio: 0.875, coverage: 0.9064490445859873 }
    },
    {
      label: 'holdout', points: holdout, durationMs: 54_624,
      expected: { offsetMs: 282, residual: 839.7777777777778, inlierRatio: 1, coverage: 0.9165202108963093 }
    }
  ])('matches frozen standalone parity for $label', ({ points, durationMs, expected }) => {
    const result = selectSynchronizationModel(points, durationMs);
    expect(result.accepted).toBe(true);
    expect(result.model).toBe('offset-only');
    expect(result.scale).toBe(1);
    expect(result.offsetMs).toBeCloseTo(expected.offsetMs, 9);
    expect(result.meanAbsoluteResidualMs).toBeCloseTo(expected.residual, 9);
    expect(result.inlierRatio).toBeCloseTo(expected.inlierRatio, 12);
    expect(result.temporalCoverage).toBeCloseTo(expected.coverage, 12);
  });

  it('does not regress to legacy false affine drift on midpoint-biased development and holdout points', () => {
    expect(estimateSynchronization(development).scale).toBeCloseTo(0.9784783890051597, 12);
    expect(estimateSynchronization(holdout).scale).toBeCloseTo(0.9772023265323265, 12);
    expect(selectSynchronizationModel(development, 60_288)).toMatchObject({ accepted: true, model: 'offset-only', scale: 1 });
    expect(selectSynchronizationModel(holdout, 54_624)).toMatchObject({ accepted: true, model: 'offset-only', scale: 1 });
  });

  it('selects affine only when the frozen improvement and scale gates are met', () => {
    const points = [0, 10_000, 20_000, 30_000, 40_000].map((sourceMs) => ({
      sourceMs,
      referenceMs: Math.round(sourceMs * 1.04 + 700)
    }));
    expect(selectSynchronizationModel(points, 40_000)).toMatchObject({
      accepted: true,
      model: 'affine',
      scale: 1.04,
      offsetMs: 700,
      meanAbsoluteResidualMs: 0
    });
  });

  it('rejects insufficient points, coverage, inlier ratio, and residual quality', () => {
    expect(selectSynchronizationModel(development.slice(0, 3), 60_288)).toMatchObject({ accepted: false, reason: 'insufficient_points' });
    const clustered = [1000, 2000, 3000, 4000].map((sourceMs) => ({ sourceMs, referenceMs: sourceMs + 100 }));
    expect(selectSynchronizationModel(clustered, 60_288)).toMatchObject({ accepted: false, reason: 'insufficient_coverage' });
    const noisy = [
      [1000, 1000], [5000, 5000], [9000, 9000], [13000, 40000], [17000, 45000], [21000, 50000]
    ].map(([sourceMs, referenceMs]) => ({ sourceMs, referenceMs }));
    expect(selectSynchronizationModel(noisy, 22_000)).toMatchObject({ accepted: false });
  });

  it('keeps policy explicit and validates unsafe inputs', () => {
    expect(calibratedSynchronizationModelPolicy).toMatchObject({ minimumPoints: 4, minimumTemporalCoverage: 0.55 });
    expect(() => selectSynchronizationModel([], 0)).toThrow('duration');
    expect(() => selectSynchronizationModel([{ sourceMs: -1, referenceMs: 0 }], 1000)).toThrow('point');
  });
});
