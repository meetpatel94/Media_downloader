import { inspectMedia } from "@/lib/media-info";
import { readBody, errorResponse } from "@/lib/request-body";
import { DownloadError } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    if (typeof body.url !== "string") throw new DownloadError("EMPTY_URL", "Please paste a media URL.");
    const { media } = await inspectMedia(body.url, request.signal);
    return Response.json({ success: true, media }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return errorResponse(error); }
}
