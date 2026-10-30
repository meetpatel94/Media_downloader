import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRemoteMedia, streamToFile } from "@/lib/http-media";
import { DownloadError } from "@/lib/errors";
import {
  fakeMp4Body,
  installFetchMock,
  installPrivateDns,
  installPublicDns,
  neverResolvingFetch,
  redirectResponse,
  streamResponse,
} from "@/test-utils/fetch-mock";

const MEDIA_URL = "https://samplelib.com/lib/preview/mp4/sample-5s.mp4";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "http-media-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("rejects an upstream 404", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock(() => new Response(null, { status: 404 }));
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UPSTREAM_NOT_FOUND");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("maps upstream 5xx to a generic upstream error", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock(() => new Response(null, { status: 503 }));
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UPSTREAM_ERROR");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("rejects HTML content types instead of returning a page as media", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock(() => streamResponse([Buffer.from("<!doctype html><html></html>")], { contentType: "text/html; charset=utf-8" }));
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "NOT_MEDIA");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("rejects an audio response when video was requested", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock(() => streamResponse([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], { contentType: "audio/mpeg" }));
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal, accept: "video" }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "INVALID_CONTENT_TYPE");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("rejects a declared content-length above the limit", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock(() => streamResponse([fakeMp4Body()], { contentType: "video/mp4", contentLength: 5_000_000 }));
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal, maxBytes: 1_000_000 }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "TOO_LARGE");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("follows a redirect to an allowed host and reports the final URL", async () => {
  const dns = installPublicDns();
  let calls = 0;
  const restore = installFetchMock((url) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(url, MEDIA_URL);
      return redirectResponse("https://download.samplelib.com/mp4/sample-5s.mp4", 302);
    }
    return streamResponse([fakeMp4Body()], { contentType: "video/mp4" });
  });

  try {
    const media = await openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal });
    assert.equal(media.finalUrl.hostname, "download.samplelib.com");
    assert.equal(media.kind, "video");
    const result = await withTempDir((dir) => streamToFile(media.stream, join(dir, "out.bin"), { maxBytes: 1_000_000, signal: new AbortController().signal, timeoutMs: 5_000 }));
    assert.ok(result.size > 0);
  } finally {
    restore();
    dns();
  }
});

test("blocks a redirect to a private address", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock(() => redirectResponse("http://169.254.169.254/latest/meta-data"));
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UNSAFE_URL");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("blocks a redirect to a non-allowlisted host", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock(() => redirectResponse("https://evil.example/video.mp4"));
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UNSUPPORTED_SOURCE");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("stops after too many redirects", async () => {
  const dns = installPublicDns();
  let counter = 0;
  const restore = installFetchMock(() => {
    counter += 1;
    return redirectResponse(`https://samplelib.com/loop/${counter}.mp4`);
  });
  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "SOURCE_NOT_PERMITTED");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("refuses to fetch when DNS resolves to a private address", async () => {
  const dns = installPrivateDns();
  let fetched = false;
  const restore = installFetchMock(() => {
    fetched = true;
    return streamResponse([fakeMp4Body()], { contentType: "video/mp4" });
  });

  try {
    await assert.rejects(openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UNSAFE_URL");
      return true;
    });
    assert.equal(fetched, false);
  } finally {
    restore();
    dns();
  }
});

test("times out when the upstream never responds", async () => {
  const dns = installPublicDns();
  const restore = installFetchMock((_url, init) => neverResolvingFetch(init));

  try {
    await assert.rejects(
      openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal, headerTimeoutMs: 100 }),
      (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "UPSTREAM_TIMEOUT");
        return true;
      },
    );
  } finally {
    restore();
    dns();
  }
});

test("cancels on caller abort", async () => {
  const dns = installPublicDns();
  const controller = new AbortController();
  const restore = installFetchMock((_url, init) => neverResolvingFetch(init));

  try {
    const pending = openRemoteMedia(new URL(MEDIA_URL), { signal: controller.signal, headerTimeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "CANCELLED");
      return true;
    });
  } finally {
    restore();
    dns();
  }
});

test("streaming an endless body hits the download timeout", async () => {
  const endless = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0x64]));
      // never closes, never errors
    },
  });

  await withTempDir(async (dir) => {
    await assert.rejects(
      streamToFile(endless, join(dir, "stalled.mp3"), { maxBytes: 1_000_000, signal: new AbortController().signal, timeoutMs: 100 }),
      (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "UPSTREAM_TIMEOUT");
        return true;
      },
    );
  });
});

test("streamToFile aborts and reports when the byte cap is exceeded", async () => {
  const dns = installPublicDns();
  const chunk = new Uint8Array(64 * 1024);
  const restore = installFetchMock(() => streamResponse([chunk, chunk, chunk], { contentType: "video/mp4" }));

  try {
    const media = await openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal, maxBytes: 100_000 });

    await withTempDir(async (dir) => {
      await assert.rejects(
        streamToFile(media.stream, join(dir, "out.bin"), { maxBytes: 100_000, signal: new AbortController().signal, timeoutMs: 5_000 }),
        (error: unknown) => {
          assert.ok(error instanceof DownloadError);
          assert.equal(error.code, "TOO_LARGE");
          return true;
        },
      );
    });
  } finally {
    restore();
    dns();
  }
});

test("streamToFile writes the stream and returns the sniffer bytes", async () => {
  const dns = installPublicDns();
  const body = fakeMp4Body();
  const restore = installFetchMock(() => streamResponse([body], { contentType: "video/mp4" }));

  try {
    const media = await openRemoteMedia(new URL(MEDIA_URL), { signal: new AbortController().signal });

    await withTempDir(async (dir) => {
      const target = join(dir, "out.mp4");
      const result = await streamToFile(media.stream, target, { maxBytes: 1_000_000, signal: new AbortController().signal, timeoutMs: 5_000 });
      assert.equal(result.size, body.byteLength);
      const written = await readFile(target);
      assert.equal(written.byteLength, body.byteLength);
      assert.equal(written.subarray(4, 8).toString(), "ftyp");
      assert.equal(Buffer.from(result.firstBytes).subarray(4, 8).toString(), "ftyp");
    });
  } finally {
    restore();
    dns();
  }
});
