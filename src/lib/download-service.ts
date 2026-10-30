/**
 * Download pipeline.
 *
 * url validation -> capability check -> source handler (streamed to a temp file
 * with a byte cap) -> format processing (passthrough / MP3 / MP4) -> verified
 * temp file -> single-use cleanup.
 *
 * `inspectMedia` (used by both API routes) builds on the same primitives; this
 * module is the lower-level entry point that is also exercised directly by the
 * test suite.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "@/lib/config";
import { acquireSlot } from "@/lib/concurrency";
import { DownloadError } from "@/lib/errors";
import {
  defaultMp3Bitrate,
  type FormatSpec,
  type OutputContainer,
} from "@/lib/formats";
import {
  createArtifactStream,
  filenameForUrl,
  produceOutput,
  sniffedContainerFor,
  type ProducedOutput,
} from "@/lib/media-processing";
import { containerKind, type Container } from "@/lib/media-inspect";
import { getSourceHandler } from "@/lib/source-handlers";
import { validateMediaUrl } from "@/lib/download-validation";

export { createArtifactStream, filenameForUrl, sanitizeFilename } from "@/lib/media-processing";

export type DownloadArtifact = {
  filePath: string;
  filename: string;
  contentType: string;
  size: number;
  cleanup: () => Promise<void>;
};

/** Decide how a source container becomes the requested output. */
function specFor(container: Container, format: OutputContainer): FormatSpec {
  if (sniffedContainerFor(format) === container) {
    return { kind: "original", container: format };
  }

  const kind = containerKind(container);

  if (kind === "audio" && (format === "mp4" || format === "webm")) {
    throw new DownloadError("FORMAT_UNAVAILABLE", "This source contains audio only. Choose MP3 instead.");
  }

  if (kind === "unknown") {
    throw new DownloadError("FORMAT_UNAVAILABLE", "That output format cannot be produced for this source.");
  }

  if (format === "mp3") {
    return { kind: "transcode", container: "mp3", bitrateKbps: defaultMp3Bitrate() };
  }

  if (format === "mp4") {
    return { kind: "transcode", container: "mp4" };
  }

  throw new DownloadError("FORMAT_UNAVAILABLE", "That output format cannot be produced for this source.");
}

/**
 * Download (and convert when needed) a URL.
 *
 * Throws `DownloadError` for every expected failure. On success the caller owns
 * the temp directory and must call `cleanup()`.
 */
export async function downloadMedia(
  rawUrl: string,
  format: OutputContainer,
  options: { signal?: AbortSignal } = {},
): Promise<DownloadArtifact> {
  const config = getConfig();
  const signal = options.signal ?? new AbortController().signal;

  const validation = validateMediaUrl(rawUrl);

  if (!validation.ok) {
    throw new DownloadError(validation.code, validation.message);
  }

  const handler = getSourceHandler(validation.source);
  const capabilities = handler.capabilities();

  if (!capabilities.download.supported) {
    throw new DownloadError(
      "UNSUPPORTED_SOURCE",
      capabilities.download.reason ?? "This source cannot be downloaded by this deployment.",
    );
  }

  const slot = await acquireSlot(signal);
  const workDir = await mkdtemp(join(tmpdir(), "media-downloader-"));

  const cleanup = async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  };

  let handedOff = false;

  try {
    if (signal.aborted) {
      throw new DownloadError("CANCELLED", "The download was cancelled.");
    }

    const result = await handler.download({
      url: validation.url,
      source: validation.source,
      format,
      signal,
      workDir,
    });

    const produced: ProducedOutput = await produceOutput({
      sourcePath: result.sourcePath,
      sourceContainer: result.container,
      spec: specFor(result.container, format),
      workDir,
      signal,
    });

    const filename = filenameForUrl(result.finalUrl, produced.container);
    const size = produced.size;

    if (size > config.maxFileSizeBytes) {
      throw new DownloadError("TOO_LARGE", "The media file is too large to download.");
    }

    handedOff = true;

    return {
      filePath: produced.filePath,
      filename,
      contentType: produced.contentType,
      size,
      cleanup,
    };
  } finally {
    slot.release();

    if (!handedOff) {
      // Defensive: ensure nothing is left behind on early exits.
      await cleanup();
    }
  }
}
