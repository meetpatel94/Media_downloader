import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySource,
  DIRECT_MEDIA_HOSTS,
  extractYouTubeVideoId,
  getSupportedHosts,
  isAllowedDirectHost,
  isPlatformHost,
} from "@/lib/sources";

const ID = "dQw4w9WgXcQ";

function classify(url: string) {
  return classifySource(new URL(url));
}

test("allows every declared direct-media host", () => {
  for (const host of DIRECT_MEDIA_HOSTS) {
    assert.equal(isAllowedDirectHost(host), true, host);
  }
});

test("allows www variants and subdomains of the canonical media hosts", () => {
  for (const host of ["samplelib.com", "file-examples.com", "sample-videos.com", "archive.org"]) {
    assert.equal(isAllowedDirectHost(`www.${host}`), true, `www.${host}`);
    assert.equal(isAllowedDirectHost(`cdn.${host}`), true, `cdn.${host}`);
  }
});

test("does not allow arbitrary hosts", () => {
  for (const host of ["example.com", "evil.test", "samplelib.com.evil.test", "youtube.com"]) {
    assert.equal(isAllowedDirectHost(host), false, host);
  }
});

test("classifies a direct media URL with its extension", () => {
  const result = classify("https://download.samplelib.com/mp3/sample-3s.mp3");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source.kind, "direct");
    assert.equal(result.source.extension, ".mp3");
  }
});

test("classifies web pages on allowed hosts as direct sources (extension unknown)", () => {
  const result = classify("https://samplelib.com/");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source.kind, "direct");
    assert.equal(result.source.extension, null);
  }
});

test("extracts video ids from every supported YouTube URL shape", () => {
  const urls = [
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share&t=3`,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?list=PL123&v=${ID}&index=2`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=tracking`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://WWW.YouTube.com./shorts/${ID}`,
  ];

  for (const url of urls) {
    const parsed = new URL(url);
    assert.equal(isPlatformHost(parsed.hostname), true, url);
    const source = extractYouTubeVideoId(parsed);
    assert.ok(source, `expected id for ${url}`);
    assert.equal(source?.videoId, ID, url);
  }
});

test("rejects YouTube URLs without a valid 11-character video id", () => {
  const urls = [
    "https://www.youtube.com/playlist?list=PL1234567890",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/shorts/too-short",
    "https://www.youtube.com/watch?v=badid",
    "https://youtu.be/",
    "https://www.youtube.com/results?search_query=cats",
  ];

  for (const url of urls) {
    assert.equal(extractYouTubeVideoId(new URL(url)), null, url);
    const result = classify(url);
    assert.equal(result.ok, false, url);
  }
});

test("supported host list includes direct hosts and platform hosts", () => {
  const hosts = getSupportedHosts();
  assert.ok(hosts.includes("samplelib.com"));
  assert.ok(hosts.includes("youtu.be"));
  assert.ok(hosts.includes("www.youtube.com"));
});
