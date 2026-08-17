declare module 'stremio-addon-sdk' {
  export interface Manifest {
    id: string;
    version: string;
    name: string;
    description: string;
    resources: string[];
    types: string[];
    idPrefixes?: string[];
    catalogs: unknown[];
  }

  export interface SubtitlesHandlerArgs {
    type: string;
    id: string;
    extra?: Record<string, string>;
  }

  export interface Subtitle {
    id: string;
    url: string;
    lang: string;
  }

  export interface AddonInterface {
    manifest: Manifest;
    get(
      resource: 'subtitles',
      type: string,
      id: string,
      extra: Record<string, string>
    ): Promise<{ subtitles: Subtitle[] }>;
  }

  export class addonBuilder {
    constructor(manifest: Manifest);
    defineSubtitlesHandler(
      handler: (args: SubtitlesHandlerArgs) => Promise<{ subtitles: Subtitle[] }>
    ): void;
    getInterface(): AddonInterface;
  }
}
