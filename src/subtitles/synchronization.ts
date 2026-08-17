export interface SynchronizationPoint {
  sourceMs: number;
  referenceMs: number;
}

export interface SynchronizationMapping {
  scale: number;
  offsetMs: number;
  confidence: number;
  pointsUsed: number;
}

/**
 * Estimates a linear timestamp mapping from known synchronization points.
 *
 * referenceMs = sourceMs * scale + offsetMs
 *
 * This function does not inspect subtitle text and does not discover
 * synchronization points by itself. The caller must provide points that
 * are already known to correspond.
 */
export function estimateSynchronization(
  points: readonly SynchronizationPoint[]
): SynchronizationMapping {
  validatePoints(points);

  if (points.length === 1) {
    return {
      scale: 1,
      offsetMs: points[0].referenceMs - points[0].sourceMs,
      confidence: 0.5,
      pointsUsed: 1
    };
  }

  const meanSource =
    points.reduce((sum, point) => sum + point.sourceMs, 0) /
    points.length;

  const meanReference =
    points.reduce((sum, point) => sum + point.referenceMs, 0) /
    points.length;

  let covariance = 0;
  let sourceVariance = 0;

  for (const point of points) {
    const sourceDelta = point.sourceMs - meanSource;
    const referenceDelta =
      point.referenceMs - meanReference;

    covariance += sourceDelta * referenceDelta;
    sourceVariance += sourceDelta * sourceDelta;
  }

  if (sourceVariance === 0) {
    throw new Error(
      'Synchronization source timestamps must not all be identical.'
    );
  }

  const scale = covariance / sourceVariance;
  const offsetMs =
    meanReference - scale * meanSource;

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      'Estimated synchronization scale must be finite and greater than zero.'
    );
  }

  if (!Number.isFinite(offsetMs)) {
    throw new Error(
      'Estimated synchronization offset must be finite.'
    );
  }

  const residuals = points.map((point) => {
    const predicted =
      point.sourceMs * scale + offsetMs;

    return Math.abs(
      predicted - point.referenceMs
    );
  });

  const meanAbsoluteError =
    residuals.reduce(
      (sum, value) => sum + value,
      0
    ) / residuals.length;

  /*
   * Confidence represents how closely the estimated linear mapping fits
   * the supplied synchronization points.
   *
   * 0 ms error       -> 1.0
   * 500 ms error     -> 0.5
   * >= 1000 ms error -> 0
   *
   * A single synchronization point remains deliberately conservative and
   * is handled separately above with confidence 0.5.
   *
   * With two or more points, an exact linear alignment receives
   * full confidence.
   */
  const confidence = Math.max(
    0,
    1 - meanAbsoluteError / 1000
  );

  return {
    scale,
    offsetMs,
    confidence,
    pointsUsed: points.length
  };
}

function validatePoints(
  points: readonly SynchronizationPoint[]
): void {
  if (points.length === 0) {
    throw new Error(
      'At least one synchronization point is required.'
    );
  }

  for (const point of points) {
    if (
      !Number.isSafeInteger(point.sourceMs) ||
      point.sourceMs < 0
    ) {
      throw new Error(
        'Synchronization source timestamp must be a non-negative safe integer.'
      );
    }

    if (
      !Number.isSafeInteger(point.referenceMs) ||
      point.referenceMs < 0
    ) {
      throw new Error(
        'Synchronization reference timestamp must be a non-negative safe integer.'
      );
    }
  }
}