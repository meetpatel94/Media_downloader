"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type DownloadFormat = "mp4" | "mp3";
type StatusTone = "idle" | "error" | "success" | "loading";

type Status = { tone: StatusTone; message: string };

const IDLE_STATUS: Status = { tone: "idle", message: "" };

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read the RFC 6266 filename, preferring the UTF-8 encoded variant. */
export function filenameFromDisposition(disposition: string | null, format: DownloadFormat): string {
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

const TONE_CLASS: Record<StatusTone, string> = {
  idle: "text-slate-500",
  loading: "text-slate-700",
  success: "text-emerald-700",
  error: "text-rose-700",
};

export function DownloaderForm() {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<DownloadFormat>("mp4");
  const [status, setStatus] = useState<Status>(IDLE_STATUS);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (inFlightRef.current) return;

    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      setStatus({ tone: "error", message: "Please paste a media URL." });
      return;
    }

    if (!parseHttpUrl(trimmedUrl)) {
      setStatus({ tone: "error", message: "Please enter a valid http:// or https:// URL." });
      return;
    }

    inFlightRef.current = true;
    setIsSubmitting(true);
    setStatus({
      tone: "loading",
      message: format === "mp3" ? "Downloading and converting to MP3..." : "Downloading your video...",
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/download", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "audio/*,video/*,application/json" },
        body: JSON.stringify({ url: trimmedUrl, format }),
        signal: controller.signal,
      });

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

      if (!response.ok) {
        if (contentType.includes("application/json")) {
          const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
          const message = typeof payload.error === "string" ? payload.error : "Download failed. Please try again.";
          throw new Error(message);
        }
        throw new Error("Download failed. Please try again.");
      }

      if (!contentType.startsWith("audio/") && !contentType.startsWith("video/")) {
        throw new Error("The server did not return a media file. Please try again.");
      }

      const blob = await response.blob();

      if (blob.size === 0) {
        throw new Error("The server returned an empty file. Please try again.");
      }

      const filename = filenameFromDisposition(response.headers.get("content-disposition"), format);
      triggerBrowserDownload(blob, filename);

      setStatus({
        tone: "success",
        message: `Download started: ${filename}`,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus({ tone: "error", message: "The download was cancelled." });
        return;
      }

      setStatus({
        tone: "error",
        message: error instanceof Error && error.message ? error.message : "Download failed. Please try again.",
      });
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
      abortRef.current = null;
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 sm:space-y-6" noValidate aria-busy={isSubmitting}>
      <div className="space-y-2">
        <label htmlFor="media-url" className="block text-sm font-medium text-slate-800">
          Media URL
        </label>
        <textarea
          id="media-url"
          name="media-url"
          rows={4}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/video.mp4"
          className="block w-full resize-y rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base leading-6 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus-visible:border-slate-500 focus-visible:ring-4 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:bg-slate-100"
          aria-describedby="download-status"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          disabled={isSubmitting}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="format" className="block text-sm font-medium text-slate-800">
          Format
        </label>
        <select
          id="format"
          name="format"
          value={format}
          onChange={(event) => setFormat(event.target.value as DownloadFormat)}
          className="block h-12 w-full rounded-2xl border border-slate-300 bg-white px-4 text-base text-slate-900 shadow-sm outline-none transition focus-visible:border-slate-500 focus-visible:ring-4 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:bg-slate-100"
          disabled={isSubmitting}
        >
          <option value="mp4">MP4 Video</option>
          <option value="mp3">MP3 Audio</option>
        </select>
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-400/60 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {isSubmitting ? (
          <>
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
            Downloading...
          </>
        ) : (
          "Download"
        )}
      </button>

      <p
        id="download-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`min-h-5 break-words text-sm leading-6 ${TONE_CLASS[status.tone]}`}
      >
        {status.message}
      </p>
    </form>
  );
}
