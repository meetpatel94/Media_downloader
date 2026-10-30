import { createReadStream } from "node:fs";
import type { NextRequest } from "next/server";
import { downloadMedia } from "@/lib/download-service";
import { isDownloadError } from "@/lib/errors";
import { contentDisposition } from "@/lib/http-response";
import type { DownloadFormat } from "@/lib/source-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_BODY_BYTES = 8 * 1024;

function jsonError(message: string, status: number, code?: string) {
  return Response.json(
    { error: message, ...(code ? { code } : {}) },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function publicMessage(error: unknown): { message: string; status: number; code: string } {
  if (isDownloadError(error)) {
    return { message: error.message, status: error.status, code: error.code };
  }

  return { message: "Download failed. Please try again.", status: 500, code: "INTERNAL" };
}

function logDiagnostic(error: unknown) {
  if (isDownloadError(error) && error.diagnostic) {
    console.error(`[download] ${error.code}:`, error.diagnostic);
    return;
  }

  if (error instanceof Error) {
    console.error(`[download] ${error.name}: ${error.message}`);
  }
}

/**
 * Stream a finished temp file to the client and always remove the temp
 * directory afterwards (success, error, timeout, or client disconnect).
 */
function streamArtifact(filePath: string, cleanup: () => Promise<void>, size: number, contentType: string, filename: string, signal: AbortSignal) {
  const nodeStream = createReadStream(filePath);
  let finished = false;

  const cleanupOnce = async () => {
    if (finished) return;
    finished = true;
    await cleanup();
  };

  const onAbort = () => {
    nodeStream.destroy();
    void cleanupOnce();
  };

  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: string | Buffer) => {
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

type RequestBody = { url?: unknown; format?: unknown };

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return jsonError("Invalid request body.", 400, "INVALID_BODY");
  }

  let body: RequestBody;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return jsonError("Invalid request body.", 400, "INVALID_BODY");
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError("Invalid request body.", 400, "INVALID_BODY");
    }
    body = parsed as RequestBody;
  } catch {
    return jsonError("Invalid request body.", 400, "INVALID_BODY");
  }

  const format = body.format;
  if (format !== "mp4" && format !== "mp3") {
    return jsonError("Unsupported format. Choose MP4 or MP3.", 400, "INVALID_FORMAT");
  }

  if (typeof body.url !== "string") {
    return jsonError("Please paste a media URL.", 400, "EMPTY_URL");
  }

  try {
    const artifact = await downloadMedia(body.url, format as DownloadFormat, { signal: request.signal });

    return streamArtifact(artifact.filePath, artifact.cleanup, artifact.size, artifact.contentType, artifact.filename, request.signal);
  } catch (error) {
    logDiagnostic(error);

    // A disconnected client cannot receive a JSON body; nothing to send.
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    const { message, status, code } = publicMessage(error);
    return jsonError(message, status, code);
  }
}

export function GET() {
  return jsonError("Method not allowed. Use POST.", 405, "METHOD_NOT_ALLOWED");
}
