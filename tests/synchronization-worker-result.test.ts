import { describe, expect, it } from 'vitest';
import type { SynchronizationEvidence } from '../src/subtitles/synchronization-evidence.js';
import { approvedMappingFromResult } from '../src/subtitles/synchronization-result-provenance.js';
import {
  buildCalibratedSynchronizationResult,
  calibratedSynchronizationPolicyIdentity
} from '../src/subtitles/synchronization-worker-result.js';
import { validateSynchronizationResult, type SynchronizationResult } from '../src/subtitles/synchronization-context.js';

const now = 1_000_000;
const development = [
  [2604, 1870], [12360, 12040], [19044, 20850], [26808, 27100],
  [32004, 33270], [38700, 37530], [50844, 49570], [57252, 56390]
] as const;
const holdout = [
  [1548, 1830], [6252, 5200], [12540, 13770], [20532, 20940], [27852, 28720],
  [33228, 34170], [38844, 37760], [45072, 44270], [51612, 50440]
] as const;

function evidence(values: readonly (readonly [number, number])[]): SynchronizationEvidence[] {
  return values.map(([sourceAnchorMs, referenceAnchorMs], index) => ({
    source: { cueIndex: index, startMs: Math.max(0, sourceAnchorMs - 100), endMs: sourceAnchorMs + 100 },
    reference: { startMs: Math.max(0, referenceAnchorMs - 100), endMs: referenceAnchorMs + 100 },
    sourceAnchorMs,
    referenceAnchorMs,
    confidence: 0.82,
    method: 'labse-monotonic-v2'
  }));
}

function build(values: readonly (readonly [number, number])[], sourceDurationMs: number) {
  return buildCalibratedSynchronizationResult({
    taskId: 'task_123', evidence: evidence(values), sourceDurationMs,
    evidenceConfidence: 0.82, evidenceMethod: 'labse-monotonic-v2',
    createdAt: now, expiresAt: now + 60_000
  });
}

describe('pre-production calibrated worker result boundary', () => {
  it.each([
    ['development', development, 60_288, -527, 0.875, 0.9064490445859873],
    ['holdout', holdout, 54_624, 282, 1, 0.9165202108963093]
  ] as const)('flows real %s evidence through calibrated approval without legacy estimator',
    (_label, values, duration, offset, inlierRatio, coverage) => {
      const output = build(values, duration);
      expect(output.selection).toMatchObject({ accepted: true, model: 'offset-only', scale: 1, offsetMs: offset });
      expect(output.result).not.toHaveProperty('mapping');
      expect(output.result.provenance).toEqual({
        kind: 'calibrated-model-selection', state: 'approved',
        ...calibratedSynchronizationPolicyIdentity
      });
      expect(output.result.approvedMapping).toMatchObject({
        acceptanceStatus: 'approved', model: 'offset-only', scale: 1,
        offsetMs: offset, inlierRatio, temporalCoverage: coverage,
        ...calibratedSynchronizationPolicyIdentity
      });
      expect(output.result.evidence).toEqual(evidence(values));
      expect(output.mapping).toEqual({ scale: 1, offsetMs: offset });
      expect(() => validateSynchronizationResult(output.result)).not.toThrow();
    });

  it('keeps rejected calibrated selection safe and never falls back to legacy estimation', () => {
    const output = build(development.slice(0, 3), 60_288);
    expect(output.selection).toMatchObject({ accepted: false, reason: 'insufficient_points' });
    expect(output.result.provenance).toMatchObject({ kind: 'calibrated-model-selection', state: 'rejected' });
    expect(output.result).not.toHaveProperty('mapping');
    expect(output.result.approvedMapping).toBeUndefined();
    expect(output.mapping).toBeUndefined();
    expect(approvedMappingFromResult(output.result)).toBeUndefined();
    expect(() => validateSynchronizationResult(output.result)).not.toThrow();
  });

  it('does not expose accepted-but-unapproved, legacy, invalid provenance, or version mismatch', () => {
    const approved = build(development, 60_288).result;
    const accepted = structuredClone(approved);
    accepted.provenance = { ...accepted.provenance as any, state: 'accepted' };
    accepted.approvedMapping = undefined;
    expect(approvedMappingFromResult(accepted)).toBeUndefined();

    const legacy: SynchronizationResult = {
      taskId: 'task_123', points: approved.points,
      mapping: { scale: 1.02, offsetMs: 700, confidence: 1, pointsUsed: approved.points.length },
      provenance: { kind: 'legacy-estimator', estimatorVersion: 'linear-v1' },
      confidence: 1, method: 'legacy', createdAt: now, expiresAt: now + 60_000
    };
    expect(approvedMappingFromResult(legacy)).toBeUndefined();

    const invalid = structuredClone(approved);
    invalid.provenance = { ...invalid.provenance as any, kind: 'legacy-estimator' };
    expect(approvedMappingFromResult(invalid)).toBeUndefined();

    const mismatch = structuredClone(approved);
    mismatch.approvedMapping = { ...mismatch.approvedMapping!, policyVersion: 'wrong' };
    expect(approvedMappingFromResult(mismatch)).toBeUndefined();
  });

  it('preserves safe behavior for an explicit accepted state without synchronization', () => {
    const result = build(holdout, 54_624).result;
    result.provenance = { ...result.provenance as any, state: 'accepted' };
    result.approvedMapping = undefined;
    expect(() => validateSynchronizationResult(result)).not.toThrow();
    expect(approvedMappingFromResult(result)).toBeUndefined();
  });
});
