import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadMedia, filenameForUrl } from "@/lib/download-service";
import { DownloadError } from "@/lib/errors";
import { getFfmpegStatus, resetFfmpegCache } from "@/lib/ffmpeg";
import { sniffContainer } from "@/lib/media-inspect";
import {
  bytes,
  fakeMp3Body,
  fakeMp4Body,
  installFetchMock,
  installPublicDns,
  streamResponse,
} from "@/test-utils/fetch-mock";

const MEDIA_URL = "https://samplelib.com/lib/preview/mp4/sample-5s.mp4";

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

async function tempDownloaderDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith("media-downloader-"));
}

async function makeFfmpegFixture(kind: "av" | "video-only", dir: string): Promise<Uint8Array> {
  const installer = (await import("@ffmpeg-installer/ffmpeg")) as unknown as { path: string };
  const output = join(dir, `${kind}.mp4`);

  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5:duration=1"];

  if (kind === "av") {
    args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", "-shortest");
  }

  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", output);

  const result = spawnSync(installer.path, args, { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`fixture generation failed: ${result.stderr}`);
  }

  return new Uint8Array(await readFile(output));
}

async function ffmpegAvailable(): Promise<boolean> {
  const status = await getFfmpegStatus();
  return status.available;
}

test("filenameForUrl sanitises the URL path", () => {
  assert.equal(filenameForUrl(new URL("https://samplelib.com/a/sample%20video.mp4"), "mp3"), "sample-video.mp3");
  assert.equal(filenameForUrl(new URL("https://samplelib.com/"), "mp4"), "media-download.mp4");
  assert.equal(filenameForUrl(new URL("https://samplelib.com/----------.mp4"), "mp4"), "media-download.mp4");
  assert.equal(filenameForUrl(new URL("https://samplelib.com/../../etc/passwd.mp4"), "mp4"), "passwd.mp4");
});

test("rejects YouTube URLs with an actionable error and never fetches them", async () => {
  let fetched = false;

  await withNetwork(
    () => {
      fetched = true;
      return streamResponse([fakeMp4Body()], { contentType: "video/mp4" });
    },
    async () => {
      for (const url of ["https://www.youtube.com/shorts/abcdefghijk", "https://youtu.be/abcdefghijk"]) {
        await assert.rejects(downloadMedia(url, "mp4"), (error: unknown) => {
          assert.ok(error instanceof DownloadError);
          assert.equal(error.code, "UNSUPPORTED_SOURCE");
          assert.match(error.message, /YouTube links cannot be downloaded/);
          return true;
        });
      }
    },
  );

  assert.equal(fetched, false);
});

test("rejects unsupported hosts before any network I/O", async () => {
  let fetched = false;

  await withNetwork(
    () => {
      fetched = true;
      return streamResponse([fakeMp4Body()], { contentType: "video/mp4" });
    },
    async () => {
      await assert.rejects(downloadMedia("https://example.com/video.mp4", "mp4"), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "UNSUPPORTED_SOURCE");
        return true;
      });
    },
  );

  assert.equal(fetched, false);
});

test("downloads a valid MP4 and cleans up its temp directory", async () => {
  const body = fakeMp4Body();

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const artifact = await downloadMedia(MEDIA_URL, "mp4");

      try {
        assert.equal(artifact.contentType, "video/mp4");
        assert.equal(artifact.filename, "sample-5s.mp4");
        assert.equal(artifact.size, body.byteLength);

        const written = await readFile(artifact.filePath);
        assert.equal(sniffContainer(new Uint8Array(written.subarray(0, 32))), "mp4");
      } finally {
        await artifact.cleanup();
      }
    },
  );

  assert.deepEqual(await tempDownloaderDirs(), []);
});

test("maps an upstream 404 to a clear error and removes temp files", async () => {
  await withNetwork(
    () => new Response(null, { status: 404 }),
    async () => {
      await assert.rejects(downloadMedia(MEDIA_URL, "mp4"), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "UPSTREAM_NOT_FOUND");
        assert.equal(error.status, 404);
        return true;
      });
    },
  );

  assert.deepEqual(await tempDownloaderDirs(), []);
});

test("refuses an HTML page even when the URL ends in .mp4", async () => {
  await withNetwork(
    () => streamResponse([bytes("<!doctype html><html><body>nope</body></html>")], { contentType: "text/html" }),
    async () => {
      await assert.rejects(downloadMedia(MEDIA_URL, "mp4"), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "NOT_MEDIA");
        return true;
      });
    },
  );
});

test("rejects unknown binary content that is not verifiable media", async () => {
  await withNetwork(
    () => streamResponse([bytes("this is definitely not media")], { contentType: "application/octet-stream" }),
    async () => {
      await assert.rejects(downloadMedia(MEDIA_URL, "mp4"), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "NOT_MEDIA");
        return true;
      });
    },
  );
});

test("enforces the configurable file-size limit while streaming", async () => {
  const chunk = new Uint8Array(256 * 1024).fill(1);

  await withEnv({ MEDIA_DOWNLOADER_MAX_FILE_MB: "1" }, async () => {
    await withNetwork(
      () => streamResponse([fakeMp4Body(), chunk, chunk, chunk, chunk, chunk], { contentType: "video/mp4" }),
      async () => {
        await assert.rejects(downloadMedia(MEDIA_URL, "mp4"), (error: unknown) => {
          assert.ok(error instanceof DownloadError);
          assert.equal(error.code, "TOO_LARGE");
          assert.equal(error.status, 413);
          return true;
        });
      },
    );
  });

  assert.deepEqual(await tempDownloaderDirs(), []);
});

test("rejects a video-only source when MP3 is requested and no audio track exists", async () => {
  if (!(await ffmpegAvailable())) {
    test.skip?.("FFmpeg not available");
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "fixture-video-only-"));
  const source = await makeFfmpegFixture("video-only", dir);

  try {
    await withNetwork(
      () => streamResponse([source], { contentType: "video/mp4" }),
      async () => {
        await assert.rejects(downloadMedia(MEDIA_URL, "mp3"), (error: unknown) => {
          assert.ok(error instanceof DownloadError);
          assert.equal(error.code, "CONVERSION_FAILED");
          return true;
        });
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serves an existing MP3 directly without transcoding", async () => {
  const body = fakeMp3Body();

  await withNetwork(
    () => streamResponse([body], { contentType: "audio/mpeg" }),
    async () => {
      const artifact = await downloadMedia("https://samplelib.com/mp3/sample-3s.mp3", "mp3");

      try {
        assert.equal(artifact.contentType, "audio/mpeg");
        assert.equal(artifact.filename, "sample-3s.mp3");
        assert.equal(artifact.size, body.byteLength);
      } finally {
        await artifact.cleanup();
      }
    },
  );
});

test("real MP3 extraction from a real MP4 source produces genuine MP3 audio", async () => {
  if (!(await ffmpegAvailable())) {
    test.skip?.("FFmpeg not available");
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "fixture-av-"));
  const source = await makeFfmpegFixture("av", dir);

  try {
    await withNetwork(
      () => streamResponse([source], { contentType: "video/mp4" }),
      async () => {
        const artifact = await downloadMedia(MEDIA_URL, "mp3");

        try {
          assert.equal(artifact.contentType, "audio/mpeg");
          assert.ok(artifact.size > 1000, `expected audio output, got ${artifact.size} bytes`);

          const written = new Uint8Array(await readFile(artifact.filePath));
          assert.equal(sniffContainer(written.subarray(0, 32)), "mp3");
        } finally {
          await artifact.cleanup();
        }
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports MP3 conversion as unavailable when FFmpeg is missing", async () => {
  resetFfmpegCache();

  try {
    await withEnv({ FFMPEG_PATH: "/nonexistent/ffmpeg" }, async () => {
      resetFfmpegCache();

      await withNetwork(
        () => streamResponse([fakeMp4Body()], { contentType: "video/mp4" }),
        async () => {
          await assert.rejects(downloadMedia(MEDIA_URL, "mp3"), (error: unknown) => {
            assert.ok(error instanceof DownloadError);
            assert.equal(error.code, "CONVERSION_UNAVAILABLE");
            assert.equal(error.status, 503);
            return true;
          });
        },
      );
    });
  } finally {
    resetFfmpegCache();
  }
});

test("cancels an in-flight download and cleans up", async () => {
  const controller = new AbortController();

  await withNetwork(
    () =>
      streamResponse([fakeMp4Body()], { contentType: "video/mp4" }),
    async () => {
      controller.abort();

      await assert.rejects(downloadMedia(MEDIA_URL, "mp4", { signal: controller.signal }), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "CANCELLED");
        return true;
      });
    },
  );

  assert.deepEqual(await tempDownloaderDirs(), []);
});

test("rejects an audio file when MP4 video is requested (declared audio type)", async () => {
  await withNetwork(
    () => streamResponse([fakeMp3Body()], { contentType: "audio/mpeg" }),
    async () => {
      await assert.rejects(downloadMedia("https://samplelib.com/mp3/sample-3s.mp3", "mp4"), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "INVALID_CONTENT_TYPE");
        return true;
      });
    },
  );
});

test("rejects an audio-only file typed as octet-stream when MP4 is requested", async () => {
  await withNetwork(
    () => streamResponse([fakeMp3Body()], { contentType: "application/octet-stream" }),
    async () => {
      await assert.rejects(downloadMedia("https://samplelib.com/mp3/sample-3s.mp3", "mp4"), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "FORMAT_UNAVAILABLE");
        return true;
      });
    },
  );
});
