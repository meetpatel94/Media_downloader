import test from "node:test";
import assert from "node:assert/strict";
import { validateMediaUrl } from "@/lib/download-validation";

test("rejects empty URL", () => {
  const result = validateMediaUrl("");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, "Please paste a media URL.");
  }
});

test("rejects malformed URL", () => {
  const result = validateMediaUrl("not-a-url");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, "Please enter a valid URL.");
  }
});

test("rejects unsupported scheme", () => {
  const result = validateMediaUrl("ftp://samplelib.com/file.mp4");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, "Please enter a valid URL.");
  }
});

test("rejects unsupported host", () => {
  const result = validateMediaUrl("https://example.com/file.mp4");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, "This media source is not supported.");
  }
});

test("accepts supported host", () => {
  const result = validateMediaUrl("https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.url.hostname, "samplelib.com");
  }
});
