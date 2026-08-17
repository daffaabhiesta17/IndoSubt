# IndoSync — Phase 2B

Stremio subtitle add-on with a provider abstraction for acquiring Indonesian subtitles. The known-good Phase 1 static WebVTT fixture remains available as a development fallback when OpenSubtitles is not configured.

## Architecture

```text
Stremio route -> SubtitleService -> SubtitleProvider -> OpenSubtitles.com REST API
```

The Stremio route never calls OpenSubtitles directly. OpenSubtitles search results are mapped to signed IndoSync URLs; IndoSync performs the documented `POST /download` flow server-side and serves validated WebVTT without exposing the consumer key.

Phase 2B ranks Indonesian subtitle candidates using release metadata when available. It compares the bounded Stremio video filename with OpenSubtitles candidate filenames using deterministic local scoring, then returns at most five candidates. This improves the likelihood of a release match, but does not guarantee timing synchronization and never changes subtitle timing or content. Without filename metadata, provider order is preserved.

## Environment

Create an OpenSubtitles.com API consumer and set the key only in your shell or deployment environment:

```text
OPENSUBTITLES_API_KEY=
OPENSUBTITLES_USER_AGENT=IndoSync/0.1.0
```

Never commit a real key. `.env` and `.env.*` are ignored by Git. `.env.example` contains placeholders only. The project does not automatically load `.env`; set variables in the shell, for example in PowerShell:

```powershell
$env:OPENSUBTITLES_API_KEY = '<your key>'
$env:OPENSUBTITLES_USER_AGENT = 'IndoSync/0.1.0'
npm.cmd run dev
```

When no API key is configured, the clearly identified Phase 1 fixture is returned to preserve local protocol compatibility. When a provider is configured but returns no result or fails, IndoSync returns an empty subtitle array rather than presenting the fixture as a real result.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

Local manifest URL:

```text
http://localhost:3000/manifest.json
```

Movie lookup:

```text
http://localhost:3000/subtitles/movie/tt0133093.json
```

Series lookup (`IMDb ID:season:episode`):

```text
http://localhost:3000/subtitles/series/tt0944947:1:1.json
```

## Vercel deployment

Keep the existing Vercel architecture and add `OPENSUBTITLES_API_KEY` through Project Settings -> Environment Variables. Do not put it in `vercel.json`.

```bash
npx vercel
npx vercel --prod
```

Vercel serves `api/[...path].ts` as the HTTP function and `public/` as static assets. No database, persistent filesystem, queue, worker, synchronization engine, or external cache is used.

OpenSubtitles quotas, rate limits, API terms, and subtitle licensing still apply. The server-side endpoint must not be used for bulk downloading or quota avoidance.

