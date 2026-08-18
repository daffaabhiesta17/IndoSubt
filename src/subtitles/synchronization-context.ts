import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MediaSource } from '../media/types.js';
import type { SynchronizationMapping, SynchronizationPoint } from './synchronization.js';

export type SynchronizationTaskStatus = 'pending' | 'processing' | 'completed' | 'rejected';

export interface SynchronizationTask {
  id: string;
  mediaSource: MediaSource;
  provider: string;
  providerReference: string;
  language: 'id';
  status: SynchronizationTaskStatus;
  createdAt: number;
  expiresAt: number;
}

export interface SynchronizationResult {
  taskId: string;
  points: readonly SynchronizationPoint[];
  mapping?: SynchronizationMapping;
  confidence: number;
  method: string;
  createdAt: number;
  expiresAt: number;
}

export interface SynchronizationTaskStore {
  create(task: SynchronizationTask): Promise<void>;
  get(id: string): Promise<SynchronizationTask | null>;
  update(task: SynchronizationTask): Promise<void>;
  transition?(
    taskId: string,
    expected: SynchronizationTaskStatus,
    next: SynchronizationTaskStatus,
    now: number
  ): Promise<SynchronizationTask>;
}

export interface SynchronizationResultStore {
  create(result: SynchronizationResult): Promise<void>;
  get(taskId: string): Promise<SynchronizationResult | null>;
  complete?(
    task: SynchronizationTask,
    result: SynchronizationResult,
    now: number
  ): Promise<void>;
}

/** Test/development implementation only; it is not durable across serverless invocations. */
export class InMemorySynchronizationTaskStore implements SynchronizationTaskStore {
  private readonly tasks = new Map<string, SynchronizationTask>();

  async create(task: SynchronizationTask): Promise<void> {
    validateSynchronizationTask(task);
    if (this.tasks.has(task.id)) throw new Error('Synchronization task already exists.');
    this.tasks.set(task.id, structuredClone(task));
  }

  async get(id: string): Promise<SynchronizationTask | null> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async update(task: SynchronizationTask): Promise<void> {
    validateSynchronizationTask(task);
    if (!this.tasks.has(task.id)) throw new Error('Synchronization task does not exist.');
    this.tasks.set(task.id, structuredClone(task));
  }
}

/** Test/development implementation only; it is not durable across serverless invocations. */
export class InMemorySynchronizationResultStore implements SynchronizationResultStore {
  private readonly results = new Map<string, SynchronizationResult>();

  async create(result: SynchronizationResult): Promise<void> {
    validateSynchronizationResult(result);
    if (this.results.has(result.taskId)) {
      throw new Error('Synchronization result already exists.');
    }
    this.results.set(result.taskId, structuredClone(result));
  }

  async get(taskId: string): Promise<SynchronizationResult | null> {
    const result = this.results.get(taskId);
    return result ? structuredClone(result) : null;
  }
}

export interface SynchronizationReference {
  taskId: string;
  expiresAt: number;
}

/** Signs an opaque task id; media URLs and evidence never enter the public reference. */
export class SynchronizationReferenceCodec {
  constructor(
    private readonly secret: string,
    private readonly purpose = 'subtitle-synchronization'
  ) {
    if (!secret) throw new Error('A synchronization reference secret is required.');
    if (!purpose) throw new Error('A synchronization reference purpose is required.');
  }

  issue(reference: SynchronizationReference): string {
    validateOpaqueId(reference.taskId, 'task id');
    positiveSafeInteger(reference.expiresAt, 'reference expiry');
    const payload = this.payload(reference.taskId, reference.expiresAt);
    return `${payload}.${this.signature(payload)}`;
  }

  verify(value: string, now = Date.now()): SynchronizationReference {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Current time is invalid.');
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== 'v2') throw new Error('Invalid synchronization reference.');
    const [version, encodedPurpose, taskId, expiryText, received] = parts;
    const payload = `${version}.${encodedPurpose}.${taskId}.${expiryText}`;
    const expected = this.signature(payload);
    const left = Buffer.from(received);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new Error('Invalid synchronization reference.');
    }
    if (decodeSegment(encodedPurpose) !== this.purpose) {
      throw new Error('Invalid synchronization reference purpose.');
    }
    validateOpaqueId(taskId, 'task id');
    if (!/^\d+$/.test(expiryText)) throw new Error('Invalid synchronization reference expiry.');
    const expiresAt = Number(expiryText);
    positiveSafeInteger(expiresAt, 'reference expiry');
    if (expiresAt <= now) throw new Error('Synchronization reference has expired.');
    return { taskId, expiresAt };
  }

  private payload(taskId: string, expiresAt: number): string {
    return `v2.${encodeSegment(this.purpose)}.${taskId}.${expiresAt}`;
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url').slice(0, 32);
  }
}

export function createSynchronizationTaskId(): string {
  return randomBytes(18).toString('base64url');
}

export function validateSynchronizationTask(task: SynchronizationTask): void {
  validateOpaqueId(task.id, 'task id');
  if (task.mediaSource.kind !== 'remote-url' || !task.mediaSource.url) {
    throw new Error('Synchronization task media source is invalid.');
  }
  validateOpaqueId(task.provider, 'provider');
  validateOpaqueId(task.providerReference, 'provider reference');
  if (task.language !== 'id') throw new Error('Synchronization task language is invalid.');
  if (!['pending', 'processing', 'completed', 'rejected'].includes(task.status)) {
    throw new Error('Synchronization task status is invalid.');
  }
  nonNegativeSafeInteger(task.createdAt, 'task creation time');
  positiveSafeInteger(task.expiresAt, 'task expiry');
  if (task.expiresAt <= task.createdAt) throw new Error('Synchronization task expiry is invalid.');
}

export function validateSynchronizationResult(result: SynchronizationResult): void {
  validateOpaqueId(result.taskId, 'task id');
  confidence(result.confidence);
  if (!result.method.trim() || result.method.length > 64) {
    throw new Error('Synchronization result method is invalid.');
  }
  nonNegativeSafeInteger(result.createdAt, 'result creation time');
  positiveSafeInteger(result.expiresAt, 'result expiry');
  if (result.expiresAt <= result.createdAt) throw new Error('Synchronization result expiry is invalid.');
  let previousSource = -1;
  let previousReference = -1;
  for (const point of result.points) {
    nonNegativeSafeInteger(point.sourceMs, 'source timestamp');
    nonNegativeSafeInteger(point.referenceMs, 'reference timestamp');
    if (point.sourceMs <= previousSource || point.referenceMs <= previousReference) {
      throw new Error('Synchronization result points must be strictly monotonic.');
    }
    previousSource = point.sourceMs;
    previousReference = point.referenceMs;
  }
  if (result.mapping) {
    if (!Number.isFinite(result.mapping.scale) || result.mapping.scale <= 0) {
      throw new Error('Synchronization result scale is invalid.');
    }
    if (!Number.isFinite(result.mapping.offsetMs)) {
      throw new Error('Synchronization result offset is invalid.');
    }
    confidence(result.mapping.confidence);
    if (!Number.isSafeInteger(result.mapping.pointsUsed) || result.mapping.pointsUsed < 1) {
      throw new Error('Synchronization result pointsUsed is invalid.');
    }
  }
}

function validateOpaqueId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Synchronization ${label} is invalid.`);
}

function confidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Synchronization confidence is invalid.');
  }
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Synchronization ${label} is invalid.`);
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Synchronization ${label} is invalid.`);
}

function encodeSegment(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function decodeSegment(value: string): string {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid synchronization reference purpose.');
  }
}
