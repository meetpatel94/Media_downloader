/**
 * Real (tiny) media fixtures generated with the installed FFmpeg binary.
 *
 * The suite never ships binary blobs in the repository and never fabricates
 * media bytes: inspection and conversion are exercised against files FFmpeg
 * actually encoded, so ffprobe results are genuine.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FixtureKind =
  | "av-mp4"
  | "video-webm"
  | "audio-m4a"
  | "audio-mp3"
  | "audio-mp4"
  | "audio-webm"
  | "av-mpegts";

const cache = new Map<FixtureKind, Uint8Array>();
let ffmpegBinary: string | null = null;

async function binary(): Promise<string | null> {
  if (ffmpegBinary) return ffmpegBinary;

  try {
    const installer = (await import("@ffmpeg-installer/ffmpeg")) as unknown as { path: string };
    ffmpegBinary = installer.path;
    return ffmpegBinary;
  } catch {
    return null;
  }
}

export async function ffmpegAvailable(): Promise<boolean> {
  return (await binary()) !== null;
}

function run(bin: string, args: string[]): void {
  const result = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`fixture generation failed: ${result.stderr || result.error?.message}`);
  }
}

const VIDEO = ["-f", "lavfi", "-i", "testsrc=size=128x96:rate=10:duration=1.5"];
const AUDIO = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1.5"];

/**
 * Returns the requested fixture, generating it once per process. Throws when
 * the installed FFmpeg cannot produce that container.
 */
export async function mediaFixture(kind: FixtureKind): Promise<Uint8Array> {
  const cached = cache.get(kind);
  if (cached) return cached;

  const bin = await binary();
  if (!bin) throw new Error("FFmpeg is not available, so media fixtures cannot be generated.");

  const dir = await mkdtemp(join(tmpdir(), "media-fixture-"));

  try {
    const output = join(dir, kind);

    switch (kind) {
      case "av-mp4":
        run(bin, [...VIDEO, ...AUDIO, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", "-f", "mp4", output]);
        break;
      case "video-webm":
        run(bin, [...VIDEO, "-c:v", "libvpx", "-b:v", "200k", "-an", "-f", "webm", output]);
        break;
      case "audio-m4a":
        run(bin, [...AUDIO, "-c:a", "aac", "-b:a", "96k", "-f", "ipod", output]);
        break;
      case "audio-mp3":
        run(bin, [...AUDIO, "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", output]);
        break;
      case "audio-mp4":
        // An MP4 container that carries audio only (`ftypisom`, no video track).
        run(bin, [...AUDIO, "-c:a", "aac", "-b:a", "96k", "-f", "mp4", output]);
        break;
      case "audio-webm":
        // A WebM container that carries audio only.
        run(bin, [...AUDIO, "-c:a", "libopus", "-b:a", "64k", "-f", "webm", output]);
        break;
      case "av-mpegts":
        run(bin, [...VIDEO, ...AUDIO, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mpegts", output]);
        break;
    }

    const bytes = new Uint8Array(await readFile(output));
    cache.set(kind, bytes);
    return bytes;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Probe a local file with the installed ffprobe (used for assertions). */
export async function probeWithFfprobe(path: string): Promise<{ streams?: Array<{ codec_type?: string; codec_name?: string; bit_rate?: string; height?: number }>; format?: { duration?: string } }> {
  const { spawnSync: spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const probePath = (
    createRequire(join(process.cwd(), "package.json"))("@ffprobe-installer/ffprobe") as { path: string }
  ).path;

  const result = spawn(probePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,bit_rate,height:format=duration", "-of", "json", path], { encoding: "utf8" });

  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);

  return JSON.parse(result.stdout);
}
