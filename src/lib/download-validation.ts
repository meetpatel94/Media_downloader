import { promises as dns } from "node:dns";
import net from "node:net";

const MAX_URL_LENGTH = 2048;
const ALLOWED_HOSTS = new Set([
  "samplelib.com",
  "www.samplelib.com",
  "file-examples.com",
  "www.file-examples.com",
  "sample-videos.com",
  "www.sample-videos.com",
]);

const PRIVATE_IPV4_RANGES: Array<[string, string]> = [
  ["10.0.0.0", "10.255.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.168.0.0", "192.168.255.255"],
];

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIpv4(ip: string) {
  if (ip === "0.0.0.0") return true;
  const value = ipv4ToInt(ip);
  return PRIVATE_IPV4_RANGES.some(([start, end]) => value >= ipv4ToInt(start) && value <= ipv4ToInt(end));
}

function isBlockedIp(ip: string) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80")
    );
  }
  return true;
}

export function validateMediaUrl(rawUrl: string) {
  const url = rawUrl.trim();

  if (!url) {
    return { ok: false as const, message: "Please paste a media URL." };
  }

  if (url.length > MAX_URL_LENGTH) {
    return { ok: false as const, message: "Please enter a valid URL." };
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return { ok: false as const, message: "Please enter a valid URL." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false as const, message: "Please enter a valid URL." };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!ALLOWED_HOSTS.has(hostname)) {
    return { ok: false as const, message: "This media source is not supported." };
  }

  return { ok: true as const, url: parsed };
}

export async function ensurePublicRemoteHost(url: URL) {
  const records = await dns.lookup(url.hostname, { all: true });

  if (!records.length) {
    throw new Error("The media could not be accessed.");
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error("This media source is not supported.");
    }
  }
}

export function isAllowedRedirect(location: string) {
  try {
    const target = new URL(location);
    return ["http:", "https:"].includes(target.protocol) && ALLOWED_HOSTS.has(target.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const SUPPORTED_HOSTS = Array.from(ALLOWED_HOSTS).sort();
