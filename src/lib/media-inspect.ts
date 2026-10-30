/**
 * Media sniffing helpers.
 *
 * Content-Type headers and file extensions are attacker-controlled hints, so the
 * first bytes of every download are inspected before the file is considered
 * valid media. This is what prevents "HTML error page named video.mp4".
 */

export type Container = "mp4" | "webm" | "mpeg-ts" | "mp3" | "ogg" | "wav" | "flac" | "aac" | "html" | "unknown";

const SNIFF_BYTES = 64;

export function sniffContainer(bytes: Uint8Array): Container {
  const head = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));

  if (head.length >= 12) {
    const boxType = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (boxType === "ftyp") {
      const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
      if (brand.startsWith("M4A") || brand.startsWith("M4B")) return "aac";
      return "mp4";
    }
  }

  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "webm";
  }

  if (head.length >= 3 && String.fromCharCode(head[0], head[1], head[2]) === "ID3") {
    return "mp3";
  }

  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return "mp3";
  }

  if (head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
    return "ogg";
  }

  if (head.length >= 4 && String.fromCharCode(head[0], head[1], head[2], head[3]) === "RIFF") {
    return "wav";
  }

  if (head.length >= 4 && String.fromCharCode(head[0], head[1], head[2], head[3]) === "fLaC") {
    return "flac";
  }

  if (head.length >= 1 && head[0] === 0x47) {
    return "mpeg-ts";
  }

  const text = Buffer.from(head).toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<!doctype") || text.startsWith("<html") || text.startsWith("<?xml") || text.startsWith("<")) {
    return "html";
  }

  return "unknown";
}

export type MediaKind = "video" | "audio" | "unknown";

export function contentTypeKind(contentType: string): MediaKind {
  const value = contentType.split(";")[0].trim().toLowerCase();
  if (value.startsWith("video/")) return "video";
  if (value.startsWith("audio/")) return "audio";
  return "unknown";
}

export function containerKind(container: Container): MediaKind {
  switch (container) {
    case "mp4":
    case "webm":
    case "mpeg-ts":
      return "video";
    case "mp3":
    case "ogg":
    case "wav":
    case "flac":
    case "aac":
      return "audio";
    default:
      return "unknown";
  }
}

/** True when the sniffed container can be turned into MP4 video without a re-encode. */
export function isMp4CompatibleVideo(container: Container): boolean {
  return container === "mp4";
}

/** True when the sniffed container is already MP3 audio. */
export function isMp3Audio(container: Container): boolean {
  return container === "mp3";
}

/** Containers FFmpeg can read from a local file. */
export function isConvertible(container: Container): boolean {
  return ["mp4", "webm", "mpeg-ts", "mp3", "ogg", "wav", "flac", "aac"].includes(container);
}
