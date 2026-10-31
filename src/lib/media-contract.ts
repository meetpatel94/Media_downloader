/** Shared JSON contract for metadata inspection and verified download options. */

export const MEDIA_CONTAINERS = ["mp4", "webm", "m4a", "mp3"] as const;
export type MediaContainer = (typeof MEDIA_CONTAINERS)[number];

export type MediaFormat = {
  /** Opaque, content-bound id; the download endpoint re-verifies it. */
  id: string;
  container: MediaContainer;
  label: string;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  filesize: number | null;
  bitrate: string | null;
  sourceAudioBitrate: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  /** True only when a real server-side conversion was verified. */
  conversion: boolean;
};

export type MediaInfo = {
  /** True when this endpoint successfully inspected or retrieved metadata. */
  metadataAvailable: boolean;
  /** True iff at least one item in `formats` is actually downloadable. */
  downloadAvailable: boolean;
  /** Backwards-compatible alias for downloadAvailable. */
  downloadSupported: boolean;
  title: string | null;
  duration: number | null;
  thumbnail: string | null;
  sourceType: "direct-media" | "youtube";
  sourceLabel: string;
  author: string | null;
  metadataProvider: string | null;
  formats: MediaFormat[];
  /** Outputs for which conversion has been verified, not merely possible. */
  supportedConversions: MediaContainer[];
  /** User-facing source or deployment constraints. */
  limitations: string[];
  /** Primary limitation, retained for existing clients. */
  limitation: string | null;
  notes: string[];
};
