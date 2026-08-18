export function validateWebVtt(content: string): string {
  const withoutBom = content.replace(/^\uFEFF/, '');
  if (!/^WEBVTT(?:[ \t].*)?(?:\r?\n|$)/.test(withoutBom)) {
    throw new Error('Subtitle content is not valid WebVTT.');
  }
  return withoutBom;
}

export interface WebVttTimestampMapping {
  scale?: number;
  offsetMs?: number;
}

export interface WebVttCue {
  text: string;
  startMs: number;
  endMs: number;
}

interface DocumentBlock {
  block: string;
  followingSeparator: string;
}

interface BlockLine {
  text: string;
  start: number;
  end: number;
}

interface TimestampStyle {
  short: boolean;
  hourWidth: number;
}

interface ParsedTimestamp {
  milliseconds: number;
  style: TimestampStyle;
}

interface CueTimingLine {
  prefix: string;
  separator: string;
  suffix: string;
  start: ParsedTimestamp;
  end: ParsedTimestamp;
}

const timestampSource =
  '(?:\\d{2,}:[0-5]\\d:[0-5]\\d\\.\\d{3}|[0-5]\\d:[0-5]\\d\\.\\d{3})';

const timingLinePattern = new RegExp(
  `^(\\s*)(${timestampSource})([ \\t]+-->[ \\t]+)(${timestampSource})(.*)$`
);

const maximumSafeTimestamp = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parses validated WebVTT cue blocks into evidence-friendly structured data.
 * Cue text is returned without interpreting markup or discovering alignment.
 */
export function parseWebVttCues(content: string): WebVttCue[] {
  const blocks = splitDocumentBlocks(validateWebVtt(content));
  const cues: WebVttCue[] = [];

  // The first block contains the WEBVTT header and optional header metadata.
  for (let index = 1; index < blocks.length; index += 1) {
    const lines = readBlockLines(blocks[index].block);
    if (lines.length === 0 || isSpecialBlock(lines[0].text)) continue;

    const timingLineIndex = findTimingLineIndex(lines);
    const timing = parseTimingLine(lines[timingLineIndex].text);
    if (!timing) {
      throw new Error('WebVTT cue timing line contains a malformed timestamp.');
    }
    if (timing.start.milliseconds >= timing.end.milliseconds) {
      throw new Error('WebVTT cue end timestamp must be greater than its start timestamp.');
    }

    cues.push({
      text: lines
        .slice(timingLineIndex + 1)
        .map((line) => line.text)
        .join('\n'),
      startMs: timing.start.milliseconds,
      endMs: timing.end.milliseconds
    });
  }

  return cues;
}

/**
 * Applies a known linear mapping to WebVTT cue timestamps.
 *
 * outputMs = round(inputMs * scale + offsetMs)
 *
 * This function does not discover or calculate synchronization parameters.
 */
export function transformWebVtt(
  content: string,
  mapping: WebVttTimestampMapping = {}
): string {
  const validated = validateWebVtt(content);
  const scale = mapping.scale ?? 1;
  const offsetMs = mapping.offsetMs ?? 0;

  validateMapping(scale, offsetMs);

  // Preserve the original timestamp representation and document structure
  // when no transformation is requested. BOM behavior remains identical to
  // validateWebVtt(): an initial BOM is removed.
  if (scale === 1 && offsetMs === 0) {
    return validated;
  }

  const blocks = splitDocumentBlocks(validated);
  if (blocks.length === 0) return validated;

  let output = blocks[0].block + blocks[0].followingSeparator;

  for (let index = 1; index < blocks.length; index += 1) {
    const entry = blocks[index];
    const transformed = transformCueBlock(
      entry.block,
      scale,
      offsetMs
    );

    // Dropping a cue also drops the separator that originally followed it.
    // The separator before it belongs to the preceding retained block.
    if (transformed === undefined) continue;

    output += transformed + entry.followingSeparator;
  }

  return output;
}

function validateMapping(scale: number, offsetMs: number): void {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      'WebVTT timestamp scale must be finite and greater than zero.'
    );
  }

  if (!Number.isFinite(offsetMs)) {
    throw new Error('WebVTT timestamp offset must be finite.');
  }
}

function transformCueBlock(
  block: string,
  scale: number,
  offsetMs: number
): string | undefined {
  const lines = readBlockLines(block);

  if (lines.length === 0) {
    throw new Error('WebVTT block is empty.');
  }

  if (isSpecialBlock(lines[0].text)) {
    return block;
  }

  const timingLineIndex = findTimingLineIndex(lines);
  const timingLine = lines[timingLineIndex];
  const timing = parseTimingLine(timingLine.text);

  if (!timing) {
    throw new Error(
      'WebVTT cue timing line contains a malformed timestamp.'
    );
  }

  if (timing.start.milliseconds >= timing.end.milliseconds) {
    throw new Error(
      'WebVTT cue end timestamp must be greater than its start timestamp.'
    );
  }

  let transformedStart = transformTimestamp(
    timing.start.milliseconds,
    scale,
    offsetMs
  );

  const transformedEnd = transformTimestamp(
    timing.end.milliseconds,
    scale,
    offsetMs
  );

  if (transformedEnd <= 0) {
    return undefined;
  }

  if (transformedStart < 0) {
    transformedStart = 0;
  }

  if (transformedEnd <= transformedStart) {
    return undefined;
  }

  const transformedTimingLine =
    timing.prefix +
    formatTimestamp(transformedStart, timing.start.style) +
    timing.separator +
    formatTimestamp(transformedEnd, timing.end.style) +
    timing.suffix;

  return (
    block.slice(0, timingLine.start) +
    transformedTimingLine +
    block.slice(timingLine.end)
  );
}

function isSpecialBlock(firstLine: string): boolean {
  const normalized = firstLine.trimStart();

  return /^(?:NOTE(?:[ \t]|$)|STYLE(?:[ \t]|$)|REGION(?:[ \t]|$))/.test(
    normalized
  );
}

function findTimingLineIndex(lines: readonly BlockLine[]): number {
  const firstLine = lines[0];

  if (timingLinePattern.test(firstLine.text)) {
    return 0;
  }

  if (firstLine.text.includes('-->')) {
    throw new Error(
      'WebVTT cue timing line contains a malformed timestamp.'
    );
  }

  if (looksLikeTimingWithoutArrow(firstLine.text)) {
    throw new Error('WebVTT cue timing line was not found.');
  }

  const secondLine = lines[1];

  if (!secondLine) {
    throw new Error('WebVTT cue timing line was not found.');
  }

  if (timingLinePattern.test(secondLine.text)) {
    return 1;
  }

  if (secondLine.text.includes('-->')) {
    throw new Error(
      'WebVTT cue timing line contains a malformed timestamp.'
    );
  }

  throw new Error(
    'WebVTT cue identifier is not followed by a valid timing line.'
  );
}

function looksLikeTimingWithoutArrow(line: string): boolean {
  return /\d{2,}:\S+[ \t]+\d{2,}:\S+/.test(line);
}

function parseTimingLine(line: string): CueTimingLine | undefined {
  const match = timingLinePattern.exec(line);

  if (!match) return undefined;

  return {
    prefix: match[1],
    start: parseTimestamp(match[2]),
    separator: match[3],
    end: parseTimestamp(match[4]),
    suffix: match[5]
  };
}

function parseTimestamp(timestamp: string): ParsedTimestamp {
  const components = timestamp.split(':');
  const short = components.length === 2;

  if (!short && components.length !== 3) {
    throw new Error(
      'WebVTT cue timing line contains a malformed timestamp.'
    );
  }

  const hoursText = short ? '0' : components[0];
  const minutesText = short ? components[0] : components[1];
  const secondsAndMilliseconds = short
    ? components[1]
    : components[2];

  const secondsMatch = /^(\d{2})\.(\d{3})$/.exec(
    secondsAndMilliseconds
  );

  if (!secondsMatch) {
    throw new Error(
      'WebVTT cue timing line contains a malformed timestamp.'
    );
  }

  const minutes = Number(minutesText);
  const seconds = Number(secondsMatch[1]);
  const milliseconds = Number(secondsMatch[2]);

  if (
    !/^\d+$/.test(hoursText) ||
    !/^\d{2}$/.test(minutesText) ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59 ||
    milliseconds < 0 ||
    milliseconds > 999
  ) {
    throw new Error(
      'WebVTT cue timing line contains a malformed timestamp.'
    );
  }

  const hours = BigInt(hoursText);

  const total =
    hours * 3_600_000n +
    BigInt(minutes) * 60_000n +
    BigInt(seconds) * 1_000n +
    BigInt(milliseconds);

  if (total > maximumSafeTimestamp) {
    throw new Error(
      'WebVTT cue timestamp is outside the supported safe integer range.'
    );
  }

  return {
    milliseconds: Number(total),
    style: {
      short,
      hourWidth: short ? 2 : hoursText.length
    }
  };
}

function transformTimestamp(
  inputMs: number,
  scale: number,
  offsetMs: number
): number {
  const transformed = Math.round(
    inputMs * scale + offsetMs
  );

  if (!Number.isSafeInteger(transformed)) {
    throw new Error(
      'Transformed WebVTT timestamp is outside the supported safe integer range.'
    );
  }

  return transformed;
}

function formatTimestamp(
  timestampMs: number,
  style: TimestampStyle
): string {
  const hours = Math.floor(timestampMs / 3_600_000);
  const afterHours = timestampMs % 3_600_000;
  const minutes = Math.floor(afterHours / 60_000);
  const afterMinutes = afterHours % 60_000;
  const seconds = Math.floor(afterMinutes / 1_000);
  const milliseconds = afterMinutes % 1_000;

  const minutePart = String(minutes).padStart(2, '0');
  const secondPart = String(seconds).padStart(2, '0');
  const millisecondPart = String(milliseconds).padStart(3, '0');

  if (style.short && hours === 0) {
    return `${minutePart}:${secondPart}.${millisecondPart}`;
  }

  const hourWidth = Math.max(2, style.hourWidth);
  const hourPart = String(hours).padStart(hourWidth, '0');

  return `${hourPart}:${minutePart}:${secondPart}.${millisecondPart}`;
}

function splitDocumentBlocks(content: string): DocumentBlock[] {
  const lines = readCompleteLines(content);
  const blocks: DocumentBlock[] = [];

  let block = '';
  let separator = '';
  let readingSeparator = false;

  for (const line of lines) {
    if (isBlankLine(line)) {
      if (readingSeparator) {
        separator += line;
      } else {
        readingSeparator = true;
        separator = line;
      }
      continue;
    }

    if (readingSeparator) {
      blocks.push({
        block,
        followingSeparator: separator
      });

      block = line;
      separator = '';
      readingSeparator = false;
    } else {
      block += line;
    }
  }

  if (block || separator) {
    blocks.push({
      block,
      followingSeparator: separator
    });
  }

  return blocks;
}

function isBlankLine(completeLine: string): boolean {
  const text = removeLineEnding(completeLine);
  return /^[ \t]*$/.test(text);
}

function readCompleteLines(content: string): string[] {
  const lines: string[] = [];
  const linePattern = /[^\r\n]*(?:\r\n|\n|$)/g;

  for (const match of content.matchAll(linePattern)) {
    if (match[0]) lines.push(match[0]);
  }

  return lines;
}

function readBlockLines(block: string): BlockLine[] {
  const lines: BlockLine[] = [];
  const linePattern = /[^\r\n]*(?:\r\n|\n|$)/g;

  for (const match of block.matchAll(linePattern)) {
    const completeLine = match[0];

    if (!completeLine) continue;

    const newlineLength = completeLine.endsWith('\r\n')
      ? 2
      : completeLine.endsWith('\n')
        ? 1
        : 0;

    const start = match.index;
    const end =
      start + completeLine.length - newlineLength;

    lines.push({
      text: completeLine.slice(
        0,
        completeLine.length - newlineLength
      ),
      start,
      end
    });
  }

  return lines;
}

function removeLineEnding(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  if (line.endsWith('\n')) return line.slice(0, -1);
  return line;
}