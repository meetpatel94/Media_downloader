/**
 * Download pipeline.
 *
 * url validation -> source handler (streamed to a temp file with a byte cap)
 * -> format processing (MP4 package / MP3 transcode) -> verified temp file
 * -> single-use cleanup.
 *
 * Nothing is buffered in memory, every step is bounded by timeouts, and the
 * temp directory is always removed by the caller via `cleanup()`.
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "@/lib/config";
import { acquireSlot } from "@/lib/concurrency";
import { DownloadError } from "@/lib/errors";
import { convertToMp3, convertToMp4, getFfmpegStatus } from "@/lib/ffmpeg";
import {
  containerKind,
  isConvertible,
  isMp3Audio,
  isMp4CompatibleVideo,
  sniffContainer,
  type Container,
} from "@/lib/media-inspect";
import { getSourceHandler, type DownloadFormat } from "@/lib/source-handlers";
import { validateMediaUrl } from "@/lib/download-validation";

export type DownloadArtifact = {
  filePath: string;
  filename: string;
  contentType: string;
  size: number;
  cleanup: () => Promise<void>;
};

function sanitizeFilename(input: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);

  return cleaned || "media-download";
}

export function filenameForUrl(url: URL, format: DownloadFormat): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.pop() ?? "";

  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }

  const base = decoded.replace(/\.[a-zA-Z0-9]{1,5}$/, "");
  return `${sanitizeFilename(base)}.${format}`;
}

async function assertFileSize(filePath: string, maxBytes: number): Promise<number> {
  const stats = await stat(filePath);

  if (!stats.isFile() || stats.size === 0) {
    throw new DownloadError("UPSTREAM_ERROR", "The media file is empty.");
  }

  if (stats.size > maxBytes) {
    throw new DownloadError("TOO_LARGE", "The media file is too large to download.");
  }

  return stats.size;
}

/** Sniff the first 64 bytes of a file without reading it into memory. */
async function sniffFile(filePath: string): Promise<Container> {
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    return sniffContainer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function verifyContainer(filePath: string, expected: Container[], mismatch: DownloadError): Promise<void> {
  const container = await sniffFile(filePath);

  if (!expected.includes(container)) {
    throw mismatch;
  }
}

async function processMp4(
  sourcePath: string,
  container: Container,
  workDir: string,
  signal: AbortSignal,
): Promise<string> {
  const config = getConfig();

  if (containerKind(container) === "audio") {
    throw new DownloadError("FORMAT_UNAVAILABLE", "This source contains audio only. Choose MP3 instead.");
  }

  if (isMp4CompatibleVideo(container)) {
    return sourcePath;
  }

  if (!isConvertible(container)) {
    throw new DownloadError("FORMAT_UNAVAILABLE", "This video is not available in MP4 format.");
  }

  const outputPath = join(workDir, `output-${randomUUID()}.mp4`);
  await convertToMp4(sourcePath, outputPath, { signal, timeoutMs: config.conversionTimeoutMs });

  await verifyContainer(
    outputPath,
    ["mp4"],
    new DownloadError("CONVERSION_FAILED", "The converted file was not a valid MP4 video."),
  );

  await assertFileSize(outputPath, config.maxFileSizeBytes);
  return outputPath;
}

async function processMp3(
  sourcePath: string,
  container: Container,
  workDir: string,
  signal: AbortSignal,
): Promise<string> {
  const config = getConfig();

  if (isMp3Audio(container)) {
    return sourcePath;
  }

  if (!isConvertible(container)) {
    throw new DownloadError("FORMAT_UNAVAILABLE", "Audio could not be extracted from this source.");
  }

  const status = await getFfmpegStatus();
  if (!status.available) {
    throw new DownloadError(
      "CONVERSION_UNAVAILABLE",
      "MP3 conversion is not available on this server because FFmpeg is not installed.",
    );
  }

  const outputPath = join(workDir, `output-${randomUUID()}.mp3`);
  await convertToMp3(sourcePath, outputPath, { signal, timeoutMs: config.conversionTimeoutMs });

  await verifyContainer(
    outputPath,
    ["mp3"],
    new DownloadError("CONVERSION_FAILED", "The converted file was not valid MP3 audio."),
  );

  await assertFileSize(outputPath, config.maxFileSizeBytes);
  return outputPath;
}

/**
 * Download (and convert when needed) a URL.
 *
 * Throws `DownloadError` for every expected failure. On success the caller owns
 * the temp directory and must call `cleanup()`.
 */
export async function downloadMedia(
  rawUrl: string,
  format: DownloadFormat,
  options: { signal?: AbortSignal } = {},
): Promise<DownloadArtifact> {
  const config = getConfig();
  const signal = options.signal ?? new AbortController().signal;

  const validation = validateMediaUrl(rawUrl);
  if (!validation.ok) {
    throw new DownloadError(validation.code, validation.message);
  }

  const handler = getSourceHandler(validation.source);
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

    const filePath =
      format === "mp4"
        ? await processMp4(result.sourcePath, result.container, workDir, signal)
        : await processMp3(result.sourcePath, result.container, workDir, signal);

    const size = await assertFileSize(filePath, config.maxFileSizeBytes);
    const filename = filenameForUrl(result.finalUrl, format);

    handedOff = true;

    return {
      filePath,
      filename,
      contentType: format === "mp4" ? "video/mp4" : "audio/mpeg",
      size,
      cleanup,
    };
  } catch (error) {
    throw error;
  } finally {
    slot.release();
    if (!handedOff) {
      // Defensive: ensure nothing is left behind on early exits.
      await cleanup();
    }
  }
}

/** Exposed for streamed responses. */
export function createArtifactStream(filePath: string) {
  return createReadStream(filePath);
}
