import type { SynchronizationPoint } from './synchronization.js';

export interface SynchronizationEvidence {
  source: {
    cueIndex: number;
    startMs: number;
    endMs: number;
  };
  reference: {
    startMs: number;
    endMs: number;
  };
  sourceAnchorMs: number;
  referenceAnchorMs: number;
  confidence: number;
  method: string;
}

/**
 * Validates provenance-bearing correspondence evidence without deciding how
 * that correspondence was discovered. Empty evidence is invalid by design.
 */
export function validateSynchronizationEvidence(
  evidence: readonly SynchronizationEvidence[]
): void {
  if (evidence.length === 0) {
    throw new Error('At least one synchronization evidence item is required.');
  }

  let previousCueIndex = -1;
  let previousSourceAnchor = -1;
  let previousReferenceAnchor = -1;

  for (const item of evidence) {
    nonNegativeSafeInteger(item.source.cueIndex, 'source cue index');
    interval(item.source.startMs, item.source.endMs, 'source');
    interval(item.reference.startMs, item.reference.endMs, 'reference');
    nonNegativeSafeInteger(item.sourceAnchorMs, 'source anchor timestamp');
    nonNegativeSafeInteger(item.referenceAnchorMs, 'reference anchor timestamp');

    if (
      item.sourceAnchorMs < item.source.startMs ||
      item.sourceAnchorMs > item.source.endMs
    ) {
      throw new Error('Synchronization evidence source anchor is outside its interval.');
    }
    if (
      item.referenceAnchorMs < item.reference.startMs ||
      item.referenceAnchorMs > item.reference.endMs
    ) {
      throw new Error('Synchronization evidence reference anchor is outside its interval.');
    }
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error('Synchronization evidence confidence is invalid.');
    }
    if (!item.method.trim() || item.method.length > 64) {
      throw new Error('Synchronization evidence method is invalid.');
    }
    if (
      item.source.cueIndex < previousCueIndex ||
      item.sourceAnchorMs <= previousSourceAnchor ||
      item.referenceAnchorMs <= previousReferenceAnchor
    ) {
      throw new Error('Synchronization evidence must be strictly monotonic.');
    }

    previousCueIndex = item.source.cueIndex;
    previousSourceAnchor = item.sourceAnchorMs;
    previousReferenceAnchor = item.referenceAnchorMs;
  }
}

/** Projects validated rich evidence into the estimator's existing point API. */
export function synchronizationPointsFromEvidence(
  evidence: readonly SynchronizationEvidence[]
): SynchronizationPoint[] {
  validateSynchronizationEvidence(evidence);
  return evidence.map((item) => ({
    sourceMs: item.sourceAnchorMs,
    referenceMs: item.referenceAnchorMs
  }));
}

function interval(startMs: number, endMs: number, label: string): void {
  nonNegativeSafeInteger(startMs, `${label} start timestamp`);
  nonNegativeSafeInteger(endMs, `${label} end timestamp`);
  if (endMs <= startMs) {
    throw new Error(`Synchronization evidence ${label} interval is invalid.`);
  }
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Synchronization evidence ${label} is invalid.`);
  }
}
