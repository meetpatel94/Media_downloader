import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedMp3Bitrates,
  decodeFormatId,
  describeContainer,
  encodeFormatId,
  isOutputContainer,
} from "@/lib/formats";

const DIGEST = "a".repeat(64);

test("round-trips every supported original container", () => {
  for (const container of ["mp4", "webm", "m4a", "mp3"] as const) {
    const id = encodeFormatId(DIGEST, { kind: "original", container });
    assert.deepEqual(decodeFormatId(id), { digest: DIGEST, spec: { kind: "original", container } });
  }
});

test("round-trips MP3 conversions at every offered bitrate", () => {
  for (const bitrateKbps of allowedMp3Bitrates()) {
    const id = encodeFormatId(DIGEST, { kind: "transcode", container: "mp3", bitrateKbps });
    assert.deepEqual(decodeFormatId(id), {
      digest: DIGEST,
      spec: { kind: "transcode", container: "mp3", bitrateKbps },
    });
  }
});

test("round-trips a container-only conversion (MPEG-TS to MP4)", () => {
  const id = encodeFormatId(DIGEST, { kind: "transcode", container: "mp4" });
  assert.deepEqual(decodeFormatId(id), { digest: DIGEST, spec: { kind: "transcode", container: "mp4" } });
});

test("rejects fabricated and malformed format ids", () => {
  const rejected = [
    "",
    "mp4",
    "made-up",
    "v1." + DIGEST + ".mp4", // missing kind
    "v2." + DIGEST + ".mp4.orig", // wrong version
    "v1." + "a".repeat(63) + ".mp4.orig", // short digest
    "v1." + "a".repeat(64) + ".avi.orig", // unknown container
    "v1." + "a".repeat(64) + ".mp3.orig.192", // original with bitrate
    "v1." + "a".repeat(64) + ".mp3.conv", // conversion without bitrate
    "v1." + "a".repeat(64) + ".webm.conv", // webm conversion is not offered
    "v1." + "a".repeat(64) + ".mp3.conv.999", // bitrate outside the offered set
    "v1." + "a".repeat(64) + ".mp3.conv.abc",
    "v1." + "A".repeat(64) + ".mp4.orig", // digest must be lowercase hex
    `v1.${"a".repeat(64)}.mp4.orig.${"x".repeat(200)}`,
  ];

  for (const id of rejected) {
    assert.equal(decodeFormatId(id), null, `expected rejection: ${id}`);
  }
});

test("mp4 conversion ids are accepted without a bitrate", () => {
  assert.deepEqual(decodeFormatId(`v1.${DIGEST}.mp4.conv`), {
    digest: DIGEST,
    spec: { kind: "transcode", container: "mp4" },
  });
});

test("describes container content types and extensions", () => {
  assert.equal(describeContainer("mp4").contentType, "video/mp4");
  assert.equal(describeContainer("webm").contentType, "video/webm");
  assert.equal(describeContainer("m4a").contentType, "audio/mp4");
  assert.equal(describeContainer("mp3").contentType, "audio/mpeg");
  assert.equal(describeContainer("m4a").extension, "m4a");
});

test("validates output container names", () => {
  for (const value of ["mp4", "webm", "m4a", "mp3"]) assert.equal(isOutputContainer(value), true);
  for (const value of ["avi", "MP4", "", null, undefined, 4]) assert.equal(isOutputContainer(value), false);
});

test("offers sane MP3 bitrates", () => {
  const bitrates = allowedMp3Bitrates();
  assert.ok(bitrates.length >= 3);
  assert.ok(bitrates.every((value) => value >= 32 && value <= 320));
  assert.deepEqual([...bitrates].sort((a, b) => a - b), bitrates);
});
