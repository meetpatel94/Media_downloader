import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET as infoGet, POST as info } from "@/app/api/media-info/route";
import { POST as download } from "@/app/api/download/route";
import { decodeFormatId } from "@/lib/formats";
import { mediaFixture, probeWithFfprobe } from "@/test-utils/media-fixtures";
import {
  installFetchMock,
  installPublicDns,
  jsonResponse,
  redirectResponse,
  stalledJsonFetch,
  streamResponse,
} from "@/test-utils/fetch-mock";

const MP4_URL = "https://samplelib.com/lib/preview/mp4/sample.mp4";
const WEBM_URL = "https://samplelib.com/lib/preview/webm/sample.webm";
const M4A_URL = "https://samplelib.com/lib/preview/m4a/sample.m4a";
const MP3_URL = "https://samplelib.com/lib/preview/mp3/sample.mp3";
const YOUTUBE_URL = "https://www.youtube.com/shorts/dQw4w9WgXcQ";

const OEMBED = {
  title: "Real YouTube title",
  author_name: "Real channel",
  thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  provider_name: "YouTube",
  type: "video",
};

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/media-info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function downloadReq(body: unknown, signal?: AbortSignal): NextRequest {
  return new NextRequest("http://localhost/api/download", {
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

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];

    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

async function leftoverTempDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith("media-downloader-"));
}

type MediaResponse = {
  success: boolean;
  media: {
    title: string | null;
    duration: number | null;
    thumbnail: string | null;
    sourceType: string;
    sourceLabel: string;
    author: string | null;
    metadataProvider: string | null;
    downloadSupported: boolean;
    limitation: string | null;
    notes: string[];
    formats: Array<{
      id: string;
      container: string;
      label: string;
      resolution: string | null;
      videoCodec: string | null;
      audioCodec: string | null;
      filesize: number | null;
      bitrate: string | null;
      sourceAudioBitrate: string | null;
      hasVideo: boolean;
      hasAudio: boolean;
      conversion: boolean;
    }>;
  };
};

async function inspect(url: string): Promise<{ response: Response; payload: MediaResponse }> {
  const response = await info(req({ url }));
  const payload = (await response.json()) as MediaResponse;

  return { response, payload };
}

/** Fetch a download response and persist it so ffprobe can verify the bytes. */
async function downloadToFile(response: Response): Promise<{ dir: string; path: string; bytes: Buffer }> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "download-result-"));
  const path = join(dir, "result.bin");
  await writeFile(path, bytes);

  return { dir, path, bytes };
}

test("inspects a real MP4 and reports verified, content-bound formats", async () => {
  const body = await mediaFixture("av-mp4");

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const { response, payload } = await inspect(MP4_URL);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(payload.success, true);
      assert.equal(payload.media.sourceType, "direct-media");
      assert.equal(payload.media.sourceLabel, "Direct media file");
      assert.equal(payload.media.downloadSupported, true);
      assert.equal(payload.media.thumbnail, null);
      assert.ok(payload.media.duration !== null && Math.abs(payload.media.duration - 1.5) < 0.3);

      const mp4 = payload.media.formats.find((format) => format.container === "mp4" && !format.conversion);
      assert.ok(mp4, "expected an original MP4 format");
      assert.equal(mp4.resolution, "96p");
      assert.equal(mp4.videoCodec, "h264");
      assert.equal(mp4.audioCodec, "aac");
      assert.equal(mp4.hasVideo, true);
      assert.equal(mp4.hasAudio, true);
      assert.equal(mp4.filesize, body.byteLength);
      assert.equal(mp4.conversion, false);

      const mp3 = payload.media.formats.filter((format) => format.container === "mp3");
      assert.ok(mp3.length >= 2, "expected selectable MP3 bitrates");
      assert.ok(mp3.every((format) => format.conversion && !format.hasVideo && format.hasAudio));
      assert.ok(mp3.some((format) => format.filesize !== null), "the verified bitrate must carry its real size");
      assert.ok(mp3.some((format) => format.bitrate === "192k"));
      // The source audio bitrate is reported separately from the target bitrate.
      assert.ok(mp3.every((format) => format.sourceAudioBitrate !== format.bitrate));

      // Every advertised id must be a valid, content-bound id.
      for (const format of payload.media.formats) {
        const decoded = decodeFormatId(format.id);
        assert.ok(decoded, `invalid id ${format.id}`);
        assert.equal(decoded.spec.container, format.container);
      }
    },
  );

  assert.deepEqual(await leftoverTempDirs(), []);
});

test("downloads the reported MP4 byte-for-byte with attachment headers", async () => {
  const body = await mediaFixture("av-mp4");

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const { payload } = await inspect(MP4_URL);
      const mp4 = payload.media.formats.find((format) => format.container === "mp4" && !format.conversion);
      assert.ok(mp4);

      const response = await download(downloadReq({ url: MP4_URL, formatId: mp4.id, outputFormat: "mp4" }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "video/mp4");
      assert.equal(response.headers.get("content-length"), String(body.byteLength));
      assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="sample\.mp4"/);
      assert.equal(response.headers.get("cache-control"), "no-store, no-transform");

      const { dir, bytes } = await downloadToFile(response);
      try {
        assert.deepEqual(bytes, Buffer.from(body));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  assert.deepEqual(await leftoverTempDirs(), []);
});

test("produces a genuine MP3 at the selected bitrate (320 kbps)", async () => {
  const body = await mediaFixture("av-mp4");

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const { payload } = await inspect(MP4_URL);
      const target = payload.media.formats.find((format) => format.container === "mp3" && format.bitrate === "320k");
      assert.ok(target, "expected a 320 kbps MP3 option");

      const response = await download(downloadReq({ url: MP4_URL, formatId: target.id, outputFormat: "mp3" }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      assert.match(response.headers.get("content-disposition") ?? "", /filename="sample\.mp3"/);

      const { dir, path, bytes } = await downloadToFile(response);
      try {
        assert.ok(bytes.length > 1000);
        // ID3 tag or an MPEG frame sync — never HTML or MP4 bytes.
        const head = bytes.subarray(0, 3).toString("latin1");
        assert.ok(head === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0), `unexpected MP3 header ${head}`);
        const probe = await probeWithFfprobe(path);
        const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
        assert.equal(audio?.codec_name, "mp3");
        const kbps = Math.round(Number(audio?.bit_rate ?? 0) / 1000);
        assert.ok(Math.abs(kbps - 320) <= 32, `expected ~320 kbps, got ${kbps}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

test("reports WebM as WebM and never invents an MP4 stream", async () => {
  const body = await mediaFixture("video-webm");

  await withNetwork(
    () => streamResponse([body], { contentType: "video/webm", contentLength: body.byteLength }),
    async () => {
      const { payload } = await inspect(WEBM_URL);
      assert.equal(payload.media.formats.length, 1);
      const webm = payload.media.formats[0];
      assert.equal(webm.container, "webm");
      assert.equal(webm.videoCodec, "vp8");
      assert.equal(webm.hasAudio, false);
      assert.equal(webm.filesize, body.byteLength);

      const response = await download(downloadReq({ url: WEBM_URL, formatId: webm.id, outputFormat: "webm" }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "video/webm");
      const { dir, bytes } = await downloadToFile(response);
      try {
        assert.deepEqual(bytes, Buffer.from(body));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

test("reports M4A audio with its original container and honest MP3 conversions", async () => {
  const body = await mediaFixture("audio-m4a");

  await withNetwork(
    () => streamResponse([body], { contentType: "audio/mp4", contentLength: body.byteLength }),
    async () => {
      const { payload } = await inspect(M4A_URL);
      const original = payload.media.formats.find((format) => format.container === "m4a");
      assert.ok(original);
      assert.equal(original.hasVideo, false);
      assert.equal(original.audioCodec, "aac");
      assert.equal(original.filesize, body.byteLength);
      assert.equal(original.conversion, false);

      const mp3 = payload.media.formats.filter((format) => format.container === "mp3");
      assert.ok(mp3.length > 0);
      assert.ok(payload.media.formats.every((format) => !format.hasVideo));
    },
  );
});

test("reports an MP3 source with exactly one original format", async () => {
  const body = await mediaFixture("audio-mp3");

  await withNetwork(
    () => streamResponse([body], { contentType: "audio/mpeg", contentLength: body.byteLength }),
    async () => {
      const { payload } = await inspect(MP3_URL);
      assert.equal(payload.media.formats.length, 1);
      const mp3 = payload.media.formats[0];
      assert.equal(mp3.container, "mp3");
      assert.equal(mp3.conversion, false);
      assert.equal(mp3.bitrate, "128k");

      const response = await download(downloadReq({ url: MP3_URL, formatId: mp3.id, outputFormat: "mp3" }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      const { dir, bytes } = await downloadToFile(response);
      try {
        assert.deepEqual(bytes, Buffer.from(body));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

test("rejects fabricated, cross-file and mismatched format ids", async () => {
  const body = await mediaFixture("av-mp4");

  await withNetwork(
    () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
    async () => {
      const { payload } = await inspect(MP4_URL);
      const mp4 = payload.media.formats.find((format) => format.container === "mp4");
      assert.ok(mp4);

      const cases: Array<[Record<string, unknown>, string]> = [
        [{ url: MP4_URL, formatId: "made-up", outputFormat: "mp4" }, "INVALID_FORMAT"],
        [{ url: MP4_URL, formatId: `v1.${"0".repeat(64)}.mp4.orig`, outputFormat: "mp4" }, "INVALID_FORMAT"],
        [{ url: MP4_URL, formatId: mp4.id, outputFormat: "mp3" }, "INVALID_FORMAT"],
        [{ url: MP4_URL, formatId: `v1.${"0".repeat(64)}.mp3.conv.999`, outputFormat: "mp3" }, "INVALID_FORMAT"],
        [{ url: MP4_URL, outputFormat: "mp4" }, "INVALID_FORMAT"],
        [{ url: MP4_URL, formatId: mp4.id, outputFormat: "avi" }, "INVALID_FORMAT"],
      ];

      for (const [requestBody, code] of cases) {
        const response = await download(downloadReq(requestBody));
        assert.equal(response.status, 400, JSON.stringify(requestBody));
        const payloadError = (await response.json()) as { code?: string; success?: boolean };
        assert.equal(payloadError.code, code);
        assert.equal(payloadError.success, false);
      }
    },
  );
});

test("unsupported hosts produce a specific, non-generic error", async () => {
  const { response, payload } = await inspect("https://example.com/video.mp4");

  assert.equal(response.status, 422);
  assert.equal((payload as unknown as { code?: string }).code, "UNSUPPORTED_SOURCE");
  assert.match((payload as unknown as { error?: string }).error ?? "", /approved hosts/);
});

test("returns YouTube metadata but correctly reports that download is unavailable", async () => {
  await withNetwork(
    () => jsonResponse(OEMBED),
    async () => {
      const { response, payload } = await inspect(YOUTUBE_URL);

      assert.equal(response.status, 200);
      assert.equal(payload.media.sourceType, "youtube");
      assert.equal(payload.media.title, "Real YouTube title");
      assert.equal(payload.media.author, "Real channel");
      assert.equal(payload.media.thumbnail, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
      assert.equal(payload.media.downloadSupported, false);
      assert.deepEqual(payload.media.formats, []);
      assert.match(payload.media.limitation ?? "", /cannot be downloaded/i);
      assert.doesNotMatch(payload.media.limitation ?? "", /extractor/i);

      const attempt = await download(
        downloadReq({ url: YOUTUBE_URL, formatId: `v1.${"a".repeat(64)}.mp4.orig`, outputFormat: "mp4" }),
      );
      assert.equal(attempt.status, 422);
      const failure = (await attempt.json()) as { code?: string; error?: string };
      assert.equal(failure.code, "UNSUPPORTED_SOURCE");
      assert.match(failure.error ?? "", /YouTube media files cannot be downloaded/);
    },
  );
});

test("explains disabled YouTube metadata instead of a generic extractor error", async () => {
  await withEnv({ MEDIA_DOWNLOADER_YOUTUBE_METADATA: "off" }, async () => {
    const { response, payload } = await inspect(YOUTUBE_URL);

    assert.equal(response.status, 422);
    assert.equal((payload as unknown as { code?: string }).code, "UNSUPPORTED_SOURCE");
    assert.match((payload as unknown as { error?: string }).error ?? "", /metadata lookup is disabled/i);
  });
});

test("rejects malformed requests with safe 400s", async () => {
  for (const body of [{}, { url: 123 }, { url: "" }, { url: "not-a-url" }]) {
    const response = await info(req(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    const payload = (await response.json()) as { success: boolean; code?: string };
    assert.equal(payload.success, false);
    assert.ok(payload.code);
  }

  const broken = new NextRequest("http://localhost/api/media-info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const response = await info(broken);
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code?: string }).code, "INVALID_BODY");

  const oversized = new NextRequest("http://localhost/api/media-info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "x".repeat(2000) }),
  });
  assert.equal((await info(oversized)).status, 400);
});

test("maps upstream failures to distinct status codes without leaking internals", async () => {
  const dns = installPublicDns();

  try {
    let restore = installFetchMock(() => new Response(null, { status: 404 }));
    let response = await info(req({ url: MP4_URL }));
    assert.equal(response.status, 404);
    let payload = (await response.json()) as { code?: string; error?: string };
    assert.equal(payload.code, "UPSTREAM_NOT_FOUND");
    assert.doesNotMatch(payload.error ?? "", /\/tmp\/|stack trace|at Object\.|Error:/);
    restore();

    restore = installFetchMock(() => streamResponse([new Uint8Array(16)], { contentType: "text/html" }));
    response = await info(req({ url: MP4_URL }));
    assert.equal(response.status, 415);
    assert.equal(((await response.json()) as { code?: string }).code, "NOT_MEDIA");
    restore();

    restore = installFetchMock(() => streamResponse([new Uint8Array([1])], { contentLength: 100_000_000 }));
    response = await info(req({ url: MP4_URL }));
    assert.equal(response.status, 413);
    restore();

    restore = installFetchMock(() => redirectResponse("http://127.0.0.1/steal.mp4"));
    response = await info(req({ url: MP4_URL }));
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code?: string }).code, "UNSAFE_URL");
    restore();
  } finally {
    dns();
  }
});

test("returns 504 when the upstream stalls", async () => {
  await withEnv({ MEDIA_DOWNLOADER_REQUEST_TIMEOUT_MS: "1000" }, async () => {
    const dns = installPublicDns();
    const restore = installFetchMock((_url, init) => stalledJsonFetch(_url, init));

    try {
      const response = await info(req({ url: MP4_URL }));
      assert.equal(response.status, 504);
      assert.equal(((await response.json()) as { code?: string }).code, "UPSTREAM_TIMEOUT");
    } finally {
      restore();
      dns();
    }
  });
});

test("GET is not allowed", async () => {
  const response = infoGet();

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(((await response.json()) as { code?: string }).code, "METHOD_NOT_ALLOWED");
});

test("requires ffprobe and reports the missing dependency by name", async () => {
  const body = await mediaFixture("av-mp4");
  const previous = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = "/missing/ffprobe";

  const dns = installPublicDns();
  const restore = installFetchMock(() => streamResponse([body], { contentType: "video/mp4" }));

  try {
    const response = await info(req({ url: MP4_URL }));
    assert.equal(response.status, 503);
    assert.match(((await response.json()) as { error?: string }).error ?? "", /ffprobe/i);
  } finally {
    restore();
    dns();

    if (previous === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = previous;
  }
});

test("reads the real file path and keeps temp storage clean", async () => {
  const body = await mediaFixture("audio-mp3");

  await withNetwork(
    () => streamResponse([body], { contentType: "audio/mpeg", contentLength: body.byteLength }),
    async () => {
      await inspect(MP3_URL);
    },
  );

  assert.deepEqual(await leftoverTempDirs(), []);
});

test("does not advertise MP3 when the encoder fails, and explains the failure", async () => {
  const { mkdtemp: makeDir, writeFile: write, chmod, rm: remove } = await import("node:fs/promises");
  const dir = await makeDir(join(tmpdir(), "fake-ffmpeg-"));
  const script = join(dir, "ffmpeg");
  const body = await mediaFixture("av-mp4");
  const { resetFfmpegCache } = await import("@/lib/ffmpeg");

  // A binary that reports a version (so it is "available") but cannot encode.
  await write(script, '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "-version" ]; then echo "ffmpeg version 0-fake"; exit 0; fi; done\necho "Unknown encoder libmp3lame" >&2\nexit 1\n');
  await chmod(script, 0o755);
  resetFfmpegCache();

  try {
    await withEnv({ FFMPEG_PATH: script }, async () => {
      await withNetwork(
        () => streamResponse([body], { contentType: "video/mp4", contentLength: body.byteLength }),
        async () => {
          const { response, payload } = await inspect(MP4_URL);

          assert.equal(response.status, 200);
          assert.ok(payload.media.formats.length > 0);
          assert.equal(payload.media.formats.filter((format) => format.container === "mp3").length, 0);
          assert.ok(payload.media.notes.some((note) => /MP3 conversion failed/i.test(note)));
        },
      );
    });
  } finally {
    resetFfmpegCache();
    await remove(dir, { recursive: true, force: true });
  }
});
