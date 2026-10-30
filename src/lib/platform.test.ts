import test from "node:test";
import assert from "node:assert/strict";
import { DownloadError } from "@/lib/errors";
import {
  fetchYouTubeMetadata,
  parseIsoDuration,
  youTubeCapability,
} from "@/lib/platform";
import {
  installFetchMock,
  installPublicDns,
  jsonResponse,
  oversizedJsonResponse,
  stalledJsonFetch,
} from "@/test-utils/fetch-mock";

const VIDEO_ID = "dQw4w9WgXcQ";
const OEMBED_BODY = {
  title: "A real video title",
  author_name: "A real channel",
  author_url: "https://www.youtube.com/@channel",
  type: "video",
  thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  width: 480,
  height: 360,
  provider_name: "YouTube",
  html: "<iframe></iframe>",
};

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

async function withNetwork<T>(
  handler: Parameters<typeof installFetchMock>[0],
  run: () => Promise<T>,
): Promise<T> {
  const dns = installPublicDns();
  const restore = installFetchMock(handler);

  try {
    return await run();
  } finally {
    restore();
    dns();
  }
}

test("reads metadata from the official oEmbed endpoint without a key", async () => {
  const requested: Array<{ url: string; init: RequestInit }> = [];

  await withNetwork(
    (url, init) => {
      requested.push({ url, init });
      return jsonResponse(OEMBED_BODY);
    },
    async () => {
      const metadata = await fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal);

      assert.equal(metadata.title, "A real video title");
      assert.equal(metadata.author, "A real channel");
      assert.equal(metadata.thumbnail, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
      // oEmbed does not expose duration — it must stay null rather than be guessed.
      assert.equal(metadata.duration, null);
      assert.equal(metadata.provider, "youtube-oembed");
    },
  );

  assert.equal(requested.length, 1);
  const parsed = new URL(requested[0].url);
  assert.equal(parsed.origin, "https://www.youtube.com");
  assert.equal(parsed.pathname, "/oembed");
  assert.equal(parsed.searchParams.get("format"), "json");
  assert.equal(parsed.searchParams.get("url"), `https://www.youtube.com/watch?v=${VIDEO_ID}`);
  assert.equal(requested[0].init.method, "GET");
});

test("uses the YouTube Data API when a key is configured and parses the duration", async () => {
  const requested: string[] = [];

  await withEnv({ YOUTUBE_API_KEY: "test-key-not-real" }, async () => {
    await withNetwork(
      (url) => {
        requested.push(url);
        return jsonResponse({
          items: [
            {
              snippet: {
                title: "Data API title",
                channelTitle: "Data API channel",
                thumbnails: { maxres: { url: "https://i.ytimg.com/vi/x/maxres.jpg" } },
              },
              contentDetails: { duration: "PT1M3S" },
            },
          ],
        });
      },
      async () => {
        const metadata = await fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal);

        assert.equal(metadata.title, "Data API title");
        assert.equal(metadata.duration, 63);
        assert.equal(metadata.provider, "youtube-data-api");
        assert.equal(metadata.thumbnail, "https://i.ytimg.com/vi/x/maxres.jpg");
      },
    );
  });

  const parsed = new URL(requested[0]);
  assert.equal(parsed.origin, "https://www.googleapis.com");
  assert.equal(parsed.pathname, "/youtube/v3/videos");
  assert.equal(parsed.searchParams.get("id"), VIDEO_ID);
  // The key is sent server-side only; the returned metadata never contains it.
  assert.equal(parsed.searchParams.get("key"), "test-key-not-real");
});

test("falls back to oEmbed when the Data API is unavailable (quota exceeded)", async () => {
  const calls: string[] = [];

  await withEnv({ YOUTUBE_API_KEY: "quota-exhausted" }, async () => {
    await withNetwork(
      (url) => {
        calls.push(url);
        return url.includes("googleapis.com") ? new Response(null, { status: 403 }) : jsonResponse(OEMBED_BODY);
      },
      async () => {
        const metadata = await fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal);

        assert.equal(metadata.provider, "youtube-oembed");
        assert.equal(metadata.title, "A real video title");
      },
    );
  });

  assert.equal(calls.length, 2);
});

test("maps a missing or private video to a clear, non-generic error", async () => {
  for (const status of [404, 401]) {
    await withNetwork(
      () => new Response(null, { status }),
      async () => {
        await assert.rejects(fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal), (error: unknown) => {
          assert.ok(error instanceof DownloadError);
          assert.equal(error.code, "MEDIA_UNAVAILABLE");
          assert.equal(error.status, 422);
          assert.match(error.message, /not found|private/i);
          return true;
        });
      },
    );
  }
});

test("ignores thumbnails hosted outside YouTube's image CDNs", async () => {
  await withNetwork(
    () => jsonResponse({ ...OEMBED_BODY, thumbnail_url: "https://evil.example/tracker.gif?u=1" }),
    async () => {
      const metadata = await fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal);
      assert.equal(metadata.thumbnail, null);
    },
  );
});

test("rejects an oversized metadata response instead of buffering it", async () => {
  await withNetwork(
    () => oversizedJsonResponse(),
    async () => {
      await assert.rejects(fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "UPSTREAM_ERROR");
        return true;
      });
    },
  );
});

test("rejects invalid JSON from the metadata endpoint", async () => {
  await withNetwork(
    () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      await assert.rejects(fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "UPSTREAM_ERROR");
        return true;
      });
    },
  );
});

test("times out a stalled metadata endpoint", async () => {
  await withEnv({ MEDIA_DOWNLOADER_REQUEST_TIMEOUT_MS: "1000" }, async () => {
    await withNetwork(
      (_url, init) => stalledJsonFetch(_url, init),
      async () => {
        await assert.rejects(fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal), (error: unknown) => {
          assert.ok(error instanceof DownloadError);
          assert.equal(error.code, "UPSTREAM_TIMEOUT");
          return true;
        });
      },
    );
  });
});

test("does not follow redirects from the metadata endpoint", async () => {
  await withNetwork(
    () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/steal" } }),
    async () => {
      await assert.rejects(fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "UPSTREAM_ERROR");
        return true;
      });
    },
  );
});

test("rejects a malformed video id before any network call", async () => {
  let fetched = false;

  await withNetwork(
    () => {
      fetched = true;
      return jsonResponse(OEMBED_BODY);
    },
    async () => {
      await assert.rejects(fetchYouTubeMetadata("short", new AbortController().signal), (error: unknown) => {
        assert.ok(error instanceof DownloadError);
        assert.equal(error.code, "INVALID_URL");
        return true;
      });
    },
  );

  assert.equal(fetched, false);
});

test("reports metadata as disabled when the deployment opts out", async () => {
  await withEnv({ MEDIA_DOWNLOADER_YOUTUBE_METADATA: "off" }, async () => {
    const capability = youTubeCapability();
    assert.equal(capability.supported, false);
    assert.match(capability.reason ?? "", /disabled/i);

    await assert.rejects(fetchYouTubeMetadata(VIDEO_ID, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UNSUPPORTED_SOURCE");
      return true;
    });
  });
});

test("parses ISO-8601 durations", () => {
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("PT1M3S"), 63);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(parseIsoDuration("P1DT1S"), 86_401);
  assert.equal(parseIsoDuration("PT0S"), null);
  assert.equal(parseIsoDuration("P0D"), null);
  assert.equal(parseIsoDuration("nonsense"), null);
  assert.equal(parseIsoDuration(undefined), null);
});
