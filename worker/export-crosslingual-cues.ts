import { readFileSync, writeFileSync } from 'node:fs';
import { parseWebVttCues } from '../src/subtitles/webvtt.js';
for (const directory of ['fixture/covost2-en-id', 'fixture/covost2-en-id-holdout']) {
  const input = readFileSync(`${directory}/subtitle-id.vtt`, 'utf8');
  writeFileSync(`${directory}/cues.json`, JSON.stringify(parseWebVttCues(input), null, 2));
}
