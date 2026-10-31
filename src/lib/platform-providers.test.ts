import test from "node:test";
import assert from "node:assert/strict";
import {
  getPlatformProvider,
  listPlatformProviders,
} from "@/lib/platform-providers";

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

test("registers YouTube as an official metadata provider", () => {
  const provider = getPlatformProvider("youtube");

  assert.equal(provider.name, "youtube");
  assert.equal(provider.label, "YouTube video");
  assert.equal(typeof provider.fetchMetadata, "function");
});

test("provider registry reports independent metadata and download capabilities", async () => {
  await withEnv({ MEDIA_DOWNLOADER_YOUTUBE_METADATA: "on", YOUTUBE_API_KEY: undefined }, async () => {
    const providers = listPlatformProviders();
    assert.equal(providers.length, 1);

    const youtube = providers[0];
    assert.equal(youtube.name, "youtube");
    assert.equal(youtube.capabilities.metadata.supported, true);
    assert.equal(youtube.capabilities.download.supported, false);
    assert.match(youtube.capabilities.download.reason ?? "", /official APIs|licensed/i);
  });
});

test("provider registry respects the YouTube metadata opt-out", async () => {
  await withEnv({ MEDIA_DOWNLOADER_YOUTUBE_METADATA: "off" }, async () => {
    const youtube = listPlatformProviders().find((provider) => provider.name === "youtube");
    assert.ok(youtube);
    assert.equal(youtube.capabilities.metadata.supported, false);
    assert.equal(youtube.capabilities.download.supported, false);
  });
});
