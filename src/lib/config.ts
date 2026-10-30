/**
 * Runtime configuration for the media downloader.
 *
 * Every value is read from the environment on demand so that tests and
 * deployments can change them without module-load ordering surprises.
 * Defaults are intentionally conservative: bounded memory, bounded time,
 * and bounded concurrency.
 */

const MEGABYTE = 1024 * 1024;

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(parsed, min), max);
}

function readHostList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];

  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/\.$/, ""))
    .filter((value) => /^[a-z0-9.-]+$/.test(value) && value.includes("."))
    .filter((value) => !value.startsWith(".") && !value.endsWith("."))
    .slice(0, 50);
}

export type AppConfig = {
  /** Hard cap for a single downloaded/converted file. */
  maxFileSizeBytes: number;
  /** Deadline for connect + response headers of one upstream request. */
  requestTimeoutMs: number;
  /** Deadline for streaming one upstream response body. */
  downloadTimeoutMs: number;
  /** Deadline for one FFmpeg conversion. */
  conversionTimeoutMs: number;
  /** Max concurrent download + conversion jobs per server instance. */
  maxConcurrentJobs: number;
  /** Max number of jobs allowed to wait for a slot before returning 503. */
  maxQueuedJobs: number;
  /** Max redirects followed while resolving a media URL. */
  maxRedirects: number;
  /** Target bitrate for transcoded MP3 audio. */
  mp3Bitrate: string;
  /** Additional explicitly supported direct-media hosts. */
  extraHosts: string[];
  /** Absolute path to an FFmpeg binary (optional). */
  ffmpegPath: string | null;
};

export function getConfig(): AppConfig {
  return {
    maxFileSizeBytes: readInt("MEDIA_DOWNLOADER_MAX_FILE_MB", 50, 1, 512) * MEGABYTE,
    requestTimeoutMs: readInt("MEDIA_DOWNLOADER_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
    downloadTimeoutMs: readInt("MEDIA_DOWNLOADER_DOWNLOAD_TIMEOUT_MS", 120_000, 5_000, 900_000),
    conversionTimeoutMs: readInt("MEDIA_DOWNLOADER_CONVERSION_TIMEOUT_MS", 120_000, 5_000, 900_000),
    maxConcurrentJobs: readInt("MEDIA_DOWNLOADER_MAX_CONCURRENCY", 2, 1, 16),
    maxQueuedJobs: readInt("MEDIA_DOWNLOADER_MAX_QUEUE", 20, 0, 200),
    maxRedirects: readInt("MEDIA_DOWNLOADER_MAX_REDIRECTS", 5, 0, 10),
    mp3Bitrate: process.env.MEDIA_DOWNLOADER_MP3_BITRATE?.trim() || "192k",
    extraHosts: readHostList("MEDIA_DOWNLOADER_EXTRA_HOSTS"),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || null,
  };
}
