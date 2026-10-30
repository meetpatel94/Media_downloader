import { createReadStream } from "node:fs";
import type { NextRequest } from "next/server";
import { inspectMedia } from "@/lib/media-info";
import { readBody, errorResponse } from "@/lib/request-body";
import { DownloadError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { contentDisposition } from "@/lib/http-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function jsonError(message: string, status: number, code?: string) {
  return Response.json({ error: message, code }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Stream a finished temp file to the client and always remove the temp
 * directory afterwards (success, error, timeout, or client disconnect).
 */
function streamArtifact(filePath: string, cleanup: () => Promise<void>, size: number, contentType: string, filename: string, signal: AbortSignal) {
  const nodeStream = createReadStream(filePath);
  let finished = false;
  const timer = setTimeout(() => { nodeStream.destroy(new Error("Response timed out")); }, getConfig().downloadTimeoutMs);

  const cleanupOnce = async () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    await cleanup();
  };

  const onAbort = () => {
    nodeStream.destroy(new Error("Response aborted"));
  };

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: string | Buffer) => {
        nodeStream.pause();
        controller.enqueue(new Uint8Array(Buffer.from(chunk)));
      });

      nodeStream.on("end", () => {
        controller.close();
        signal.removeEventListener("abort", onAbort);
        void cleanupOnce();
      });

      nodeStream.on("error", (error) => {
        controller.error(error);
        signal.removeEventListener("abort", onAbort);
        void cleanupOnce();
      });
    },

    pull() { nodeStream.resume(); },

    async cancel() {
      nodeStream.destroy();
      signal.removeEventListener("abort", onAbort);
      await cleanupOnce();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "content-disposition": contentDisposition(filename),
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await readBody(request);
    if (typeof body.url !== "string") throw new DownloadError("EMPTY_URL", "Please paste a media URL.");
    if (typeof body.formatId !== "string" || !body.formatId || (body.outputFormat !== "mp4" && body.outputFormat !== "mp3")) throw new DownloadError("INVALID_FORMAT", "Select an available format after fetching media information.");
    const { artifact } = await inspectMedia(body.url, request.signal, { id: body.formatId, output: body.outputFormat });
    if (!artifact) throw new DownloadError("INTERNAL", "Download failed. Please try again.");
    return streamArtifact(artifact.filePath, artifact.cleanup, artifact.size, artifact.contentType, artifact.filename, request.signal);
  } catch (error) { return errorResponse(error); }
}
export function GET() { return jsonError("Method not allowed. Use POST.", 405, "METHOD_NOT_ALLOWED"); }
