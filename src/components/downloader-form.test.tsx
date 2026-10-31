import "@/test-utils/dom";
import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { DownloaderForm, groupFormats, filenameFromDisposition, type Media } from "@/components/downloader-form";
import { setupDom, type DomHarness } from "@/test-utils/dom";

const DIGEST = "a".repeat(64);

const MEDIA: Media = {
  metadataAvailable: true,
  downloadAvailable: true,
  title: "Sample clip",
  duration: 95,
  thumbnail: null,
  sourceType: "direct-media",
  sourceLabel: "Direct media file",
  author: null,
  metadataProvider: null,
  downloadSupported: true,
  supportedConversions: ["mp3"],
  limitations: [],
  limitation: null,
  notes: [],
  formats: [
    {
      id: `v1.${DIGEST}.mp4.orig`,
      container: "mp4",
      label: "MP4 — 96p",
      resolution: "96p",
      videoCodec: "h264",
      audioCodec: "aac",
      filesize: 19853,
      bitrate: "20k",
      sourceAudioBitrate: "73k",
      hasVideo: true,
      hasAudio: true,
      conversion: false,
    },
    {
      id: `v1.${DIGEST}.mp3.conv.128`,
      container: "mp3",
      label: "MP3 — 128k",
      resolution: null,
      videoCodec: null,
      audioCodec: "mp3",
      filesize: 8000,
      bitrate: "128k",
      sourceAudioBitrate: "73k",
      hasVideo: false,
      hasAudio: true,
      conversion: true,
    },
    {
      id: `v1.${DIGEST}.mp3.conv.320`,
      container: "mp3",
      label: "MP3 — 320k",
      resolution: null,
      videoCodec: null,
      audioCodec: "mp3",
      filesize: null,
      bitrate: "320k",
      sourceAudioBitrate: "73k",
      hasVideo: false,
      hasAudio: true,
      conversion: true,
    },
  ],
};

type FetchCall = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

async function render(): Promise<{ harness: DomHarness; root: ReturnType<typeof createRoot>; unmount: () => Promise<void> }> {
  const harness = setupDom();
  const root = createRoot(harness.container);

  await act(async () => {
    root.render(<DownloaderForm />);
  });

  return {
    harness,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      harness.cleanup();
    },
  };
}

test("initial render is accessible and free of invented formats", async () => {
  const { harness, unmount } = await render();

  try {
    assert.ok(harness.container.querySelector('label[for="media-url"]'));
    assert.ok(harness.container.querySelector("textarea#media-url"));
    assert.match(harness.container.textContent ?? "", /Fetch Info/);
    assert.equal(harness.container.querySelector("#format"), null);
    assert.equal(harness.container.querySelector("#quality"), null);
    assert.equal(harness.container.querySelector("#media-heading"), null);
    assert.match(harness.container.innerHTML, /break-words/);
  } finally {
    await unmount();
  }
});

test("Fetch Info renders the server's real formats and quality choices", async () => {
  const network = mockFetch(() => Response.json({ success: true, media: MEDIA }));
  const { harness, unmount } = await render();

  try {
    await act(async () => {
      harness.setTextareaValue("media-url", "https://samplelib.com/a.mp4");
    });

    await act(async () => {
      harness.submitForm();
    });

    assert.equal(network.calls.length, 1);
    assert.equal(network.calls[0].url, "/api/media-info");
    assert.deepEqual(JSON.parse(String(network.calls[0].init.body)), { url: "https://samplelib.com/a.mp4" });

    const format = harness.document.getElementById("format") as HTMLSelectElement;
    assert.ok(format, "format selector must appear after inspection");
    assert.deepEqual(
      [...format.options].map((option) => option.value),
      ["mp4-original", "mp3-converted"],
    );
    assert.match(format.options[0].textContent ?? "", /MP4/);

    // The single MP4 variant needs no quality selector; MP3 has two bitrates.
    assert.equal(harness.document.getElementById("quality"), null);

    await act(async () => {
      harness.selectOption("format", "mp3-converted");
    });

    const quality = harness.document.getElementById("quality") as HTMLSelectElement;
    assert.ok(quality, "quality selector must appear for multiple MP3 bitrates");
    assert.deepEqual(
      [...quality.options].map((option) => option.textContent),
      ["128k (converted)", "320k (converted)"],
    );

    assert.match(harness.container.textContent ?? "", /Source audio bitrate: 73k → output 128k/);
    assert.match(harness.container.textContent ?? "", /File size: 7\.8 KB/);
  } finally {
    network.restore();
    await unmount();
  }
});

test("Download posts the selected, server-provided format id and triggers a real download", async () => {
  const network = mockFetch((url) => {
    if (url === "/api/media-info") return Response.json({ success: true, media: MEDIA });

    return new Response(new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x04])], { type: "audio/mpeg" }), {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-disposition": `attachment; filename="sample.mp3"; filename*=UTF-8''sample.mp3`,
      },
    });
  });

  const { harness, unmount } = await render();

  try {
    await act(async () => harness.setTextareaValue("media-url", "https://samplelib.com/a.mp4"));
    await act(async () => harness.submitForm());
    await act(async () => harness.selectOption("format", "mp3-converted"));
    await act(async () => harness.selectOption("quality", `v1.${DIGEST}.mp3.conv.320`));

    const downloadButton = [...harness.container.querySelectorAll("button")].find((button) => button.textContent === "Download");
    assert.ok(downloadButton, "download button must exist");

    await act(async () => {
      downloadButton.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true }));
    });

    const downloadCall = network.calls.find((call) => call.url === "/api/download");
    assert.ok(downloadCall);
    assert.deepEqual(JSON.parse(String(downloadCall.init.body)), {
      url: "https://samplelib.com/a.mp4",
      formatId: `v1.${DIGEST}.mp3.conv.320`,
      outputFormat: "mp3",
    });
    assert.equal(harness.clicks.length, 1);
    assert.equal(harness.clicks[0].download, "sample.mp3");
    assert.match(harness.statusText(), /Download started: sample\.mp3/);
  } finally {
    network.restore();
    await unmount();
  }
});

test("shows the server's specific error instead of claiming success", async () => {
  const network = mockFetch(() =>
    Response.json(
      {
        success: false,
        code: "UNSUPPORTED_SOURCE",
        error: "This media source is not supported. Only direct media file URLs from approved hosts are supported.",
      },
      { status: 422 },
    ),
  );

  const { harness, unmount } = await render();

  try {
    await act(async () => harness.setTextareaValue("media-url", "https://example.com/video.mp4"));
    await act(async () => harness.submitForm());

    assert.match(harness.statusText(), /Only direct media file URLs from approved hosts/);
    assert.equal(harness.document.getElementById("format"), null);
  } finally {
    network.restore();
    await unmount();
  }
});

test("a metadata-only source shows its metadata and explains the missing capability", async () => {
  const network = mockFetch(() =>
    Response.json({
      success: true,
      media: {
        ...MEDIA,
        metadataAvailable: true,
        downloadAvailable: false,
        supportedConversions: [],
        limitations: ["YouTube media files cannot be downloaded by this deployment."],
        sourceType: "youtube",
        sourceLabel: "YouTube video",
        title: "Real YouTube title",
        author: "Real channel",
        metadataProvider: "youtube-oembed",
        downloadSupported: false,
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        limitation: "YouTube media files cannot be downloaded by this deployment.",
        notes: ["YouTube media files cannot be downloaded by this deployment."],
        formats: [],
      },
    }),
  );

  const { harness, unmount } = await render();

  try {
    await act(async () => harness.setTextareaValue("media-url", "https://youtu.be/dQw4w9WgXcQ"));
    await act(async () => harness.submitForm());

    assert.match(harness.container.textContent ?? "", /Real YouTube title/);
    assert.match(harness.container.textContent ?? "", /Real channel/);
    assert.match(harness.container.textContent ?? "", /cannot be downloaded by this deployment/);
    assert.equal(harness.document.getElementById("format"), null);

    const thumbnail = harness.container.querySelector("img") as HTMLImageElement | null;
    assert.ok(thumbnail);
    assert.equal(thumbnail.getAttribute("src"), "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    assert.match(thumbnail.getAttribute("referrerpolicy") ?? "", /no-referrer/);
  } finally {
    network.restore();
    await unmount();
  }
});

test("shows the Download action for verified formats regardless of source type", async () => {
  const platformMedia: Media = {
    ...MEDIA,
    sourceType: "youtube",
    sourceLabel: "Configured video source",
    downloadAvailable: true,
  };
  const network = mockFetch((url) => {
    if (url === "/api/media-info") return Response.json({ success: true, media: platformMedia });
    return new Response(new Uint8Array([0, 0, 0, 1]), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-disposition": 'attachment; filename="source.mp4"',
      },
    });
  });
  const { harness, unmount } = await render();

  try {
    await act(async () => harness.setTextareaValue("media-url", "https://youtu.be/dQw4w9WgXcQ"));
    await act(async () => harness.submitForm());

    const downloadButton = [...harness.container.querySelectorAll("button")].find((button) => button.textContent === "Download");
    assert.ok(downloadButton, "verified server formats make Download visible even for a platform source");
  } finally {
    network.restore();
    await unmount();
  }
});

test("prevents duplicate submissions while a request is in flight", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const network = mockFetch(async () => {
    await gate;
    return Response.json({ success: true, media: MEDIA });
  });

  const { harness, unmount } = await render();

  try {
    harness.setTextareaValue("media-url", "https://samplelib.com/a.mp4");

    await act(async () => {
      harness.submitForm();
    });

    await act(async () => {
      harness.submitForm();
      harness.submitForm();
    });

    assert.equal(network.calls.length, 1, "only one request may be in flight");
    assert.equal(harness.button().disabled, true);
    assert.match(harness.button().textContent ?? "", /Working/);
    assert.match(harness.statusText(), /Inspecting media/);

    release?.();
    await act(async () => {
      await gate;
    });
  } finally {
    network.restore();
    await unmount();
  }
});

test("network failures surface a readable error", async () => {
  const network = mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  const { harness, unmount } = await render();

  try {
    await act(async () => harness.setTextareaValue("media-url", "https://samplelib.com/a.mp4"));
    await act(async () => harness.submitForm());

    assert.match(harness.statusText(), /Network request failed or was interrupted/);
  } finally {
    network.restore();
    await unmount();
  }
});

test("groups formats by container without inventing options", () => {
  const groups = groupFormats(MEDIA.formats);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].container, "mp4");
  assert.equal(groups[0].formats.length, 1);
  assert.equal(groups[1].container, "mp3");
  assert.equal(groups[1].formats.length, 2);
  assert.deepEqual(groupFormats([]), []);
});

test("safe filename fallback", () => {
  assert.equal(filenameFromDisposition(null, "mp3"), "media-download.mp3");
  assert.equal(filenameFromDisposition('attachment; filename="clip.mp4"', "mp4"), "clip.mp4");
});
