import { isFfprobeAvailable } from "@/lib/media-processing";
import { getConfig } from "@/lib/config";
import { getFfmpegStatus } from "@/lib/ffmpeg";
import { getConcurrencySnapshot } from "@/lib/concurrency";
import { listSourceHandlers } from "@/lib/source-handlers";
import { youTubeCapability } from "@/lib/platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness probe.
 *
 * Reports only capability information: no filesystem paths, environment
 * variables, hostnames, or version strings of the OS. `mp3` is reported as
 * available only when FFmpeg was actually located and probed.
 */
export async function GET() {
  const ffmpeg = await getFfmpegStatus();
  const config = getConfig();
  const ffprobe = await isFfprobeAvailable();

  return Response.json(
    {
      status: "ok",
      ready: ffprobe,
      capabilities: {
        mp4: ffprobe,
        webm: ffprobe,
        m4a: ffprobe,
        mp3: ffprobe && ffmpeg.available,
        ffprobe: { available: ffprobe },
        ffmpeg: {
          available: ffmpeg.available,
          source: ffmpeg.source,
          version: ffmpeg.version,
          detail: ffmpeg.reason,
        },
      },
      policy: {
        sourcePolicy: config.sourcePolicy,
        youtubeMetadata: youTubeCapability(),
      },
      limits: {
        maxFileSizeMb: Math.round(config.maxFileSizeBytes / (1024 * 1024)),
        maxConcurrentDownloads: config.maxConcurrentJobs,
      },
      sources: listSourceHandlers(),
      jobs: getConcurrencySnapshot(),
    },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
