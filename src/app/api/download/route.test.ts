import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { GET as downloadGet, POST as download } from "@/app/api/download/route";
import { POST as info } from "@/app/api/media-info/route";
import { getConcurrencySnapshot } from "@/lib/concurrency";
import { mediaFixture } from "@/test-utils/media-fixtures";
import { installFetchMock, installPublicDns, streamResponse } from "@/test-utils/fetch-mock";

const URL_MP4 = "https://samplelib.com/lib/preview/mp4/sample.mp4";

function post(path: string, body: unknown, signal?: AbortSignal): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function withNetwork<T>(handler: Parameters<typeof installFetchMock>[0], run: () => Promise<T>): Promise<T> {
  const dns = installPublicDns();
  const restore = installFetchMock(handler);

  try {
    return await run();
  } finally {
    restore();
    dns();
  }
}

async function leftoverTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith("media-downloader-"));
}

test("streams a verified MP4 and removes the temp directory afterwards", async () => {
  const body = await mediaFixture("av-mp4");

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const inspected = await info(post("/api/media-info", { url: URL_MP4 }));
      const { media } = (await inspected.json()) as { media: { formats: Array<{ id: string; container: string }> } };
      const format = media.formats.find((entry) => entry.container === "mp4");
      assert.ok(format);

      const response = await download(post("/api/download", { url: URL_MP4, formatId: format.id, outputFormat: "mp4" }));
      assert.equal(response.status, 200);

      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, body.byteLength);
    },
  );

  // Cleanup is scheduled when the stream ends.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await leftoverTempDirs(), []);
});

test("aborting a response errors the stream and releases the job slot", async () => {
  const body = await mediaFixture("av-mp4");

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const inspected = await info(post("/api/media-info", { url: URL_MP4 }));
      const { media } = (await inspected.json()) as { media: { formats: Array<{ id: string; container: string }> } };
      const format = media.formats.find((entry) => entry.container === "mp4");
      assert.ok(format);

      const controller = new AbortController();
      const response = await download(
        post("/api/download", { url: URL_MP4, formatId: format.id, outputFormat: "mp4" }, controller.signal),
      );
      const reader = response.body!.getReader();

      controller.abort();
      await assert.rejects(reader.read());

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(getConcurrencySnapshot().active, 0);
    },
  );

  assert.deepEqual(await leftoverTempDirs(), []);
});

test("rejects a body larger than the API limit", async () => {
  const response = await download(post("/api/download", { url: "https://samplelib.com/a.mp4", formatId: "x".repeat(9000), outputFormat: "mp4" }));

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code?: string }).code, "INVALID_BODY");
});

test("does not allow GET", async () => {
  const response = downloadGet();

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});
