"use client";

import { useEffect, useRef, useState } from "react";

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

type Format = { id: string; container: "mp4" | "mp3"; resolution: string | null; videoCodec: string | null; audioCodec: string | null; filesize: number | null; hasVideo: boolean; hasAudio: boolean; bitrate: string | null; conversion: boolean };
type Media = { title: string | null; duration: number | null; sourceType: string; formats: Format[] };

export function DownloaderForm() {
  const [url, setUrl] = useState("");
  const [media, setMedia] = useState<Media | null>(null);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<Status>(IDLE_STATUS);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => abortRef.current?.abort(), []);
  const field = "block w-full min-w-0 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-300 disabled:bg-slate-100";
  const button = "flex min-h-12 w-full items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-400 disabled:bg-slate-400";

  async function run(action: "info" | "download") {
    if (inFlight.current) return;
    const value = url.trim();
    if (!value || !parseHttpUrl(value)) { setStatus({ tone: "error", message: value ? "Please enter a valid http:// or https:// URL." : "Please paste a media URL." }); return; }
    const format = media?.formats.find((item) => item.id === selected);
    if (action === "download" && !format) { setStatus({ tone: "error", message: "Select an available format." }); return; }
    if (action === "info") { setMedia(null); setSelected(""); }
    inFlight.current = true; setBusy(true); setStatus({ tone: "loading", message: action === "info" ? "Inspecting media…" : "Preparing download…" });
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const response = await fetch(action === "info" ? "/api/media-info" : "/api/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "info" ? { url: value } : { url: value, formatId: format!.id, outputFormat: format!.container }), signal: controller.signal });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(typeof payload.error === "string" ? payload.error : "Request failed. Please try again."); }
      if (action === "info") {
        const payload = await response.json();
        if (!payload.success || !Array.isArray(payload.media?.formats)) throw new Error("The server returned invalid media information.");
        setMedia(payload.media); setSelected(payload.media.formats[0]?.id ?? ""); setStatus({ tone: "success", message: "Media information ready." });
      } else {
        const type = response.headers.get("content-type") ?? "";
        if (!type.startsWith("audio/") && !type.startsWith("video/")) throw new Error("The server did not return a media file.");
        const blob = await response.blob(); if (!blob.size) throw new Error("The server returned an empty file.");
        const filename = filenameFromDisposition(response.headers.get("content-disposition"), format!.container);
        triggerBrowserDownload(blob, filename); setStatus({ tone: "success", message: `Download started: ${filename}` });
      }
    } catch (error) { setStatus({ tone: "error", message: error instanceof Error && !(error instanceof TypeError) && error.message ? error.message : "Network request failed or was interrupted. Please try again." }); }
    finally { inFlight.current = false; setBusy(false); abortRef.current = null; }
  }
  return <form className="space-y-5 sm:space-y-6" noValidate aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void run("info"); }}>
    <div className="space-y-2"><label htmlFor="media-url" className="block text-sm font-medium text-slate-800">Media URL</label>
      <textarea id="media-url" rows={4} value={url} onChange={(event) => { setUrl(event.target.value); setMedia(null); setSelected(""); }} placeholder="https://example.com/video.mp4" className={field + " resize-y break-all"} aria-describedby="download-status" autoComplete="off" spellCheck={false} inputMode="url" disabled={busy} />
    </div>
    <button className={button} disabled={busy} type="submit">{busy ? "Working…" : "Fetch Info"}</button>
    {media && <section aria-labelledby="media-heading" className="min-w-0 space-y-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
      <h2 id="media-heading" className="font-semibold text-slate-950">Media information</h2>
      {media.title && <p className="break-words"><strong>Title:</strong> {media.title}</p>}
      <p>Source: Direct media file</p>
      {media.duration !== null && <p>Duration: {Math.round(media.duration)} seconds</p>}
      <p>Thumbnail and other unavailable metadata are not provided.</p>
      <label htmlFor="format" className="block font-medium">Available formats and quality</label>
      <select id="format" className={field} value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy}>
        {media.formats.map((f) => <option key={f.id} value={f.id}>{f.container.toUpperCase()} {f.resolution ? `— ${f.resolution}` : ""} {f.bitrate ? `— ${f.bitrate}` : ""}{f.conversion ? " (converted)" : " (original)"}</option>)}
      </select>
      {media.formats.filter((f) => f.id === selected).map((f) => <div key={f.id} className="break-words space-y-1"><p>{f.hasVideo && f.hasAudio ? "Audio and video combined" : f.hasVideo ? "Video only" : "Audio only"}</p><p>Video codec: {f.videoCodec ?? "unavailable"} · Audio codec: {f.audioCodec ?? "unavailable"}</p><p>File size: {f.filesize === null ? "unavailable" : `${(f.filesize / 1024 / 1024).toFixed(2)} MB`}</p></div>)}
      <button type="button" className={button} disabled={busy || !selected} onClick={() => void run("download")}>{busy ? "Working…" : "Download"}</button>
    </section>}
    <p id="download-status" role="status" aria-live="polite" className={`min-h-5 break-words text-sm leading-6 ${status.tone === "error" ? "text-rose-700" : "text-slate-700"}`}>{status.message}</p>
  </form>;
}
