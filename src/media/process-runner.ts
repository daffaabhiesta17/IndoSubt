import { spawn } from 'node:child_process';
import { MediaProbeError } from './types.js';

export interface ProcessRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProcessRunResult {
  stdout: string;
  stdoutBytes?: Uint8Array;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): Promise<ProcessRunResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: ProcessRunOptions
  ): Promise<ProcessRunResult> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('Process timeout must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
      throw new Error('Process output limit must be a positive safe integer.');
    }

    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finishWithError = (error: MediaProbeError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(error);
      };

      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > options.maxOutputBytes) {
          finishWithError(new MediaProbeError('output_too_large', 'Media probe output exceeded its limit.'));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', () => {
        finishWithError(new MediaProbeError('process_failed', 'Media probe process failed.'));
      });
      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stdoutBytes: new Uint8Array(Buffer.concat(stdout)),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? -1
        });
      });

      const timer = setTimeout(() => {
        finishWithError(new MediaProbeError('timeout', 'Media probe process timed out.'));
      }, options.timeoutMs);
      timer.unref();
    });
  }
}


