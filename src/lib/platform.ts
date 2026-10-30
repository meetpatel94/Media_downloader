/**
 * YouTube metadata provider.
 *
 * Capabilities, stated plainly:
 *
 * - YouTube **metadata** can be retrieved through two *official, documented,
 *   key-free-or-keyed* mechanisms:
 *     a. the YouTube oEmbed endpoint (`https://www.youtube.com/oembed`), which
 *        returns title, author and thumbnail and needs no credentials;
 *     b. the YouTube Data API v3 (`videos.list`), enabled when
 *        `YOUTUBE_API_KEY` is set, which additionally returns duration.
 * - YouTube **media download** is *not* offered by either mechanism. The Data
 *   API returns metadata and URLs to embeddable players, not downloadable
 *   streams; downloading is restricted by YouTube's Terms of Service. This
 *   module therefore never returns a media URL and the source handler reports
 *   `download.supported = false`.
 *
 * No page scraping, signature extraction, cipher reversal, DRM bypass or
 * third-party "savefrom"-style endpoint is used.
 *
 * Both endpoints are fixed constants, not user-controlled. The video id is
 * validated before it is interpolated, the response is bounded, and the API key
 * is only ever sent to `www.googleapis.com` and never returned to a client.
 */

import { getConfig } from "@/lib/config";
import { DownloadError } from "@/lib/errors";
import { fetchJsonLimited } from "@/lib/http-media";

const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";
const DATA_API_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
const YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch";

export type YouTubeMetadata = {
  title: string | null;
  duration: number | null;
  thumbnail: string | null;
  author: string | null;
  provider: YouTubeMetadataProvider;
};

export type YouTubeMetadataProvider = "youtube-data-api" | "youtube-oembed";

export type YouTubeCapability = {
  supported: boolean;
  provider: YouTubeMetadataProvider | null;
  reason: string | null;
};

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Only YouTube's own image CDNs may be used as a thumbnail source. */
function safeThumbnailUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;

    const host = url.hostname.toLowerCase();
    const allowed = host === "i.ytimg.com" || host === "img.youtube.com" || host === "i9.ytimg.com" || host.endsWith(".ytimg.com");

    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** ISO-8601 duration (`PT1M3S`) to seconds. Returns `null` when unknown. */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim().toUpperCase());
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);

  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Which provider would be used right now, if any. */
export function youTubeCapability(): YouTubeCapability {
  const config = getConfig();

  if (!config.youtubeMetadata) {
    return {
      supported: false,
      provider: null,
      reason:
        "YouTube metadata lookup is disabled on this deployment (MEDIA_DOWNLOADER_YOUTUBE_METADATA).",
    };
  }

  return {
    supported: true,
    provider: config.youtubeApiKey ? "youtube-data-api" : "youtube-oembed",
    reason: null,
  };
}

function assertVideoId(videoId: string): void {
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new DownloadError("INVALID_URL", "That YouTube URL does not contain a valid video id.");
  }
}

/**
 * oEmbed only answers for the one video it was asked about, so a 401/403 there
 * really does mean "this video is not publicly available".
 */
function mapOembedFailure(status: number): DownloadError {
  if (status === 404 || status === 410) {
    return new DownloadError("MEDIA_UNAVAILABLE", "That YouTube video was not found or is no longer available.");
  }

  if (status === 401 || status === 403) {
    return new DownloadError(
      "MEDIA_UNAVAILABLE",
      "This YouTube video is private, age-restricted, region-blocked, or otherwise not publicly available.",
    );
  }

  return new DownloadError("UPSTREAM_ERROR", "The YouTube oEmbed service returned an error. Please try again.");
}

/**
 * The Data API reports key/quota problems as 401/403 and missing videos as 404,
 * so only 404/410 may short-circuit the oEmbed fallback.
 */
function mapDataApiFailure(status: number): DownloadError {
  if (status === 404 || status === 410) {
    return new DownloadError("MEDIA_UNAVAILABLE", "That YouTube video was not found or is no longer available.");
  }

  return new DownloadError("UPSTREAM_ERROR", "The YouTube Data API returned an error. Please try again.");
}

async function fetchViaDataApi(videoId: string, signal: AbortSignal): Promise<YouTubeMetadata> {
  const key = getConfig().youtubeApiKey;

  if (!key) throw new DownloadError("UPSTREAM_ERROR", "YouTube Data API key is not configured.");

  const url = new URL(DATA_API_ENDPOINT);
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", key);

  const result = await fetchJsonLimited(url, { signal });

  if (!result.ok) throw mapDataApiFailure(result.status);

  const payload = result.data as {
    items?: Array<{
      snippet?: { title?: unknown; channelTitle?: unknown; thumbnails?: Record<string, { url?: unknown }> };
      contentDetails?: { duration?: unknown };
    }>;
  } | null;

  const item = Array.isArray(payload?.items) ? payload.items[0] : undefined;

  if (!item) {
    throw new DownloadError("MEDIA_UNAVAILABLE", "That YouTube video was not found or is no longer available.");
  }

  const thumbs = item.snippet?.thumbnails ?? {};
  const thumbnail = safeThumbnailUrl(
    thumbs.maxres?.url ?? thumbs.standard?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url,
  );

  return {
    title: cleanText(item.snippet?.title),
    duration: parseIsoDuration(item.contentDetails?.duration),
    thumbnail,
    author: cleanText(item.snippet?.channelTitle, 120),
    provider: "youtube-data-api",
  };
}

async function fetchViaOembed(videoId: string, signal: AbortSignal): Promise<YouTubeMetadata> {
  const canonical = new URL(YOUTUBE_WATCH_BASE);
  canonical.searchParams.set("v", videoId);

  const url = new URL(OEMBED_ENDPOINT);
  url.searchParams.set("url", canonical.toString());
  url.searchParams.set("format", "json");

  const result = await fetchJsonLimited(url, { signal });

  if (!result.ok) throw mapOembedFailure(result.status);

  const payload = result.data as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown } | null;

  if (!payload || typeof payload !== "object") {
    throw new DownloadError("UPSTREAM_ERROR", "The YouTube oEmbed service returned an invalid response.");
  }

  return {
    title: cleanText(payload.title),
    // oEmbed does not expose duration; never guess it.
    duration: null,
    thumbnail: safeThumbnailUrl(payload.thumbnail_url),
    author: cleanText(payload.author_name, 120),
    provider: "youtube-oembed",
  };
}

/**
 * Retrieve real metadata for a single public YouTube video.
 *
 * The Data API is preferred when a key is configured; if it fails for a
 * transient/quota reason the key-free oEmbed endpoint is used instead. Definitive
 * "video unavailable" answers are surfaced immediately.
 */
export async function fetchYouTubeMetadata(videoId: string, signal: AbortSignal): Promise<YouTubeMetadata> {
  assertVideoId(videoId);

  const capability = youTubeCapability();

  if (!capability.supported) {
    throw new DownloadError("UNSUPPORTED_SOURCE", capability.reason ?? "YouTube metadata lookup is not configured.");
  }

  if (capability.provider === "youtube-data-api") {
    try {
      return await fetchViaDataApi(videoId, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof DownloadError && error.code === "MEDIA_UNAVAILABLE") throw error;
      // Quota exhaustion or an API outage must not remove metadata entirely.
    }
  }

  return fetchViaOembed(videoId, signal);
}
