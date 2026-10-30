/**
 * Guarded HTTP fetching for remote media.
 *
 * Responsibilities:
 * - manual redirect handling, re-validating (allowlist + DNS/SSRF) every hop
 * - bounded connection/header timeout, composed with the caller's signal
 * - content-type and content-length screening
 * - streaming the body to a temp file with a hard byte cap (never buffers it)
 */

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { getConfig } from "@/lib/config";
import { DownloadError } from "@/lib/errors";
import { assertSafeRemoteHost, resolveAllowedRedirect } from "@/lib/download-validation";
import { contentTypeKind, type MediaKind } from "@/lib/media-inspect";

const USER_AGENT = "MediaDownloader/1.0 (+https://github.com/meetpatel94/Media_downloader)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type OpenMediaOptions = {
  signal: AbortSignal;
  /** Which kind of media the caller needs; `any` accepts video or audio. */
  accept?: MediaKind | "any";
  maxBytes?: number;
  /** Override the header timeout (tests / advanced callers). */
  headerTimeoutMs?: number;
};

export type OpenMedia = {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number | null;
  finalUrl: URL;
  kind: MediaKind;
};

function headerTimeoutSignal(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const combined = AbortSignal.any([signal, controller.signal]);

  return {
    signal: combined,
    cancel: () => clearTimeout(timer),
    didTimeout: () => timedOut,
  };
}

async function fetchHop(url: URL, options: OpenMediaOptions, timeoutGuard: ReturnType<typeof headerTimeoutSignal>) {
  // Re-check DNS for the exact hop we are about to contact.
  await assertSafeRemoteHost(url);

  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: timeoutGuard.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "video/*,audio/*,application/octet-stream;q=0.9,*/*;q=0.5",
        "accept-encoding": "identity",
      },
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw new DownloadError("CANCELLED", "The download was cancelled.", { cause: error });
    }
    if (timeoutGuard.didTimeout()) {
      throw new DownloadError("UPSTREAM_TIMEOUT", "The source took too long to respond. Please try again.", { cause: error });
    }
    throw new DownloadError("UPSTREAM_ERROR", "The media could not be reached.", { cause: error });
  }
}

/**
 * Open a stream for a validated direct-media URL. The caller owns `signal` and
 * must cancel the returned stream (or abort the signal) on failure.
 */
export async function openRemoteMedia(input: URL, options: OpenMediaOptions): Promise<OpenMedia> {
  const config = getConfig();
  const maxBytes = options.maxBytes ?? config.maxFileSizeBytes;
  const accept = options.accept ?? "any";

  let url = input;
  const timeoutGuard = headerTimeoutSignal(options.signal, options.headerTimeoutMs ?? config.requestTimeoutMs);

  try {
    for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
      const response = await fetchHop(url, options, timeoutGuard);

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");

        // Drain/cancel the redirect body so the socket is released.
        await response.body?.cancel().catch(() => undefined);

        if (!location) {
          throw new DownloadError("UPSTREAM_ERROR", "The media could not be reached.");
        }

        url = resolveAllowedRedirect(location, url);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404 || response.status === 410) {
          throw new DownloadError("UPSTREAM_NOT_FOUND", "The media file was not found at that URL.");
        }
        if (response.status === 401 || response.status === 403) {
          throw new DownloadError("FORMAT_UNAVAILABLE", "This media is not publicly accessible.");
        }
        throw new DownloadError("UPSTREAM_ERROR", "The source returned an error. Please try again.");
      }

      if (!response.body) {
        throw new DownloadError("UPSTREAM_ERROR", "The source returned an empty response.");
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.startsWith("text/html") || contentType.startsWith("application/xhtml")) {
        await response.body.cancel().catch(() => undefined);
        throw new DownloadError("NOT_MEDIA", "That URL returns a web page, not a media file.");
      }

      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new DownloadError("TOO_LARGE", "The media file is too large to download.");
      }

      const kind = contentTypeKind(contentType);

      if (accept !== "any" && kind !== "unknown" && kind !== accept) {
        await response.body.cancel().catch(() => undefined);
        throw new DownloadError(
          "INVALID_CONTENT_TYPE",
          accept === "video" ? "That URL does not point to a video file." : "That URL does not point to an audio file.",
        );
      }

      return {
        stream: response.body,
        contentType,
        contentLength: contentLength !== null && Number.isFinite(contentLength) ? contentLength : null,
        finalUrl: url,
        kind,
      };
    }

    throw new DownloadError("SOURCE_NOT_PERMITTED", "The source redirected too many times.");
  } finally {
    timeoutGuard.cancel();
  }
}

export type StreamToFileResult = { size: number; firstBytes: Uint8Array };

/**
 * Stream a web stream into a file without buffering it in memory, aborting as
 * soon as the byte cap is exceeded. Partial files are removed by the caller.
 */
export async function streamToFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  options: { maxBytes: number; signal: AbortSignal; timeoutMs: number },
): Promise<StreamToFileResult> {
  const nodeStream = Readable.fromWeb(stream as unknown as WebReadableStream);
  const fileStream = createWriteStream(filePath, { flags: "w", mode: 0o600 });

  let size = 0;
  let firstBytes = new Uint8Array(0);

  const controller = new AbortController();
  const cancel = () => controller.abort();

  if (options.signal.aborted) {
    controller.abort();
  } else {
    options.signal.addEventListener("abort", cancel, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  nodeStream.on("data", (chunk: Buffer) => {
    if (firstBytes.length === 0) {
      firstBytes = new Uint8Array(chunk.subarray(0, 64));
    }
    size += chunk.length;

    if (size > options.maxBytes) {
      controller.abort();
    }
  });

  try {
    await pipeline(nodeStream, fileStream, { signal: controller.signal });

    if (size > options.maxBytes) {
      throw new DownloadError("TOO_LARGE", "The media file is too large to download.");
    }

    if (size === 0) {
      throw new DownloadError("UPSTREAM_ERROR", "The source returned an empty file.");
    }

    return { size, firstBytes };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (size > options.maxBytes) {
      throw new DownloadError("TOO_LARGE", "The media file is too large to download.", { cause: error });
    }
    if (options.signal.aborted) {
      throw new DownloadError("CANCELLED", "The download was cancelled.", { cause: error });
    }
    if (controller.signal.aborted) {
      throw new DownloadError("UPSTREAM_TIMEOUT", "Downloading the media timed out. Please try again.", { cause: error });
    }
    throw new DownloadError("UPSTREAM_ERROR", "The download was interrupted. Please try again.", { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    if (!fileStream.closed) {
      await new Promise<void>((resolve) => fileStream.close(() => resolve()));
    }
  }
}
