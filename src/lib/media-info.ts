/**
 * Media inspection + verified format discovery.
 *
 * The server never trusts client metadata: it downloads (or, for metadata-only
 * sources, asks the official API for) real information, probes the actual bytes,
 * and reports only formats it can genuinely produce. A format is advertised as
 * converted only after FFmpeg has actually produced and probed it once.
 *
 * `inspectMedia` is also the download entry point: passing `selection` verifies
 * the requested format against freshly computed metadata and hands back a temp
 * artifact plus a single-use cleanup function.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "@/lib/config";
import { acquireSlot, type Slot } from "@/lib/concurrency";
import { validateMediaUrl } from "@/lib/download-validation";
import { DownloadError } from "@/lib/errors";
import { getFfmpegStatus } from "@/lib/ffmpeg";
import type { MediaContainer, MediaFormat, MediaInfo } from "@/lib/media-contract";
export type { MediaFormat, MediaInfo } from "@/lib/media-contract";
import {
  allowedMp3Bitrates,
  decodeFormatId,
  defaultMp3Bitrate,
  encodeFormatId,
  formatLabel,
  type FormatSpec,
  type OutputContainer,
} from "@/lib/formats";
import {
  bitrateLabel,
  fileSize,
  filenameForUrl,
  probeMediaFile,
  produceOutput,
  resolutionLabel,
  summarizeProbe,
  type ProbeStream,
} from "@/lib/media-processing";
import { containerKind, type Container } from "@/lib/media-inspect";
import { getSourceHandler } from "@/lib/source-handlers";

export type DownloadArtifact = {
  filePath: string;
  filename: string;
  contentType: string;
  size: number;
  cleanup: () => Promise<void>;
};

export type InspectionSelection = { id: string; output: OutputContainer };

const SOURCE_TYPE: Record<string, MediaInfo["sourceType"]> = {
  direct: "direct-media",
  platform: "youtube",
};

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

type CandidateArgs = {
  digest: string;
  container: Container;
  video: ProbeStream | undefined;
  audio: ProbeStream | undefined;
  sourceSize: number;
  ffmpegAvailable: boolean;
  /** Whether an MP3 encode for this file actually succeeded (or was not attempted). */
  mp3Supported: boolean;
  /** Result of an actual MP3 encode performed during this inspection. */
  verifiedMp3: { bitrateKbps: number; size: number } | null;
};

/**
 * Build the list of formats this source can actually produce.
 *
 * Rules:
 * - a container is offered as `original` only when the downloaded bytes are
 *   already that container (webm is never re-labelled as mp4, and an MP4 is
 *   never re-labelled as MP3). Any supported container qualifies, including
 *   audio-only MP4/WebM files, because those bytes are still a real download;
 * - MP3 conversions are offered only when FFmpeg is present *and* the source
 *   has an audio stream;
 * - the default MP3 variant carries the real size of an encode that actually
 *   succeeded; other bitrates are honest `filesize: null` variants that are
 *   encoded and re-probed at download time;
 * - source resolution and bitrate are reported as-is; transcoding never claims
 *   higher quality than the source.
 */
function buildFormats(args: CandidateArgs): MediaFormat[] {
  const formats: MediaFormat[] = [];
  const resolution = resolutionLabel(args.video);
  const sourceAudioBitrate = bitrateLabel(args.audio?.bit_rate);
  const base = {
    resolution,
    videoCodec: args.video?.codec_name ?? null,
    audioCodec: args.audio?.codec_name ?? null,
    hasVideo: Boolean(args.video),
    hasAudio: Boolean(args.audio),
    sourceAudioBitrate,
  };

  const push = (format: Omit<MediaFormat, "label">) => {
    formats.push({ ...format, label: formatLabel(format) });
  };

  /**
   * The upstream file itself can always be served byte-for-byte when its
   * container maps to a supported output. This is deliberately independent of
   * which streams were probed: an audio-only MP4/WebM is still a real MP4/WebM
   * file, and previously it had no passthrough option at all.
   */
  const passthrough: OutputContainer | null =
    args.container === "aac"
      ? "m4a"
      : args.container === "mp4" || args.container === "webm" || args.container === "mp3"
        ? args.container
        : null;

  if (passthrough && (args.video || args.audio)) {
    push({
      ...base,
      id: encodeFormatId(args.digest, { kind: "original", container: passthrough }),
      container: passthrough,
      filesize: args.sourceSize,
      // A passthrough file's bitrate is the bitrate of the stream it carries.
      bitrate: bitrateLabel(args.video?.bit_rate ?? args.audio?.bit_rate),
      conversion: false,
    });
  } else if (args.video && args.ffmpegAvailable && containerKind(args.container) === "video") {
    // e.g. MPEG-TS: re-package/encode into an MP4 that browsers can play.
    push({
      ...base,
      id: encodeFormatId(args.digest, { kind: "transcode", container: "mp4" }),
      container: "mp4",
      filesize: null,
      bitrate: null,
      conversion: true,
    });
  }

  if (args.audio) {
    if (args.ffmpegAvailable && args.mp3Supported && args.container !== "mp3") {
      for (const bitrateKbps of allowedMp3Bitrates()) {
        const verified = args.verifiedMp3?.bitrateKbps === bitrateKbps ? args.verifiedMp3 : null;

        push({
          id: encodeFormatId(args.digest, { kind: "transcode", container: "mp3", bitrateKbps }),
          container: "mp3",
          resolution: null,
          videoCodec: null,
          audioCodec: "mp3",
          filesize: verified?.size ?? null,
          bitrate: `${bitrateKbps}k`,
          sourceAudioBitrate,
          hasVideo: false,
          hasAudio: true,
          conversion: true,
        });
      }
    }
  }

  return formats;
}

function formatSpecOf(id: string): FormatSpec | null {
  return decodeFormatId(id)?.spec ?? null;
}

/** Trim, drop blanks and remove repeats while preserving order. */
function uniqueMessages(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const messages: string[] = [];

  for (const value of values) {
    const message = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!message || seen.has(message)) continue;

    seen.add(message);
    messages.push(message);
  }

  return messages;
}

/**
 * Inspect a URL. With `selection`, also produce the selected format and return
 * the artifact; otherwise only metadata is returned and all temp files removed.
 */
export async function inspectMedia(
  rawUrl: string,
  signal: AbortSignal,
  selection?: InspectionSelection,
): Promise<{ media: MediaInfo; artifact?: DownloadArtifact }> {
  const validated = validateMediaUrl(rawUrl);

  if (!validated.ok) {
    throw new DownloadError(validated.code, validated.message);
  }

  const handler = getSourceHandler(validated.source);
  const capabilities = handler.capabilities();

  if (selection) {
    if (!capabilities.download.supported) {
      throw new DownloadError(
        "UNSUPPORTED_SOURCE",
        capabilities.download.reason ?? "This source cannot be downloaded by this deployment.",
      );
    }
  } else if (!capabilities.metadata.supported) {
    throw new DownloadError(
      "UNSUPPORTED_SOURCE",
      capabilities.metadata.reason ?? "This source cannot be inspected by this deployment.",
    );
  }

  const config = getConfig();
  const slot: Slot = await acquireSlot(signal);
  let workDir: string | undefined;
  let handedOff = false;

  try {
    workDir = await mkdtemp(join(tmpdir(), "media-downloader-"));
    const directory = workDir;

    const inspection = await handler.inspect({
      url: validated.url,
      source: validated.source,
      signal,
      workDir: directory,
    });

    const sourceType = SOURCE_TYPE[validated.source.kind] ?? "direct-media";

    // Metadata-only source (e.g. YouTube): report what the official API knows
    // and state plainly that the media itself cannot be downloaded. The reason
    // is published once, as a limitation; `notes` only carries anything extra,
    // so clients cannot render the same explanation twice.
    if (!inspection.media) {
      const messages = uniqueMessages(inspection.notes);
      const limitation = messages[0] ?? null;

      const media: MediaInfo = {
        metadataAvailable: true,
        downloadAvailable: false,
        downloadSupported: false,
        title: inspection.metadata.title,
        duration: inspection.metadata.duration,
        thumbnail: inspection.metadata.thumbnail,
        sourceType,
        sourceLabel: handler.label,
        author: inspection.metadata.author,
        metadataProvider: inspection.metadata.provider,
        formats: [],
        supportedConversions: [],
        limitations: limitation ? [limitation] : [],
        limitation,
        notes: messages.slice(1),
      };

      return { media };
    }

    const result = inspection.media;
    const probe = await probeMediaFile(result.sourcePath, result.container, signal);
    const { video, audio, duration, title } = summarizeProbe(probe);

    if (!video && !audio) {
      throw new DownloadError("NOT_MEDIA", "No usable audio or video streams were found in that file.");
    }

    const sourceSize = await fileSize(result.sourcePath, config.maxFileSizeBytes);
    const digest = await digestFile(result.sourcePath);
    const ffmpeg = await getFfmpegStatus();
    const notes = [...inspection.notes];

    const selectionSpec = selection ? formatSpecOf(selection.id) : undefined;
    const wantMp3 =
      Boolean(audio) && ffmpeg.available && result.container !== "mp3" &&
      (!selection || selectionSpec?.container === "mp3");

    let verifiedMp3: { bitrateKbps: number; size: number } | null = null;
    let preview: { bitrateKbps: number; produced: Awaited<ReturnType<typeof produceOutput>> } | null = null;
    let conversionError: unknown;

    if (wantMp3) {
      const bitrateKbps =
        selectionSpec?.kind === "transcode" && selectionSpec.container === "mp3"
          ? (selectionSpec.bitrateKbps ?? defaultMp3Bitrate())
          : defaultMp3Bitrate();

      try {
        const produced = await produceOutput({
          sourcePath: result.sourcePath,
          sourceContainer: result.container,
          spec: { kind: "transcode", container: "mp3", bitrateKbps },
          workDir: directory,
          signal,
        });

        verifiedMp3 = { bitrateKbps, size: produced.size };
        preview = { bitrateKbps, produced };
      } catch (error) {
        if (signal.aborted) throw error;

        conversionError = error;

        // A requested conversion must fail loudly instead of silently vanishing.
        if (selectionSpec?.container === "mp3") throw error;
      }
    }

    if (!ffmpeg.available) {
      notes.push(
        `MP3 conversion is unavailable on this server: ${ffmpeg.reason ?? "FFmpeg was not found."}`,
      );
    } else if (conversionError instanceof DownloadError) {
      notes.push(`MP3 conversion failed for this file: ${conversionError.message}`);
    }

    // If the verification encode ran and failed, MP3 must not be advertised:
    // only formats this server can genuinely produce are offered.
    const mp3Supported = verifiedMp3 !== null || !wantMp3;

    const formats = buildFormats({
      digest,
      container: result.container,
      video,
      audio,
      sourceSize,
      ffmpegAvailable: ffmpeg.available,
      mp3Supported,
      verifiedMp3,
    });

    const limitation =
      formats.length === 0
        ? ffmpeg.available
          ? "No downloadable format could be produced from this file."
          : "Only MP3 conversion could add a format here, and FFmpeg is not installed on this server."
        : null;
    const media: MediaInfo = {
      metadataAvailable: true,
      downloadAvailable: formats.length > 0,
      downloadSupported: formats.length > 0,
      title: inspection.metadata.title ?? title,
      duration: inspection.metadata.duration ?? duration,
      thumbnail: inspection.metadata.thumbnail,
      sourceType,
      sourceLabel: handler.label,
      author: inspection.metadata.author,
      metadataProvider: inspection.metadata.provider,
      formats,
      supportedConversions: [...new Set(formats.filter((format) => format.conversion).map((format) => format.container))] as MediaContainer[],
      limitations: limitation ? [limitation] : [],
      limitation,
      notes,
    };

    if (selection) {
      const selected = formats.find((format) => format.id === selection.id && format.container === selection.output);

      if (!selected || !selectionSpec) {
        throw new DownloadError(
          "INVALID_FORMAT",
          "That format is not available for this media, or the file changed. Fetch media information again.",
        );
      }

      // Re-use the verified preview when the selection is that same encode.
      const reusePreview =
        selectionSpec.kind === "transcode" &&
        selectionSpec.container === "mp3" &&
        preview !== null &&
        preview.bitrateKbps === selectionSpec.bitrateKbps;

      const produced = reusePreview
        ? preview!.produced
        : await produceOutput({
            sourcePath: result.sourcePath,
            sourceContainer: result.container,
            spec: selectionSpec,
            workDir: directory,
            signal,
          });

      const artifact: DownloadArtifact = {
        filePath: produced.filePath,
        filename: filenameForUrl(result.finalUrl, produced.container),
        contentType: produced.contentType,
        size: produced.size,
        cleanup: async () => {
          try {
            await rm(directory, { recursive: true, force: true });
          } finally {
            slot.release();
          }
        },
      };

      handedOff = true;
      return { media, artifact };
    }

    return { media };
  } finally {
    if (!handedOff) {
      slot.release();

      if (workDir) {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
