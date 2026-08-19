import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SynchronizationEvidenceEngine, SynchronizationEvidenceEngineInput, SynchronizationEvidenceEngineOutput } from './synchronization-worker.js';
import { validateSynchronizationEvidence } from './synchronization-evidence.js';
import {
  evidenceEngineProtocolVersion,
  type EvidenceEngineProtocolMessage,
  type EvidenceEngineProtocolRequest
} from './synchronization-evidence-engine-protocol.js';

export type EvidenceEngineProcessErrorCategory =
  | 'invalid_input' | 'spawn_failure' | 'process_crash' | 'timeout'
  | 'cancelled' | 'malformed_response' | 'output_too_large' | 'engine_error';

export class EvidenceEngineProcessError extends Error {
  constructor(public readonly category: EvidenceEngineProcessErrorCategory, message: string) {
    super(message); this.name = 'EvidenceEngineProcessError';
  }
}

export interface EvidenceEngineProcessAdapterOptions {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxAudioBytes?: number;
  maxCueCount?: number;
  maxCueTextLength?: number;
  signal?: AbortSignal;
  spawnProcess?: typeof spawn;
  temporaryRoot?: string;
  protocolMediaPath?: string;
}

/** FIFO semaphore; default single permit enforces one model process per GPU. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly permits = 1) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new EvidenceEngineProcessError('cancelled', 'Evidence engine request was cancelled.');
    if (this.active < this.permits) { this.active += 1; return () => this.release(); }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => { cleanup(); this.active += 1; resolve(); };
      const abort = () => { const index = this.waiting.indexOf(waiter); if (index >= 0) this.waiting.splice(index, 1); cleanup(); reject(new EvidenceEngineProcessError('cancelled', 'Evidence engine request was cancelled.')); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.waiting.push(waiter); signal?.addEventListener('abort', abort, { once: true });
    });
    return () => this.release();
  }
  private release() { this.active -= 1; this.waiting.shift()?.(); }
}

export class EvidenceEngineProcessAdapter implements SynchronizationEvidenceEngine {
  private readonly semaphore = new Semaphore(1);
  private readonly timeoutMs: number; private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number; private readonly maxAudioBytes: number;
  private readonly maxCueCount: number; private readonly maxCueTextLength: number;
  constructor(private readonly options: EvidenceEngineProcessAdapterOptions) {
    if (!options.command.trim()) throw new Error('Evidence engine command is required.');
    this.timeoutMs = bounded(options.timeoutMs ?? 120_000, 1, 30 * 60_000, 'timeout');
    this.maxInputBytes = bounded(options.maxInputBytes ?? 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'input limit');
    this.maxOutputBytes = bounded(options.maxOutputBytes ?? 16 * 1024 * 1024, 1, 64 * 1024 * 1024, 'output limit');
    this.maxAudioBytes = bounded(options.maxAudioBytes ?? 16 * 1024 * 1024, 44, 64 * 1024 * 1024, 'audio limit');
    this.maxCueCount = bounded(options.maxCueCount ?? 2_000, 1, 10_000, 'cue limit');
    this.maxCueTextLength = bounded(options.maxCueTextLength ?? 4_096, 1, 16_384, 'cue text limit');
  }
  async generate(input: SynchronizationEvidenceEngineInput, requestSignal?: AbortSignal): Promise<SynchronizationEvidenceEngineOutput> {
    const signal = requestSignal ?? this.options.signal; const release = await this.semaphore.acquire(signal);
    let directory: string | undefined;
    try {
      this.validateInput(input);
      directory = await mkdtemp(path.join(this.options.temporaryRoot ?? tmpdir(), 'indosync-evidence-'));
      const mediaPath = path.join(directory, 'audio.wav'); await writeFile(mediaPath, input.audio.bytes, { flag: 'wx' });
      const requestId = deterministicRequestId(input);
      const protocolMediaPath = this.options.protocolMediaPath
        ? this.options.protocolMediaPath.replace('{tempDirectory}', path.basename(directory))
        : mediaPath;
      const request: EvidenceEngineProtocolRequest = {
        protocolVersion: evidenceEngineProtocolVersion, requestId, mediaPath: protocolMediaPath,
        cues: input.cues.map((cue, cueIndex) => ({ cueIndex, ...cue }))
      };
      const serialized = JSON.stringify(request) + '\n';
      if (Buffer.byteLength(serialized) > this.maxInputBytes) throw new EvidenceEngineProcessError('invalid_input', 'Evidence engine request exceeds its input limit.');
      const messages = await this.execute(serialized, requestId, signal);
      const result = messages.find((message) => message.type === 'result');
      if (!messages.some((message) => message.type === 'ready')) throw new EvidenceEngineProcessError('malformed_response', 'Evidence engine did not report readiness.');
      if (!result || result.type !== 'result') throw new EvidenceEngineProcessError('malformed_response', 'Evidence engine did not return a result.');
      if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 || !result.method.trim()) throw new EvidenceEngineProcessError('malformed_response', 'Evidence engine result metadata is invalid.');
      if (result.evidence.length > 0) validateSynchronizationEvidence(result.evidence);
      const ready = messages.find((message) => message.type === 'ready');
      return {
        evidence: result.evidence,
        confidence: result.confidence,
        method: result.method,
        metrics: result.metrics,
        models: ready?.type === 'ready'
          ? {
              whisperRevision: ready.models.whisperRevision,
              labseRevision: ready.models.labseRevision
            }
          : undefined
      };
    } catch (error) {
      if (error instanceof EvidenceEngineProcessError) throw error;
      throw new EvidenceEngineProcessError('malformed_response', 'Evidence engine returned invalid evidence.');
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      release();
    }
  }
  private validateInput(input: SynchronizationEvidenceEngineInput) {
    if (input.audio.bytes.byteLength > this.maxAudioBytes) throw new EvidenceEngineProcessError('invalid_input', 'Evidence engine audio exceeds its limit.');
    if (!input.cues.length || input.cues.length > this.maxCueCount || input.cues.some((cue) => !cue.text.trim() || cue.text.length > this.maxCueTextLength)) throw new EvidenceEngineProcessError('invalid_input', 'Evidence engine cues are invalid.');
  }
  private execute(serialized: string, requestId: string, signal?: AbortSignal): Promise<EvidenceEngineProtocolMessage[]> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new EvidenceEngineProcessError('cancelled', 'Evidence engine request was cancelled.'));
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (this.options.spawnProcess ?? spawn)(
          this.options.command,
          [...(this.options.args ?? [])],
          { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        );
      } catch {
        reject(new EvidenceEngineProcessError('spawn_failure', 'Evidence engine process could not be spawned.'));
        return;
      }
      let output = Buffer.alloc(0);
      let outputBytes = 0;
      let settled = false;
      let terminationError: EvidenceEngineProcessError | undefined;
      const finish = (error?: Error, messages?: EvidenceEngineProtocolMessage[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(messages ?? []);
      };
      const terminate = (error: EvidenceEngineProcessError) => {
        if (settled || terminationError) return;
        terminationError = error;
        child.kill('SIGKILL');
      };
      const abort = () => terminate(
        new EvidenceEngineProcessError('cancelled', 'Evidence engine request was cancelled.')
      );
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(
        new EvidenceEngineProcessError('spawn_failure', 'Evidence engine process failed to start.')
      ));
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes) {
          terminate(new EvidenceEngineProcessError(
            'output_too_large',
            'Evidence engine output exceeded its limit.'
          ));
          return;
        }
        output = Buffer.concat([output, chunk]);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes) {
          terminate(new EvidenceEngineProcessError(
            'output_too_large',
            'Evidence engine output exceeded its limit.'
          ));
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (terminationError) {
          finish(terminationError);
          return;
        }
        let messages: EvidenceEngineProtocolMessage[];
        try {
          messages = output.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
        } catch {
          finish(new EvidenceEngineProcessError('malformed_response', 'Evidence engine output is malformed.'));
          return;
        }
        if (messages.some((message) =>
          message.protocolVersion !== evidenceEngineProtocolVersion ||
          message.requestId !== requestId
        )) {
          finish(new EvidenceEngineProcessError(
            'malformed_response',
            'Evidence engine response correlation failed.'
          ));
          return;
        }
        const engineError = messages.find((message) => message.type === 'error');
        if (engineError?.type === 'error') {
          finish(new EvidenceEngineProcessError(
            'engine_error',
            `Evidence engine ${engineError.category}: ${engineError.message}`
          ));
          return;
        }
        if (code !== 0) {
          finish(new EvidenceEngineProcessError(
            'process_crash',
            `Evidence engine process exited with code ${code ?? -1}.`
          ));
          return;
        }
        finish(undefined, messages);
      });
      const timer = setTimeout(() => terminate(
        new EvidenceEngineProcessError('timeout', 'Evidence engine request timed out.')
      ), this.timeoutMs);
      timer.unref();
      child.stdin.end(serialized);
    });
  }

}

function deterministicRequestId(input: SynchronizationEvidenceEngineInput): string {
  return createHash('sha256').update(input.task.id).update('\0').update(input.task.providerReference).update('\0').update(JSON.stringify(input.cues)).update('\0').update(input.audio.bytes).digest('base64url').slice(0, 32);
}
function bounded(value: number, min: number, max: number, label: string) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Evidence engine ${label} is invalid.`); return value; }
