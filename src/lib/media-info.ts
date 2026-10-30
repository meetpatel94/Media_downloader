import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Container } from "@/lib/media-inspect";
import { acquireSlot } from "@/lib/concurrency";
import { getConfig } from "@/lib/config";
import { validateMediaUrl } from "@/lib/download-validation";
import { DownloadError } from "@/lib/errors";
import { convertToMp3, getFfmpegStatus } from "@/lib/ffmpeg";
import { getSourceHandler } from "@/lib/source-handlers";
import { filenameForUrl, type DownloadArtifact } from "@/lib/download-service";

type Stream = { codec_type?: string; codec_name?: string; width?: number; height?: number; bit_rate?: string; disposition?: { attached_pic?: number } };
type Probe = { streams?: Stream[]; format?: { duration?: string; tags?: { title?: string } } };
export type MediaFormat = { id: string; container: "mp4" | "mp3"; resolution: string | null; videoCodec: string | null; audioCodec: string | null; filesize: number | null; hasVideo: boolean; hasAudio: boolean; bitrate: string | null; conversion: boolean };
export type MediaInfo = { title: string | null; duration: number | null; thumbnail: null; sourceType: "direct-media"; formats: MediaFormat[] };

function probeBinary(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try { return (createRequire(join(process.cwd(), "package.json"))("@ffprobe-installer/ffprobe") as { path: string }).path; } catch { return "ffprobe"; }
}
export async function isFfprobeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(probeBinary(), ["-version"], { stdio: "ignore", shell: false });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, 5000);
    child.on("error", () => finish(false)); child.on("close", (code) => finish(code === 0));
  });
}
const demuxer: Partial<Record<Container, string>> = { mp4: "mov", aac: "mov", webm: "matroska", "mpeg-ts": "mpegts", mp3: "mp3", ogg: "ogg", wav: "wav", flac: "flac" };
async function probe(path: string, signal: AbortSignal, container: Container): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const child = spawn(probeBinary(), ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer[container] || "invalid", "-show_entries", "stream=codec_type,codec_name,width,height,bit_rate:stream_disposition=attached_pic:format=duration:format_tags=title", "-of", "json", path], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let done = false;
    const finish = (error?: DownloadError) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(output) as Probe); } catch { reject(new DownloadError("NOT_MEDIA", "Media metadata could not be read.")); }
    };
    const abort = () => { child.kill("SIGKILL"); finish(new DownloadError("CANCELLED", "The request was cancelled.")); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new DownloadError("UPSTREAM_TIMEOUT", "Media inspection timed out.")); }, getConfig().conversionTimeoutMs);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 100_000) { child.kill("SIGKILL"); finish(new DownloadError("NOT_MEDIA", "Media metadata is too large.")); } });
    child.on("error", () => finish(new DownloadError("CONVERSION_UNAVAILABLE", "Media inspection requires ffprobe. Install FFmpeg and ffprobe on the server.")));
    child.on("close", (code) => finish(code === 0 ? undefined : new DownloadError("NOT_MEDIA", "Media metadata could not be read. The file may be invalid or use an unsupported codec.")));
  });
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Downloads and probes actual bytes on every request; no client metadata or persistent cache is trusted. */
export async function inspectMedia(url: string, signal: AbortSignal, selection?: { id: string; output: string }): Promise<{ media: MediaInfo; artifact?: DownloadArtifact }> {
  const validated = validateMediaUrl(url);
  if (!validated.ok) throw new DownloadError(validated.code, validated.message);
  const slot = await acquireSlot(signal);
  let dir: string | undefined;
  let handedOff = false;
  try {
    dir = await mkdtemp(join(tmpdir(), "media-downloader-"));
    const workDir = dir;
    const result = await getSourceHandler(validated.source).download({ url: validated.url, source: validated.source, format: "mp3", signal, workDir });
    const metadata = await probe(result.sourcePath, signal, result.container);
    const video = metadata.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
    const audio = metadata.streams?.find((s) => s.codec_type === "audio");
    if (!video && !audio) throw new DownloadError("NOT_MEDIA", "No usable audio or video streams were found.");
    const size = (await stat(result.sourcePath)).size;
    const hash = await digest(result.sourcePath);
    const base = { resolution: video?.height ? `${video.height}p` : null, videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null, hasVideo: !!video, hasAudio: !!audio };
    const formats: MediaFormat[] = [];
    if (result.container === "mp4" && video) formats.push({ ...base, id: `${hash}:mp4`, container: "mp4", filesize: size, bitrate: null, conversion: false });
    if (result.container === "mp3" && audio?.codec_name === "mp3") formats.push({ ...base, id: `${hash}:mp3`, container: "mp3", filesize: size, bitrate: audio.bit_rate ? `${Math.round(Number(audio.bit_rate) / 1000)}k` : null, conversion: false });
    // Only advertise a conversion after actually producing and probing it.
    let converted: string | undefined;
    if (audio && result.container !== "mp3" && (await getFfmpegStatus()).available) {
      converted = join(workDir, "preview.mp3");
      try {
        await convertToMp3(result.sourcePath, converted, { signal, inputFormat: demuxer[result.container] });
        const convertedSize = (await stat(converted)).size;
        if (!convertedSize || convertedSize > getConfig().maxFileSizeBytes) throw new DownloadError("TOO_LARGE", "Converted media exceeds the size limit.");
        const convertedProbe = await probe(converted, signal, "mp3");
        const track = convertedProbe.streams?.find((s) => s.codec_type === "audio" && s.codec_name === "mp3");
        if (track) formats.push({ id: `${hash}:mp3`, container: "mp3", resolution: null, videoCodec: null, audioCodec: "mp3", filesize: convertedSize, hasVideo: false, hasAudio: true, bitrate: track.bit_rate ? `${Math.round(Number(track.bit_rate) / 1000)}k` : null, conversion: true });
      } catch (error) {
        if (signal.aborted) throw error;
        if (selection?.output === "mp3") throw error;
        converted = undefined;
      }
    }
    const duration = Number(metadata.format?.duration);
    const media: MediaInfo = { title: typeof metadata.format?.tags?.title === "string" ? metadata.format.tags.title.slice(0, 500) : null, duration: Number.isFinite(duration) && duration > 0 ? duration : null, thumbnail: null, sourceType: "direct-media", formats };
    if (selection) {
      const selected = formats.find((f) => f.id === selection.id && f.container === selection.output);
      if (!selected) throw new DownloadError("INVALID_FORMAT", "That format is no longer available. Fetch media information again.");
      const filePath = selected.conversion ? converted! : result.sourcePath;
      const artifact: DownloadArtifact = { filePath, filename: filenameForUrl(result.finalUrl, selected.container), contentType: selected.container === "mp4" ? "video/mp4" : "audio/mpeg", size: (await stat(filePath)).size, cleanup: async () => { try { await rm(workDir, { recursive: true, force: true }); } finally { slot.release(); } } };
      handedOff = true;
      return { media, artifact };
    }
    if (!formats.length) throw new DownloadError("FORMAT_UNAVAILABLE", "No downloadable MP4 or MP3 formats are available for this file. MP3 conversion requires FFmpeg with libmp3lame.");
    return { media };
  } finally {
    if (!handedOff) { slot.release(); if (dir) await rm(dir, { recursive: true, force: true }); }
  }
}
