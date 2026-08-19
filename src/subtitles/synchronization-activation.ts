import { approvedMappingFromResult } from './synchronization-result-provenance.js';
import type { SynchronizationMapping } from './synchronization.js';
import type { SynchronizationMappingPolicy } from './synchronization-orchestrator.js';

export type CalibratedSynchronizationRuntimeEnvironment = 'development' | 'staging' | 'production';
export type CalibratedSynchronizationActivation = 'disabled' | 'staging' | 'production';
export type ActivationReadinessStatus = 'disabled' | 'not_ready' | 'ready';

export interface CalibratedSynchronizationActivationConfig {
  runtimeEnvironment: CalibratedSynchronizationRuntimeEnvironment;
  activation: CalibratedSynchronizationActivation;
  enabled: boolean;
  namespace?: string;
  redisConfigured: boolean;
  workerConfigured: boolean;
  productionCompositionActive: false;
}

export interface ActivationReadinessAudit {
  status: ActivationReadinessStatus;
  runtimeEnvironment: CalibratedSynchronizationRuntimeEnvironment;
  activation: CalibratedSynchronizationActivation;
  checks: Readonly<Record<string, boolean>>;
  reasons: readonly string[];
  policyIdentity: typeof import('./synchronization-worker-result.js').calibratedSynchronizationPolicyIdentity;
  evidenceProtocolVersion: typeof import('./synchronization-evidence-engine-protocol.js').evidenceEngineProtocolVersion;
  mappingGateway: 'approvedMappingFromResult';
  productionCompositionActive: false;
}

const namespacePattern = /^(indosync-sync)-(staging|production)-([A-Za-z0-9_-]{1,48})$/;

export function readCalibratedSynchronizationActivation(
  environment: NodeJS.ProcessEnv
): CalibratedSynchronizationActivationConfig {
  const runtimeEnvironment = parseRuntime(environment.INDOSYNC_RUNTIME_ENV ?? environment.VERCEL_ENV ?? environment.NODE_ENV);
  const raw = environment.INDOSYNC_CALIBRATED_SYNCHRONIZATION?.trim();
  const activationTarget = environment.INDOSYNC_CALIBRATED_TARGET?.trim();
  if (raw === undefined || raw === '' || raw === 'false') {
    return { runtimeEnvironment, activation: 'disabled', enabled: false,
      redisConfigured: hasRedis(environment), workerConfigured: hasWorker(environment),
      productionCompositionActive: false };
  }
  if (raw !== 'true') throw new Error('Calibrated synchronization activation flag is invalid.');
  if (activationTarget !== 'staging' && activationTarget !== 'production') {
    throw new Error('Calibrated synchronization activation target is invalid.');
  }
  // A target for another environment never activates this runtime.
  if (activationTarget !== runtimeEnvironment) {
    return { runtimeEnvironment, activation: 'disabled', enabled: false,
      redisConfigured: hasRedis(environment), workerConfigured: hasWorker(environment),
      productionCompositionActive: false };
  }
  const namespace = environment.INDOSYNC_SYNCHRONIZATION_NAMESPACE?.trim();
  validateNamespace(namespace, activationTarget);
  validateCredentialEnvironment(environment, activationTarget);
  return {
    runtimeEnvironment,
    activation: activationTarget,
    enabled: true,
    namespace,
    redisConfigured: hasRedis(environment),
    workerConfigured: hasWorker(environment),
    productionCompositionActive: false
  };
}

export async function auditCalibratedSynchronizationReadiness(
  config: CalibratedSynchronizationActivationConfig,
  workerAvailable: boolean
): Promise<ActivationReadinessAudit> {
  const { calibratedSynchronizationPolicyIdentity } = await import('./synchronization-worker-result.js');
  const { evidenceEngineProtocolVersion } = await import('./synchronization-evidence-engine-protocol.js');
  const checks = {
    explicitlyEnabled: config.enabled,
    environmentMatchesActivation: config.enabled && config.runtimeEnvironment === config.activation,
    namespaceValid: config.enabled && !!config.namespace && namespaceMatches(config.namespace, config.activation),
    redisConfigured: config.redisConfigured,
    workerConfigured: config.workerConfigured,
    workerAvailable,
    calibratedPolicyIdentity: calibratedSynchronizationPolicyIdentity.policyId === 'indosync-crosslingual',
    modelSelectionVersion: calibratedSynchronizationPolicyIdentity.modelSelectionVersion === 'offset-first-v1',
    evidenceProtocolVersion: evidenceEngineProtocolVersion === 'indosync-evidence-v1',
    approvedMappingGateway: true,
    productionCompositionInactive: config.productionCompositionActive === false
  };
  const reasons = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
  const status: ActivationReadinessStatus = !config.enabled
    ? 'disabled'
    : reasons.length === 0
      ? 'ready'
      : 'not_ready';
  return { status, runtimeEnvironment: config.runtimeEnvironment, activation: config.activation,
    checks, reasons, policyIdentity: calibratedSynchronizationPolicyIdentity,
    evidenceProtocolVersion: evidenceEngineProtocolVersion, mappingGateway: 'approvedMappingFromResult',
    productionCompositionActive: false };
}

/** Staging-only opt-in policy; never reads legacy result.mapping. */
export class ApprovedCalibratedSynchronizationMappingPolicy implements SynchronizationMappingPolicy {
  select(result: Parameters<SynchronizationMappingPolicy['select']>[0]): SynchronizationMapping | undefined {
    const mapping = approvedMappingFromResult(result);
    if (!mapping || !result.approvedMapping) return undefined;
    return { ...mapping, confidence: Math.max(0, 1 - result.approvedMapping.meanAbsoluteResidualMs / 1_000),
      pointsUsed: result.approvedMapping.inlierCount };
  }
}

function parseRuntime(value: string | undefined): CalibratedSynchronizationRuntimeEnvironment {
  if (!value || value === 'development' || value === 'dev') return 'development';
  if (value === 'staging' || value === 'preview') return 'staging';
  if (value === 'production') return 'production';
  throw new Error('Calibrated synchronization runtime environment is invalid.');
}
function validateNamespace(value: string | undefined, target: 'staging'|'production') {
  if (!value) throw new Error('Calibrated synchronization namespace is required.');
  const match = namespacePattern.exec(value);
  if (!match || match[2] !== target) throw new Error('Calibrated synchronization namespace does not match activation target.');
}
function namespaceMatches(value: string, target: CalibratedSynchronizationActivation) {
  const match = namespacePattern.exec(value); return !!match && match[2] === target;
}
function validateCredentialEnvironment(env: NodeJS.ProcessEnv, target: 'staging'|'production') {
  const credentialEnvironment = env.INDOSYNC_REDIS_CREDENTIAL_ENV?.trim();
  if (credentialEnvironment !== target) throw new Error('Calibrated synchronization credential environment does not match activation target.');
}
function hasRedis(env: NodeJS.ProcessEnv) { return !!env.KV_REST_API_URL?.trim() && !!env.KV_REST_API_TOKEN?.trim(); }
function hasWorker(env: NodeJS.ProcessEnv) { return !!env.INDOSYNC_EVIDENCE_ENGINE_COMMAND?.trim(); }
