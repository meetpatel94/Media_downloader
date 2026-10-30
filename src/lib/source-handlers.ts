/**
 * Source handler registry.
 *
 * Each source kind declares two *independent* capabilities:
 *
 * - `metadata`  – can this source be described (title, duration, formats)?
 * - `download`  – can this server actually produce media bytes for it?
 *
 * Keeping them separate is what lets YouTube metadata work without pretending
 * that YouTube downloads work. A handler may never report a capability it does
 * not implement: the direct handler verifies bytes and probes them, and the
 * platform handler only calls official metadata APIs.
 *
 * Adding a source means adding a handler here plus a validated entry in
 * `src/lib/sources.ts` — not sprinkling hostnames through the fetch code.
 */

import { join } from "node:path";
import { DownloadError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { openRemoteMedia, streamToFile } from "@/lib/http-media";
import { sniffContainer, type Container, type MediaKind } from "@/lib/media-inspect";
import type { OutputContainer } from "@/lib/formats";
import { fetchYouTubeMetadata, youTubeCapability, type YouTubeMetadata } from "@/lib/platform";
import { MESSAGES, type ClassifiedSource, type SourceKind } from "@/lib/sources";

export type SourceCapability = "metadata" | "download";

export type CapabilityState = {
  supported: boolean;
  /** Safe, user-facing explanation when the capability is unavailable. */
  reason: string | null;
};

export type HandlerContext = {
  url: URL;
  source: ClassifiedSource;
  signal: AbortSignal;
  workDir: string;
};

export type DownloadContext = HandlerContext & {
  /** Output the caller intends to produce; used for early content-type checks. */
  format: OutputContainer;
};

export type HandlerResult = {
  /** Local temp file containing the raw upstream media. */
  sourcePath: string;
  container: Container;
  /** Upstream content type (may be empty when the server sent none). */
  contentType: string;
  kind: MediaKind;
  finalUrl: URL;
};

export type HandlerMetadata = {
  title: string | null;
  duration: number | null;
  thumbnail: string | null;
  author: string | null;
  /** Which official API supplied the metadata, if any. */
  provider: string | null;
};

export type SourceInspection = {
  metadata: HandlerMetadata;
  /** `null` for metadata-only sources (nothing was downloaded). */
  media: HandlerResult | null;
  /** Limitations to surface to the user alongside the metadata. */
  notes: string[];
};

export type SourceHandler = {
  kind: SourceKind;
  label: string;
  capabilities: () => Record<SourceCapability, CapabilityState>;
  inspect: (context: HandlerContext) => Promise<SourceInspection>;
  download: (context: DownloadContext) => Promise<HandlerResult>;
};

const EMPTY_METADATA: HandlerMetadata = { title: null, duration: null, thumbnail: null, author: null, provider: null };

function rejectNonMedia(container: Container): never {
  if (container === "html") {
    throw new DownloadError("NOT_MEDIA", "That URL returns a web page, not a media file.");
  }

  throw new DownloadError(
    "NOT_MEDIA",
    "The file at that URL could not be verified as audio or video. Paste a direct link to a media file.",
  );
}

/** Media kind required by an output container, for early content-type checks. */
function acceptFor(format: OutputContainer): MediaKind | "any" {
  return format === "mp4" || format === "webm" ? "video" : "any";
}

/**
 * Stream the upstream file into `workDir`, verifying the bytes before returning.
 * `format` is `null` during inspection, when the output is not chosen yet.
 */
async function fetchDirectMedia(context: HandlerContext, format: OutputContainer | null): Promise<HandlerResult> {
  const config = getConfig();
  const maxBytes = config.maxFileSizeBytes;

  const media = await openRemoteMedia(context.url, {
    signal: context.signal,
    accept: format ? acceptFor(format) : "any",
    maxBytes,
  });

  const sourcePath = join(context.workDir, "source.bin");

  const { firstBytes } = await streamToFile(media.stream, sourcePath, {
    maxBytes,
    signal: context.signal,
    timeoutMs: config.downloadTimeoutMs,
  });

  const container = sniffContainer(firstBytes);

  if (container === "html" || container === "unknown") {
    rejectNonMedia(container);
  }

  return {
    sourcePath,
    container,
    contentType: media.contentType,
    kind: media.kind,
    finalUrl: media.finalUrl,
  };
}

/**
 * Direct media file handler: the only source kind this deployment downloads.
 * Bytes are streamed to a temp file with a hard cap, then sniffed so an HTML
 * error page can never be served as media.
 */
const directMediaHandler: SourceHandler = {
  kind: "direct",
  label: "Direct media file",

  capabilities: () => ({
    metadata: { supported: true, reason: null },
    download: { supported: true, reason: null },
  }),

  async inspect(context: HandlerContext): Promise<SourceInspection> {
    // The output format is not chosen yet, so any verified media is accepted.
    const media = await fetchDirectMedia(context, null);

    return { metadata: { ...EMPTY_METADATA }, media, notes: [] };
  },

  async download(context: DownloadContext): Promise<HandlerResult> {
    return fetchDirectMedia(context, context.format);
  },
};

/**
 * Video platform handler (YouTube Shorts, watch, youtu.be...).
 *
 * Metadata: implemented through official YouTube APIs (see `src/lib/platform.ts`).
 * Download: deliberately not implemented. YouTube's official APIs do not expose
 * media files, and this repository contains no scraping, signature extraction,
 * DRM bypass or third-party "download service" integration.
 */
function platformCapabilities(): Record<SourceCapability, CapabilityState> {
  const metadata = youTubeCapability();

  return {
    metadata: {
      supported: metadata.supported,
      reason: metadata.reason,
    },
    download: {
      supported: false,
      reason: MESSAGES.platformDownloadNotSupported,
    },
  };
}

const platformHandler: SourceHandler = {
  kind: "platform",
  label: "YouTube video",

  capabilities: platformCapabilities,

  async inspect(context: HandlerContext): Promise<SourceInspection> {
    const capabilities = platformCapabilities();

    if (!capabilities.metadata.supported) {
      throw new DownloadError(
        "UNSUPPORTED_SOURCE",
        capabilities.metadata.reason ?? MESSAGES.platformMetadataNotSupported,
      );
    }

    const platform = context.source.platform;

    if (!platform) {
      throw new DownloadError("UNSUPPORTED_SOURCE", MESSAGES.unsupportedSource);
    }

    const metadata: YouTubeMetadata = await fetchYouTubeMetadata(platform.videoId, context.signal);

    return {
      metadata: {
        title: metadata.title,
        duration: metadata.duration,
        thumbnail: metadata.thumbnail,
        author: metadata.author,
        provider: metadata.provider,
      },
      media: null,
      notes: [capabilities.download.reason ?? MESSAGES.platformDownloadNotSupported],
    };
  },

  async download(): Promise<HandlerResult> {
    throw new DownloadError("UNSUPPORTED_SOURCE", MESSAGES.platformDownloadNotSupported);
  },
};

const HANDLERS: Record<SourceKind, SourceHandler> = {
  direct: directMediaHandler,
  platform: platformHandler,
};

export function getSourceHandler(source: ClassifiedSource): SourceHandler {
  return HANDLERS[source.kind];
}

export type SourceHandlerSummary = {
  kind: SourceKind;
  label: string;
  /** Backwards-compatible flag: does this source support media download? */
  implemented: boolean;
  capabilities: Record<SourceCapability, CapabilityState>;
};

export function listSourceHandlers(): SourceHandlerSummary[] {
  return Object.values(HANDLERS).map((handler) => {
    const capabilities = handler.capabilities();

    return {
      kind: handler.kind,
      label: handler.label,
      implemented: capabilities.download.supported,
      capabilities,
    };
  });
}
