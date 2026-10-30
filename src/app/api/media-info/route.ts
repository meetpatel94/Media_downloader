import type { NextRequest } from "next/server";
import { inspectMedia } from "@/lib/media-info";
import { readBody, errorResponse, errorPayload } from "@/lib/request-body";
import { DownloadError } from "@/lib/errors";
import { MAX_URL_LENGTH } from "@/lib/download-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/**
 * Inspect a media URL and return real, verified metadata.
 *
 * Response:
 *   { success: true, media: { title, duration, thumbnail, sourceType,
 *     sourceLabel, author, metadataProvider, downloadSupported, limitation,
 *     notes, formats: [{ id, container, label, resolution, videoCodec,
 *     audioCodec, filesize, bitrate, sourceAudioBitrate, hasVideo, hasAudio,
 *     conversion }] } }
 *
 * Unavailable values are `null`; nothing is invented.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await readBody(request);

    if (typeof body.url !== "string") {
      throw new DownloadError("EMPTY_URL", "Please paste a media URL.");
    }

    if (body.url.length > MAX_URL_LENGTH) {
      throw new DownloadError("URL_TOO_LONG", "That URL is too long. Please use a link shorter than 2048 characters.");
    }

    const { media } = await inspectMedia(body.url, request.signal);

    return Response.json({ success: true, media }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET() {
  return Response.json(
    { success: false, ...errorPayload("Method not allowed. Use POST.", 405, "METHOD_NOT_ALLOWED") },
    { status: 405, headers: { ...NO_STORE, allow: "POST" } },
  );
}
