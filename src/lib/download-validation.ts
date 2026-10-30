/**
 * URL validation and SSRF protection.
 *
 * `validateMediaUrl` is synchronous and pure: syntax, protocol, credentials,
 * blocked hostnames and the source allowlist. Any DNS work happens in
 * `assertSafeRemoteHost`, which must be called for *every* hop (initial URL and
 * every redirect) immediately before the request is issued.
 */

import { promises as dns } from "node:dns";
import { isBlockedHostname, isBlockedIp } from "@/lib/ip";
import { DownloadError, type DownloadErrorCode } from "@/lib/errors";
import { classifySource, MESSAGES, type ClassifiedSource } from "@/lib/sources";

export const MAX_URL_LENGTH = 2048;

export type UrlValidationResult =
  | { ok: true; url: URL; source: ClassifiedSource }
  | { ok: false; code: DownloadErrorCode; message: string };

export function validateMediaUrl(rawUrl: string): UrlValidationResult {
  const value = (rawUrl ?? "").trim();

  if (!value) {
    return { ok: false, code: "EMPTY_URL", message: "Please paste a media URL." };
  }

  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, code: "URL_TOO_LONG", message: "That URL is too long. Please use a link shorter than 2048 characters." };
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, code: "INVALID_URL", message: "Please enter a valid URL, including https://." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "INVALID_URL", message: "Only http:// and https:// URLs are supported." };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, code: "UNSAFE_URL", message: "URLs containing credentials are not allowed." };
  }

  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    return { ok: false, code: "UNSAFE_URL", message: "Only the standard HTTP and HTTPS ports are supported." };
  }

  if (isBlockedHostname(parsed.hostname)) {
    return { ok: false, code: "UNSAFE_URL", message: "This URL is not allowed." };
  }

  const classification = classifySource(parsed);

  if (!classification.ok) {
    return {
      ok: false,
      code: classification.reason === "unsupported-source" ? "UNSUPPORTED_SOURCE" : "NOT_MEDIA",
      message: classification.message,
    };
  }

  return { ok: true, url: parsed, source: classification.source };
}

export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: HostLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

let hostLookup: HostLookup = defaultLookup;

/**
 * Test hook: replace the DNS resolver used by SSRF checks.
 * Only the resolver is swappable — the host allowlist and private-range rules
 * are never affected. Not reachable from any HTTP surface.
 */
export function setHostLookupForTests(lookup: HostLookup | null): void {
  hostLookup = lookup ?? defaultLookup;
}

/**
 * Resolve the host and reject the request if any answer is a private,
 * loopback, link-local, metadata, or otherwise reserved address.
 *
 * The check happens immediately before connecting, which limits (but cannot by
 * itself eliminate) DNS-rebinding windows; redirects are re-validated hop by
 * hop in `assertAllowedRedirect`.
 */
export async function assertSafeRemoteHost(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");

  if (isBlockedHostname(hostname)) {
    throw new DownloadError("UNSAFE_URL", "This URL is not allowed.");
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    if (isBlockedIp(hostname)) {
      throw new DownloadError("UNSAFE_URL", "This URL is not allowed.");
    }
    return;
  }

  let records: Array<{ address: string }>;

  try {
    records = await hostLookup(hostname);
  } catch {
    throw new DownloadError("UPSTREAM_ERROR", "The media could not be reached. The host did not resolve.");
  }

  if (records.length === 0) {
    throw new DownloadError("UPSTREAM_ERROR", "The media could not be reached. The host did not resolve.");
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new DownloadError("UNSAFE_URL", "This URL resolves to a blocked address.");
    }
  }
}

/**
 * Validate one redirect hop. Resolves `location` against the current URL and
 * requires the result to be a supported, non-internal direct media URL.
 */
export function resolveAllowedRedirect(location: string, current: URL): URL {
  let target: URL;

  try {
    target = new URL(location, current);
  } catch {
    throw new DownloadError("SOURCE_NOT_PERMITTED", MESSAGES.unsupportedSource);
  }

  const validated = validateMediaUrl(target.toString());

  if (!validated.ok) {
    throw new DownloadError(validated.code, validated.message === MESSAGES.notAMediaUrl ? MESSAGES.unsupportedSource : validated.message);
  }

  if (validated.source.kind !== "direct") {
    throw new DownloadError("SOURCE_NOT_PERMITTED", MESSAGES.unsupportedSource);
  }

  return validated.url;
}

/** Backwards-compatible boolean helper. */
export function isAllowedRedirect(location: string, current?: URL): boolean {
  try {
    resolveAllowedRedirect(location, current ?? new URL("https://samplelib.com/"));
    return true;
  } catch {
    return false;
  }
}
