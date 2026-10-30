/**
 * FFmpeg integration.
 *
 * FFmpeg is only used for audio extraction/transcoding. The binary is located
 * in this order:
 *
 *   1. `FFMPEG_PATH` environment variable (explicit configuration)
 *   2. `ffmpeg` on the process `PATH`
 *   3. the optional `@ffmpeg-installer/ffmpeg` package, if installed
 *
 * Availability is probed once per process, so the app never claims MP3
 * conversion works when no working binary exists. Spawning uses an argument
 * array (never a shell string), a bounded timeout, and captured stderr.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getConfig } from "@/lib/config";
import { DownloadError } from "@/lib/errors";

export type FfmpegSource = "env" | "path" | "bundled";

export type FfmpegStatus = {
  available: boolean;
  source: FfmpegSource | null;
  version: string | null;
  /** Human readable reason when unavailable; safe to display. */
  reason: string | null;
};

type LocatedBinary = { path: string; source: FfmpegSource };

const PROBE_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 4_000;

let cachedStatus: Promise<FfmpegStatus> | null = null;
let cachedBinary: LocatedBinary | null = null;

function runBinary(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });

    let stdout = "";
    let stderr = "";

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(0, MAX_DIAGNOSTIC_CHARS), stderr: stderr.slice(0, MAX_DIAGNOSTIC_CHARS) });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_DIAGNOSTIC_CHARS) stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_DIAGNOSTIC_CHARS) stderr += chunk.toString();
    });

    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

async function isExecutable(binary: string): Promise<boolean> {
  try {
    await access(binary, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the optional bundled binary.
 *
 * `@ffmpeg-installer/ffmpeg` resolves its platform binary with its own dynamic
 * requires, which bundlers cannot analyse. Resolving it through a runtime
 * `require` keeps it out of the bundle graph (the package is also listed in
 * `serverExternalPackages`); if it is not installed this simply returns null.
 */
function loadBundledInstaller(): { path?: unknown } | null {
  try {
    // Resolve from the application root at runtime: bundler-opaque, and the
    // package stays an ordinary optional dependency.
    const requireFromProject = createRequire(join(process.cwd(), "package.json"));
    return requireFromProject("@ffmpeg-installer/ffmpeg") as { path?: unknown };
  } catch {
    return null;
  }
}

async function locateBundled(): Promise<string | null> {
  const mod = loadBundledInstaller();
  if (!mod) return null;

  const candidate = mod.path;

  if (typeof candidate === "string" && (await isExecutable(candidate))) {
    return candidate;
  }

  return null;
}

async function locate(): Promise<LocatedBinary | null> {
  const configured = getConfig().ffmpegPath;
  if (configured) {
    if (await isExecutable(configured)) return { path: configured, source: "env" };
    return null;
  }

  const onPath = await runBinary("ffmpeg", ["-hide_banner", "-version"], PROBE_TIMEOUT_MS);
  if (onPath.code === 0 && onPath.stdout.toLowerCase().includes("ffmpeg version")) {
    return { path: "ffmpeg", source: "path" };
  }

  const bundled = await locateBundled();
  if (bundled) {
    const probed = await runBinary(bundled, ["-hide_banner", "-version"], PROBE_TIMEOUT_MS);
    if (probed.code === 0) return { path: bundled, source: "bundled" };
  }

  return null;
}

/** Locate and verify FFmpeg. Result is cached for the lifetime of the process. */
export function getFfmpegStatus(): Promise<FfmpegStatus> {
  if (!cachedStatus) {
    cachedStatus = (async (): Promise<FfmpegStatus> => {
      const binary = await locate();
      if (!binary) {
        return {
          available: false,
          source: null,
          version: null,
          reason: "FFmpeg was not found. Set FFMPEG_PATH or install FFmpeg to enable MP3 conversion.",
        };
      }

      const probe = await runBinary(binary.path, ["-hide_banner", "-version"], PROBE_TIMEOUT_MS);
      if (probe.code !== 0 || !probe.stdout.toLowerCase().includes("ffmpeg version")) {
        return { available: false, source: null, version: null, reason: "FFmpeg could not be executed. Check the server configuration." };
      }
      const firstLine = probe.stdout.split("\n")[0]?.trim() ?? "";
      const versionMatch = firstLine.match(/ffmpeg version\s+([^\s]+)/i);

      cachedBinary = binary;

      return {
        available: true,
        source: binary.source,
        version: versionMatch?.[1] ?? null,
        reason: null,
      };
    })();
  }

  return cachedStatus;
}

/** Test hook: forget the probed binary. */
export function resetFfmpegCache(): void {
  cachedStatus = null;
  cachedBinary = null;
}

async function requireBinary(): Promise<string> {
  const status = await getFfmpegStatus();

  if (!status.available) {
    throw new DownloadError(
      "CONVERSION_UNAVAILABLE",
      "MP3 conversion is not available on this server because FFmpeg is not installed.",
    );
  }

  if (cachedBinary) return cachedBinary.path;

  const located = await locate();
  if (!located) {
    cachedStatus = null;
    throw new DownloadError("CONVERSION_UNAVAILABLE", "MP3 conversion is not available on this server.");
  }

  cachedBinary = located;
  return located.path;
}

export type ConvertOptions = {
  signal: AbortSignal;
  timeoutMs?: number;
  bitrate?: string;
  inputFormat?: string;
};

/**
 * Transcode any FFmpeg-readable input into MP3 audio.
 * Rejects with a `DownloadError` on timeout, abort, missing audio, or failure.
 */
export async function convertToMp3(inputPath: string, outputPath: string, options: ConvertOptions): Promise<void> {
  const config = getConfig();
  const timeoutMs = options.timeoutMs ?? config.conversionTimeoutMs;
  const bitrate = options.bitrate ?? config.mp3Bitrate;

  const result = await runConversion(
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-protocol_whitelist", "file,pipe",
      ...(options.inputFormat ? ["-f", options.inputFormat] : []),
      "-i",
      inputPath,
      "-vn",
      "-map",
      "0:a:0?",
      "-c:a",
      "libmp3lame",
      "-b:a",
      bitrate,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-fs", String(config.maxFileSizeBytes + 1),
      "-f",
      "mp3",
      outputPath,
    ],
    options.signal,
    timeoutMs,
  );

  if (options.signal.aborted) {
    throw new DownloadError("CANCELLED", "The download was cancelled.");
  }

  if (result.code !== 0) {
    throw new DownloadError("CONVERSION_FAILED", "Audio conversion failed. The source may not contain a usable audio track.", {
      diagnostic: result.stderr,
    });
  }
}

export type ConvertMp4Options = ConvertOptions & {
  /** Copy streams when possible (faster, lossless) before falling back to transcoding. */
  allowCopy?: boolean;
};

async function runConversion(args: string[], signal: AbortSignal, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  const binary = await requireBinary();

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], shell: false });

    let stderr = "";

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stderr: stderr.slice(0, MAX_DIAGNOSTIC_CHARS) });
    };

    const onAbort = () => {
      child.kill("SIGKILL");
      finish(null);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_DIAGNOSTIC_CHARS) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Repackage/encode a video into a browser-friendly MP4 (H.264/AAC) file.
 * A stream copy is attempted first; if the source codecs are not MP4-friendly
 * the operation falls back to a full transcode.
 */
export async function convertToMp4(inputPath: string, outputPath: string, options: ConvertMp4Options): Promise<void> {
  const config = getConfig();
  const timeoutMs = options.timeoutMs ?? config.conversionTimeoutMs;

  const base = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe", "-i", inputPath];

  if (options.allowCopy !== false) {
    const copyResult = await runConversion(
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-protocol_whitelist", "file,pipe",
        "-i",
        inputPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-fs", String(config.maxFileSizeBytes + 1),
        "-f",
        "mp4",
        outputPath,
      ],
      options.signal,
      timeoutMs,
    );

    if (copyResult.code === 0) return;
  }

  const encodeResult = await runConversion(
    [
      ...base,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-fs", String(config.maxFileSizeBytes + 1),
      "-f",
      "mp4",
      outputPath,
    ],
    options.signal,
    timeoutMs,
  );

  if (options.signal.aborted) {
    throw new DownloadError("CANCELLED", "The download was cancelled.");
  }

  if (encodeResult.code !== 0) {
    throw new DownloadError("CONVERSION_FAILED", "Converting this video to MP4 failed.", {
      diagnostic: encodeResult.stderr,
    });
  }
}
