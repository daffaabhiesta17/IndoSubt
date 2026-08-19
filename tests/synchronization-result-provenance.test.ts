import { describe, expect, it } from 'vitest';
import {
  InMemorySynchronizationResultStore,
  validateSynchronizationResult,
  type SynchronizationResult
} from '../src/subtitles/synchronization-context.js';
import type { SynchronizationEvidence } from '../src/subtitles/synchronization-evidence.js';
import {
  approvedMappingFromResult,
  type ApprovedSynchronizationMapping,
  type CalibratedSynchronizationProvenance
} from '../src/subtitles/synchronization-result-provenance.js';

const now = 1_000_000;
const evidence: SynchronizationEvidence[] = [
  {
    source: { cueIndex: 0, startMs: 1_000, endMs: 2_000 },
    reference: { startMs: 2_000, endMs: 3_000 },
    sourceAnchorMs: 1_500,
    referenceAnchorMs: 2_500,
    confidence: 0.82,
    method: 'labse-monotonic-v2'
  },
  {
    source: { cueIndex: 1, startMs: 5_000, endMs: 6_000 },
    reference: { startMs: 6_000, endMs: 7_000 },
    sourceAnchorMs: 5_500,
    referenceAnchorMs: 6_500,
    confidence: 0.88,
    method: 'labse-monotonic-v2'
  }
];

const provenance: CalibratedSynchronizationProvenance = {
  kind: 'calibrated-model-selection',
  state: 'approved',
  policyId: 'indosync-crosslingual',
  policyVersion: '2026-08-v1',
  modelSelectionVersion: 'offset-first-v1'
};

function approvedMapping(overrides: Partial<ApprovedSynchronizationMapping> = {}): ApprovedSynchronizationMapping {
  return {
    acceptanceStatus: 'approved',
    model: 'offset-only',
    scale: 1,
    offsetMs: 1_000,
    meanAbsoluteResidualMs: 120,
    inlierRatio: 1,
    temporalCoverage: 0.75,
    inlierCount: 2,
    evidenceCount: 2,
    policyId: provenance.policyId,
    policyVersion: provenance.policyVersion,
    modelSelectionVersion: provenance.modelSelectionVersion,
    ...overrides
  };
}

function calibratedResult(overrides: Partial<SynchronizationResult> = {}): SynchronizationResult {
  return {
    taskId: 'task_123',
    points: evidence.map((item) => ({ sourceMs: item.sourceAnchorMs, referenceMs: item.referenceAnchorMs })),
    provenance,
    evidence,
    approvedMapping: approvedMapping(),
    confidence: 0.85,
    method: 'labse-monotonic-v2',
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides
  };
}

describe('synchronization result provenance and approval contract', () => {
  it('accepts approved offset-only and affine mappings with raw evidence', () => {
    const offset = calibratedResult();
    expect(() => validateSynchronizationResult(offset)).not.toThrow();
    expect(offset.evidence).toEqual(evidence);
    expect(approvedMappingFromResult(offset)).toEqual({ scale: 1, offsetMs: 1_000 });

    const affine = calibratedResult({
      approvedMapping: approvedMapping({ model: 'affine', scale: 1.02, offsetMs: 700 })
    });
    expect(() => validateSynchronizationResult(affine)).not.toThrow();
    expect(approvedMappingFromResult(affine)).toEqual({ scale: 1.02, offsetMs: 700 });
  });

  it('accepts an explicit rejected state but exposes no downstream mapping', () => {
    const rejected = calibratedResult({
      points: [], evidence: [], approvedMapping: undefined,
      provenance: { ...provenance, state: 'rejected' }
    });
    expect(() => validateSynchronizationResult(rejected)).not.toThrow();
    expect(approvedMappingFromResult(rejected)).toBeUndefined();
  });

  it('keeps accepted distinct from approved', () => {
    const accepted = calibratedResult({
      approvedMapping: undefined,
      provenance: { ...provenance, state: 'accepted' }
    });
    expect(() => validateSynchronizationResult(accepted)).not.toThrow();
    expect(approvedMappingFromResult(accepted)).toBeUndefined();
  });

  it('never treats a legacy mapping as calibrated or approved', () => {
    const legacy: SynchronizationResult = {
      taskId: 'task_123',
      points: [{ sourceMs: 1_000, referenceMs: 2_000 }],
      mapping: { scale: 1.05, offsetMs: 400, confidence: 1, pointsUsed: 1 },
      provenance: { kind: 'legacy-estimator', estimatorVersion: 'linear-v1' },
      confidence: 1,
      method: 'legacy-estimator',
      createdAt: now,
      expiresAt: now + 60_000
    };
    expect(() => validateSynchronizationResult(legacy)).not.toThrow();
    expect(approvedMappingFromResult(legacy)).toBeUndefined();
  });

  it('carries exact policy/version provenance and preserves evidence through stores', async () => {
    const value = calibratedResult();
    const store = new InMemorySynchronizationResultStore();
    await store.create(value);
    const stored = await store.get(value.taskId);
    expect(stored?.provenance).toEqual(provenance);
    expect(stored?.evidence).toEqual(evidence);
    expect(value.provenance).toEqual(provenance);
    expect(value.approvedMapping).toMatchObject({
      policyId: provenance.policyId,
      policyVersion: provenance.policyVersion,
      modelSelectionVersion: provenance.modelSelectionVersion
    });
    expect(value.evidence).toEqual(evidence);
  });

  it.each([
    calibratedResult({ mapping: { scale: 1, offsetMs: 0, confidence: 1, pointsUsed: 2 } }),
    calibratedResult({ evidence: undefined }),
    calibratedResult({ points: [{ sourceMs: 1, referenceMs: 2 }] }),
    calibratedResult({ approvedMapping: undefined }),
    calibratedResult({ approvedMapping: approvedMapping({ policyVersion: 'wrong' }) }),
    calibratedResult({ approvedMapping: approvedMapping({ inlierCount: 3 }) }),
    calibratedResult({ approvedMapping: approvedMapping({ acceptanceStatus: 'approved', scale: 0 }) }),
    calibratedResult({ provenance: { ...provenance, state: 'accepted' } }),
    calibratedResult({ provenance: { kind: 'legacy-estimator', estimatorVersion: 'linear-v1' } })
  ])('rejects ambiguous or internally inconsistent calibrated result %#', (value) => {
    expect(() => validateSynchronizationResult(value)).toThrow();
    expect(approvedMappingFromResult(value)).toBeUndefined();
  });
});
