/**
 * Source handling.
 *
 * Two legally and technically distinct source kinds exist:
 *
 * 1. `direct`   – a URL that serves the media file itself (MP4/WebM/M4A/MP3/...).
 *                 These are fetched over plain HTTP(S) with SSRF protections.
 * 2. `platform` – a page URL on a video platform (YouTube). Such a URL is *not*
 *                 a media file. It can only be handled by an optional, lawful
 *                 extractor integration (see `src/lib/platform.ts`); without it
 *                 the API returns an actionable error instead of pretending the
 *                 page is a download.
 *
 * Hosts are never trusted because a user typed them: the allowlist below is the
 * complete set of hosts the downloader will ever contact.
 */

import { getConfig } from "@/lib/config";

export const DIRECT_MEDIA_HOSTS = [
  "samplelib.com",
  "www.samplelib.com",
  "download.samplelib.com",
  "file-examples.com",
  "www.file-examples.com",
  "sample-videos.com",
  "www.sample-videos.com",
  "filesamples.com",
  "www.filesamples.com",
  "test-videos.co.uk",
  "www.test-videos.co.uk",
  "media.w3.org",
  "www.w3schools.com",
  "commondatastorage.googleapis.com",
  "storage.googleapis.com",
  "archive.org",
  "ia801504.us.archive.org",
  "upload.wikimedia.org",
] as const;

export const PLATFORM_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"] as const;

/**
 * Public suffix-ish parents that are allowed to match subdomains of the
 * canonical CDNs above (hostname === entry OR hostname endsWith "." + entry).
 * Kept separate so that www/apex pairs stay explicit.
 */
const WILDCARD_HOSTS = [
  "samplelib.com",
  "file-examples.com",
  "sample-videos.com",
  "filesamples.com",
  "test-videos.co.uk",
  "archive.org",
] as const;

export type SourceKind = "direct" | "platform";

/**
 * Explicit source policy for direct media.
 *
 * - `allowlist` – only the curated hosts below (plus `MEDIA_DOWNLOADER_EXTRA_HOSTS`).
 * - `public`    – any other public http(s) host is accepted, but every address
 *                 is still resolved and checked for private/loopback/link-local
 *                 ranges, redirects are re-validated, and the response bytes are
 *                 verified as media before anything is served.
 */
export function directSourcePolicy(): "allowlist" | "public" {
  return getConfig().sourcePolicy;
}

export type ClassifiedSource = {
  kind: SourceKind;
  host: string;
  /** Present only for platform sources. */
  platform?: {
    name: "youtube";
    videoId: string;
    /** `short` for /shorts/<id>, `watch` for watch/youtu.be, `embed` for /embed/<id>. */
    variant: "short" | "watch" | "embed";
  };
  /** Lower-cased path + query extension hint, e.g. `.mp4`. */
  extension: string | null;
};

export type SourceClassification =
  | { ok: true; source: ClassifiedSource }
  | { ok: false; reason: "unsupported-source" | "not-a-media-url"; message: string };

/**
 * Two distinct platform limitations. Metadata and media download are separate
 * capabilities, so they get separate, accurate messages.
 */
const YOUTUBE_DOWNLOAD_NOT_SUPPORTED =
  "YouTube media files cannot be downloaded by this deployment: YouTube's official APIs provide metadata only and " +
  "do not permit retrieving the video or audio streams, and no licensed download integration is configured. " +
  "Use Fetch Info for the video's metadata, or paste a direct media file URL (.mp4, .webm, .m4a, .mp3).";

const YOUTUBE_METADATA_NOT_SUPPORTED =
  "YouTube metadata lookup is disabled on this deployment. Paste a direct media file URL (.mp4, .webm, .m4a, .mp3), " +
  "or enable MEDIA_DOWNLOADER_YOUTUBE_METADATA to allow official YouTube metadata lookups.";

export const MESSAGES = {
  unsupportedSource: "This media source is not supported. Only direct media file URLs from approved hosts are supported.",
  notAMediaUrl:
    "This URL points to a web page, not a media file. Paste a direct link ending in .mp4, .webm, .m4a, or .mp3.",
  platformDownloadNotSupported: YOUTUBE_DOWNLOAD_NOT_SUPPORTED,
  platformMetadataNotSupported: YOUTUBE_METADATA_NOT_SUPPORTED,
} as const;

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function collectAllowedHosts(): string[] {
  return [...DIRECT_MEDIA_HOSTS, ...getConfig().extraHosts];
}

export function isAllowedDirectHost(hostname: string): boolean {
  const host = normalizeHost(hostname);

  for (const entry of collectAllowedHosts()) {
    if (host === entry) return true;
  }

  for (const entry of WILDCARD_HOSTS) {
    if (host.endsWith(`.${entry}`)) return true;
  }

  // Explicit opt-in: any public host. Private addresses are still rejected by
  // `assertSafeRemoteHost` immediately before each connection.
  return directSourcePolicy() === "public";
}

export function isPlatformHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return (PLATFORM_HOSTS as readonly string[]).includes(host);
}

export function getSupportedHosts(): string[] {
  return Array.from(new Set([...collectAllowedHosts(), ...PLATFORM_HOSTS])).sort();
}

function pathExtension(url: URL): string | null {
  const candidate = `${url.pathname}${url.search}`.toLowerCase();
  const match = candidate.match(/\.([a-z0-9]{2,5})(?:[?&#]|$)/);
  return match ? `.${match[1]}` : null;
}

/**
 * Extract the canonical 11-character YouTube video id from Shorts, watch,
 * youtu.be, embed, live and music URLs. Returns `null` for anything else.
 */
export function extractYouTubeVideoId(url: URL): { videoId: string; variant: "short" | "watch" | "embed" } | null {
  if (!isPlatformHost(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const host = normalizeHost(url.hostname);

  const isVideoId = (value: string | undefined | null): value is string => Boolean(value && /^[A-Za-z0-9_-]{11}$/.test(value));

  if (host === "youtu.be") {
    const id = segments[0];
    return isVideoId(id) ? { videoId: id, variant: "watch" } : null;
  }

  if (segments[0] === "shorts" && isVideoId(segments[1])) {
    return { videoId: segments[1], variant: "short" };
  }

  if (segments[0] === "embed" && isVideoId(segments[1])) {
    return { videoId: segments[1], variant: "embed" };
  }

  if (segments[0] === "live" && isVideoId(segments[1])) {
    return { videoId: segments[1], variant: "watch" };
  }

  if (segments[0] === "watch") {
    const id = url.searchParams.get("v");
    return isVideoId(id) ? { videoId: id, variant: "watch" } : null;
  }

  // music.youtube.com/watch?v=... is covered above; /playlist etc. is rejected.
  return null;
}

/**
 * Decide how (or whether) a URL can be handled. Pure and synchronous.
 */
export function classifySource(url: URL): SourceClassification {
  if (isPlatformHost(url.hostname)) {
    const platform = extractYouTubeVideoId(url);
    if (!platform) {
      return {
        ok: false,
        reason: "not-a-media-url",
        message: "This YouTube URL is not a single video (playlists and channel pages are not supported).",
      };
    }

    return {
      ok: true,
      source: {
        kind: "platform",
        host: normalizeHost(url.hostname),
        platform: { name: "youtube", ...platform },
        extension: null,
      },
    };
  }

  if (!isAllowedDirectHost(url.hostname)) {
    return { ok: false, reason: "unsupported-source", message: MESSAGES.unsupportedSource };
  }

  const extension = pathExtension(url);

  return {
    ok: true,
    source: {
      kind: "direct",
      host: normalizeHost(url.hostname),
      extension,
    },
  };
}
