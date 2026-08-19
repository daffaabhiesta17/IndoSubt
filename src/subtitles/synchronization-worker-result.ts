import type { SynchronizationResult } from './synchronization-context.js';
import {
  synchronizationPointsFromEvidence,
  type SynchronizationEvidence
} from './synchronization-evidence.js';
import {
  calibratedSynchronizationModelPolicy,
  selectSynchronizationModel,
  type SynchronizationModelSelection,
  type SynchronizationModelSelectionPolicy
} from './synchronization-model-selection.js';
import {
  approvedMappingFromResult,
  type CalibratedSynchronizationProvenance
} from './synchronization-result-provenance.js';

export const calibratedSynchronizationPolicyIdentity = Object.freeze({
  policyId: 'indosync-crosslingual',
  policyVersion: '2026-08-v1',
  modelSelectionVersion: 'offset-first-v1'
});

export interface CalibratedSynchronizationResultInput {
  taskId: string;
  evidence: readonly SynchronizationEvidence[];
  sourceDurationMs: number;
  evidenceConfidence: number;
  evidenceMethod: string;
  createdAt: number;
  expiresAt: number;
  policy?: Readonly<SynchronizationModelSelectionPolicy>;
}

export interface CalibratedSynchronizationBoundaryOutput {
  result: SynchronizationResult;
  selection: SynchronizationModelSelection;
  mapping?: Readonly<{ scale: number; offsetMs: number }>;
}

/**
 * Additive pre-production worker boundary. It never calls the legacy estimator:
 * rejected calibrated selection remains rejected with no mapping or fallback.
 */
export function buildCalibratedSynchronizationResult(
  input: CalibratedSynchronizationResultInput
): CalibratedSynchronizationBoundaryOutput {
  const points = input.evidence.length > 0
    ? synchronizationPointsFromEvidence(input.evidence)
    : [];
  const selection = selectSynchronizationModel(
    points,
    input.sourceDurationMs,
    input.policy ?? calibratedSynchronizationModelPolicy
  );
  const baseProvenance = calibratedSynchronizationPolicyIdentity;
  const provenance: CalibratedSynchronizationProvenance = {
    kind: 'calibrated-model-selection',
    state: selection.accepted ? 'approved' : 'rejected',
    ...baseProvenance
  };
  const result: SynchronizationResult = {
    taskId: input.taskId,
    points,
    provenance,
    evidence: structuredClone(input.evidence),
    approvedMapping: selection.accepted
      ? {
          acceptanceStatus: 'approved',
          model: selection.model,
          scale: selection.scale,
          offsetMs: selection.offsetMs,
          meanAbsoluteResidualMs: selection.meanAbsoluteResidualMs,
          inlierRatio: selection.inlierRatio,
          temporalCoverage: selection.temporalCoverage,
          inlierCount: selection.inlierIndices.length,
          evidenceCount: input.evidence.length,
          ...baseProvenance
        }
      : undefined,
    confidence: input.evidenceConfidence,
    method: input.evidenceMethod,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  };
  return {
    result,
    selection,
    mapping: approvedMappingFromResult(result)
  };
}
