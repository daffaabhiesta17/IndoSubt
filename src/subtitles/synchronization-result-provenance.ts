import type { SynchronizationEvidence } from './synchronization-evidence.js';
import type { SynchronizationModel } from './synchronization-model-selection.js';

export type CalibratedSynchronizationState = 'rejected' | 'accepted' | 'approved';

export interface LegacySynchronizationProvenance {
  kind: 'legacy-estimator';
  estimatorVersion: string;
}

export interface CalibratedSynchronizationProvenance {
  kind: 'calibrated-model-selection';
  state: CalibratedSynchronizationState;
  policyId: string;
  policyVersion: string;
  modelSelectionVersion: string;
}

export type SynchronizationResultProvenance =
  | LegacySynchronizationProvenance
  | CalibratedSynchronizationProvenance;

/**
 * A mapping approved by the calibrated contract. Evidence confidence remains
 * separate and is deliberately not represented as timestamp confidence.
 */
export interface ApprovedSynchronizationMapping {
  acceptanceStatus: 'approved';
  model: SynchronizationModel;
  scale: number;
  offsetMs: number;
  meanAbsoluteResidualMs: number;
  inlierRatio: number;
  temporalCoverage: number;
  inlierCount: number;
  evidenceCount: number;
  policyId: string;
  policyVersion: string;
  modelSelectionVersion: string;
}

export interface SynchronizationApprovalView {
  provenance?: SynchronizationResultProvenance;
  evidence?: readonly SynchronizationEvidence[];
  approvedMapping?: ApprovedSynchronizationMapping;
}

/** The only additive contract boundary that exposes a calibrated mapping downstream. */
export function approvedMappingFromResult(
  result: SynchronizationApprovalView
): Readonly<{ scale: number; offsetMs: number }> | undefined {
  const provenance = result.provenance;
  const mapping = result.approvedMapping;
  const points = 'points' in result && Array.isArray(result.points)
    ? result.points as readonly { sourceMs: number; referenceMs: number }[]
    : undefined;
  if (
    provenance?.kind !== 'calibrated-model-selection' ||
    provenance.state !== 'approved' ||
    'mapping' in result ||
    !points ||
    !result.evidence ||
    result.evidence.length === 0 ||
    points.length !== result.evidence.length ||
    result.evidence.some((item, index) =>
      points[index]?.sourceMs !== item.sourceAnchorMs ||
      points[index]?.referenceMs !== item.referenceAnchorMs
    ) ||
    !mapping ||
    mapping.acceptanceStatus !== 'approved' ||
    (mapping.model !== 'offset-only' && mapping.model !== 'affine') ||
    !Number.isFinite(mapping.scale) ||
    mapping.scale <= 0 ||
    !Number.isFinite(mapping.offsetMs) ||
    !Number.isFinite(mapping.meanAbsoluteResidualMs) ||
    mapping.meanAbsoluteResidualMs < 0 ||
    !Number.isFinite(mapping.inlierRatio) ||
    mapping.inlierRatio < 0 || mapping.inlierRatio > 1 ||
    !Number.isFinite(mapping.temporalCoverage) ||
    mapping.temporalCoverage < 0 || mapping.temporalCoverage > 1 ||
    !Number.isSafeInteger(mapping.inlierCount) ||
    mapping.inlierCount < 1 ||
    !Number.isSafeInteger(mapping.evidenceCount) ||
    mapping.evidenceCount !== result.evidence.length ||
    mapping.inlierCount > mapping.evidenceCount ||
    mapping.policyId !== provenance.policyId ||
    mapping.policyVersion !== provenance.policyVersion ||
    mapping.modelSelectionVersion !== provenance.modelSelectionVersion
  ) {
    return undefined;
  }
  return { scale: mapping.scale, offsetMs: mapping.offsetMs };
}
