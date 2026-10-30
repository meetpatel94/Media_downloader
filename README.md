# Media Downloader

A minimal, production-minded media downloader built with Next.js 16 (App Router), React 19, TypeScript and Tailwind CSS v4.

Paste a **direct, publicly accessible media file URL**, choose **MP4** or **MP3**, press **Download**. The server validates the URL, blocks internal/unsafe destinations, streams the file to a temporary location with hard size limits, extracts MP3 audio with FFmpeg when needed, and returns the finished file as an attachment.

The UI is intentionally limited to: the title, a URL text area, a format selector, one Download button, and one status message.

---

## Table of contents

- [What actually works](#what-actually-works)
- [Supported and unsupported sources](#supported-and-unsupported-sources)
- [Why YouTube links are rejected](#why-youtube-links-are-rejected)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment configuration](#environment-configuration)
- [FFmpeg setup](#ffmpeg-setup)
- [Development commands](#development-commands)
- [API contract](#api-contract)
- [Security controls](#security-controls)
- [Testing](#testing)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Known limitations / not implemented](#known-limitations--not-implemented)

---

## What actually works

Implemented and covered by automated tests:

| Capability | Status |
| --- | --- |
| Responsive single-card UI (320 px → desktop) | ✅ implemented |
| URL validation (syntax, protocol, length, credentials, ports) | ✅ implemented |
| Source allowlist with explicit source kinds (direct file vs. platform page) | ✅ implemented |
| YouTube Shorts / `watch?v=` / `youtu.be` / `embed` / `live` URL recognition and normalisation | ✅ implemented (recognition only) |
| Downloading YouTube media | ❌ not implemented (no permitted extractor — see below) |
| SSRF protection: localhost, loopback, private, link-local, CGNAT, multicast, IPv4-mapped IPv6, cloud metadata | ✅ implemented |
| DNS resolution checks on every hop, redirect re-validation, redirect cap | ✅ implemented |
| Streamed download with configurable byte cap (never fully buffered) | ✅ implemented |
| Content sniffing so an HTML error page is never returned as `.mp4` | ✅ implemented |
| Real MP4 delivery (verified `ftyp` container) | ✅ implemented |
| WebM/MKV → MP4 packaging via FFmpeg (stream copy, then transcode fallback) | ✅ implemented |
| Real MP3 extraction from video via FFmpeg (`libmp3lame`) | ✅ implemented when FFmpeg is available |
| FFmpeg availability probe (never claims MP3 works if it does not) | ✅ implemented |
| Concurrency limit + bounded queue (503 when saturated) | ✅ implemented |
| Timeouts for connect/headers, body streaming and conversion | ✅ implemented |
| Temp-file cleanup on success, error, timeout and client disconnect | ✅ implemented |
| Request cancellation when the client disconnects | ✅ implemented |
| Health endpoint reporting real capabilities | ✅ implemented |

## Supported and unsupported sources

The downloader only contacts hosts in an explicit allowlist (`src/lib/sources.ts`). It is **not** a general-purpose URL fetcher and does not claim universal site support.

Allowed direct-media hosts (plus `www.` and explicit subdomains):

- `samplelib.com`
- `file-examples.com`
- `sample-videos.com`
- `filesamples.com`
- `test-videos.co.uk`
- `archive.org` (and `*.archive.org` CDN nodes)
- `media.w3.org`
- `www.w3schools.com`
- `commondatastorage.googleapis.com`, `storage.googleapis.com`
- `upload.wikimedia.org`

You can add your own permitted hosts with `MEDIA_DOWNLOADER_EXTRA_HOSTS` (comma separated) — add only hosts you are legally and technically allowed to download from.

Recognised but **not downloadable**:

- YouTube (`youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`) — including Shorts, `watch?v=`, `embed`, `live`.

Explicitly unsupported:

- Playlists, channel pages and any URL that is not a single video.
- DRM-protected, paid, private, age-restricted or login-only media.
- Streaming manifests (HLS/DASH) and live streams.
- Web pages on unknown hosts, internal network targets, `file://`, FTP, etc.
- Anything requiring bypassing access controls.

## Why YouTube links are rejected

The original implementation fetched URLs with a plain HTTP request and expected the response body to already be an MP4/MP3. A YouTube page is HTML; the media URL is not in the page, is split across adaptive streams, and is protected by the platform's terms and access controls. Adding `youtube.com` to an allowlist cannot work and would only produce HTML pages named `.mp4`.

Any legitimate YouTube download requires an extractor that is permitted by YouTube's Terms of Service (for example an authorised, keyed API integration). Such an integration is **not** configured here, so the `platform` source handler refuses the request with an explicit, actionable error. No scraping, signature manipulation, cookie reuse or proxy tricks are implemented.

To add a lawful extractor later: implement it as a new handler in `src/lib/source-handlers.ts`, keep the platform URL normalisation from `src/lib/sources.ts`, and make sure it respects the platform's terms and all legal constraints in your jurisdiction.

## Architecture

```
POST /api/download
  └─ route.ts                 request validation, streaming response, cleanup
      └─ download-service.ts  pipeline orchestration, temp dir ownership
          ├─ download-validation.ts  validateMediaUrl + assertSafeRemoteHost + redirect policy
          │     ├─ ip.ts                private/reserved/loopback IP classification
          │     └─ sources.ts           allowlist, direct vs platform classification, YouTube IDs
          ├─ source-handlers.ts  registry: direct-media handler (real), platform handler (refuses)
          │     └─ http-media.ts       guarded fetch, per-hop DNS check, streamed body with byte cap
          ├─ media-inspect.ts    magic-byte container sniffing (mp4/webm/mp3/ogg/wav/flac/html/…)
          ├─ ffmpeg.ts           binary discovery, probe, MP3 extraction, MP4 packaging
          └─ concurrency.ts      process-wide semaphore + queue
```

Every download goes through the same bounded pipeline: streamed to a temp file → sniffed → converted if required → size-checked → streamed to the client → temp directory deleted.

## Requirements

- Node.js **20.9+** (Node 22 recommended)
- npm 10+
- FFmpeg **only if you need MP3** (or MP4 packaging from non-MP4 video). MP4 downloads of MP4 sources work without FFmpeg.

## Installation

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>.

The optional `@ffmpeg-installer/ffmpeg` package is listed under `optionalDependencies`. It downloads a platform binary at install time (~66–80 MB) and is used only as a fallback when no system FFmpeg exists. Install with `npm ci --omit=optional` to skip it.

## Environment configuration

Everything is optional; defaults are safe. Set values in `.env.local` (never commit `.env*` files; `.env.example` is provided).

| Variable | Default | Meaning |
| --- | --- | --- |
| `FFMPEG_PATH` | unset | Absolute path to an FFmpeg binary. Takes priority. |
| `MEDIA_DOWNLOADER_MAX_FILE_MB` | `50` | Hard cap per download (1–512 MB). |
| `MEDIA_DOWNLOADER_REQUEST_TIMEOUT_MS` | `30000` | Connect + response-header deadline. |
| `MEDIA_DOWNLOADER_DOWNLOAD_TIMEOUT_MS` | `120000` | Body streaming deadline. |
| `MEDIA_DOWNLOADER_CONVERSION_TIMEOUT_MS` | `120000` | FFmpeg conversion deadline. |
| `MEDIA_DOWNLOADER_MAX_CONCURRENCY` | `2` | Simultaneous download+conversion jobs. |
| `MEDIA_DOWNLOADER_MAX_QUEUE` | `20` | Waiting jobs before `503 SERVER_BUSY`. |
| `MEDIA_DOWNLOADER_MAX_REDIRECTS` | `5` | Redirect hops followed per download. |
| `MEDIA_DOWNLOADER_MP3_BITRATE` | `192k` | MP3 target bitrate. |
| `MEDIA_DOWNLOADER_EXTRA_HOSTS` | unset | Extra allowed direct-media hosts, comma separated. |
| `DATABASE_URL` | unset | Not used by the downloader (leftover Drizzle scaffold in `src/db/`). |

## FFmpeg setup

FFmpeg is discovered in this order (the result is probed once per process, and reported by `/api/health`):

1. `FFMPEG_PATH`
2. `ffmpeg` on `PATH`
3. the optional `@ffmpeg-installer/ffmpeg` package

Install examples:

```bash
# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg

# macOS
brew install ffmpeg

# Windows (winget)
winget install Gyan.FFmpeg
```

If no working binary is found:

- MP4 requests that only need to be *served* still work.
- MP3 requests fail with HTTP `503` and `CONVERSION_UNAVAILABLE` — never with a renamed MP4.
- `/api/health` reports `capabilities.mp3: false` and the reason.

## Development commands

```bash
npm run dev        # development server
npm run build      # production build
npm start          # run the production build
npm test           # node:test suites (validation, pipeline, API, UI)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

## API contract

### `GET /api/health`

Reports readiness without leaking paths, secrets or stack traces:

```json
{
  "status": "ok",
  "ready": true,
  "capabilities": {
    "mp4": true,
    "mp3": true,
    "ffmpeg": { "available": true, "source": "bundled", "version": "…", "detail": null }
  },
  "limits": { "maxFileSizeMb": 50, "maxConcurrentDownloads": 2 },
  "sources": [
    { "kind": "direct", "label": "Direct media file", "implemented": true },
    { "kind": "platform", "label": "Video platform page", "implemented": false }
  ],
  "jobs": { "active": 0, "waiting": 0 }
}
```

### `POST /api/download`

```json
{ "url": "https://samplelib.com/lib/preview/mp4/sample-5s.mp4", "format": "mp4" }
```

`format` must be `mp4` or `mp3`. Success returns the media file (streamed) with:

- `Content-Type: video/mp4` or `audio/mpeg`
- `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`
- `Cache-Control: no-store, no-transform`
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`

Failures return JSON `{ "error": "<safe message>", "code": "<CODE>" }`:

| Code | HTTP | When |
| --- | --- | --- |
| `INVALID_BODY` | 400 | Malformed JSON, non-object body, body > 8 KB |
| `EMPTY_URL` | 400 | Missing/blank URL |
| `INVALID_URL` | 400 | Unparsable URL, non-HTTP(S) scheme |
| `URL_TOO_LONG` | 400 | URL longer than 2048 characters |
| `UNSAFE_URL` | 400 | localhost/loopback/private/link-local/metadata address, credentials in URL, non-standard port |
| `INVALID_FORMAT` | 400 | Format not `mp4`/`mp3` |
| `UNSUPPORTED_SOURCE` | 422 | Host not allowlisted, or platform URL without a permitted extractor |
| `NOT_MEDIA` | 422/415 | Page instead of media, unverifiable content |
| `SOURCE_NOT_PERMITTED` | 422 | Unsafe/too many redirects |
| `UPSTREAM_NOT_FOUND` | 404 | Upstream 404/410 |
| `FORMAT_UNAVAILABLE` | 422 | Audio-only source requested as MP4, upstream 401/403, unconvertible format |
| `TOO_LARGE` | 413 | Declared or streamed size exceeds the cap |
| `INVALID_CONTENT_TYPE` | 415 | Audio returned for MP4 request (or vice versa) |
| `CONVERSION_UNAVAILABLE` | 503 | MP3 needed but no FFmpeg |
| `CONVERSION_FAILED` | 502 | FFmpeg failed or produced no audio |
| `UPSTREAM_ERROR` | 502 | Connection/DNS/other upstream failure |
| `UPSTREAM_TIMEOUT` | 504 | Header or body deadline exceeded |
| `SERVER_BUSY` | 503 | Concurrency + queue limit reached |
| `CANCELLED` | 499 | Client disconnected |
| `INTERNAL` | 500 | Unexpected error (details only in server logs) |

## Security controls

- HTTP/HTTPS only; credentials and non-standard ports rejected.
- Explicit host allowlist for outbound requests — no arbitrary fetches.
- DNS is resolved for every hop and every answer must be public; literal private IPs are rejected without DNS.
- IPv4: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (cloud metadata), `172.16/12`, `192.168/16`, documentation/benchmarking ranges, multicast, reserved.
- IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001:db8::/32`, `2001::/32`, Teredo/6to4/NAT64-embedded IPv4, IPv4-mapped addresses (re-checked as IPv4).
- Redirects are followed manually, capped, and each destination is re-validated (allowlist + DNS) before it is contacted.
- Downloads are streamed with a hard byte cap; `Content-Length` lies cannot exceed memory because nothing is buffered whole.
- Magic-byte sniffing rejects HTML pages and unverifiable content.
- FFmpeg is invoked with an argument array (`shell: false`) — no shell interpolation of user input — with a hard timeout and SIGKILL.
- Error responses contain only safe, pre-written messages; diagnostics (including FFmpeg stderr) go to server logs.
- Temporary directories are `mkdtemp`-scoped and deleted on success, error, timeout and disconnect.

## Testing

```bash
npm test
```

95 tests across five suites, all using mocked network I/O (no live third-party service required):

- `src/lib/download-validation.test.ts` — empty/malformed/unsupported/oversized URLs, protocols, credentials, ports, allowed hosts, hostname look-alikes, localhost, private IPv4, IPv6 loopback/ULA/link-local/mapped, DNS failures, redirect policy, YouTube normalisation.
- `src/lib/ip.test.ts` — IP range classification (IPv4 + IPv6, malformed input).
- `src/lib/sources.test.ts` — allowlist, source classification, YouTube Shorts/watch/`youtu.be`/embed/live ID extraction, playlist rejection.
- `src/lib/http-media.test.ts` — 404/5xx, HTML content type, audio-vs-video mismatch, declared oversize, redirect allow/block/loop, DNS-to-private refusal, header timeout, caller cancellation, byte-cap abort, streaming to file.
- `src/lib/download-service.test.ts` — YouTube refusal, unsupported host, real MP4 artifact + cleanup, HTML masquerading as `.mp4`, unverifiable content, size limit, audio-only-to-MP4 rejection, direct MP3, **real MP4 → MP3 conversion using a generated FFmpeg fixture**, FFmpeg-missing 503, cancellation, temp-dir cleanliness.
- `src/app/api/download/route.test.ts` — invalid JSON, non-object body, oversized body, missing/non-string/empty URL, unsupported format, unsupported source, YouTube 422, SSRF targets, 404, 504, 415 (audio and HTML), 413, 503, streaming MP4 with headers, **real MP3 conversion response**, 405 for GET.
- `src/components/downloader-form.test.tsx` — filename parsing, accessible labels, empty/malformed input, loading state and duplicate-submit guard, API error surfaces, non-JSON failures, network failure, empty body, successful download + object-URL revocation, responsive class invariants.

Frontend tests use jsdom + React `act` (no testing-library dependency). The DOM environment module must be imported before `react-dom` — see the comment in `src/test-utils/dom.ts`.

Manual check list (viewport 320/375/768/1366/1920): no horizontal scroll, focus ring visible via keyboard, button disabled while working, status message announced by screen readers, file downloads with the server-provided filename.

Verification status in this repository snapshot: `npm test` (95/95), `npm run typecheck`, `npm run lint` and `npm run build` all pass. Live downloads from public sample hosts could **not** be verified from the development sandbox because outbound HTTPS to those hosts is blocked there (requests correctly return `502 UPSTREAM_ERROR`); the download, sniffing and conversion pipeline is instead verified end-to-end with mocked HTTP responses and a real FFmpeg binary.

## Deployment

- Requires a Node.js server runtime (route handlers use Node APIs: `fs`, `dns`, `child_process`). **Not** compatible with the Edge runtime.
- FFmpeg must be installed in the image/container for MP3; set `FFMPEG_PATH` if it is not on `PATH`. A `Dockerfile` in this repo installs it via `apt-get`.
- Temporary storage: `os.tmpdir()` needs enough free space for one pending file per concurrent job (`maxConcurrency × maxFileSize`, plus conversion output).
- Serverless platforms with short execution limits need `maxDuration` raised and a larger memory/disk allocation; conversion streaming is bound by `MEDIA_DOWNLOADER_*_TIMEOUT_MS`.
- Run behind HTTPS, keep Node and dependencies patched, and review the host allowlist before expanding it.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `This media source is not supported.` | Host not allowlisted. Add a permitted host via `MEDIA_DOWNLOADER_EXTRA_HOSTS`. |
| `YouTube links cannot be downloaded…` | Expected: no permitted extractor is configured. Use a direct media file URL. |
| `The media could not be reached.` | DNS/connection failure, TLS error, or egress blocked by the host firewall. |
| `MP3 conversion is not available…` | Install FFmpeg or set `FFMPEG_PATH`; check `/api/health`. |
| `The media file is too large to download.` | Raise `MEDIA_DOWNLOADER_MAX_FILE_MB` or use a smaller source file. |
| `That URL returns a web page, not a media file.` | The URL is an HTML page; use the direct file link. |
| `The requested … is not available.` | Source is audio-only for an MP4 request, or upstream returned 401/403. |
| Build warning “encountered unexpected file in NFT list” | Turbopack traces FFmpeg's runtime binary discovery; build still succeeds. Pin the binary with `FFMPEG_PATH` in production. |

## Known limitations / not implemented

- No YouTube (or other platform) extraction — by design, see above.
- No HLS/DASH, live stream, or playlist support.
- No downloading of authenticated/private/paywalled/DRM content.
- No persistent history, accounts, or storage; each request is independent.
- No virus scanning; only container sniffing and size/type validation.
- MP3 conversion quality is fixed via `MEDIA_DOWNLOADER_MP3_BITRATE` (no per-request selection).
- Serverless cold-start probing of FFmpeg is cached per process.
