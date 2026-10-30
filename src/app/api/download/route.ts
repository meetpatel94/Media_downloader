import { createReadStream } from "node:fs";
import type { NextRequest } from "next/server";
import { inspectMedia } from "@/lib/media-info";
import { readBody, errorResponse, errorPayload } from "@/lib/request-body";
import { DownloadError } from "@/lib/errors";
import { getConfig } from "@/lib/config";
import { contentDisposition } from "@/lib/http-response";
import { decodeFormatId, isOutputContainer, type OutputContainer } from "@/lib/formats";
import { MAX_URL_LENGTH } from "@/lib/download-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/**
 * Stream a finished temp file to the client and always remove the temp
 * directory afterwards (success, error, timeout, or client disconnect).
 */
function streamArtifact(
  filePath: string,
  cleanup: () => Promise<void>,
  size: number,
  contentType: string,
  filename: string,
  signal: AbortSignal,
) {
  const nodeStream = createReadStream(filePath);
  let finished = false;
  const timer = setTimeout(() => {
    nodeStream.destroy(new Error("Response timed out"));
  }, getConfig().downloadTimeoutMs);

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

    pull() {
      nodeStream.resume();
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

/**
 * Download a previously inspected format.
 *
 * The client's `formatId` is only a hint: `inspectMedia` re-downloads, re-probes
 * and re-hashes the source, rebuilds the format list, and rejects any id that is
 * not in it (fabricated, stale, or from a different file).
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

    if (!isOutputContainer(body.outputFormat)) {
      throw new DownloadError("INVALID_FORMAT", "Select an available format after fetching media information.");
    }

    if (typeof body.formatId !== "string" || !body.formatId) {
      throw new DownloadError("INVALID_FORMAT", "Select an available format after fetching media information.");
    }

    const decoded = decodeFormatId(body.formatId);

    if (!decoded || decoded.spec.container !== (body.outputFormat as OutputContainer)) {
      throw new DownloadError("INVALID_FORMAT", "That format is not valid. Fetch media information and choose an available format.");
    }

    const { artifact } = await inspectMedia(body.url, request.signal, {
      id: body.formatId,
      output: body.outputFormat,
    });

    if (!artifact) {
      throw new DownloadError("INTERNAL", "The download could not be prepared. Please try again.");
    }

    return streamArtifact(
      artifact.filePath,
      artifact.cleanup,
      artifact.size,
      artifact.contentType,
      artifact.filename,
      request.signal,
    );
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
