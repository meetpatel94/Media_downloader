"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MediaContainer, MediaFormat, MediaInfo } from "@/lib/media-contract";

type OutputContainer = MediaContainer;
type StatusTone = "idle" | "error" | "success" | "loading";
type BusyAction = "info" | "download" | null;

type Status = { tone: StatusTone; message: string };

export type Format = MediaFormat;
export type Media = MediaInfo;

const IDLE_STATUS: Status = { tone: "idle", message: "" };

const CONTAINER_ORDER: OutputContainer[] = ["mp4", "webm", "m4a", "mp3"];

const NO_FORMAT_MESSAGE = "No downloadable formats are available for this source.";

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Collapse whitespace, drop blanks and remove repeats while preserving the
 * server's order. A single, de-duplicated list is what keeps one limitation
 * from being shown twice.
 */
export function uniqueMessages(values: Array<string | null | undefined> | null | undefined): string[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const messages: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;

    const message = value.replace(/\s+/g, " ").trim();
    if (!message || seen.has(message)) continue;

    seen.add(message);
    messages.push(message);
  }

  return messages;
}

/**
 * The formats the UI may offer. The backend only sends formats it has verified,
 * and `downloadAvailable` must also agree; a format list without downloadable
 * media must never produce a button.
 */
export function downloadableFormats(media: Media | null | undefined): Format[] {
  if (!media || media.downloadAvailable === false || !Array.isArray(media.formats)) return [];

  return media.formats.filter(
    (format) =>
      Boolean(format) &&
      typeof format.id === "string" &&
      format.id.length > 0 &&
      CONTAINER_ORDER.includes(format.container),
  );
}

/** Source/deployment limitations, de-duplicated (legacy `limitation` included). */
export function mediaLimitations(media: Media | null | undefined): string[] {
  if (!media) return [];

  return uniqueMessages([...(Array.isArray(media.limitations) ? media.limitations : []), media.limitation]);
}

/** Supplementary notes that are not already shown as limitations. */
export function mediaNotes(media: Media | null | undefined): string[] {
  if (!media) return [];

  const limitations = new Set(mediaLimitations(media));

  return uniqueMessages(Array.isArray(media.notes) ? media.notes : []).filter((note) => !limitations.has(note));
}

/** Read the RFC 6266 filename, preferring the UTF-8 encoded variant. */
export function filenameFromDisposition(disposition: string | null, format: OutputContainer): string {
  const fallback = `media-download.${format}`;
  if (!disposition) return fallback;

  const extended = disposition.match(/filename\*\s*=\s*([^;]+)/i);

  if (extended?.[1]) {
    const value = extended[1].trim().replace(/^"|"$/g, "");
    const encoded = value.includes("''") ? value.split("''").slice(1).join("''") : value;

    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.trim()) return decoded.trim();
    } catch {
      // fall through to the plain filename
    }
  }

  const plain = disposition.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i);
  const candidate = (plain?.[1] ?? plain?.[2] ?? "").trim();

  return candidate || fallback;
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Give the browser time to start the download before releasing the blob URL.
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 60_000);
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "size unavailable";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Quality label within one container group. */
function qualityLabel(format: Format): string {
  if (format.resolution) return format.resolution;
  if (format.bitrate) return `${format.bitrate}${format.conversion ? " (converted)" : ""}`;
  return format.conversion ? "converted" : "original";
}

/** Group the server-provided formats by container, preserving server order. */
export function groupFormats(formats: Format[]): Array<{ container: OutputContainer; formats: Format[]; conversion: boolean }> {
  const groups = new Map<string, { container: OutputContainer; formats: Format[]; conversion: boolean }>();

  for (const format of formats) {
    const key = groupKeyOf(format);
    const existing = groups.get(key);

    if (existing) existing.formats.push(format);
    else groups.set(key, { container: format.container, formats: [format], conversion: format.conversion });
  }

  return [...groups.values()].sort(
    (a, b) => CONTAINER_ORDER.indexOf(a.container) - CONTAINER_ORDER.indexOf(b.container),
  );
}

function groupLabel(group: ReturnType<typeof groupFormats>[number]): string {
  const container = group.container.toUpperCase();
  return group.conversion ? `${container} — converted` : `${container} — original file`;
}

function streamSummary(format: Format): string {
  const streams = format.hasVideo && format.hasAudio ? "Audio and video" : format.hasVideo ? "Video only" : "Audio only";

  return `${streams}${format.conversion ? ", converted on the server" : ", original file"}`;
}

export function DownloaderForm() {
  const [url, setUrl] = useState("");
  const [media, setMedia] = useState<Media | null>(null);
  const [groupKey, setGroupKey] = useState("");
  const [formatId, setFormatId] = useState("");
  const [status, setStatus] = useState<Status>(IDLE_STATUS);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = busyAction !== null;

  // Only server-verified, genuinely downloadable formats reach the UI.
  const formats = useMemo(() => downloadableFormats(media), [media]);
  const limitations = useMemo(() => mediaLimitations(media), [media]);
  const notes = useMemo(() => mediaNotes(media), [media]);

  const groups = useMemo(() => groupFormats(formats), [formats]);
  const activeGroup = groups.find((group) => groupKeyOf(group) === groupKey) ?? groups[0];
  const selectedFormat = activeGroup?.formats.find((format) => format.id === formatId) ?? activeGroup?.formats[0];

  const field =
    "block w-full min-w-0 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 disabled:bg-slate-100";
  const button =
    "flex min-h-12 w-full items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-400 disabled:bg-slate-400";

  function resetSelection(next: Media) {
    const first = groupFormats(downloadableFormats(next))[0];

    setGroupKey(first ? groupKeyOf(first) : "");
    setFormatId(first?.formats[0]?.id ?? "");
  }

  function selectGroup(key: string) {
    const group = groups.find((item) => groupKeyOf(item) === key);
    setGroupKey(key);
    setFormatId(group?.formats[0]?.id ?? "");
  }

  async function run(action: "info" | "download") {
    if (inFlight.current) return;

    const value = url.trim();

    if (!value || !parseHttpUrl(value)) {
      setStatus({
        tone: "error",
        message: value ? "Please enter a valid http:// or https:// URL." : "Please paste a media URL.",
      });
      return;
    }

    if (action === "download" && !selectedFormat) {
      setStatus({ tone: "error", message: "Fetch media information and choose a verified format first." });
      return;
    }

    if (action === "info") {
      setMedia(null);
      setGroupKey("");
      setFormatId("");
    }

    inFlight.current = true;
    setBusyAction(action);
    setStatus({ tone: "loading", message: action === "info" ? "Inspecting media…" : "Preparing download…" });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(action === "info" ? "/api/media-info" : "/api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "info"
            ? { url: value }
            : { url: value, formatId: selectedFormat!.id, outputFormat: selectedFormat!.container },
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Request failed. Please try again.",
        );
      }

      if (action === "info") {
        const payload = await response.json();

        if (!payload.success || !payload.media || !Array.isArray(payload.media.formats)) {
          throw new Error("The server returned invalid media information.");
        }

        const next = payload.media as Media;
        setMedia(next);
        resetSelection(next);

        // The status line only reports the *operation*. Source limitations are
        // rendered once, inside the media card, so they are never repeated here.
        setStatus({
          tone: "success",
          message: downloadableFormats(next).length
            ? "Media information ready. Choose a format and download."
            : "Media information ready.",
        });
      } else {
        const type = response.headers.get("content-type") ?? "";

        if (!type.startsWith("audio/") && !type.startsWith("video/")) {
          throw new Error("The server did not return a media file.");
        }

        const blob = await response.blob();

        if (!blob.size) throw new Error("The server returned an empty file.");

        const filename = filenameFromDisposition(response.headers.get("content-disposition"), selectedFormat!.container);
        triggerBrowserDownload(blob, filename);
        setStatus({ tone: "success", message: `Download started: ${filename}` });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;

      setStatus({
        tone: "error",
        message:
          error instanceof Error && !(error instanceof TypeError) && error.message
            ? error.message
            : "Network request failed or was interrupted. Please try again.",
      });
    } finally {
      inFlight.current = false;
      setBusyAction(null);
      abortRef.current = null;
    }
  }

  return (
    <form
      className="space-y-5 sm:space-y-6"
      noValidate
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void run("info");
      }}
    >
      <div className="space-y-2">
        <label htmlFor="media-url" className="block text-sm font-medium text-slate-800">
          Media URL
        </label>
        <textarea
          id="media-url"
          rows={4}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setMedia(null);
            setGroupKey("");
            setFormatId("");
            setStatus(IDLE_STATUS);
          }}
          placeholder="https://example.com/video.mp4"
          className={field + " resize-y break-all"}
          aria-describedby="download-status"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          disabled={busy}
        />
        <p className="break-words text-xs text-slate-500">
          Paste a direct media link (.mp4, .webm, .m4a, .mp3) or a supported platform video URL to read its
          metadata.
        </p>
      </div>

      <button className={button} disabled={busy} type="submit">
        {busyAction === "info" ? "Working…" : "Fetch Info"}
      </button>

      {media && (
        <section
          aria-labelledby="media-heading"
          className="min-w-0 space-y-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700"
        >
          <h2 id="media-heading" className="font-semibold text-slate-950">
            Media information
          </h2>

          {media.thumbnail && (
            // The URL is validated server-side against YouTube's image CDNs.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={media.thumbnail}
              alt={media.title ? `Thumbnail for ${media.title}` : "Media thumbnail"}
              className="h-auto w-full max-w-xs rounded-xl border border-slate-200"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          )}

          {media.title && (
            <p className="break-words">
              <span className="font-medium text-slate-900">Title:</span> {media.title}
            </p>
          )}

          {media.author && (
            <p className="break-words">
              <span className="font-medium text-slate-900">Channel:</span> {media.author}
            </p>
          )}

          <p className="break-words">
            <span className="font-medium text-slate-900">Source:</span> {media.sourceLabel}
          </p>

          {media.duration !== null && (
            <p>
              <span className="font-medium text-slate-900">Duration:</span> {formatDuration(media.duration)}
            </p>
          )}

          {/* Every limitation is rendered here exactly once — never in the status line. */}
          {limitations.length > 0 && (
            <div className="space-y-1 break-words" data-testid="media-limitations">
              <ul className="list-disc space-y-1 pl-5 text-slate-800">
                {limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          )}

          {selectedFormat && activeGroup ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="format" className="block font-medium text-slate-900">
                  Format
                </label>
                <select
                  id="format"
                  className={field}
                  value={groupKeyOf(activeGroup)}
                  onChange={(event) => selectGroup(event.target.value)}
                  disabled={busy}
                >
                  {groups.map((group) => (
                    <option key={groupKeyOf(group)} value={groupKeyOf(group)}>
                      {groupLabel(group)}
                    </option>
                  ))}
                </select>
              </div>

              {activeGroup.formats.length > 1 && (
                <div className="space-y-2">
                  <label htmlFor="quality" className="block font-medium text-slate-900">
                    Quality
                  </label>
                  <select
                    id="quality"
                    className={field}
                    value={selectedFormat.id}
                    onChange={(event) => setFormatId(event.target.value)}
                    disabled={busy}
                  >
                    {activeGroup.formats.map((format) => (
                      <option key={format.id} value={format.id}>
                        {qualityLabel(format)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1 break-words">
                <p>{streamSummary(selectedFormat)}</p>
                {selectedFormat.hasVideo && (
                  <p>
                    Video codec: {selectedFormat.videoCodec ?? "unavailable"} · Resolution:{" "}
                    {selectedFormat.resolution ?? "unavailable"}
                  </p>
                )}
                <p>
                  Audio codec: {selectedFormat.audioCodec ?? "unavailable"}
                  {selectedFormat.hasVideo && selectedFormat.bitrate
                    ? ` · Video bitrate: ${selectedFormat.bitrate}`
                    : ""}
                </p>
                {selectedFormat.conversion && selectedFormat.sourceAudioBitrate && (
                  <p>
                    Source audio bitrate: {selectedFormat.sourceAudioBitrate} → output{" "}
                    {selectedFormat.bitrate}
                  </p>
                )}
                <p>File size: {formatSize(selectedFormat.filesize)}</p>
                {selectedFormat.conversion && (
                  <p className="text-xs text-slate-600">
                    Conversion does not improve the source quality; the output is encoded at the selected rate.
                  </p>
                )}
              </div>

              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void run("download")}
              >
                {busyAction === "download" ? "Preparing download…" : "Download"}
              </button>
            </div>
          ) : (
            limitations.length === 0 && (
              <p className="break-words font-medium text-slate-800">{NO_FORMAT_MESSAGE}</p>
            )
          )}

          {notes.length > 0 && (
            <ul className="list-disc space-y-1 break-words pl-5 text-xs text-slate-600">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}

          {media.metadataProvider && (
            <p className="break-words text-xs text-slate-500">Metadata source: {media.metadataProvider}</p>
          )}
        </section>
      )}

      <p
        id="download-status"
        role={status.tone === "error" ? "alert" : "status"}
        aria-live={status.tone === "error" ? "assertive" : "polite"}
        className={`min-h-5 break-words text-sm leading-6 ${
          status.tone === "error" ? "text-rose-700" : "text-slate-700"
        }`}
      >
        {status.message}
      </p>
    </form>
  );
}

function groupKeyOf(format: { container: OutputContainer; conversion: boolean }): string {
  return `${format.container}-${format.conversion ? "converted" : "original"}`;
}
