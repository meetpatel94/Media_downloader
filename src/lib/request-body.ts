import { DownloadError } from "@/lib/errors";
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") || 0) > 8192 || !request.body) throw new DownloadError("INVALID_BODY", "Invalid request body.");
  const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); throw new DownloadError("INVALID_BODY", "Invalid request body."); } chunks.push(value); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) { if (error instanceof DownloadError) throw error; throw new DownloadError("INVALID_BODY", "Invalid request body."); }
}
export function errorResponse(error: unknown): Response {
  const e = error instanceof DownloadError ? error : new DownloadError("INTERNAL", "The request failed. Please try again.");
  return Response.json({ success: false, error: e.message, code: e.code }, { status: e.status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
