/**
 * Output format model.
 *
 * A "format" is something this server can actually hand to the browser for a
 * specific source file:
 *
 * - `original` – the upstream bytes already are that container (no re-encode)
 * - `transcode` – FFmpeg produced that container from the upstream bytes
 *
 * Format IDs are stateless and bound to the *content* of the inspected file
 * (SHA-256 digest), so the download endpoint can reject fabricated, stale, or
 * cross-file selections without keeping server-side session state.
 */

import { getConfig } from "@/lib/config";

export const OUTPUT_CONTAINERS = ["mp4", "webm", "m4a", "mp3"] as const;

export type OutputContainer = (typeof OUTPUT_CONTAINERS)[number];

/** MP3 bitrates the UI offers in addition to the configured default. */
export const DEFAULT_MP3_BITRATES = [128, 192, 320] as const;

const MIN_MP3_KBPS = 32;
const MAX_MP3_KBPS = 320;

export type FormatSpec =
  | { kind: "original"; container: OutputContainer }
  | { kind: "transcode"; container: OutputContainer; bitrateKbps?: number };

export type FormatDescriptor = {
  container: OutputContainer;
  contentType: string;
  extension: OutputContainer;
  /** `true` for containers that are also valid video containers. */
  video: boolean;
};

const DESCRIPTORS: Record<OutputContainer, FormatDescriptor> = {
  mp4: { container: "mp4", contentType: "video/mp4", extension: "mp4", video: true },
  webm: { container: "webm", contentType: "video/webm", extension: "webm", video: true },
  m4a: { container: "m4a", contentType: "audio/mp4", extension: "m4a", video: false },
  mp3: { container: "mp3", contentType: "audio/mpeg", extension: "mp3", video: false },
};

export function describeContainer(container: OutputContainer): FormatDescriptor {
  return DESCRIPTORS[container];
}

export function isOutputContainer(value: unknown): value is OutputContainer {
  return typeof value === "string" && (OUTPUT_CONTAINERS as readonly string[]).includes(value);
}

/**
 * MP3 bitrates this deployment may produce: the configured default plus the
 * standard choices. Every value is validated against the MP3/LAME range.
 */
export function allowedMp3Bitrates(): number[] {
  const configured = Number.parseInt(getConfig().mp3Bitrate, 10);
  const values = new Set<number>(DEFAULT_MP3_BITRATES);

  if (Number.isFinite(configured) && configured >= MIN_MP3_KBPS && configured <= MAX_MP3_KBPS) {
    values.add(configured);
  }

  return [...values].sort((a, b) => a - b);
}

/** The bitrate used when the caller does not pick one. */
export function defaultMp3Bitrate(): number {
  return allowedMp3Bitrates()[Math.floor(allowedMp3Bitrates().length / 2)];
}

const FORMAT_ID_PATTERN = /^v1\.([a-f0-9]{64})\.(mp4|webm|m4a|mp3)\.(orig|conv)(?:\.(\d{2,3}))?$/;

/** Build a deterministic, content-bound format id. */
export function encodeFormatId(digest: string, spec: FormatSpec): string {
  const suffix = spec.kind === "original" ? "orig" : "conv";
  const bitrate = spec.kind === "transcode" && spec.container === "mp3" ? `.${spec.bitrateKbps ?? defaultMp3Bitrate()}` : "";

  return `v1.${digest}.${spec.container}.${suffix}${bitrate}`;
}

/**
 * Strictly parse a client-supplied format id. Returns `null` for anything that
 * was not produced by `encodeFormatId`, including unknown containers, invalid
 * bitrates and reversed kind/container combinations.
 */
export function decodeFormatId(id: string): { digest: string; spec: FormatSpec } | null {
  if (typeof id !== "string" || id.length > 128) return null;

  const match = FORMAT_ID_PATTERN.exec(id);
  if (!match) return null;

  const [, digest, container, kind, bitrate] = match;
  const output = container as OutputContainer;

  if (kind === "orig") {
    if (bitrate !== undefined) return null;
    return { digest, spec: { kind: "original", container: output } };
  }

  if (bitrate === undefined) {
    // The only conversion without a bitrate is re-packaging into MP4
    // (e.g. MPEG-TS -> MP4). WebM/M4A are passthrough only.
    return output === "mp4" ? { digest, spec: { kind: "transcode", container: "mp4" } } : null;
  }

  if (output !== "mp3") return null;

  const kbps = Number.parseInt(bitrate, 10);
  if (!Number.isInteger(kbps) || !allowedMp3Bitrates().includes(kbps)) return null;

  return { digest, spec: { kind: "transcode", container: "mp3", bitrateKbps: kbps } };
}

/** Human-readable label, e.g. `MP4 — 1080p` or `MP3 — 192 kbps (converted)`. */
export function formatLabel(input: {
  container: OutputContainer;
  resolution: string | null;
  bitrate: string | null;
  conversion: boolean;
}): string {
  const container = input.container.toUpperCase();
  const detail = input.resolution ?? input.bitrate;

  return detail ? `${container} — ${detail}` : container;
}
