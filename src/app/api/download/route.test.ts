import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/download/route";
import { getFfmpegStatus, resetFfmpegCache } from "@/lib/ffmpeg";
import {
  fakeMp3Body,
  fakeMp4Body,
  installFetchMock,
  installPublicDns,
  neverResolvingFetch,
  streamResponse,
} from "@/test-utils/fetch-mock";

const MEDIA_URL = "https://samplelib.com/lib/preview/mp4/sample-5s.mp4";

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost/api/download", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function callRoute(body: unknown, headers?: Record<string, string>) {
  return POST(makeRequest(body, headers));
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

async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitForTempDirsToClear(timeoutMs = 2_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = await tempDirs();

  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = await tempDirs();
  }

  return remaining;
}

async function tempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith("media-downloader-"));
}

async function jsonBody(response: Response): Promise<{ error?: string; code?: string }> {
  return (await response.json()) as { error?: string; code?: string };
}

test("rejects invalid JSON", async () => {
  const response = await callRoute("{not json");
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).code, "INVALID_BODY");
});

test("rejects a non-object body", async () => {
  const response = await callRoute("[1,2,3]");
  assert.equal(response.status, 400);
});

test("rejects an oversized request body", async () => {
  const response = await callRoute({ url: "x".repeat(10_000), format: "mp4" });
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).code, "INVALID_BODY");
});

test("rejects a missing URL", async () => {
  const response = await callRoute({ format: "mp4" });
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).code, "EMPTY_URL");
});

test("rejects a non-string URL", async () => {
  const response = await callRoute({ url: 42, format: "mp4" });
  assert.equal(response.status, 400);
});

test("rejects an empty URL", async () => {
  const response = await callRoute({ url: "   ", format: "mp4" });
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).error, "Please paste a media URL.");
});

test("rejects an unsupported format", async () => {
  for (const format of ["wav", "MP4", "", null, 3]) {
    const response = await callRoute({ url: MEDIA_URL, format });
    assert.equal(response.status, 400, String(format));
    assert.equal((await jsonBody(response)).code, "INVALID_FORMAT");
  }
});

test("rejects an unsupported source with 422", async () => {
  const response = await callRoute({ url: "https://example.com/video.mp4", format: "mp4" });
  assert.equal(response.status, 422);
  assert.match((await jsonBody(response)).error ?? "", /not supported/);
});

test("rejects YouTube URLs with 422 and an actionable message", async () => {
  const response = await callRoute({ url: "https://www.youtube.com/shorts/abcdefghijk", format: "mp4" });
  assert.equal(response.status, 422);
  const body = await jsonBody(response);
  assert.equal(body.code, "UNSUPPORTED_SOURCE");
  assert.match(body.error ?? "", /YouTube links cannot be downloaded/);
});

test("rejects SSRF targets before fetching", async () => {
  let fetched = false;

  await withNetwork(
    () => {
      fetched = true;
      return streamResponse([fakeMp4Body()], { contentType: "video/mp4" });
    },
    async () => {
      for (const url of ["http://127.0.0.1/video.mp4", "http://169.254.169.254/latest/meta-data", "http://[::1]/video.mp4"]) {
        const response = await callRoute({ url, format: "mp4" });
        assert.equal(response.status, 400, url);
      }
    },
  );

  assert.equal(fetched, false);
});

test("maps an upstream 404 to 404", async () => {
  await withNetwork(
    () => new Response(null, { status: 404 }),
    async () => {
      const response = await callRoute({ url: MEDIA_URL, format: "mp4" });
      assert.equal(response.status, 404);
      const body = await jsonBody(response);
      assert.equal(body.code, "UPSTREAM_NOT_FOUND");
      assert.match(body.error ?? "", /not found/);
    },
  );
});

test("maps an upstream timeout to 504", async () => {
  await withEnv({ MEDIA_DOWNLOADER_REQUEST_TIMEOUT_MS: "1000" }, async () => {
    await withNetwork(
      (_url, init) => neverResolvingFetch(init),
      async () => {
        const response = await callRoute({ url: MEDIA_URL, format: "mp4" });
        assert.equal(response.status, 504);
        assert.equal((await jsonBody(response)).code, "UPSTREAM_TIMEOUT");
      },
    );
  });
});

test("rejects an invalid content type with 415", async () => {
  await withNetwork(
    () => streamResponse([fakeMp3Body()], { contentType: "audio/mpeg" }),
    async () => {
      const response = await callRoute({ url: MEDIA_URL, format: "mp4" });
      assert.equal(response.status, 415);
      assert.equal((await jsonBody(response)).code, "INVALID_CONTENT_TYPE");
    },
  );
});

test("rejects an HTML error page with 415 instead of returning it as MP4", async () => {
  await withNetwork(
    () => streamResponse([Buffer.from("<html><body>error</body></html>")], { contentType: "text/html" }),
    async () => {
      const response = await callRoute({ url: MEDIA_URL, format: "mp4" });
      assert.equal(response.status, 415);
      assert.equal((await jsonBody(response)).code, "NOT_MEDIA");
    },
  );
});

test("rejects oversized media with 413", async () => {
  const chunk = new Uint8Array(256 * 1024);

  await withEnv({ MEDIA_DOWNLOADER_MAX_FILE_MB: "1" }, async () => {
    await withNetwork(
      () => streamResponse([fakeMp4Body(), chunk, chunk, chunk, chunk, chunk], { contentType: "video/mp4" }),
      async () => {
        const response = await callRoute({ url: MEDIA_URL, format: "mp4" });
        assert.equal(response.status, 413);
        assert.equal((await jsonBody(response)).code, "TOO_LARGE");
      },
    );
  });
});

test("returns 503 when MP3 conversion is required but FFmpeg is absent", async () => {
  resetFfmpegCache();

  try {
    await withEnv({ FFMPEG_PATH: "/nonexistent/ffmpeg" }, async () => {
      resetFfmpegCache();

      await withNetwork(
        () => streamResponse([fakeMp4Body()], { contentType: "video/mp4" }),
        async () => {
          const response = await callRoute({ url: MEDIA_URL, format: "mp3" });
          assert.equal(response.status, 503);
          assert.equal((await jsonBody(response)).code, "CONVERSION_UNAVAILABLE");
        },
      );
    });
  } finally {
    resetFfmpegCache();
  }
});

test("returns a genuine MP4 response with safe headers and cleans up", async () => {
  const body = fakeMp4Body();

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const response = await callRoute({ url: MEDIA_URL, format: "mp4" });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "video/mp4");
      assert.equal(response.headers.get("content-length"), String(body.byteLength));
      assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="sample-5s\.mp4"/);
      assert.match(response.headers.get("content-disposition") ?? "", /filename\*=UTF-8''sample-5s\.mp4/);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");

      const received = new Uint8Array(await response.arrayBuffer());
      assert.equal(received.byteLength, body.byteLength);
      assert.equal(Buffer.from(received.subarray(4, 8)).toString(), "ftyp");
    },
  );

  assert.deepEqual(await waitForTempDirsToClear(), []);
});

test("returns a genuine MP3 response when FFmpeg conversion is configured", async () => {
  const status = await getFfmpegStatus();
  if (!status.available) {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "route-fixture-"));
  const installer = (await import("@ffmpeg-installer/ffmpeg")) as unknown as { path: string };
  const output = join(dir, "fixture.mp4");

  const generated = spawnSync(
    installer.path,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x48:rate=5:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      output,
    ],
    { encoding: "utf8" },
  );

  assert.equal(generated.status, 0, generated.stderr);

  try {
    const source = new Uint8Array(await readFile(output));

    await withNetwork(
      () => streamResponse([source], { contentType: "video/mp4" }),
      async () => {
        const response = await callRoute({ url: MEDIA_URL, format: "mp3" });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "audio/mpeg");
        assert.match(response.headers.get("content-disposition") ?? "", /\.mp3"/);

        const received = new Uint8Array(await response.arrayBuffer());
        assert.ok(received.byteLength > 1000, `expected audio, got ${received.byteLength} bytes`);
        assert.ok(received[0] === 0x49 || received[0] === 0xff, "expected an MP3 frame header");
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert.deepEqual(await waitForTempDirsToClear(), []);
});

test("GET is not allowed", async () => {
  const response = GET();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
