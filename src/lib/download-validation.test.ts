import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeRemoteHost,
  isAllowedRedirect,
  MAX_URL_LENGTH,
  resolveAllowedRedirect,
  setHostLookupForTests,
  validateMediaUrl,
} from "@/lib/download-validation";
import { DownloadError } from "@/lib/errors";

test("rejects an empty URL", () => {
  const result = validateMediaUrl("");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "EMPTY_URL");
    assert.equal(result.message, "Please paste a media URL.");
  }
});

test("rejects whitespace-only URL", () => {
  const result = validateMediaUrl("   \n  ");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY_URL");
});

test("rejects a malformed URL", () => {
  const result = validateMediaUrl("not-a-url");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "INVALID_URL");
});

test("rejects unsupported protocols", () => {
  for (const url of ["ftp://samplelib.com/file.mp4", "file:///etc/passwd", "javascript:alert(1)", "data:video/mp4;base64,AAAA"]) {
    const result = validateMediaUrl(url);
    assert.equal(result.ok, false, `expected reject: ${url}`);
    if (!result.ok) assert.equal(result.code, "INVALID_URL");
  }
});

test("rejects oversized URLs", () => {
  const result = validateMediaUrl(`https://samplelib.com/${"a".repeat(MAX_URL_LENGTH)}.mp4`);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "URL_TOO_LONG");
});

test("rejects credentials embedded in the URL", () => {
  const result = validateMediaUrl("https://user:pass@samplelib.com/lib/preview/mp4/sample-5s.mp4");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNSAFE_URL");
});

test("rejects non-standard ports", () => {
  const result = validateMediaUrl("https://samplelib.com:8080/lib/preview/mp4/sample-5s.mp4");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNSAFE_URL");
});

test("accepts an allowed direct-media URL", () => {
  const result = validateMediaUrl("https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.url.hostname, "samplelib.com");
    assert.equal(result.source.kind, "direct");
    assert.equal(result.source.extension, ".mp4");
  }
});

test("accepts allowed subdomains and https www variants", () => {
  const result = validateMediaUrl("https://www.file-examples.com/download/Media/mp4/sample.mp4");
  assert.equal(result.ok, true);
});

test("rejects an unsupported host", () => {
  const result = validateMediaUrl("https://example.com/file.mp4");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "UNSUPPORTED_SOURCE");
    assert.equal(result.message, "This media source is not supported. Only direct media file URLs from approved hosts are supported.");
  }
});

test("rejects a host that merely contains an allowed host name", () => {
  const result = validateMediaUrl("https://samplelib.com.evil.example/file.mp4");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNSUPPORTED_SOURCE");
});

test("rejects localhost variants", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "app.localhost"]) {
    const result = validateMediaUrl(`http://${host}/file.mp4`);
    assert.equal(result.ok, false, `expected reject for ${host}`);
    if (!result.ok) assert.equal(result.code, "UNSAFE_URL", `code for ${host}`);
  }
});

test("rejects private, link-local and metadata IPv4 addresses", () => {
  const addresses = ["10.0.0.5", "192.168.1.10", "172.16.0.1", "169.254.169.254", "127.0.0.2", "100.64.1.1", "0.0.0.0"];

  for (const address of addresses) {
    const result = validateMediaUrl(`http://${address}/file.mp4`);
    assert.equal(result.ok, false, `expected reject for ${address}`);
    if (!result.ok) assert.equal(result.code, "UNSAFE_URL", `code for ${address}`);
  }
});

test("rejects IPv6 loopback and private addresses", () => {
  for (const address of ["[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[::ffff:127.0.0.1]"]) {
    const result = validateMediaUrl(`http://${address}/file.mp4`);
    assert.equal(result.ok, false, `expected reject for ${address}`);
    if (!result.ok) assert.equal(result.code, "UNSAFE_URL", `code for ${address}`);
  }
});

test("recognises YouTube Shorts, watch and youtu.be URLs as platform sources", () => {
  const cases: Array<[string, "short" | "watch"]> = [
    ["https://www.youtube.com/shorts/abcdefghijk", "short"],
    ["https://youtube.com/shorts/abcdefghijk?feature=share", "short"],
    ["https://www.youtube.com/watch?v=abcdefghijk&t=12s", "watch"],
    ["https://m.youtube.com/watch?v=abcdefghijk", "watch"],
    ["https://youtu.be/abcdefghijk", "watch"],
    ["https://music.youtube.com/watch?v=abcdefghijk", "watch"],
  ];

  for (const [url, variant] of cases) {
    const result = validateMediaUrl(url);
    assert.equal(result.ok, true, `expected accept for ${url}`);
    if (result.ok) {
      assert.equal(result.source.kind, "platform");
      assert.equal(result.source.platform?.name, "youtube");
      assert.equal(result.source.platform?.videoId, "abcdefghijk");
      assert.equal(result.source.platform?.variant, variant);
    }
  }
});

test("rejects YouTube URLs that are not single videos", () => {
  const playlist = validateMediaUrl("https://www.youtube.com/playlist?list=PL1234567890");
  assert.equal(playlist.ok, false);
  if (!playlist.ok) assert.equal(playlist.code, "NOT_MEDIA");

  const badId = validateMediaUrl("https://www.youtube.com/shorts/short");
  assert.equal(badId.ok, false);
});

test("resolves safe redirects and rejects unsafe ones", () => {
  const current = new URL("https://samplelib.com/lib/preview/mp4/sample-5s.mp4");

  const safe = resolveAllowedRedirect("/lib/preview/mp4/other.mp4", current);
  assert.equal(safe.hostname, "samplelib.com");

  const unsafeTargets = [
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "https://evil.example/video.mp4",
    "file:///etc/passwd",
    "https://www.youtube.com/shorts/abcdefghijk",
  ];

  for (const target of unsafeTargets) {
    assert.equal(isAllowedRedirect(target, current), false, `expected blocked redirect: ${target}`);
    assert.throws(() => resolveAllowedRedirect(target, current), DownloadError);
  }
});

test("assertSafeRemoteHost rejects hostnames resolving to private addresses", async () => {
  setHostLookupForTests(async () => [{ address: "10.0.0.1" }]);

  try {
    await assert.rejects(assertSafeRemoteHost(new URL("https://samplelib.com/file.mp4")), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UNSAFE_URL");
      return true;
    });
  } finally {
    setHostLookupForTests(null);
  }
});

test("assertSafeRemoteHost rejects mixed public/private DNS answers", async () => {
  setHostLookupForTests(async () => [{ address: "93.184.216.34" }, { address: "192.168.0.10" }]);

  try {
    await assert.rejects(assertSafeRemoteHost(new URL("https://samplelib.com/file.mp4")));
  } finally {
    setHostLookupForTests(null);
  }
});

test("assertSafeRemoteHost accepts public addresses and treats DNS failures as upstream errors", async () => {
  setHostLookupForTests(async () => [{ address: "93.184.216.34" }]);
  try {
    await assertSafeRemoteHost(new URL("https://samplelib.com/file.mp4"));
  } finally {
    setHostLookupForTests(null);
  }

  setHostLookupForTests(async () => {
    throw new Error("ENOTFOUND");
  });

  try {
    await assert.rejects(assertSafeRemoteHost(new URL("https://samplelib.com/file.mp4")), (error: unknown) => {
      assert.ok(error instanceof DownloadError);
      assert.equal(error.code, "UPSTREAM_ERROR");
      return true;
    });
  } finally {
    setHostLookupForTests(null);
  }
});

test("assertSafeRemoteHost blocks literal private IPs without consulting DNS", async () => {
  let called = false;
  setHostLookupForTests(async () => {
    called = true;
    return [{ address: "93.184.216.34" }];
  });

  try {
    await assert.rejects(assertSafeRemoteHost(new URL("http://192.168.0.1/file.mp4")));
    assert.equal(called, false);
  } finally {
    setHostLookupForTests(null);
  }
});
