import { addonBuilder, type SubtitlesHandlerArgs } from 'stremio-addon-sdk';
import type { SubtitleService } from './subtitles/service.js';
import type { SubtitleRequestMetadata } from './subtitles/types.js';

export const manifest = {
  id: 'org.indosync.phase1',
  version: '0.1.0',
  name: 'IndoSync Local',
  description: 'Local development build of IndoSync.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

function requestMetadata(extra: Record<string, string> | undefined): SubtitleRequestMetadata {
  const metadata: SubtitleRequestMetadata = {};
  if (typeof extra?.filename === 'string') metadata.filename = extra.filename;
  if (typeof extra?.videoSize === 'string') metadata.videoSize = extra.videoSize;
  if (typeof extra?.videoUrl === 'string') metadata.videoUrl = extra.videoUrl;
  return metadata;
}

export function createAddon(origin: string, subtitleService: SubtitleService) {
  const builder = new addonBuilder(manifest);

  builder.defineSubtitlesHandler(({ type, id, extra }: SubtitlesHandlerArgs) => {
    return subtitleService.search(type, id, origin, requestMetadata(extra));
  });

  return builder.getInterface();
}

