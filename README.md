# Media Downloader

A small Next.js application that inspects a media URL, shows the formats this server can **actually** produce for it, and streams the selected file back. You must have the rights and permission to download and convert any material you use it with.

The important design rule: **the server never trusts client metadata and never advertises a format it has not verified.** Format IDs are bound to the SHA-256 digest of the file that was really inspected, and the download endpoint re-downloads, re-probes and re-validates before serving a byte.

---

## What works today

| Capability | Status |
| --- | --- |
| Direct MP4 download (passthrough, no re-encode; video or audio-only container) | ✅ implemented & tested |
| Direct WebM download (passthrough; video or audio-only container) | ✅ implemented & tested |
| Direct M4A/AAC download (`audio/mp4`) | ✅ implemented & tested |
| Direct MP3 download (passthrough) | ✅ implemented & tested |
| Real MP3 conversion from audio/video sources at selectable bitrate (128/192/320 kbps + configured default) | ✅ implemented & tested with real media |
| MPEG-TS → MP4 re-package | ⚠️ implemented, depends on the ffprobe build (the bundled probe segfaults on MPEG-TS in the test container) |
| YouTube **metadata** (title, channel, thumbnail, duration) | ✅ implemented; **not verifiable from this sandbox** because it has no egress to `youtube.com` (see below) |
| YouTube **media download** | ❌ not implemented, and not permitted by YouTube's APIs/ToS |
| SaveFrom / other platforms | ❌ not implemented (no documented, permitted server-side API) |

---

## User interface

`src/components/downloader-form.tsx` keeps two **separate** message channels so a
source limitation can never be shown twice:

| Channel | Shows | Never shows |
| --- | --- | --- |
| Media information card (`section[aria-labelledby="media-heading"]`) | title, channel, source, duration, verified format pickers, source limitations and notes | transient request/validation errors |
| Status line (`#download-status`) | loading ("Inspecting media…", "Preparing download…"), validation, request failures, download result | source limitations or notes |

Rules enforced by the component (and covered by the jsdom tests):

* `limitations` and the legacy `limitation` are merged into one list, whitespace
  normalised and de-duplicated; any note that repeats one of those messages is
  dropped. Each message is rendered exactly once, inside the card.
* `/api/media-info` likewise publishes the YouTube explanation only in
  `limitations`; `notes` carries supplementary information only, so the payload
  itself contains no repeated copy.
* The **Download** button exists only when the API returned at least one format
  **and** `downloadAvailable !== false` **and** the selected format has a valid
  id whose container is one of MP4/WebM/M4A/MP3. Metadata without a verified
  format therefore renders one explanation and no button.
* When there are neither formats nor limitations, one fallback sentence is
  shown instead of an empty section.
* Errors are announced with `role="alert"` / `aria-live="assertive"`; the
  status line is only used for transient operation state.

---

## Architecture

```
Browser (React client component)
   │  POST /api/media-info   { url }                       → metadata + formats
   │  POST /api/download     { url, formatId, outputFormat } → real file stream
   ▼
src/app/api/*/route.ts        request parsing (8 KiB cap), HTTP status mapping
   ▼
src/lib/media-info.ts         inspect → probe → build verified formats → produce output
   ├── src/lib/source-handlers.ts   per-source capability model + fetch
   │     ├── direct handler    guarded HTTP download → temp file
   │     └── platform handler  official YouTube metadata only (no download)
   ├── src/lib/platform.ts     YouTube oEmbed / Data API v3 metadata client
   ├── src/lib/media-processing.ts  ffprobe probe, size checks, output production
   ├── src/lib/ffmpeg.ts       FFmpeg discovery, MP3/MP4 conversion
   ├── src/lib/formats.ts      format model + content-bound format IDs
   ├── src/lib/download-validation.ts + ip.ts   URL/protocol/SSRF validation
   ├── src/lib/http-media.ts   redirect-safe, size-capped streaming + JSON fetch
   └── src/lib/concurrency.ts  per-process job semaphore
```

`src/lib/download-service.ts` exposes the same pipeline as a library function (`downloadMedia`) and is exercised directly by the test suite.

### Source capabilities are explicit

A handler declares two independent capabilities instead of one `implemented` flag:

```ts
type SourceHandler = {
  kind: SourceKind;                                  // "direct" | "platform"
  label: string;
  capabilities: () => Record<"metadata" | "download", { supported: boolean; reason: string | null }>;
  inspect: (context) => Promise<SourceInspection>;   // metadata (+ downloaded bytes when needed)
  download: (context) => Promise<HandlerResult>;     // media bytes, or a specific error
};
```

`GET /api/health` publishes that matrix, so a deployment can prove what it supports:

```json
"sources": [
  { "kind": "direct",   "label": "Direct media file", "implemented": true,
    "capabilities": { "metadata": { "supported": true, "reason": null },
                      "download": { "supported": true, "reason": null } } },
  { "kind": "platform", "label": "YouTube video",     "implemented": false,
    "capabilities": { "metadata": { "supported": true, "reason": null },
                      "download": { "supported": false, "reason": "YouTube media files cannot be downloaded…" } } }
]
```

---

## Supported sources

### Direct media files

A URL that serves the media itself. Supported containers: **MP4, WebM, M4A/AAC, MP3** (plus MPEG-TS as an input, see above).

* The response bytes are sniffed (magic numbers), not trusted from `Content-Type` or the file extension. An HTML error page named `video.mp4` is rejected with `415 NOT_MEDIA`.
* A container is offered as "original" only when the downloaded bytes really are that container. WebM is never relabelled as MP4, and an MP4 is never relabelled as MP3.
* For a single-stream MP4 the real stream properties are reported (`h264`, `aac`, `720p`, bitrates). Multiple resolutions are **not** invented: one file has one video stream.

Host policy (`MEDIA_DOWNLOADER_SOURCE_POLICY`):

* `allowlist` (default) — only the curated hosts in `src/lib/sources.ts` plus `MEDIA_DOWNLOADER_EXTRA_HOSTS`.
* `public` — any other public host is accepted, but every address is still resolved and checked for loopback/private/link-local/metadata ranges, redirects are re-validated hop by hop, and the bytes are still verified as media.

### YouTube — metadata only

YouTube URLs (watch, `youtu.be`, Shorts, embed, live, music) are recognised and normalised to an 11-character video id, then resolved through **official, documented** mechanisms:

1. **YouTube Data API v3** (`videos.list?part=snippet,contentDetails`) when `YOUTUBE_API_KEY` is set — title, channel, thumbnail, duration.
2. **YouTube oEmbed** (`https://www.youtube.com/oembed`) otherwise — title, channel, thumbnail. No key, no duration (which is why `duration` is `null` rather than guessed).

If the Data API fails for a transient/quota reason the key-free oEmbed endpoint is used automatically.

**Downloading is a different capability and is not implemented.** The Data API returns metadata and embed players, not media files; YouTube's Terms of Service prohibit downloading except through features they provide. There is no `yt-dlp`, no signature/cipher extraction, no page scraping, no DRM bypass, and no third-party "save from" endpoint in this repository. `POST /api/download` for a YouTube URL answers `422 UNSUPPORTED_SOURCE` with an explanation, and `/api/media-info` returns the real metadata with `"metadataAvailable": true`, `"downloadAvailable": false`, `"formats": []`, and a single `limitations` entry (the legacy `downloadSupported` and `limitation` fields remain for compatibility). The explanation is published **once** — `notes` is empty for this source — and the UI renders it once, inside the media card.

#### Integration evaluation (why there is no YouTube download)

| Mechanism | Metadata | Media bytes | Verdict |
| --- | --- | --- | --- |
| YouTube Data API v3 (`videos.list`) | ✅ documented | ❌ returns snippets/`contentDetails`, never stream URLs | metadata only |
| YouTube oEmbed | ✅ documented, key-free | ❌ title/author/thumbnail only | metadata only |
| IFrame Player API | ⚠️ playback inside an embedded player | ❌ no byte access, no file to hand to a user | not a download API |
| "YouTube download API" / licensed partner endpoints | — | — | **none published**; no documented terms, auth or quota to integrate against |
| `yt-dlp` / signature ("cipher") extraction / page scraping | — | ✅ technically possible | **not permitted** by YouTube's ToS — deliberately absent |
| Third-party "save from" services | — | — | no documented, permitted server-side API; scraping violates their terms |

Because none of the permitted, documented integrations expose media bytes, the
application reports `downloadAvailable: false` with one clear explanation rather
than inventing stream URLs or formats. The handler registry
(`src/lib/source-handlers.ts`) is the extension point: a future provider needs
verified terms, server-side credentials and a security review before it can
advertise `download.supported = true`.

Deployment consequences (also in `.env.example`):

* Outbound HTTPS to `www.youtube.com` (oEmbed) or `www.googleapis.com` (Data API) is required. Without egress the endpoint answers `502` "The metadata service could not be reached."
* The Data API key is a server-side secret. It is only ever sent to `www.googleapis.com/youtube/v3/videos`, is never returned to the browser and never logged.
* Default quota is 10,000 units/day; `videos.list` costs 1 unit, so ~10,000 metadata lookups/day. Google may require billing for higher quotas.
* Set `MEDIA_DOWNLOADER_YOUTUBE_METADATA=off` to disable the feature entirely.

### SaveFrom and other platforms

SaveFrom's website links to an "API" page, but no documented, permitted, server-side media-download API with usable terms, authentication and quotas could be verified. A public website is not a backend API, and scraping it would violate its terms. **No SaveFrom adapter, scraper or private endpoint was added.** The handler registry is the extension point: a future provider needs verified terms, server-side credentials and a security review first.

---

## API

### `POST /api/media-info`

```json
{ "url": "https://samplelib.com/lib/preview/mp4/sample-5s.mp4" }
```

Response (all values come from real inspection; unavailable values are `null`):

```json
{
  "success": true,
  "media": {
    "title": null,
    "duration": 1.5,
    "thumbnail": null,
    "sourceType": "direct-media",
    "sourceLabel": "Direct media file",
    "author": null,
    "metadataProvider": null,
    "metadataAvailable": true,
    "downloadAvailable": true,
    "downloadSupported": true,
    "supportedConversions": ["mp3"],
    "limitations": [],
    "limitation": null,
    "notes": [],
    "formats": [
      {
        "id": "v1.<sha256>… .mp4.orig",
        "container": "mp4",
        "label": "MP4 — 96p",
        "resolution": "96p",
        "videoCodec": "h264",
        "audioCodec": "aac",
        "filesize": 19853,
        "bitrate": "73k",
        "sourceAudioBitrate": "73k",
        "hasVideo": true,
        "hasAudio": true,
        "conversion": false
      },
      { "container": "mp3", "bitrate": "192k", "conversion": true, "filesize": 30000, "sourceAudioBitrate": "73k", "…": "…" }
    ]
  }
}
```

Rules enforced while building `formats`:

* an `original` entry exists only for the container that was actually downloaded — including audio-only MP4/WebM containers, which are served byte-for-byte;
* MP3 conversions are listed only when FFmpeg is present **and** the source has an audio stream **and** a real verification encode succeeded;
* the verified MP3 variant carries its real `filesize`; the other bitrates are `filesize: null` because they are encoded at download time (and re-probed then);
* `bitrate` always describes the *delivered* stream; `sourceAudioBitrate` keeps the source's original audio bitrate so a lossy conversion is never presented as an upgrade;
* no upscaling, no invented resolutions, no invented thumbnails.

### `POST /api/download`

```json
{ "url": "https://samplelib.com/lib/preview/mp4/sample-5s.mp4", "formatId": "v1.…​.mp4.orig", "outputFormat": "mp4" }
```

* `formatId` and `outputFormat` are validated syntactically, then the URL is re-inspected: the format list is rebuilt from freshly downloaded bytes and the id must be present **and** have the same container. A stale digest, a cross-file id or a made-up id returns `400 INVALID_FORMAT`.
* Success streams the file with `Content-Type`, `Content-Length`, `Content-Disposition: attachment`, `Cache-Control: no-store, no-transform`, `X-Content-Type-Options: nosniff`.
* The temp directory is removed on completion, on error, on timeout and on client disconnect.

Error codes / statuses: `400` invalid body/url/format, `404` upstream missing, `413` too large, `415` not media, `422` unsupported source/format/unavailable media, `502` upstream or conversion failure, `503` missing FFmpeg/ffprobe or server busy, `504` upstream timeout.

### `GET /api/health`

Capabilities (ffprobe/FFmpeg detection), the source capability matrix, policy, limits and job counters. It exposes no paths, environment values or credentials.

---

## MP3 conversion

* FFmpeg is located in order: `FFMPEG_PATH` → `ffmpeg` on `PATH` → the optional `@ffmpeg-installer/ffmpeg` package. **ffprobe** is located via `FFPROBE_PATH` → the bundled `@ffprobe-installer/ffprobe` → `ffprobe` on `PATH`. Both are probed once per process, so the app never claims conversion works when no usable binary exists.
* The server always spawns with an argument array (`shell: false`), a timeout, `-protocol_whitelist file,pipe`, an explicit input demuxer and a bounded output size (`-fs`).
* Conversions are validated: the output is re-sniffed, re-probed, must contain an MP3 audio stream, and the measured bitrate must be within ±20 % of the requested one. Failure is a `CONVERSION_FAILED`/`502`, never a renamed file.
* Concurrency is bounded per process (`MEDIA_DOWNLOADER_MAX_CONCURRENCY`, default 2); extra jobs queue and then receive `503`.
* If FFmpeg is missing, `/api/media-info` simply reports no MP3 options and states the exact missing dependency; `/api/download` answers `503 CONVERSION_UNAVAILABLE`.

---

## Security model

* **SSRF:** the connection's DNS lookup resolves *all* answers, rejects any loopback/private/CGNAT/link-local/cloud-metadata/reserved address (IPv4 **and** IPv6, including IPv4-mapped and NAT64 forms), and connects to a validated address while preserving TLS SNI/hostname — closing the DNS-rebinding window. Redirects are `manual`, re-validated hop by hop (allowlist + address checks), capped at `MEDIA_DOWNLOADER_MAX_REDIRECTS`.
* **No arbitrary URL fetching:** an explicit host policy plus the request checks above; only standard ports; no credentials in URLs; `http`/`https` only.
* **Bounded resources:** 8 KiB request bodies, `Content-Length` screening, a hard byte cap enforced while streaming, deadlines for connect/download/conversion, capped ffprobe/ffmpeg output, no in-memory buffering of media.
* **Media verification:** magic-number sniffing on the first bytes plus ffprobe on the complete file. HTML, unknown binaries and MIME-spoofed pages are rejected.
* **No leakage:** errors are curated strings; stack traces, filesystem paths, environment values and upstream bodies are never sent. The API key is never echoed.
* **Filenames** are sanitised and RFC 6266-encoded; converted outputs are re-verified before being served.

These controls are defence in depth, not a substitute for sandboxing FFmpeg, running unprivileged, or restricting egress at the network layer.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_DOWNLOADER_SOURCE_POLICY` | `allowlist` | `allowlist` or `public` direct-media host policy |
| `MEDIA_DOWNLOADER_EXTRA_HOSTS` | empty | Comma-separated extra allowlisted hosts |
| `MEDIA_DOWNLOADER_MAX_FILE_MB` | `50` | Input/output size cap (1–512) |
| `MEDIA_DOWNLOADER_REQUEST_TIMEOUT_MS` | `30000` | Upstream header deadline (metadata calls use ≤10 s) |
| `MEDIA_DOWNLOADER_DOWNLOAD_TIMEOUT_MS` | `120000` | Body streaming / response deadline |
| `MEDIA_DOWNLOADER_CONVERSION_TIMEOUT_MS` | `120000` | ffprobe / FFmpeg deadline |
| `MEDIA_DOWNLOADER_MAX_CONCURRENCY` | `2` | Concurrent jobs per instance |
| `MEDIA_DOWNLOADER_MAX_QUEUE` | `20` | Queue depth before `503` |
| `MEDIA_DOWNLOADER_MAX_REDIRECTS` | `5` | Redirect cap |
| `MEDIA_DOWNLOADER_MP3_BITRATE` | `192k` | Default MP3 bitrate (added to 128/192/320) |
| `MEDIA_DOWNLOADER_YOUTUBE_METADATA` | `on` | `off` disables YouTube metadata |
| `YOUTUBE_API_KEY` | unset | Optional Data API v3 key (server-side only) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | auto | Explicit binary paths |
| `DATABASE_URL` | unset | Unused database scaffold |

---

## Development

```bash
npm ci
npm run dev          # http://localhost:3000
```

System **FFmpeg/ffprobe** (with `libmp3lame`) are the recommended installation; `npm ci` also installs bundled binaries for common platforms. Production needs a Node.js runtime (`runtime = "nodejs"`), not Edge.

### Checks

```bash
npm test        # 131 tests: unit, HTTP/API integration, jsdom UI
npm run typecheck
npm run lint
npm run build
```

Test media is generated at runtime with the installed FFmpeg (no binary blobs in the repository) and every upstream HTTP call is mocked; tests that need FFmpeg/ffprobe skip gracefully when the binaries are absent.

### Deployment

The included `Dockerfile` installs Debian FFmpeg, builds with Turbopack and runs as a non-root user:

```bash
docker build -t media-downloader .
docker run --rm -p 3000:3000 -e MEDIA_DOWNLOADER_MAX_FILE_MB=50 media-downloader
```

Allow egress only to the hosts you intend to support. Temporary storage must hold one input + one output per concurrent job. Set the platform request timeout above the configured download/conversion deadlines. Process crashes can leave files in the OS temp directory, so mount ephemeral storage and clean it periodically. Concurrency is per process, not global — apply rate limiting at your reverse proxy.

---

## Known limitations

* **Inspection downloads the whole input** (bounded by the size cap) and, when MP3 is offered, performs one verification encode. The subsequent download repeats that work. This two-request workflow favours correctness over bandwidth; there is no server-side session or inspection cache.
* The browser buffers the response into a Blob before saving (`anchor.download`), which is fine for tens of MB but not for very large files.
* Only single-file HTTP(S) media is supported: **no HLS/DASH manifests, adaptive streams, playlists or stream merging.**
* Container choice is deliberately conservative: no WebM→MP4 or MP4→WebM transcoding in the UI, no alternate resolutions, no upscaling.
* MPEG-TS inspection depends on the ffprobe build (the bundled probe segfaults on MPEG-TS in the test container; a distro ffprobe works).
* YouTube metadata could only be tested against mocked HTTP: this sandbox has no outbound access to `youtube.com`/`googleapis.com`. Verify against the target network before relying on it.
* `thumbnail` is only populated by the YouTube provider; direct files report `null` because no thumbnail is extracted.
