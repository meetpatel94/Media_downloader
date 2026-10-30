/**
 * Shared media processing primitives.
 *
 * Used by both the inspection endpoint and the download endpoint so the two
 * paths can never disagree about what a "format" is or how it is produced.
 *
 * Everything here is bounded: ffprobe/FFmpeg run with an explicit local-file
 * demuxer, a deadline, no shell, and their output is capped. Converted files are
 * re-sniffed and re-probed before they are reported as valid.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "@/lib/config";
import { DownloadError } from "@/lib/errors";
import { convertToMp3, convertToMp4, getFfmpegStatus } from "@/lib/ffmpeg";
import { describeContainer, type FormatSpec, type OutputContainer } from "@/lib/formats";
import { sniffContainer, type Container } from "@/lib/media-inspect";

export type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
};

export type MediaProbe = {
  streams?: ProbeStream[];
  format?: { duration?: string; tags?: { title?: string } };
};

const MAX_PROBE_OUTPUT = 100_000;

/** Demuxers FFmpeg/ffprobe may use for a local file. Never network protocols. */
export const DEMUXER: Partial<Record<Container, string>> = {
  mp4: "mov",
  aac: "mov",
  webm: "matroska",
  "mpeg-ts": "mpegts",
  mp3: "mp3",
  ogg: "ogg",
  wav: "wav",
  flac: "flac",
};

/** Map an output container onto the container that is sniffed from its bytes. */
export function sniffedContainerFor(container: OutputContainer): Container {
  return container === "m4a" ? "aac" : container;
}

export function probeBinary(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;

  try {
    const requireFromProject = createRequire(join(process.cwd(), "package.json"));
    return (requireFromProject("@ffprobe-installer/ffprobe") as { path: string }).path;
  } catch {
    return "ffprobe";
  }
}

export async function isFfprobeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(probeBinary(), ["-version"], { stdio: "ignore", shell: false });
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 5_000);

    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/** Probe a completed local file. Rejects with a safe `DownloadError`. */
export async function probeMediaFile(
  path: string,
  container: Container,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<MediaProbe> {
  const demuxer = DEMUXER[container];

  if (!demuxer) {
    throw new DownloadError("NOT_MEDIA", "This media container is not supported.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      probeBinary(),
      [
        "-v", "error",
        "-protocol_whitelist", "file,pipe",
        "-f", demuxer,
        "-show_entries",
        "stream=codec_type,codec_name,width,height,bit_rate,channels:stream_disposition=attached_pic:format=duration:format_tags=title",
        "-of", "json",
        path,
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    let done = false;

    const finish = (error?: DownloadError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);

      if (error) {
        reject(error);
        return;
      }

      try {
        resolve(JSON.parse(output) as MediaProbe);
      } catch {
        reject(new DownloadError("NOT_MEDIA", "Media metadata could not be read."));
      }
    };

    const abort = () => {
      child.kill("SIGKILL");
      finish(new DownloadError("CANCELLED", "The request was cancelled."));
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new DownloadError("UPSTREAM_TIMEOUT", "Media inspection timed out."));
    }, timeoutMs ?? getConfig().conversionTimeoutMs);

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();

      if (output.length > MAX_PROBE_OUTPUT) {
        child.kill("SIGKILL");
        finish(new DownloadError("NOT_MEDIA", "Media metadata is too large."));
      }
    });
    child.on("error", () =>
      finish(
        new DownloadError(
          "CONVERSION_UNAVAILABLE",
          "Media inspection requires ffprobe. Install FFmpeg (which includes ffprobe) on the server.",
        ),
      ),
    );
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new DownloadError("NOT_MEDIA", "Media metadata could not be read. The file may be invalid or use an unsupported codec."),
      ),
    );
  });
}

/** Real audio/video streams, ignoring cover art, plus the duration/title tags. */
export function summarizeProbe(probe: MediaProbe) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  const title = probe.format?.tags?.title;

  return {
    video,
    audio,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : null,
  };
}

export function resolutionLabel(video: ProbeStream | undefined): string | null {
  return video?.height && Number.isFinite(video.height) ? `${video.height}p` : null;
}

export function bitrateLabel(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;

  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? `${Math.round(numeric / 1000)}k` : null;
}

/** Parse `192k`, `192 kbps`, `192000` into kbps. */
export function parseBitrateKbps(value: string | null | undefined): number | null {
  if (!value) return null;

  const match = /^(\d+(?:\.\d+)?)\s*k(?:bps)?$/i.exec(value.trim());
  if (match) return Math.round(Number(match[1]));

  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 1000 ? Math.round(numeric / 1000) : null;
}

export function sanitizeFilename(input: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);

  return cleaned || "media-download";
}

export function filenameForUrl(url: URL, extension: OutputContainer): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments.pop() ?? "";

  let decoded = last;

  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }

  const base = decoded.replace(/\.[a-zA-Z0-9]{1,5}$/, "");
  return `${sanitizeFilename(base)}.${extension}`;
}

export async function fileSize(filePath: string, maxBytes: number, emptyMessage = "The media file is empty."): Promise<number> {
  const stats = await stat(filePath);

  if (!stats.isFile() || stats.size === 0) {
    throw new DownloadError("UPSTREAM_ERROR", emptyMessage);
  }

  if (stats.size > maxBytes) {
    throw new DownloadError("TOO_LARGE", "The media file is too large to download.");
  }

  return stats.size;
}

/** Sniff the first bytes of a local file. */
export async function sniffFile(filePath: string): Promise<Container> {
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
  const actual = await sniffFile(filePath);

  if (!expected.includes(actual)) {
    throw mismatch;
  }
}

export type ProducedOutput = {
  filePath: string;
  container: OutputContainer;
  contentType: string;
  size: number;
};

/**
 * Turn the downloaded source file into the requested output container.
 *
 * - `original`: the bytes already are that container, so they are served as-is.
 * - `transcode`: FFmpeg encodes/re-packages, and the result is sniffed *and*
 *   probed before it is accepted.
 */
export async function produceOutput(options: {
  sourcePath: string;
  sourceContainer: Container;
  spec: FormatSpec;
  workDir: string;
  signal: AbortSignal;
}): Promise<ProducedOutput> {
  const config = getConfig();
  const descriptor = describeContainer(options.spec.container);

  if (options.spec.kind === "original") {
    const expected = sniffedContainerFor(options.spec.container);

    if (options.sourceContainer !== expected) {
      throw new DownloadError("FORMAT_UNAVAILABLE", "The source file is not in that container after all. Fetch media information again.");
    }

    const size = await fileSize(options.sourcePath, config.maxFileSizeBytes);
    return { filePath: options.sourcePath, container: options.spec.container, contentType: descriptor.contentType, size };
  }

  const outputPath = join(options.workDir, `output-${randomUUID()}.${descriptor.extension}`);

  if (options.spec.container === "mp3") {
    const bitrateKbps = options.spec.bitrateKbps;

    if (!bitrateKbps) {
      throw new DownloadError("INVALID_FORMAT", "Select an MP3 bitrate.");
    }

    // Report a missing runtime dependency before blaming the file.
    const ffmpeg = await getFfmpegStatus();

    if (!ffmpeg.available) {
      throw new DownloadError(
        "CONVERSION_UNAVAILABLE",
        "MP3 conversion is not available on this server because FFmpeg is not installed.",
      );
    }

    const probe = await probeMediaFile(options.sourcePath, options.sourceContainer, options.signal);

    if (!summarizeProbe(probe).audio) {
      throw new DownloadError("FORMAT_UNAVAILABLE", "This source has no audio track to convert.");
    }

    await convertToMp3(options.sourcePath, outputPath, {
      signal: options.signal,
      bitrate: `${bitrateKbps}k`,
      inputFormat: DEMUXER[options.sourceContainer],
    });

    await verifyContainer(
      outputPath,
      ["mp3"],
      new DownloadError("CONVERSION_FAILED", "The converted file was not valid MP3 audio."),
    );

    const converted = summarizeProbe(await probeMediaFile(outputPath, "mp3", options.signal));

    if (converted.audio?.codec_name !== "mp3") {
      throw new DownloadError("CONVERSION_FAILED", "The converted file did not contain MP3 audio.");
    }

    const actualKbps = parseBitrateKbps(bitrateLabel(converted.audio.bit_rate));

    // Guard against a silently wrong encoder target; allow codec overhead slack.
    if (actualKbps !== null && Math.abs(actualKbps - bitrateKbps) > Math.max(16, bitrateKbps * 0.2)) {
      throw new DownloadError("CONVERSION_FAILED", "Audio conversion did not produce the requested bitrate.");
    }
  } else if (options.spec.container === "mp4") {
    if (options.sourceContainer === "mp4") {
      throw new DownloadError("FORMAT_UNAVAILABLE", "This source is already an MP4 file.");
    }

    await convertToMp4(options.sourcePath, outputPath, {
      signal: options.signal,
      timeoutMs: config.conversionTimeoutMs,
    });

    await verifyContainer(
      outputPath,
      ["mp4"],
      new DownloadError("CONVERSION_FAILED", "The converted file was not a valid MP4 video."),
    );

    const converted = summarizeProbe(await probeMediaFile(outputPath, "mp4", options.signal));

    if (!converted.video) {
      throw new DownloadError("CONVERSION_FAILED", "The converted file did not contain a video stream.");
    }
  } else {
    throw new DownloadError("FORMAT_UNAVAILABLE", "That output format cannot be produced for this source.");
  }

  const size = await fileSize(outputPath, config.maxFileSizeBytes, "The converted media file is empty.");
  return { filePath: outputPath, container: options.spec.container, contentType: descriptor.contentType, size };
}

/** Read a file's bytes as a stream (used by the route handler). */
export function createArtifactStream(filePath: string) {
  return createReadStream(filePath);
}
