import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { SubtitleProvider } from '../src/subtitles/provider.js';
import {
  ProviderSubtitleService,
  type SubtitleTimestampMappingResolver
} from '../src/subtitles/service.js';
import type {
  DownloadedSubtitle,
  SubtitleCandidate
} from '../src/subtitles/types.js';
import type { WebVttTimestampMapping } from '../src/subtitles/webvtt.js';

const sourceWebVtt = [
  'WEBVTT - IndoSync',
  'Language: id',
  '',
  'NOTE synchronization fixture',
  'This block must not change.',
  '',
  'STYLE',
  '::cue { color: lime; }',
  '',
  'REGION',
  'id:top',
  'width:40%',
  '',
  'cue-id',
  '00:00:01.000 --> 00:00:02.000 line:90% position:50% align:middle',
  '<v Neo><i>The Matrix</i></v>',
  'Baris kedua'
].join('\n');

const candidate: SubtitleCandidate = {
  provider: 'opensubtitles',
  reference: '42',
  language: 'id',
  fileName: 'The.Matrix.1999.1080p.BluRay-GROUP.srt'
};

function createProvider(
  content: string = sourceWebVtt,
  contentType: DownloadedSubtitle['contentType'] =
    'text/vtt; charset=utf-8'
): SubtitleProvider {
  return {
    name: 'opensubtitles',

    search: vi.fn().mockResolvedValue([
      candidate
    ]),

    download: vi.fn().mockResolvedValue({
      content,
      contentType,
      fileName: 'matrix-id.vtt'
    })
  };
}

function createMappingResolver(
  mapping: WebVttTimestampMapping
): SubtitleTimestampMappingResolver & {
  resolve: ReturnType<typeof vi.fn>;
} {
  return {
    resolve: vi.fn().mockResolvedValue(mapping)
  };
}

async function downloadThroughHttp(
  provider: SubtitleProvider,
  resolver?: SubtitleTimestampMappingResolver
) {
  const service = new ProviderSubtitleService(
    provider,
    'phase-3b-test-secret',
    { warn: vi.fn() },
    {
      rank: (candidates) => [...candidates]
    },
    resolver
  );

  const app = createApp(service);

  const searchResponse = await request(app).get(
    '/subtitles/movie/tt0133093.json'
  );

  expect(searchResponse.status).toBe(200);

  expect(
    searchResponse.body.subtitles
  ).toHaveLength(1);

  const subtitleUrl = new URL(
    searchResponse.body.subtitles[0].url
  );

  return request(app).get(
    subtitleUrl.pathname
  );
}

describe(
  'Phase 3B subtitle timestamp transformation integration',
  () => {
    it(
      'preserves provider output with the default identity mapping',
      async () => {
        const provider = createProvider();

        const response =
          await downloadThroughHttp(provider);

        expect(response.status).toBe(200);

        expect(
          response.headers['content-type']
        ).toContain('text/vtt');

        expect(response.text).toBe(
          sourceWebVtt
        );

        expect(
          provider.download
        ).toHaveBeenCalledTimes(1);

        expect(
          provider.download
        ).toHaveBeenCalledWith('42');
      }
    );

    it(
      'applies an explicit positive offset through the HTTP download flow',
      async () => {
        const provider =
          createProvider();

        const resolver =
          createMappingResolver({
            scale: 1,
            offsetMs: 2_500
          });

        const response =
          await downloadThroughHttp(
            provider,
            resolver
          );

        const expected =
          sourceWebVtt.replace(
            '00:00:01.000 --> 00:00:02.000',
            '00:00:03.500 --> 00:00:04.500'
          );

        expect(response.status).toBe(200);

        expect(
          response.headers['content-type']
        ).toContain('text/vtt');

        expect(response.text).toBe(
          expected
        );

        expect(
          resolver.resolve
        ).toHaveBeenCalledTimes(1);

        expect(
          resolver.resolve
        ).toHaveBeenCalledWith('42');

        expect(
          provider.download
        ).toHaveBeenCalledTimes(1);
      }
    );

    it(
      'applies an explicit negative offset according to the Phase 3A contract',
      async () => {
        const input = [
          'WEBVTT',
          '',
          'expired',
          '00:00:01.000 --> 00:00:02.000',
          'Expired',
          '',
          'remaining',
          '00:00:04.000 --> 00:00:05.000',
          'Remaining'
        ].join('\n');

        const provider =
          createProvider(input);

        const resolver =
          createMappingResolver({
            scale: 1,
            offsetMs: -2_500
          });

        const response =
          await downloadThroughHttp(
            provider,
            resolver
          );

        const expected = [
          'WEBVTT',
          '',
          'remaining',
          '00:00:01.500 --> 00:00:02.500',
          'Remaining'
        ].join('\n');

        expect(response.status).toBe(200);

        expect(response.text).toBe(
          expected
        );
      }
    );

    it(
      'applies scale and offset through the service boundary',
      async () => {
        const input = [
          'WEBVTT',
          '',
          '00:00:10.000 --> 00:00:20.000',
          'Scaled'
        ].join('\n');

        const provider =
          createProvider(input);

        const resolver =
          createMappingResolver({
            scale: 1.001,
            offsetMs: -1_200
          });

        const response =
          await downloadThroughHttp(
            provider,
            resolver
          );

        const expected = [
          'WEBVTT',
          '',
          '00:00:08.810 --> 00:00:18.820',
          'Scaled'
        ].join('\n');

        expect(response.status).toBe(200);

        expect(response.text).toBe(
          expected
        );
      }
    );

    it(
      'preserves identifier, multiline text, markup, settings, and special blocks',
      async () => {
        const provider =
          createProvider();

        const resolver =
          createMappingResolver({
            offsetMs: 1_000
          });

        const response =
          await downloadThroughHttp(
            provider,
            resolver
          );

        const expected =
          sourceWebVtt.replace(
            '00:00:01.000 --> 00:00:02.000',
            '00:00:02.000 --> 00:00:03.000'
          );

        expect(response.status).toBe(200);

        expect(response.text).toBe(
          expected
        );

        expect(response.text).toContain(
          'NOTE synchronization fixture\nThis block must not change.'
        );

        expect(response.text).toContain(
          'STYLE\n::cue { color: lime; }'
        );

        expect(response.text).toContain(
          'REGION\nid:top\nwidth:40%'
        );

        expect(response.text).toContain(
          'cue-id'
        );

        expect(response.text).toContain(
          'line:90% position:50% align:middle'
        );

        expect(response.text).toContain(
          '<v Neo><i>The Matrix</i></v>\nBaris kedua'
        );
      }
    );

    it(
      'does not mutate the subtitle object returned by the provider',
      async () => {
        const providerResult: DownloadedSubtitle = {
          content: sourceWebVtt,
          contentType:
            'text/vtt; charset=utf-8',
          fileName: 'matrix-id.vtt'
        };

        const provider: SubtitleProvider = {
          name: 'opensubtitles',

          search: vi.fn().mockResolvedValue([
            candidate
          ]),

          download: vi.fn().mockResolvedValue(
            providerResult
          )
        };

        const resolver =
          createMappingResolver({
            offsetMs: 1_000
          });

        const response =
          await downloadThroughHttp(
            provider,
            resolver
          );

        expect(response.status).toBe(200);

        expect(providerResult).toEqual({
          content: sourceWebVtt,
          contentType:
            'text/vtt; charset=utf-8',
          fileName: 'matrix-id.vtt'
        });
      }
    );

    it(
      'does not return corrupt subtitle content when transformation fails',
      async () => {
        const malformedWebVtt = [
          'WEBVTT',
          '',
          'cue-id',
          '00:00:AA.000 --> 00:00:02.000',
          'Malformed'
        ].join('\n');

        const provider =
          createProvider(
            malformedWebVtt
          );

        const resolver =
          createMappingResolver({
            offsetMs: 1_000
          });

        const response =
          await downloadThroughHttp(
            provider,
            resolver
          );

        expect(response.status).toBe(502);

        expect(
          response.headers['content-type']
        ).toContain('application/json');

        expect(response.body).toEqual({
          error:
            'Subtitle is temporarily unavailable.'
        });

        expect(response.text).not.toContain(
          'WEBVTT'
        );

        expect(response.text).not.toContain(
          'Malformed'
        );
      }
    );

    it(
      'does not return subtitle content when the mapping is invalid',
      async () => {
        const provider =
          createProvider();

        const resolver =
          createMappingResolver({
            scale: 0,
            offsetMs: 0
          });

        const response =
          await downloadThroughHttp(
            provider,
            resolver
          );

        expect(response.status).toBe(502);

        expect(
          response.headers['content-type']
        ).toContain('application/json');

        expect(response.body).toEqual({
          error:
            'Subtitle is temporarily unavailable.'
        });

        expect(response.text).not.toContain(
          'WEBVTT'
        );
      }
    );

    it(
      'keeps provider download output valid before service transformation',
      async () => {
        const provider =
          createProvider();

        const downloaded =
          await provider.download('42');

        expect(
          downloaded.contentType
        ).toBe(
          'text/vtt; charset=utf-8'
        );

        expect(
          downloaded.fileName
        ).toBe(
          'matrix-id.vtt'
        );

        expect(
          downloaded.content
        ).toBe(
          sourceWebVtt
        );

        expect(
          downloaded.content.startsWith(
            'WEBVTT'
          )
        ).toBe(true);
      }
    );
  }
);