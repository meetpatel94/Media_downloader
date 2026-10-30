/**
 * Test helpers: deterministic fetch/AWS-free network mocking.
 *
 * Nothing in the test suite talks to a real third-party host.
 */

import { setHostLookupForTests } from "@/lib/download-validation";

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;
const PUBLIC_IP = "93.184.216.34";

/** Replace `globalThis.fetch`; returns a restore function. */
export function installFetchMock(handler: FetchHandler): () => void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Pretend every allowlisted host resolves to a public address. */
export function installPublicDns(): () => void {
  setHostLookupForTests(async () => [{ address: PUBLIC_IP }]);
  return () => setHostLookupForTests(null);
}

export function installPrivateDns(address = "10.1.2.3"): () => void {
  setHostLookupForTests(async () => [{ address }]);
  return () => setHostLookupForTests(null);
}

export function bytes(...parts: Array<Uint8Array | string>): Uint8Array {
  const buffers = parts.map((part) => (typeof part === "string" ? Buffer.from(part) : Buffer.from(part)));
  return new Uint8Array(Buffer.concat(buffers));
}

/** Minimal but structurally valid MP4 header (an `ftyp` box). */
export function fakeMp4Body(payload = "fake-video-payload"): Uint8Array {
  const size = new Uint8Array([0, 0, 0, 0x18]);
  return bytes(size, "ftypisom", new Uint8Array([0, 0, 2, 0]), "isomiso2", payload);
}

/** Minimal MP3 (frame sync) body. */
export function fakeMp3Body(payload = "fake-audio-payload"): Uint8Array {
  return bytes(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), payload);
}

export type StreamInit = {
  status?: number;
  contentType?: string;
  contentLength?: number | null;
  headers?: Record<string, string>;
};

/** A `Response` whose body is a stream of the given chunks. */
export function streamResponse(chunks: Uint8Array[], init: StreamInit = {}): Response {
  const headers = new Headers({ ...(init.headers ?? {}) });

  if (init.contentType !== undefined) headers.set("content-type", init.contentType);
  if (init.contentLength !== undefined && init.contentLength !== null) {
    headers.set("content-length", String(init.contentLength));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  return new Response(stream, { status: init.status ?? 200, headers });
}

/** A fetch call that never settles until the caller's signal aborts. */
export function neverResolvingFetch(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));

    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
  });
}

export function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}
