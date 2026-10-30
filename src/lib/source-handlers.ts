/**
 * Source handler registry.
 *
 * Each legally/technically distinct source kind has one handler. Adding a new
 * supported source means adding a handler here plus a validated entry in
 * `src/lib/sources.ts` — not sprinkling hostnames into the fetch code.
 */

import { join } from "node:path";
import { DownloadError } from "@/lib/errors";
import { openRemoteMedia, streamToFile } from "@/lib/http-media";
import { sniffContainer, type Container, type MediaKind } from "@/lib/media-inspect";
import { getConfig } from "@/lib/config";
import { MESSAGES, type ClassifiedSource, type SourceKind } from "@/lib/sources";

export type DownloadFormat = "mp4" | "mp3";

export type HandlerContext = {
  url: URL;
  source: ClassifiedSource;
  format: DownloadFormat;
  signal: AbortSignal;
  workDir: string;
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

export type SourceHandler = {
  kind: SourceKind;
  label: string;
  implemented: boolean;
  download: (context: HandlerContext) => Promise<HandlerResult>;
};

function rejectNonMedia(container: Container): never {
  if (container === "html") {
    throw new DownloadError("NOT_MEDIA", "That URL returns a web page, not a media file.");
  }

  throw new DownloadError(
    "NOT_MEDIA",
    "The file at that URL could not be verified as audio or video. Paste a direct link to a media file.",
  );
}

/**
 * Direct media file handler: the only source kind that is actually downloaded
 * over HTTP in this deployment.
 */
const directMediaHandler: SourceHandler = {
  kind: "direct",
  label: "Direct media file",
  implemented: true,

  async download(context: HandlerContext): Promise<HandlerResult> {
    const config = getConfig();
    const maxBytes = config.maxFileSizeBytes;

    const media = await openRemoteMedia(context.url, {
      signal: context.signal,
      accept: context.format === "mp4" ? "video" : "any",
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
  },
};

/**
 * Video platform handler (YouTube Shorts, watch, youtu.be...).
 *
 * Platform URLs are recognised and normalised, but downloading them requires an
 * extractor that is permitted by the platform's terms (for example an
 * authorised API/keyed integration). No such integration is configured in this
 * repository, and no scraping or access-control bypass is implemented. The
 * handler therefore fails with an explicit, actionable message instead of
 * pretending the page is a media file.
 */
const platformHandler: SourceHandler = {
  kind: "platform",
  label: "Video platform page",
  implemented: false,

  async download(): Promise<HandlerResult> {
    throw new DownloadError("UNSUPPORTED_SOURCE", MESSAGES.platformNotSupported);
  },
};

const HANDLERS: Record<SourceKind, SourceHandler> = {
  direct: directMediaHandler,
  platform: platformHandler,
};

export function getSourceHandler(source: ClassifiedSource): SourceHandler {
  return HANDLERS[source.kind];
}

export function listSourceHandlers(): Array<{ kind: SourceKind; label: string; implemented: boolean }> {
  return Object.values(HANDLERS).map(({ kind, label, implemented }) => ({ kind, label, implemented }));
}
