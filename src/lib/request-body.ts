import { DownloadError } from "@/lib/errors";

const MAX_BODY_BYTES = 8192;

/**
 * Read a JSON request body with a hard byte cap.
 *
 * `content-length` is a hint, so the cap is also enforced while reading. Every
 * failure is reported as the same safe `INVALID_BODY` error: no parser detail,
 * stack trace or payload fragment reaches the client.
 */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES || !request.body) {
    throw new DownloadError("INVALID_BODY", "Invalid request body.");
  }

  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      size += value.length;

      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new DownloadError("INVALID_BODY", "Invalid request body.");
      }

      chunks.push(value);
    }

    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();

    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError("INVALID_BODY", "Invalid request body.");
  }
}

/** Safe JSON error payload — no stack traces, paths or upstream detail. */
export function errorPayload(message: string, status: number, code?: string): { error: string; code?: string } {
  return code ? { error: message, code } : { error: message };
}

/** Convert any thrown value into a client-safe JSON response. */
export function errorResponse(error: unknown): Response {
  const e = error instanceof DownloadError ? error : new DownloadError("INTERNAL", "The request failed. Please try again.");

  return Response.json(
    { success: false, ...errorPayload(e.message, e.status, e.code) },
    { status: e.status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
