import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { downloadMedia } from "@/lib/download-service";
import { validateMediaUrl } from "@/lib/download-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = {
  url?: string;
  format?: string;
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  let body: RequestBody;

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const validated = validateMediaUrl(body.url ?? "");
  if (!validated.ok) {
    return jsonError(validated.message, validated.message.includes("supported") ? 400 : 422);
  }

  const format = body.format;
  if (format !== "mp4" && format !== "mp3") {
    return jsonError("Unsupported format.", 400);
  }

  try {
    const result = await downloadMedia(validated.url, format);

    try {
      const fileBuffer = await readFile(result.filePath);
      const response = new Response(fileBuffer, {
        status: 200,
        headers: {
          "content-type": result.contentType,
          "content-length": String(result.size),
          "content-disposition": `attachment; filename="${result.filename}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });

      void result.cleanup();
      return response;
    } catch {
      await result.cleanup();
      throw new Error("Download failed. Please try again.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download failed. Please try again.";
    const status = message === "This media source is not supported." || message === "Unsupported format." ? 400 : 422;
    return jsonError(message, status);
  }
}
