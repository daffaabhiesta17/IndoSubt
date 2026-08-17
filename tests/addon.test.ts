import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { FixtureSubtitleService } from '../src/subtitles/service.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

// Tests use the deterministic fixture service so they never depend on
// OPENSUBTITLES_API_KEY or the external OpenSubtitles API.
const testApp = createApp(new FixtureSubtitleService());

describe('IndoSync Phase 1 Stremio protocol', () => {
  it('exports the Express app as Vercel-compatible default export', async () => {
    const { default: app, app: namedApp } = await import('../src/app.js');

    expect(app).toBe(namedApp);
  });

  it('serves a valid minimal subtitle manifest', async () => {
    const response = await request(testApp).get('/manifest.json');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.body).toMatchObject({
      id: 'org.indosync.phase1',
      version: '0.1.0',
      resources: ['subtitles'],
      types: ['movie', 'series'],
      idPrefixes: ['tt']
    });
  });

  it('returns one Indonesian subtitle for a movie request', async () => {
    const response = await request(testApp).get(
      '/subtitles/movie/tt0133093.json'
    );

    expect(response.status).toBe(200);
    expect(response.body.subtitles).toHaveLength(1);
    expect(response.body.subtitles[0]).toMatchObject({
      id: 'indosync-static-indonesian-v1',
      lang: 'ind'
    });
    expect(response.body.subtitles[0].url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/subtitles\/indosync-id\.vtt$/
    );
  });

  it('returns one Indonesian subtitle for a series episode request', async () => {
    const response = await request(testApp).get(
      '/subtitles/series/tt0944947:1:1.json'
    );

    expect(response.status).toBe(200);
    expect(response.body.subtitles).toHaveLength(1);
    expect(response.body.subtitles[0]).toMatchObject({
      id: 'indosync-static-indonesian-v1',
      lang: 'ind'
    });
  });

  it('serves the static WebVTT subtitle fixture', async () => {
    const response = await request(testApp).get(
      '/subtitles/indosync-id.vtt'
    );

    const fixture = await readFile(
      path.resolve(
        testDirectory,
        '../public/subtitles/indosync-id.vtt'
      ),
      'utf8'
    );

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.text).toBe(fixture);
    expect(response.text).toContain('WEBVTT');
    expect(response.text).toContain('Bahasa Indonesia');
  });

  it('handles CORS preflight requests', async () => {
    const response = await request(testApp).options('/manifest.json');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe(
      'GET, OPTIONS'
    );
  });
});