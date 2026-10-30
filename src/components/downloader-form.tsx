"use client";

import { FormEvent, useMemo, useState } from "react";

type DownloadFormat = "mp4" | "mp3";
type StatusTone = "idle" | "error" | "success" | "loading";

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extractFilename(disposition: string | null, format: DownloadFormat) {
  const fallback = `media-download.${format}`;
  if (!disposition) return fallback;

  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!match?.[1]) return fallback;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function DownloaderForm() {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<DownloadFormat>("mp4");
  const [status, setStatus] = useState<{ tone: StatusTone; message: string }>({
    tone: "idle",
    message: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const statusClassName = useMemo(() => {
    switch (status.tone) {
      case "error":
        return "text-rose-600";
      case "success":
        return "text-emerald-600";
      default:
        return "text-slate-600";
    }
  }, [status.tone]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      setStatus({ tone: "error", message: "Please paste a media URL." });
      return;
    }

    if (!isValidHttpUrl(trimmedUrl)) {
      setStatus({ tone: "error", message: "Please enter a valid URL." });
      return;
    }

    setIsSubmitting(true);
    setStatus({ tone: "loading", message: "Preparing your download..." });

    try {
      const response = await fetch("/api/download", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: trimmedUrl, format }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error || "Download failed. Please try again.");
        }
        throw new Error("Download failed. Please try again.");
      }

      if (!contentType.includes("audio/") && !contentType.includes("video/")) {
        throw new Error("Download failed. Please try again.");
      }

      const blob = await response.blob();
      const filename = extractFilename(response.headers.get("content-disposition"), format);
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(objectUrl);

      setStatus({ tone: "success", message: "Your download is ready." });
    } catch (error) {
      setStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "Download failed. Please try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <label htmlFor="media-url" className="text-sm font-medium text-slate-800">
          Media URL
        </label>
        <textarea
          id="media-url"
          name="media-url"
          rows={5}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Paste your video or audio URL here..."
          className="min-h-32 w-full resize-y rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base text-slate-900 shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200"
          aria-describedby="download-status"
          disabled={isSubmitting}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="format" className="text-sm font-medium text-slate-800">
          Format
        </label>
        <select
          id="format"
          name="format"
          value={format}
          onChange={(event) => setFormat(event.target.value as DownloadFormat)}
          className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-base text-slate-900 shadow-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-200"
          disabled={isSubmitting}
        >
          <option value="mp4">MP4 Video</option>
          <option value="mp3">MP3 Audio</option>
        </select>
      </div>

      <button
        type="submit"
        className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus:ring-4 focus:ring-slate-300 disabled:cursor-not-allowed disabled:bg-slate-400"
        disabled={isSubmitting}
      >
        {isSubmitting ? "Downloading..." : "Download"}
      </button>

      <p id="download-status" aria-live="polite" className={`min-h-5 text-sm ${statusClassName}`}>
        {status.message}
      </p>
    </form>
  );
}
