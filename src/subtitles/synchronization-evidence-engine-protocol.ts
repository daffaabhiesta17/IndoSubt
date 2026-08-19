export const evidenceEngineProtocolVersion = 'indosync-evidence-v1' as const;

export interface EvidenceEngineProtocolRequest {
  protocolVersion: typeof evidenceEngineProtocolVersion;
  requestId: string;
  mediaPath: string;
  cues: readonly {
    cueIndex: number;
    startMs: number;
    endMs: number;
    text: string;
  }[];
}

export interface EvidenceEngineProtocolReady {
  type: 'ready';
  protocolVersion: typeof evidenceEngineProtocolVersion;
  requestId: string;
  models: {
    whisperRevision: string;
    labseRevision: string;
    device: 'cuda';
    computeType: 'float16';
  };
}

export interface EvidenceEngineProtocolSuccess {
  type: 'result';
  protocolVersion: typeof evidenceEngineProtocolVersion;
  requestId: string;
  evidence: readonly import('./synchronization-evidence.js').SynchronizationEvidence[];
  confidence: number;
  method: string;
  metrics: Record<string, number>;
}

export interface EvidenceEngineProtocolFailure {
  type: 'error';
  protocolVersion: typeof evidenceEngineProtocolVersion;
  requestId: string;
  category: 'invalid_request' | 'media_failure' | 'model_failure' | 'inference_failure' | 'internal_error';
  message: string;
}

export type EvidenceEngineProtocolMessage =
  | EvidenceEngineProtocolReady
  | EvidenceEngineProtocolSuccess
  | EvidenceEngineProtocolFailure;
