// The DOM environment must be installed before react-dom is evaluated.
import { setupDom, type DomHarness } from "@/test-utils/dom";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DownloaderForm, filenameFromDisposition } from "@/components/downloader-form";

const originalFetch = globalThis.fetch;

async function renderForm(): Promise<{ dom: DomHarness; root: Root }> {
  const dom = setupDom();
  const root = createRoot(dom.container);

  await act(async () => {
    root.render(<DownloaderForm />);
  });

  return { dom, root };
}

async function cleanup(root: Root, dom: DomHarness) {
  await act(async () => {
    root.unmount();
  });
  dom.cleanup();
  globalThis.fetch = originalFetch;
}

async function submitWith(dom: DomHarness, url: string, format: "mp4" | "mp3" = "mp4") {
  await act(async () => {
    dom.setTextareaValue("media-url", url);
    dom.selectOption("format", format);
  });

  await act(async () => {
    dom.submitForm();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("filenameFromDisposition prefers the RFC 5987 filename", () => {
  assert.equal(
    filenameFromDisposition("attachment; filename=\"sample.mp4\"; filename*=UTF-8''sample%20video.mp4", "mp4"),
    "sample video.mp4",
  );
  assert.equal(filenameFromDisposition('attachment; filename="plain.mp4"', "mp4"), "plain.mp4");
  assert.equal(filenameFromDisposition('attachment; filename=unquoted.mp4', "mp4"), "unquoted.mp4");
  assert.equal(filenameFromDisposition(null, "mp3"), "media-download.mp3");
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", "mp4"), "media-download.mp4");
});

test("renders the minimal accessible interface", async () => {
  const { dom, root } = await renderForm();

  try {
    const textarea = dom.document.getElementById("media-url") as HTMLTextAreaElement;
    assert.ok(textarea, "textarea should exist");
    assert.equal(textarea.tagName, "TEXTAREA");

    const label = dom.document.querySelector('label[for="media-url"]');
    assert.ok(label, "textarea needs a label");

    const select = dom.document.getElementById("format") as HTMLSelectElement;
    assert.deepEqual(
      Array.from(select.options).map((option) => option.value),
      ["mp4", "mp3"],
    );
    assert.equal(dom.document.querySelector('label[for="format"]')?.textContent, "Format");

    assert.equal(dom.button().textContent?.trim(), "Download");
    assert.equal(dom.button().disabled, false);

    const status = dom.document.getElementById("download-status");
    assert.equal(status?.getAttribute("aria-live"), "polite");
    assert.equal(status?.getAttribute("role"), "status");
  } finally {
    await cleanup(root, dom);
  }
});

test("shows an error for an empty URL and does not call the API", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await submitWith(dom, "");
    assert.match(dom.statusText(), /Please paste a media URL\./);
    assert.equal(called, false);
    assert.equal(dom.button().disabled, false);
  } finally {
    await cleanup(root, dom);
  }
});

test("shows an error for a malformed URL and a non-http protocol", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("{}");
  }) as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await submitWith(dom, "not-a-url");
    assert.match(dom.statusText(), /valid http/);

    await submitWith(dom, "ftp://example.com/video.mp4");
    assert.match(dom.statusText(), /valid http/);
    assert.equal(calls, 0);
  } finally {
    await cleanup(root, dom);
  }
});

test("disables the button and shows a loading state while processing", async () => {
  let resolveResponse: ((value: Response) => void) | undefined;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    })) as unknown as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await act(async () => {
      dom.setTextareaValue("media-url", "https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
    });

    await act(async () => {
      dom.submitForm();
      await Promise.resolve();
    });

    assert.equal(dom.button().disabled, true);
    assert.match(dom.button().textContent ?? "", /Downloading/);
    assert.match(dom.statusText(), /Downloading/);
    assert.equal((dom.document.getElementById("media-url") as HTMLTextAreaElement).disabled, true);

    // A second submit while in flight must not issue a second request.
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("{}");
    }) as typeof fetch;

    await act(async () => {
      dom.submitForm();
      await Promise.resolve();
    });
    assert.equal(fetchCount, 0);

    const blob = new Blob([new Uint8Array([0, 0, 0, 0x18])], { type: "video/mp4" });
    await act(async () => {
      resolveResponse?.(
        new Response(blob, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-disposition": "attachment; filename=\"sample-5s.mp4\"",
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    assert.equal(dom.button().disabled, false);
  } finally {
    await cleanup(root, dom);
  }
});

test("surfaces API errors to the user", async () => {
  globalThis.fetch = (async () =>
    Response.json({ error: "The media file was not found at that URL.", code: "UPSTREAM_NOT_FOUND" }, { status: 404 })) as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await submitWith(dom, "https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
    assert.equal(dom.statusText(), "The media file was not found at that URL.");
    assert.equal(dom.button().disabled, false);
    assert.equal(dom.clicks.length, 0);
  } finally {
    await cleanup(root, dom);
  }
});

test("handles a non-JSON API failure body", async () => {
  globalThis.fetch = (async () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })) as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await submitWith(dom, "https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
    assert.equal(dom.statusText(), "Download failed. Please try again.");
  } finally {
    await cleanup(root, dom);
  }
});

test("handles network failures and rejects non-media success bodies", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await submitWith(dom, "https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
    assert.equal(dom.statusText(), "Failed to fetch");

    globalThis.fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    await submitWith(dom, "https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
    assert.match(dom.statusText(), /did not return a media file/);
    assert.equal(dom.clicks.length, 0);
  } finally {
    await cleanup(root, dom);
  }
});

test("starts a download for a valid MP3 response and reports the filename", async () => {
  const blob = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], { type: "audio/mpeg" });

  globalThis.fetch = (async () =>
    new Response(blob, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-disposition": "attachment; filename=\"clip.mp3\"; filename*=UTF-8''clip%20final.mp3",
      },
    })) as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await submitWith(dom, "https://samplelib.com/lib/preview/mp4/sample-5s.mp4", "mp3");

    assert.match(dom.statusText(), /Download started: clip final\.mp3/);
    assert.equal(dom.clicks.length, 1);
    assert.equal(dom.clicks[0].download, "clip final.mp3");
    assert.match(dom.clicks[0].href, /^blob:/);

    // The object URL is released once the browser had a chance to start the download.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.deepEqual(dom.liveObjectUrls(), [], "object URLs should be revoked after the download starts");
  } finally {
    await cleanup(root, dom);
  }
});

test("empty responses are not treated as successful downloads", async () => {
  globalThis.fetch = (async () =>
    new Response(new Blob([], { type: "video/mp4" }), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    })) as typeof fetch;

  const { dom, root } = await renderForm();

  try {
    await submitWith(dom, "https://samplelib.com/lib/preview/mp4/sample-5s.mp4");
    assert.match(dom.statusText(), /empty file/);
    assert.equal(dom.clicks.length, 0);
  } finally {
    await cleanup(root, dom);
  }
});

test("layout uses a responsive, overflow-safe container", async () => {
  const { dom, root } = await renderForm();

  try {
    const textarea = dom.document.getElementById("media-url");
    assert.match(textarea?.className ?? "", /\bw-full\b/);
    assert.match(textarea?.className ?? "", /\bmin-h|\brows\b|\bresize-y\b/);

    const button = dom.button();
    assert.match(button.className, /\bw-full\b/);
    assert.match(button.className, /focus-visible:ring/);
    assert.match(button.className, /disabled:/);

    const form = dom.document.querySelector("form");
    assert.match(form?.className ?? "", /\bsm:/, "form should scale spacing at larger breakpoints");
  } finally {
    await cleanup(root, dom);
  }
});
