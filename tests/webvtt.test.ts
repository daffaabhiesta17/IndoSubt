import { describe, expect, it } from 'vitest';
import {
  parseWebVttCues,
  transformWebVtt,
  validateWebVtt
} from '../src/subtitles/webvtt.js';

function cue(
  timing = '00:00:01.000 --> 00:00:02.000',
  text = 'Halo'
): string {
  return ['WEBVTT', '', timing, text].join('\n');
}

describe('WebVTT timestamp transformation', () => {
  it('applies a positive 2500 ms offset', () => {
    expect(
      transformWebVtt(cue(), { offsetMs: 2_500 })
    ).toBe(
      cue('00:00:03.500 --> 00:00:04.500')
    );
  });

  it('applies a negative 2500 ms offset', () => {
    const input = cue(
      '00:00:10.000 --> 00:00:12.500'
    );

    expect(
      transformWebVtt(input, { offsetMs: -2_500 })
    ).toBe(
      cue('00:00:07.500 --> 00:00:10.000')
    );
  });

  it('returns validation output directly for identity mappings', () => {
    const input = [
      '\uFEFFWEBVTT',
      '',
      '00:01.000 --> 00:02.500',
      'Halo'
    ].join('\n');

    const expected = input.slice(1);

    expect(transformWebVtt(input)).toBe(expected);
    expect(
      transformWebVtt(input, {
        scale: 1,
        offsetMs: 0
      })
    ).toBe(expected);
  });

  it('applies scale only', () => {
    const input = cue(
      '00:00:10.000 --> 00:00:20.000'
    );

    expect(
      transformWebVtt(input, { scale: 1.5 })
    ).toBe(
      cue('00:00:15.000 --> 00:00:30.000')
    );
  });

  it('applies scale and offset with millisecond rounding', () => {
    const input = cue(
      '00:00:10.000 --> 00:00:20.000'
    );

    expect(
      transformWebVtt(input, {
        scale: 1.001,
        offsetMs: -1_200
      })
    ).toBe(
      cue('00:00:08.810 --> 00:00:18.820')
    );
  });

  it('clamps a negative start to zero', () => {
    const input = cue(
      '00:00:01.000 --> 00:00:03.000'
    );

    expect(
      transformWebVtt(input, { offsetMs: -2_500 })
    ).toBe(
      cue('00:00:00.000 --> 00:00:00.500')
    );
  });

  it('drops a cue entirely before zero', () => {
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

    const output = transformWebVtt(input, {
      offsetMs: -2_500
    });

    const expected = [
      'WEBVTT',
      '',
      'remaining',
      '00:00:01.500 --> 00:00:02.500',
      'Remaining'
    ].join('\n');

    expect(output).toBe(expected);
  });

  it('drops a cue that actually collapses after rounding', () => {
    const input = cue(
      '00:00:00.001 --> 00:00:00.002',
      'Collapsed'
    );

    expect(
      transformWebVtt(input, {
        scale: 0.1,
        offsetMs: 1
      })
    ).toBe('WEBVTT\n\n');
  });

  it('accepts a cue whose timing line is line zero', () => {
    const input = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Direct cue'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toBe([
      'WEBVTT',
      '',
      '00:00:02.000 --> 00:00:03.000',
      'Direct cue'
    ].join('\n'));
  });

  it('accepts an identifier followed by a timing line', () => {
    const input = [
      'WEBVTT',
      '',
      'cue-id',
      '00:00:01.000 --> 00:00:02.000',
      'Identified cue'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toBe([
      'WEBVTT',
      '',
      'cue-id',
      '00:00:02.000 --> 00:00:03.000',
      'Identified cue'
    ].join('\n'));
  });

  it('transforms every cue with exact full-output equality', () => {
    const input =
      'WEBVTT\n\n' +
      '1\n00:00:01.000 --> 00:00:02.000\nSatu\n\n' +
      '2\n00:00:03.000 --> 00:00:04.000\nDua\n\n' +
      '3\n00:00:05.000 --> 00:00:06.000\nTiga';

    const expected =
      'WEBVTT\n\n' +
      '1\n00:00:01.500 --> 00:00:02.500\nSatu\n\n' +
      '2\n00:00:03.500 --> 00:00:04.500\nDua\n\n' +
      '3\n00:00:05.500 --> 00:00:06.500\nTiga';

    expect(
      transformWebVtt(input, { offsetMs: 500 })
    ).toBe(expected);
  });

  it('preserves identifier, multiline text, markup, and settings', () => {
    const input = [
      'WEBVTT',
      '',
      'matrix-cue',
      '00:00:37.200 --> 00:00:40.200 line:90% position:50% align:middle',
      '<v Neo><i>The Matrix</i></v>',
      'Baris kedua'
    ].join('\n');

    const expected = [
      'WEBVTT',
      '',
      'matrix-cue',
      '00:00:39.700 --> 00:00:42.700 line:90% position:50% align:middle',
      '<v Neo><i>The Matrix</i></v>',
      'Baris kedua'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 2_500 })
    ).toBe(expected);
  });

  it('preserves special blocks and whitespace separators exactly', () => {
    const input =
      'WEBVTT - IndoSync\r\n' +
      'Language: id\r\n' +
      ' \t\r\n' +
      'NOTE metadata\r\n' +
      'Do not transform 00:00:01.000 --> text\r\n' +
      '\t \r\n' +
      'STYLE\r\n' +
      '::cue { color: lime; }\r\n' +
      ' \r\n' +
      'REGION\r\n' +
      'id:top\r\n' +
      'width:40%\r\n' +
      '\t\r\n' +
      'cue-id\r\n' +
      '00:00:01.000 --> 00:00:02.000 line:90%\r\n' +
      'Halo';

    const expected =
      'WEBVTT - IndoSync\r\n' +
      'Language: id\r\n' +
      ' \t\r\n' +
      'NOTE metadata\r\n' +
      'Do not transform 00:00:01.000 --> text\r\n' +
      '\t \r\n' +
      'STYLE\r\n' +
      '::cue { color: lime; }\r\n' +
      ' \r\n' +
      'REGION\r\n' +
      'id:top\r\n' +
      'width:40%\r\n' +
      '\t\r\n' +
      'cue-id\r\n' +
      '00:00:02.000 --> 00:00:03.000 line:90%\r\n' +
      'Halo';

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toBe(expected);
  });

  it('preserves LF with and without trailing newline', () => {
    const withoutTrailing = cue();
    const withTrailing = `${withoutTrailing}\n`;

    expect(
      transformWebVtt(withoutTrailing, {
        offsetMs: 1_000
      })
    ).toBe(
      cue('00:00:02.000 --> 00:00:03.000')
    );

    expect(
      transformWebVtt(withTrailing, {
        offsetMs: 1_000
      })
    ).toBe(
      `${cue('00:00:02.000 --> 00:00:03.000')}\n`
    );
  });

  it('preserves CRLF', () => {
    const input = [
      'WEBVTT',
      '',
      'cue-id',
      '00:00:01.000 --> 00:00:02.000',
      'Halo'
    ].join('\r\n');

    const expected = [
      'WEBVTT',
      '',
      'cue-id',
      '00:00:02.000 --> 00:00:03.000',
      'Halo'
    ].join('\r\n');

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toBe(expected);
  });

  it('supports whitespace-only blank separators', () => {
    const input = [
      'WEBVTT',
      ' \t',
      'cue-1',
      '00:00:01.000 --> 00:00:02.000',
      'Halo',
      '\t ',
      'cue-2',
      '00:00:03.000 --> 00:00:04.000',
      'Dunia'
    ].join('\n');

    const expected = [
      'WEBVTT',
      ' \t',
      'cue-1',
      '00:00:02.000 --> 00:00:03.000',
      'Halo',
      '\t ',
      'cue-2',
      '00:00:04.000 --> 00:00:05.000',
      'Dunia'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toBe(expected);
  });

  it('preserves multiple consecutive blank lines verbatim', () => {
    const input =
      'WEBVTT\n\n\ncue-1\n' +
      '00:00:01.000 --> 00:00:02.000\nHalo\n\n\n\n' +
      'cue-2\n00:00:03.000 --> 00:00:04.000\nDunia';

    const expected =
      'WEBVTT\n\n\ncue-1\n' +
      '00:00:02.000 --> 00:00:03.000\nHalo\n\n\n\n' +
      'cue-2\n00:00:04.000 --> 00:00:05.000\nDunia';

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toBe(expected);
  });

  it('drops a middle cue without changing unrelated separators', () => {
    const input =
      'WEBVTT\n\n' +
      'first\n00:00:04.000 --> 00:00:05.000\nFirst\n\n' +
      'expired\n00:00:01.000 --> 00:00:02.000\nExpired\n\n' +
      'last\n00:00:06.000 --> 00:00:07.000\nLast';

    const expected =
      'WEBVTT\n\n' +
      'first\n00:00:01.500 --> 00:00:02.500\nFirst\n\n' +
      'last\n00:00:03.500 --> 00:00:04.500\nLast';

    expect(
      transformWebVtt(input, { offsetMs: -2_500 })
    ).toBe(expected);
  });

  it('drops the last cue while preserving the preceding separator', () => {
    const input =
      'WEBVTT\n\n' +
      'remaining\n00:00:04.000 --> 00:00:05.000\nRemaining\n\n' +
      'expired\n00:00:01.000 --> 00:00:02.000\nExpired';

    const expected =
      'WEBVTT\n\n' +
      'remaining\n00:00:01.500 --> 00:00:02.500\nRemaining\n\n';

    expect(
      transformWebVtt(input, { offsetMs: -2_500 })
    ).toBe(expected);
  });

  it('drops consecutive cues without blank-line growth', () => {
    const input =
      'WEBVTT\n\n' +
      'expired-1\n00:00:00.500 --> 00:00:01.000\nExpired one\n\n' +
      'expired-2\n00:00:01.000 --> 00:00:02.000\nExpired two\n\n' +
      'remaining\n00:00:04.000 --> 00:00:05.000\nRemaining';

    const expected =
      'WEBVTT\n\n' +
      'remaining\n00:00:01.500 --> 00:00:02.500\nRemaining';

    expect(
      transformWebVtt(input, { offsetMs: -2_500 })
    ).toBe(expected);
  });

  it('preserves multiple separators owned by a retained block when the next cue is dropped', () => {
    const input =
      'WEBVTT\n\n' +
      'remaining\n00:00:04.000 --> 00:00:05.000\nRemaining\n\n\n\n' +
      'expired\n00:00:01.000 --> 00:00:02.000\nExpired';

    const expected =
      'WEBVTT\n\n' +
      'remaining\n00:00:01.500 --> 00:00:02.500\nRemaining\n\n\n\n';

    expect(
      transformWebVtt(input, { offsetMs: -2_500 })
    ).toBe(expected);
  });

  it('throws atomically when a later cue is malformed', () => {
    const input = [
      'WEBVTT',
      '',
      'valid',
      '00:00:01.000 --> 00:00:02.000',
      'Valid',
      '',
      'invalid',
      '00:00:AA.000 --> 00:00:04.000',
      'Invalid'
    ].join('\n');

    expect(() =>
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toThrow('malformed timestamp');
  });

  it('keeps short timestamps short below one hour', () => {
    const input = [
      'WEBVTT',
      '',
      '00:01.000 --> 00:02.500',
      'Short'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 500 })
    ).toBe([
      'WEBVTT',
      '',
      '00:01.500 --> 00:03.000',
      'Short'
    ].join('\n'));
  });

  it('converts short timestamps to long form at one hour', () => {
    const input = [
      'WEBVTT',
      '',
      '59:59.000 --> 59:59.500',
      'Crossing'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toContain(
      '01:00:00.000 --> 01:00:00.500'
    );
  });

  it('supports and preserves hour width above 99', () => {
    const input = [
      'WEBVTT',
      '',
      '100:00:00.000 --> 100:00:01.000',
      'Long'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toContain(
      '100:00:01.000 --> 100:00:02.000'
    );
  });

  it('does not treat literal arrows in cue text as timing lines', () => {
    const input = [
      'WEBVTT',
      '',
      'cue-id',
      '00:00:01.000 --> 00:00:02.000',
      'A --> B',
      'Literal arrow'
    ].join('\n');

    const expected = [
      'WEBVTT',
      '',
      'cue-id',
      '00:00:02.000 --> 00:00:03.000',
      'A --> B',
      'Literal arrow'
    ].join('\n');

    expect(
      transformWebVtt(input, { offsetMs: 1_000 })
    ).toBe(expected);
  });

  it('rejects malformed header', () => {
    expect(() =>
      transformWebVtt(
        'NOT-WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHalo',
        { offsetMs: 1_000 }
      )
    ).toThrow('not valid WebVTT');
  });

  it.each([
    '00:00:AA.000 --> 00:00:02.000',
    '00:60:00.000 --> 00:60:01.000',
    '00:00:60.000 --> 00:01:01.000',
    '00:00:01.00 --> 00:00:02.000'
  ])('rejects malformed timing with arrow: %s', (timing) => {
    expect(() =>
      transformWebVtt(
        ['WEBVTT', '', timing, 'Malformed'].join('\n'),
        { offsetMs: 1_000 }
      )
    ).toThrow('malformed timestamp');
  });

  it('rejects malformed timing without arrow', () => {
    expect(() =>
      transformWebVtt(
        [
          'WEBVTT',
          '',
          '00:00:AA.000 00:00:02.000',
          'Malformed'
        ].join('\n'),
        { offsetMs: 1_000 }
      )
    ).toThrow('timing line was not found');
  });

  it('rejects identifier followed by malformed timing', () => {
    expect(() =>
      transformWebVtt(
        [
          'WEBVTT',
          '',
          'cue-id',
          '00:00:AA.000 00:00:02.000',
          'Malformed'
        ].join('\n'),
        { offsetMs: 1_000 }
      )
    ).toThrow(
      'identifier is not followed by a valid timing line'
    );
  });

  it('rejects a non-special block without timing', () => {
    expect(() =>
      transformWebVtt(
        [
          'WEBVTT',
          '',
          'some-random-block',
          'without timing',
          'text'
        ].join('\n'),
        { offsetMs: 1_000 }
      )
    ).toThrow(
      'identifier is not followed by a valid timing line'
    );
  });

  it('rejects source start equal to or after end', () => {
    for (const timing of [
      '00:00:02.000 --> 00:00:02.000',
      '00:00:03.000 --> 00:00:02.000'
    ]) {
      expect(() =>
        transformWebVtt(
          ['WEBVTT', '', timing, 'Invalid'].join('\n'),
          { offsetMs: 1_000 }
        )
      ).toThrow('greater than its start');
    }
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ])('rejects invalid scale %s', (scale) => {
    expect(() =>
      transformWebVtt(cue(), { scale })
    ).toThrow('scale');
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])('rejects invalid offset %s', (offsetMs) => {
    expect(() =>
      transformWebVtt(cue(), { offsetMs })
    ).toThrow('offset');
  });

  it('rejects input timestamp overflow', () => {
    expect(() =>
      transformWebVtt(
        [
          'WEBVTT',
          '',
          '999999999999999:00:00.000 --> 999999999999999:00:01.000',
          'Overflow'
        ].join('\n'),
        { offsetMs: 1 }
      )
    ).toThrow('safe integer range');
  });

  it('rejects transformed timestamp overflow', () => {
    expect(() =>
      transformWebVtt(cue(), {
        scale: Number.MAX_VALUE,
        offsetMs: 0
      })
    ).toThrow('safe integer range');
  });

  it('rejects a finite offset that produces a non-safe timestamp', () => {
    expect(() =>
      transformWebVtt(cue(), {
        offsetMs: Number.MAX_SAFE_INTEGER
      })
    ).toThrow('safe integer range');
  });

  it('rejects a finite extremely large offset', () => {
    expect(() =>
      transformWebVtt(cue(), {
        offsetMs: Number.MAX_VALUE
      })
    ).toThrow('safe integer range');
  });

  it('accepts a large input timestamp that remains within the safe integer range', () => {
    const input = [
      'WEBVTT',
      '',
      '2501999785:59:58.991 --> 2501999785:59:59.991',
      'Large but safe'
    ].join('\n');

    expect(() =>
      transformWebVtt(input, { offsetMs: -1 })
    ).not.toThrow();
  });

  it('keeps validateWebVtt backward compatible', () => {
    const input = '\uFEFFWEBVTT\n\narbitrary body';

    expect(validateWebVtt(input)).toBe(
      'WEBVTT\n\narbitrary body'
    );
  });
});

describe('structured WebVTT cue parsing', () => {
  it('returns cue text and millisecond intervals with identifiers and settings', () => {
    const input = [
      '\uFEFFWEBVTT example',
      'Kind: captions',
      '',
      'STYLE',
      '::cue { color: lime; }',
      '',
      'cue-1',
      '00:01.250 --> 00:03.500 align:start position:10%',
      'Halo <b>dunia</b>',
      'baris kedua',
      '',
      '00:00:05.000 --> 00:00:06.000',
      'Sampai jumpa'
    ].join('\n');

    expect(parseWebVttCues(input)).toEqual([
      {
        text: 'Halo <b>dunia</b>\nbaris kedua',
        startMs: 1_250,
        endMs: 3_500
      },
      {
        text: 'Sampai jumpa',
        startMs: 5_000,
        endMs: 6_000
      }
    ]);
  });

  it('returns an empty list for a valid document without cues', () => {
    expect(parseWebVttCues('WEBVTT\n')).toEqual([]);
  });

  it('rejects invalid cue intervals and malformed cue timing', () => {
    expect(() =>
      parseWebVttCues('WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nInvalid')
    ).toThrow('greater than');
    expect(() =>
      parseWebVttCues('WEBVTT\n\n00:00:XX.000 --> 00:00:02.000\nInvalid')
    ).toThrow('malformed timestamp');
  });
});
