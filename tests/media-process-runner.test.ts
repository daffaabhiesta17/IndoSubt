import { execPath } from 'node:process';
import { describe, expect, it } from 'vitest';
import { SpawnProcessRunner } from '../src/media/process-runner.js';

describe('spawn process runner', () => {
  it('passes arguments without shell interpretation', async () => {
    const runner = new SpawnProcessRunner();
    const injected = '$(echo injected); & whoami | test';
    const result = await runner.run(
      execPath,
      ['-e', 'process.stdout.write(process.argv[1])', injected],
      { timeoutMs: 2_000, maxOutputBytes: 10_000 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(injected);
  });

  it('times out a long-running process', async () => {
    const runner = new SpawnProcessRunner();
    await expect(
      runner.run(execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        timeoutMs: 20,
        maxOutputBytes: 10_000
      })
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects output beyond the configured limit', async () => {
    const runner = new SpawnProcessRunner();
    await expect(
      runner.run(execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], {
        timeoutMs: 2_000,
        maxOutputBytes: 100
      })
    ).rejects.toMatchObject({ code: 'output_too_large' });
  });

  it('applies the output limit to stderr as well as stdout', async () => {
    const runner = new SpawnProcessRunner();
    await expect(
      runner.run(execPath, ['-e', "process.stderr.write('x'.repeat(10000))"], {
        timeoutMs: 2_000,
        maxOutputBytes: 100
      })
    ).rejects.toMatchObject({ code: 'output_too_large' });
  });

  it('maps executable spawn failure to a controlled process error', async () => {
    const runner = new SpawnProcessRunner();
    await expect(
      runner.run('indosync-definitely-missing-executable', [], {
        timeoutMs: 2_000,
        maxOutputBytes: 100
      })
    ).rejects.toMatchObject({ code: 'process_failed' });
  });
});
