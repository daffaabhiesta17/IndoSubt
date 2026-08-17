import { describe, expect, it } from 'vitest';
import {
  estimateSynchronization
} from '../src/subtitles/synchronization.js';

describe('subtitle synchronization estimator', () => {
  it('estimates a pure positive offset', () => {
    const result = estimateSynchronization([
      {
        sourceMs: 10_000,
        referenceMs: 11_500
      },
      {
        sourceMs: 20_000,
        referenceMs: 21_500
      },
      {
        sourceMs: 30_000,
        referenceMs: 31_500
      }
    ]);

    expect(result.scale).toBeCloseTo(1);
    expect(result.offsetMs).toBeCloseTo(1_500);
    expect(result.confidence).toBe(1);
    expect(result.pointsUsed).toBe(3);
  });

  it('estimates a negative offset', () => {
    const result = estimateSynchronization([
      {
        sourceMs: 10_000,
        referenceMs: 8_000
      },
      {
        sourceMs: 20_000,
        referenceMs: 18_000
      },
      {
        sourceMs: 30_000,
        referenceMs: 28_000
      }
    ]);

    expect(result.scale).toBeCloseTo(1);
    expect(result.offsetMs).toBeCloseTo(-2_000);
    expect(result.confidence).toBe(1);
  });

  it('estimates scale and offset together', () => {
    const result = estimateSynchronization([
      {
        sourceMs: 10_000,
        referenceMs: 9_000
      },
      {
        sourceMs: 20_000,
        referenceMs: 19_000
      },
      {
        sourceMs: 30_000,
        referenceMs: 29_000
      }
    ]);

    expect(result.scale).toBeCloseTo(1);
    expect(result.offsetMs).toBeCloseTo(-1_000);
  });

  it('estimates a non-unit scale', () => {
    const result = estimateSynchronization([
      {
        sourceMs: 10_000,
        referenceMs: 10_500
      },
      {
        sourceMs: 20_000,
        referenceMs: 21_000
      },
      {
        sourceMs: 30_000,
        referenceMs: 31_500
      }
    ]);

    expect(result.scale).toBeCloseTo(1.05);
    expect(result.offsetMs).toBeCloseTo(0);
  });

  it('supports a single synchronization point as an offset-only mapping', () => {
    const result = estimateSynchronization([
      {
        sourceMs: 25_000,
        referenceMs: 27_500
      }
    ]);

    expect(result.scale).toBe(1);
    expect(result.offsetMs).toBe(2_500);
    expect(result.confidence).toBe(0.5);
    expect(result.pointsUsed).toBe(1);
  });

  it('reduces confidence when points contain alignment error', () => {
    const result = estimateSynchronization([
      {
        sourceMs: 10_000,
        referenceMs: 11_500
      },
      {
        sourceMs: 20_000,
        referenceMs: 21_500
      },
      {
        sourceMs: 30_000,
        referenceMs: 32_500
      }
    ]);

    expect(result.scale).toBeGreaterThan(1);
    expect(result.confidence).toBeLessThan(1);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('rejects an empty point set', () => {
    expect(() =>
      estimateSynchronization([])
    ).toThrow(
      'At least one synchronization point is required.'
    );
  });

  it('rejects identical source timestamps', () => {
    expect(() =>
      estimateSynchronization([
        {
          sourceMs: 10_000,
          referenceMs: 11_000
        },
        {
          sourceMs: 10_000,
          referenceMs: 12_000
        }
      ])
    ).toThrow(
      'Synchronization source timestamps must not all be identical.'
    );
  });

  it('rejects negative source timestamps', () => {
    expect(() =>
      estimateSynchronization([
        {
          sourceMs: -1,
          referenceMs: 1_000
        }
      ])
    ).toThrow(
      'Synchronization source timestamp must be a non-negative safe integer.'
    );
  });

  it('rejects negative reference timestamps', () => {
    expect(() =>
      estimateSynchronization([
        {
          sourceMs: 1_000,
          referenceMs: -1
        }
      ])
    ).toThrow(
      'Synchronization reference timestamp must be a non-negative safe integer.'
    );
  });

  it('rejects unsafe timestamps', () => {
    expect(() =>
      estimateSynchronization([
        {
          sourceMs: Number.MAX_SAFE_INTEGER + 1,
          referenceMs: 1_000
        }
      ])
    ).toThrow(
      'Synchronization source timestamp must be a non-negative safe integer.'
    );
  });
});