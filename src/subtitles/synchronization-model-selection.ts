export type SynchronizationModel = 'offset-only' | 'affine';

export type SynchronizationModelRejectionReason =
  | 'insufficient_points'
  | 'degenerate_points'
  | 'insufficient_inliers'
  | 'insufficient_inlier_ratio'
  | 'excessive_residual'
  | 'insufficient_coverage';

export interface SynchronizationModelSelectionPolicy {
  minimumPoints: number;
  minimumTemporalCoverage: number;
  maximumMeanAbsoluteResidualMs: number;
  minimumInlierRatio: number;
  minimumAffineScaleDeviation: number;
  minimumAffineRelativeImprovement: number;
  minimumAffineAbsoluteImprovementMs: number;
  minimumAffineScale: number;
  maximumAffineScale: number;
}

export interface SynchronizationModelDiagnostics {
  offsetOnlyMeanAbsoluteResidualMs: number;
  affine?: {
    scale: number;
    offsetMs: number;
    meanAbsoluteResidualMs: number;
  };
}

export interface AcceptedSynchronizationModelSelection {
  accepted: true;
  reason?: undefined;
  model: SynchronizationModel;
  scale: number;
  offsetMs: number;
  meanAbsoluteResidualMs: number;
  inlierRatio: number;
  temporalCoverage: number;
  inlierIndices: readonly number[];
  diagnostics: SynchronizationModelDiagnostics;
}

export interface RejectedSynchronizationModelSelection {
  accepted: false;
  reason: SynchronizationModelRejectionReason;
  model?: SynchronizationModel;
  scale?: number;
  offsetMs?: number;
  meanAbsoluteResidualMs?: number;
  inlierRatio?: number;
  temporalCoverage?: number;
  inlierIndices: readonly number[];
  diagnostics?: SynchronizationModelDiagnostics;
}

export type SynchronizationModelSelection =
  | AcceptedSynchronizationModelSelection
  | RejectedSynchronizationModelSelection;

/**
 * Frozen feasibility policy. Exported explicitly so callers must opt in;
 * existing estimateSynchronization() and production delivery remain unchanged.
 */
export const calibratedSynchronizationModelPolicy: Readonly<SynchronizationModelSelectionPolicy> = {
  minimumPoints: 4,
  minimumTemporalCoverage: 0.55,
  maximumMeanAbsoluteResidualMs: 900,
  minimumInlierRatio: 0.70,
  minimumAffineScaleDeviation: 0.003,
  minimumAffineRelativeImprovement: 0.45,
  minimumAffineAbsoluteImprovementMs: 250,
  minimumAffineScale: 0.94,
  maximumAffineScale: 1.06
};

/**
 * Selects an offset-first robust timestamp model from already verified points.
 * It does not discover correspondence and does not activate synchronization.
 */
export function selectSynchronizationModel(
  points: readonly import('./synchronization.js').SynchronizationPoint[],
  sourceDurationMs: number,
  policy: Readonly<SynchronizationModelSelectionPolicy> = calibratedSynchronizationModelPolicy
): SynchronizationModelSelection {
  validateInputs(points, sourceDurationMs, policy);
  if (points.length < policy.minimumPoints) {
    return { accepted: false, reason: 'insufficient_points', inlierIndices: [] };
  }

  const source = points.map((point) => point.sourceMs);
  const reference = points.map((point) => point.referenceMs);
  const deltas = points.map((point) => point.referenceMs - point.sourceMs);
  const offsetOnlyOffset = median(deltas);
  const offsetResiduals = deltas.map((delta) => Math.abs(delta - offsetOnlyOffset));
  const offsetMask = robustMask(offsetResiduals);
  const offsetInliers = indices(offsetMask);
  const offsetMae = mean(offsetInliers.map((index) => offsetResiduals[index]));

  const affine = affineCandidate(source, reference);
  let useAffine = false;
  if (
    affine &&
    affine.scale >= policy.minimumAffineScale &&
    affine.scale <= policy.maximumAffineScale
  ) {
    const absoluteImprovement = offsetMae - affine.meanAbsoluteResidualMs;
    const relativeImprovement = offsetMae > 0 ? absoluteImprovement / offsetMae : 0;
    useAffine =
      Math.abs(affine.scale - 1) >= policy.minimumAffineScaleDeviation &&
      absoluteImprovement >= policy.minimumAffineAbsoluteImprovementMs &&
      relativeImprovement >= policy.minimumAffineRelativeImprovement;
  }

  const model: SynchronizationModel = useAffine ? 'affine' : 'offset-only';
  const selectedScale = useAffine ? affine!.scale : 1;
  const selectedOffset = useAffine ? affine!.offsetMs : offsetOnlyOffset;
  const selectedMae = useAffine ? affine!.meanAbsoluteResidualMs : offsetMae;
  const selectedInliers = useAffine ? affine!.inlierIndices : offsetInliers;
  const inlierRatio = selectedInliers.length / points.length;
  const temporalCoverage = coverage(source, selectedInliers, sourceDurationMs);
  const diagnostics: SynchronizationModelDiagnostics = {
    offsetOnlyMeanAbsoluteResidualMs: offsetMae,
    affine: affine
      ? {
          scale: affine.scale,
          offsetMs: affine.offsetMs,
          meanAbsoluteResidualMs: affine.meanAbsoluteResidualMs
        }
      : undefined
  };

  let reason: SynchronizationModelRejectionReason | undefined;
  if (selectedInliers.length < policy.minimumPoints) reason = 'insufficient_inliers';
  else if (inlierRatio < policy.minimumInlierRatio) reason = 'insufficient_inlier_ratio';
  else if (selectedMae > policy.maximumMeanAbsoluteResidualMs) reason = 'excessive_residual';
  else if (temporalCoverage < policy.minimumTemporalCoverage) reason = 'insufficient_coverage';

  const common = {
    model,
    scale: selectedScale,
    offsetMs: selectedOffset,
    meanAbsoluteResidualMs: selectedMae,
    inlierRatio,
    temporalCoverage,
    inlierIndices: selectedInliers,
    diagnostics
  };
  return reason
    ? { accepted: false, reason, ...common }
    : { accepted: true, ...common };
}

interface AffineCandidate {
  scale: number;
  offsetMs: number;
  meanAbsoluteResidualMs: number;
  inlierIndices: number[];
}

function affineCandidate(source: readonly number[], reference: readonly number[]): AffineCandidate | undefined {
  const slopes: number[] = [];
  for (let left = 0; left < source.length; left += 1) {
    for (let right = left + 1; right < source.length; right += 1) {
      const difference = source[right] - source[left];
      if (difference !== 0) slopes.push((reference[right] - reference[left]) / difference);
    }
  }
  if (slopes.length === 0) return undefined;
  const initialScale = median(slopes);
  const initialOffset = median(source.map((value, index) => reference[index] - initialScale * value));
  const residuals = source.map((value, index) => Math.abs(reference[index] - (initialScale * value + initialOffset)));
  const inlierIndices = indices(robustMask(residuals));
  if (inlierIndices.length < 2) return undefined;
  const fitted = leastSquares(source, reference, inlierIndices);
  const fittedResiduals = inlierIndices.map((index) => Math.abs(reference[index] - (fitted.scale * source[index] + fitted.offsetMs)));
  return { ...fitted, meanAbsoluteResidualMs: mean(fittedResiduals), inlierIndices };
}

function leastSquares(source: readonly number[], reference: readonly number[], selected: readonly number[]) {
  const meanSource = mean(selected.map((index) => source[index]));
  const meanReference = mean(selected.map((index) => reference[index]));
  let covariance = 0;
  let variance = 0;
  for (const index of selected) {
    const delta = source[index] - meanSource;
    covariance += delta * (reference[index] - meanReference);
    variance += delta * delta;
  }
  if (variance === 0) return { scale: Number.NaN, offsetMs: Number.NaN };
  const scale = covariance / variance;
  return { scale, offsetMs: meanReference - scale * meanSource };
}

function robustMask(residuals: readonly number[]): boolean[] {
  const center = median(residuals);
  const mad = median(residuals.map((value) => Math.abs(value - center)));
  const threshold = Math.max(350, 3 * 1.4826 * mad);
  return residuals.map((value) => value <= threshold);
}

function coverage(source: readonly number[], selected: readonly number[], durationMs: number): number {
  if (selected.length < 2) return 0;
  const values = selected.map((index) => source[index]);
  return (Math.max(...values) - Math.min(...values)) / durationMs;
}

function indices(mask: readonly boolean[]): number[] {
  return mask.flatMap((included, index) => included ? [index] : []);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.POSITIVE_INFINITY : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validateInputs(
  points: readonly import('./synchronization.js').SynchronizationPoint[],
  sourceDurationMs: number,
  policy: Readonly<SynchronizationModelSelectionPolicy>
): void {
  if (!Number.isSafeInteger(sourceDurationMs) || sourceDurationMs <= 0) throw new Error('Synchronization source duration is invalid.');
  for (const point of points) {
    if (!Number.isSafeInteger(point.sourceMs) || point.sourceMs < 0 || !Number.isSafeInteger(point.referenceMs) || point.referenceMs < 0) {
      throw new Error('Synchronization model point is invalid.');
    }
    if (point.sourceMs > sourceDurationMs) throw new Error('Synchronization point exceeds source duration.');
  }
  const unit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
  if (!Number.isSafeInteger(policy.minimumPoints) || policy.minimumPoints < 2 ||
      !unit(policy.minimumTemporalCoverage) || !unit(policy.minimumInlierRatio) ||
      !Number.isFinite(policy.maximumMeanAbsoluteResidualMs) || policy.maximumMeanAbsoluteResidualMs < 0 ||
      !Number.isFinite(policy.minimumAffineScaleDeviation) || policy.minimumAffineScaleDeviation < 0 ||
      !unit(policy.minimumAffineRelativeImprovement) ||
      !Number.isFinite(policy.minimumAffineAbsoluteImprovementMs) || policy.minimumAffineAbsoluteImprovementMs < 0 ||
      !Number.isFinite(policy.minimumAffineScale) || policy.minimumAffineScale <= 0 ||
      !Number.isFinite(policy.maximumAffineScale) || policy.maximumAffineScale < policy.minimumAffineScale) {
    throw new Error('Synchronization model selection policy is invalid.');
  }
}
