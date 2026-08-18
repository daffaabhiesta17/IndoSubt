import {
  validateSynchronizationResult,
  validateSynchronizationTask,
  type SynchronizationResult,
  type SynchronizationResultStore,
  type SynchronizationTask,
  type SynchronizationTaskStatus,
  type SynchronizationTaskStore
} from './synchronization-context.js';

interface UpstashResponse<T> {
  result?: T;
  error?: string;
}

export interface UpstashRedisOptions {
  url: string;
  token: string;
  keyPrefix?: string;
  fetch?: typeof globalThis.fetch;
}

const transitionScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local task = cjson.decode(raw)
if task.id ~= ARGV[1] then return 'wrong-task' end
if tonumber(task.expiresAt) <= tonumber(ARGV[4]) then
  redis.call('DEL', KEYS[1])
  return 'expired'
end
if task.status ~= ARGV[2] then return 'invalid-state:' .. task.status end
task.status = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(task), 'PXAT', task.expiresAt)
return cjson.encode(task)
`;

const completionScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'missing' end
local task = cjson.decode(raw)
local result = cjson.decode(ARGV[2])
if task.id ~= ARGV[1] or result.taskId ~= task.id then return 'wrong-task' end
if tonumber(task.expiresAt) <= tonumber(ARGV[3]) then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return 'expired'
end
if task.status == 'completed' or redis.call('EXISTS', KEYS[2]) == 1 then return 'duplicate' end
if task.status ~= 'processing' then return 'invalid-state:' .. task.status end
if tonumber(result.expiresAt) > tonumber(task.expiresAt) or tonumber(result.expiresAt) <= tonumber(ARGV[3]) then
  return 'invalid-expiry'
end
redis.call('SET', KEYS[2], ARGV[2], 'PXAT', result.expiresAt)
task.status = 'completed'
redis.call('SET', KEYS[1], cjson.encode(task), 'PXAT', task.expiresAt)
return 'ok'
`;

/** Durable serverless store backed by the official Upstash Redis REST API. */
class UpstashSynchronizationBackend {
  private readonly url: string;
  private readonly token: string;
  private readonly prefix: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: UpstashRedisOptions) {
    this.url = validateUrl(options.url);
    if (!options.token.trim()) throw new Error('KV_REST_API_TOKEN is required.');
    this.token = options.token;
    this.prefix = validatePrefix(options.keyPrefix ?? 'indosync:synchronization:v1');
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation) throw new Error('A Fetch implementation is required.');
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): UpstashSynchronizationBackend {
    const url = environment.KV_REST_API_URL?.trim();
    const token = environment.KV_REST_API_TOKEN?.trim();
    if (!url || !token) {
      throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN are required for synchronization storage.');
    }
    return new UpstashSynchronizationBackend({ url, token });
  }

  async createTask(task: SynchronizationTask): Promise<void> {
    validateSynchronizationTask(task);
    const reply = await this.command<string | null>([
      'SET', this.taskKey(task.id), JSON.stringify(task), 'NX', 'PXAT', String(task.expiresAt)
    ]);
    if (reply === null) throw new Error('Synchronization task already exists.');
  }

  async createResult(result: SynchronizationResult): Promise<void> {
    validateSynchronizationResult(result);
    const reply = await this.evalScript(
      completionScript,
      [this.taskKey(result.taskId), this.resultKey(result.taskId)],
      [result.taskId, JSON.stringify(result), String(result.createdAt)]
    );
    if (reply !== 'ok') throw transitionError(reply);
  }

  async getTask(id: string): Promise<SynchronizationTask | null> {
    validateStorageId(id);
    const raw = await this.command<string | null>(['GET', this.taskKey(id)]);
    return raw === null ? null : parseTask(raw);
  }

  async getResult(taskId: string): Promise<SynchronizationResult | null> {
    validateStorageId(taskId);
    const raw = await this.command<string | null>(['GET', this.resultKey(taskId)]);
    return raw === null ? null : parseResult(raw);
  }
  async transition(
    taskId: string,
    expected: SynchronizationTaskStatus,
    next: SynchronizationTaskStatus,
    now: number
  ): Promise<SynchronizationTask> {
    validateStorageId(taskId);
    validateNow(now);
    if (expected !== 'pending' || next !== 'processing') {
      throw new Error('Unsupported synchronization task transition.');
    }
    const reply = await this.evalScript(transitionScript, [this.taskKey(taskId)], [
      taskId, expected, next, String(now)
    ]);
    if (reply.startsWith('{')) return parseTask(reply);
    throw transitionError(reply);
  }

  async complete(task: SynchronizationTask, result: SynchronizationResult, now: number): Promise<void> {
    validateSynchronizationTask(task);
    validateSynchronizationResult(result);
    validateNow(now);
    if (result.taskId !== task.id) throw new Error('Synchronization result task does not match.');
    const reply = await this.evalScript(
      completionScript,
      [this.taskKey(task.id), this.resultKey(task.id)],
      [task.id, JSON.stringify(result), String(now)]
    );
    if (reply !== 'ok') throw transitionError(reply);
  }

  private async evalScript(script: string, keys: string[], args: string[]): Promise<string> {
    return this.command<string>(['EVAL', script, String(keys.length), ...keys, ...args]);
  }

  private async command<T>(command: readonly string[]): Promise<T> {
    const response = await this.fetchImplementation(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    });
    if (!response.ok) throw new Error(`Upstash Redis request failed with status ${response.status}.`);
    const payload = (await response.json()) as UpstashResponse<T>;
    if (payload.error) throw new Error('Upstash Redis command failed.');
    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
      throw new Error('Upstash Redis returned a malformed response.');
    }
    return payload.result as T;
  }

  private taskKey(id: string): string { return `${this.prefix}:task:${id}`; }
  private resultKey(id: string): string { return `${this.prefix}:result:${id}`; }
}

export class UpstashSynchronizationTaskStore implements SynchronizationTaskStore {
  private readonly backend: UpstashSynchronizationBackend;

  constructor(options: UpstashRedisOptions) { this.backend = new UpstashSynchronizationBackend(options); }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): UpstashSynchronizationTaskStore {
    return new UpstashSynchronizationTaskStore(environmentOptions(environment));
  }

  create(task: SynchronizationTask): Promise<void> { return this.backend.createTask(task); }
  get(id: string): Promise<SynchronizationTask | null> { return this.backend.getTask(id); }
  update(_task: SynchronizationTask): Promise<void> {
    return Promise.reject(new Error('Unconditional synchronization task updates are not supported by Upstash storage.'));
  }
  transition(taskId: string, expected: SynchronizationTaskStatus, next: SynchronizationTaskStatus, now: number): Promise<SynchronizationTask> {
    return this.backend.transition(taskId, expected, next, now);
  }
}

export class UpstashSynchronizationResultStore implements SynchronizationResultStore {
  private readonly backend: UpstashSynchronizationBackend;

  constructor(options: UpstashRedisOptions) { this.backend = new UpstashSynchronizationBackend(options); }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): UpstashSynchronizationResultStore {
    return new UpstashSynchronizationResultStore(environmentOptions(environment));
  }

  create(result: SynchronizationResult): Promise<void> { return this.backend.createResult(result); }
  get(taskId: string): Promise<SynchronizationResult | null> { return this.backend.getResult(taskId); }
  complete(task: SynchronizationTask, result: SynchronizationResult, now: number): Promise<void> {
    return this.backend.complete(task, result, now);
  }
}

function environmentOptions(environment: NodeJS.ProcessEnv): UpstashRedisOptions {
  const url = environment.KV_REST_API_URL?.trim();
  const token = environment.KV_REST_API_TOKEN?.trim();
  if (!url || !token) {
    throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN are required for synchronization storage.');
  }
  return { url, token };
}
function parseTask(raw: string): SynchronizationTask {
  const value = parseJson(raw) as SynchronizationTask;
  validateSynchronizationTask(value);
  return value;
}

function parseResult(raw: string): SynchronizationResult {
  const value = parseJson(raw) as SynchronizationResult;
  validateSynchronizationResult(value);
  return value;
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new Error('Upstash Redis stored malformed synchronization data.'); }
}

function transitionError(code: string): Error {
  if (code === 'duplicate') return new Error('Synchronization task is already completed.');
  if (code === 'wrong-task') return new Error('Synchronization result task does not match.');
  if (code === 'expired' || code === 'missing') return new Error('Synchronization task was not found.');
  if (code === 'invalid-expiry') return new Error('Synchronization result expiry is outside the task lifetime.');
  if (code.startsWith('invalid-state:')) return new Error('Synchronization task state transition is invalid.');
  return new Error('Synchronization storage transition failed.');
}

function validateUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('KV_REST_API_URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('KV_REST_API_URL must be a credential-free HTTPS URL.');
  }
  return url.toString();
}

function validatePrefix(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(value)) throw new Error('Upstash synchronization key prefix is invalid.');
  return value;
}

function validateStorageId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Synchronization task id is invalid.');
  }
}
function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Current time is invalid.');
}





