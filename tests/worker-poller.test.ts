import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { consoleSynchronizationJobObserver } from '../src/subtitles/synchronization-job-observability.js';
import { parseAllowedMediaHosts } from '../src/media/url-policy.js';

describe('GPU worker poller entrypoint', () => {
  it('keeps poller wiring out of the Vercel request path', () => {
    const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    const pollerSource = readFileSync(new URL('../src/worker-poller.ts', import.meta.url), 'utf8');
    expect(appSource).not.toContain('runPolling');
    expect(appSource).not.toContain('worker-poller');
    expect(pollerSource).toContain('runPolling');
    expect(pollerSource).toContain('recoverStale');
    expect(pollerSource).toContain('createStagingSynchronizationComposition');
  });

  it('logs content-free job events', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (value: unknown) => { lines.push(String(value)); };
    try {
      consoleSynchronizationJobObserver.record({
        event: 'completed',
        timestamp: 1,
        jobId: 'job_1',
        correlationId: 'job_1',
        attempt: 1,
        retryCount: 0,
        workerId: 'staging_worker',
        provider: 'opensubtitles',
        resultState: 'completed',
        evidenceCount: 9,
        selectedModel: 'offset-only',
        residualMs: 839
      });
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"completed"');
    expect(lines[0]).not.toContain('https://');
    expect(parseAllowedMediaHosts('a.example, b.example')).toEqual(['a.example', 'b.example']);
  });
});
