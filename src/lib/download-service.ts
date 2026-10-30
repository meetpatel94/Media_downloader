import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePublicRemoteHost, isAllowedRedirect } from "@/lib/download-validation";

const REQUEST_TIMEOUT_MS = 20000;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const USER_AGENT = "MediaDownloader/1.0";

type DownloadFormat = "mp3" | "mp4";

function sanitizeFilename(input: string) {
  return input
    .replace(/[^a-zA-Z0-9-_\.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "media-download";
}

function filenameFromUrl(url: URL, format: DownloadFormat) {
  const lastSegment = url.pathname.split("/").filter(Boolean).pop() ?? "media-download";
  const decoded = decodeURIComponent(lastSegment);
  const base = decoded.replace(/\.[a-zA-Z0-9]{1,5}$/, "");
  return `${sanitizeFilename(base)}.${format}`;
}

async function fetchWithTimeout(url: URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "*/*",
      },
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAuthorizedMedia(url: URL) {
  await ensurePublicRemoteHost(url);
  const response = await fetchWithTimeout(url);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location || !isAllowedRedirect(location)) {
      throw new Error("This media source is not supported.");
    }
    const redirected = new URL(location);
    await ensurePublicRemoteHost(redirected);
    return fetchWithTimeout(redirected);
  }

  return response;
}

export async function downloadMedia(url: URL, format: DownloadFormat) {
  const response = await fetchAuthorizedMedia(url);

  if (!response.ok || !response.body) {
    throw new Error(response.status === 404 ? "The media could not be accessed." : "Download failed. Please try again.");
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_FILE_SIZE_BYTES) {
    throw new Error("The media file is too large.");
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const allowVideo = format === "mp4" && (contentType.startsWith("video/") || contentType === "application/octet-stream");
  const allowAudio = format === "mp3" && (contentType.startsWith("audio/") || contentType === "application/octet-stream");

  if (!allowVideo && !allowAudio) {
    throw new Error(format === "mp4" ? "The requested MP4 video is not available." : "The requested MP3 audio is not available.");
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "media-downloader-"));
  const extension = format === "mp4" ? "mp4" : "mp3";
  const filename = filenameFromUrl(url, format);
  const filePath = path.join(tempDir, `${randomUUID()}.${extension}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error("The media file is too large.");
  }

  await writeFile(filePath, bytes);
  const fileStats = await stat(filePath);

  return {
    filePath,
    filename,
    contentType: format === "mp4" ? "video/mp4" : "audio/mpeg",
    size: fileStats.size,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
