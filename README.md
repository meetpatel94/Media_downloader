# Media Downloader

A minimal Next.js application for inspecting and downloading **permitted, public direct media files**. Paste a URL, select Fetch Info, then choose one of the outputs verified for that file. You must have the rights and permission to download and convert the material.

## Supported sources and limitations

Only direct files on the hosts in `src/lib/sources.ts` and explicitly configured `MEDIA_DOWNLOADER_EXTRA_HOSTS` are contacted. This is not a general URL fetcher. YouTube pages are recognized but cannot be inspected or downloaded: no authorized download integration is configured. Merely allowing the domain does not extract a video; no scraping, DRM, login, paywall or access-control bypass is implemented. No metadata API, third-party extractor, HLS/DASH, playlists, or adaptive-stream merging is currently implemented.

An MP4 containing video and an MP3 containing MP3 audio can be delivered as-is. For other recognized direct containers with audio, MP3 is offered only after FFmpeg actually produces a probe-verified MP3 during inspection. No WebM output, MP4 transcoding, selectable audio bitrates, alternate resolutions or stream merging are exposed in this workflow. The format selector contains the *actual* source resolution and the configured MP3 bitrate where probe data is available; no upscaling is performed. If neither output is possible, the API reports that no format is available. A file's title and duration are shown only when reported by ffprobe; thumbnails are not fetched. An MP4 file is not necessarily compatible with every browser or device codec.

Inspection downloads the full input and may convert it to establish genuine availability; the subsequent download repeats that work. Format IDs include a SHA-256 digest of the actual input. The download endpoint re-fetches and re-probes it, and rejects a stale or fabricated selection. No media metadata or files are persistently stored. Upstream changes, time-limited URLs, and bandwidth costs can make this two-request workflow unsuitable for some deployments. The browser currently buffers the final output in a Blob before starting its download.

## Provider investigation

No external media-processing provider is configured. SaveFrom's [website](https://en.savefrom.net/index.php) links to an API, but its [terms](https://en.savefrom.net/34/terms.html) do not establish a documented, permitted server-side media-download integration for this application. We could not verify a suitable official API and terms, so no SaveFrom integration or private endpoint is used. The source-handler registry in `src/lib/source-handlers.ts` isolates source retrieval; a future provider requires verified terms, server-side credentials, and security review before activation. Other social platforms are not supported.

## Runtime and configuration

Node.js 20.9+ and npm are required. `npm ci`, `npm run dev` to start locally. Production requires a Node runtime, not Edge. **ffprobe is required for every inspection and download**. FFmpeg with the `libmp3lame` encoder is required for conversion. System packages are recommended; the Dockerfile installs both. npm installs bundled ffprobe and optional bundled FFmpeg for supported platforms; these binaries may not work on every OS/architecture. The bundled probe is preferred when available, otherwise `ffprobe` on PATH is used. Set `FFPROBE_PATH` to override it. Set `FFMPEG_PATH` to override FFmpeg discovery (otherwise PATH, then optional installer). Check compatibility and licensing of your own FFmpeg build. Inspect `/api/health` for FFmpeg status; actual processing is checked for each file, not guaranteed by health alone.

Optional environment variables (also see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `FFPROBE_PATH` | bundled or `ffprobe` | Probe executable override |
| `FFMPEG_PATH` | PATH or optional bundled | Conversion executable override |
| `MEDIA_DOWNLOADER_MAX_FILE_MB` | 50 | Input and output cap (1–512 MB) |
| `MEDIA_DOWNLOADER_REQUEST_TIMEOUT_MS` | 30000 | Upstream response deadline |
| `MEDIA_DOWNLOADER_DOWNLOAD_TIMEOUT_MS` | 120000 | Input and response streaming deadline |
| `MEDIA_DOWNLOADER_CONVERSION_TIMEOUT_MS` | 120000 | Probe/conversion deadline |
| `MEDIA_DOWNLOADER_MAX_CONCURRENCY` | 2 | Concurrent jobs per instance, including response streaming |
| `MEDIA_DOWNLOADER_MAX_QUEUE` | 20 | Maximum waiting jobs per instance |
| `MEDIA_DOWNLOADER_MAX_REDIRECTS` | 5 | Redirect cap |
| `MEDIA_DOWNLOADER_MP3_BITRATE` | 192k | Server-side MP3 encoding bitrate, not a client selection |
| `MEDIA_DOWNLOADER_EXTRA_HOSTS` | empty | Comma-separated permitted direct-media hosts |
| `DATABASE_URL` | unset | Unused database scaffold; not needed by downloader |

Temporary disk needs capacity for both input and output per concurrent job. Use a dedicated container, non-root user, disk quotas, CPU/memory limits, patched FFmpeg/ffprobe and restricted outbound network rules. Concurrency is per process, not global; apply rate limiting at your reverse proxy across instances. Set platform request timeouts high enough for inspection, conversion and response streaming. Process crashes or forced termination can leave files in the OS temp directory: configure periodic cleanup and ephemeral storage. No production host's egress, codecs, disk capacity, or serverless execution limits are assumed to work just because local tests pass.

## API

`POST /api/media-info` accepts `{ "url": "https://samplelib.com/example.mp4" }` and returns `{ "success": true, "media": { "title", "duration", "thumbnail", "sourceType", "formats" } }`. Metadata may be null. A format includes `id`, `container`, `resolution`, `videoCodec`, `audioCodec`, `filesize`, `hasVideo`, `hasAudio`, `bitrate`, and `conversion`.

`POST /api/download` accepts `{ "url": "...", "formatId": "<id returned by inspection>", "outputFormat": "mp4" }`. It validates the selection against freshly inspected bytes and returns the actual file with attachment headers. Errors are JSON `{ "success": false, "error": "safe message", "code": "..." }`; malformed input is 400, unsupported sources/formats 422, too large 413, missing media tools 503, upstream errors 502 and timeout 504. `GET /api/health` reports process-local capabilities and limits. APIs have an 8 KiB streaming request-body limit.

## Security

HTTP(S) URLs must pass a source allowlist, public IP validation and redirect checks. The connection's DNS lookup validates all answers and connects to a validated address to prevent DNS rebinding; TLS keeps the original hostname. Only standard ports are allowed. Downloads stream to temporary files with size/time limits. Media tools run without shell interpolation, with timeouts, restricted protocols and a selected local-file demuxer; converted outputs are bounded and probed. No user-supplied shell commands or client metadata are trusted. These controls are defense in depth, not a substitute for sandboxing media parsers or outbound firewall policy. Hosts added to the allowlist must be trusted and legally permitted.

## Checks

```
npm test
npm run typecheck
npm run lint
npm run build
```

Tests use mocked upstream network responses and generate a small real media fixture with the installed FFmpeg binary. Existing validation and HTTP suites cover private IPs, redirects, timeouts, size limits and cleanup. The UI test checks accessibility and responsive class invariants in jsdom, not real-device layout. External public hosts cannot be reached from the development sandbox, so real public-source connectivity and deployment-specific codecs still require verification in the target environment.
