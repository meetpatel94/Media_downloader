import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as info } from "@/app/api/media-info/route";
import { POST as download } from "@/app/api/download/route";
import { installFetchMock, installPublicDns, streamResponse, redirectResponse } from "@/test-utils/fetch-mock";
const url = "https://samplelib.com/video.mp4";
function req(body: unknown) { return new NextRequest("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fixture-"));
  try {
    const binary = (await import("@ffmpeg-installer/ffmpeg")).path;
    const path = join(dir, "input.mp4");
    const result = spawnSync(binary, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
    assert.equal(result.status, 0, result.stderr.toString());
    return await readFile(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test("inspection and verified MP4/MP3 downloads use real media", async () => {
  const data = await fixture(); const dns = installPublicDns(); const fetch = installFetchMock(() => streamResponse([data], { contentType: "video/mp4" }));
  try {
    const res = await info(req({ url })); assert.equal(res.status, 200, await res.clone().text());
    const { media } = await res.json(); assert.equal(media.sourceType, "direct-media");
    const mp4 = media.formats.find((f: { container: string }) => f.container === "mp4");
    const mp3 = media.formats.find((f: { container: string }) => f.container === "mp3");
    assert.equal(mp4.resolution, "48p"); assert.equal(mp4.videoCodec, "h264"); assert.equal(mp4.hasAudio, true); assert.ok(mp3);
    for (const f of [mp4, mp3]) { const output = await download(req({ url, formatId: f.id, outputFormat: f.container })); assert.equal(output.status, 200, await output.clone().text()); const bytes = Buffer.from(await output.arrayBuffer()); assert.ok(bytes.length > 100); assert.equal(output.headers.get("content-type"), f.container === "mp4" ? "video/mp4" : "audio/mpeg"); }
    const invalid = await download(req({ url, formatId: "made-up", outputFormat: "mp4" })); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, "INVALID_FORMAT");
  } finally { fetch(); dns(); }
});
test("request errors and unsupported platforms are actionable", async () => {
  assert.equal((await info(req({ url: "not a url" }))).status, 400);
  assert.equal((await info(req({ url: "https://youtu.be/abcdefghijk" }))).status, 422);
  assert.equal((await download(req({ url, formatId: "", outputFormat: "mp4" }))).status, 400);
  assert.equal((await info(req({ url: "https://127.0.0.1/a.mp4" }))).status, 400);
});
test("inspection blocks unsafe redirects and oversized files", async () => {
  const dns = installPublicDns(); let restore = installFetchMock(() => redirectResponse("http://127.0.0.1/file.mp4"));
  try { assert.equal((await info(req({ url }))).status, 400); restore(); restore = installFetchMock(() => streamResponse([new Uint8Array([1])], { contentLength: 100000000 })); assert.equal((await info(req({ url }))).status, 413); } finally { restore(); dns(); }
});
test("missing ffprobe yields a safe dependency error", async () => {
  const data = await fixture(); const dns = installPublicDns(); const fetch = installFetchMock(() => streamResponse([data], { contentType: "video/mp4" })); const old = process.env.FFPROBE_PATH; process.env.FFPROBE_PATH = "/missing/probe";
  try { const response = await info(req({ url })); assert.equal(response.status, 503); assert.match((await response.json()).error, /ffprobe/i); } finally { if (old === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = old; fetch(); dns(); }
});
test("direct MP3 is inspected and downloaded without invented video", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audio-fixture-"));
  try {
    const binary = (await import("@ffmpeg-installer/ffmpeg")).path; const path = join(dir, "sound.mp3");
    const generated = spawnSync(binary, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", path]); assert.equal(generated.status, 0);
    const data = await readFile(path); const dns = installPublicDns(); const fetch = installFetchMock(() => streamResponse([data], { contentType: "audio/mpeg" }));
    try { const response = await info(req({ url })); assert.equal(response.status, 200); const { media } = await response.json(); assert.equal(media.formats.length, 1); assert.equal(media.formats[0].hasVideo, false); assert.equal(media.formats[0].audioCodec, "mp3"); const result = await download(req({ url, formatId: media.formats[0].id, outputFormat: "mp3" })); assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), data); } finally { fetch(); dns(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
