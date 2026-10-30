import "@/test-utils/dom";
import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { DownloaderForm, filenameFromDisposition } from "@/components/downloader-form";

test("form is accessible and responsive, without invented format options", async () => {
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  await act(async () => { root.render(<DownloaderForm />); });
  assert.ok(container.querySelector('label[for="media-url"]')); assert.ok(container.querySelector('textarea'));
  assert.match(container.textContent || "", /Fetch Info/); assert.equal(container.querySelector("select"), null);
  assert.match(container.innerHTML, /w-full/); assert.match(container.innerHTML, /break-words/);
  await act(async () => { root.unmount(); }); container.remove();
});
test("safe filename fallback", () => { assert.equal(filenameFromDisposition(null, "mp3"), "media-download.mp3"); });
