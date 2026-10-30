/**
 * IP address classification used for SSRF protection.
 *
 * Pure functions only, so every branch is unit-testable without network access.
 */

import net from "node:net";

type Range = readonly [string, string];

/** IPv4 ranges that must never be reachable from this service. */
const BLOCKED_IPV4_RANGES: Range[] = [
  ["0.0.0.0", "0.255.255.255"], // "this" network
  ["10.0.0.0", "10.255.255.255"], // private
  ["100.64.0.0", "100.127.255.255"], // CGNAT
  ["127.0.0.0", "127.255.255.255"], // loopback
  ["169.254.0.0", "169.254.255.255"], // link-local + cloud metadata (169.254.169.254)
  ["172.16.0.0", "172.31.255.255"], // private
  ["192.0.0.0", "192.0.2.255"], // IETF protocol assignments / TEST-NET-1
  ["192.88.99.0", "192.88.99.255"], // 6to4 relay anycast
  ["192.168.0.0", "192.168.255.255"], // private
  ["198.18.0.0", "198.19.255.255"], // benchmarking
  ["198.51.100.0", "198.51.100.255"], // TEST-NET-2
  ["203.0.113.0", "203.0.113.255"], // TEST-NET-3
  ["224.0.0.0", "239.255.255.255"], // multicast
  ["240.0.0.0", "255.255.255.255"], // reserved + broadcast
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
}

export function isPublicIpv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const value = ipv4ToInt(ip);
  return !BLOCKED_IPV4_RANGES.some(([start, end]) => value >= ipv4ToInt(start) && value <= ipv4ToInt(end));
}

/** Expand an IPv6 literal into its eight 16-bit groups, or `null`. */
function parseIpv6Groups(ip: string): number[] | null {
  let address = ip.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  address = address.split("%")[0]; // drop zone index

  if (!address.includes(":")) return null;

  // Trailing dotted-quad (e.g. ::ffff:192.168.0.1)
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const octets = tail.split(".").map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const [head, rest] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest === undefined ? [] : rest ? rest.split(":") : [];

  if (rest !== undefined && address.split("::").length > 2) return null;

  const filler = rest === undefined ? 0 : 8 - headGroups.length - restGroups.length;
  if (filler < 0) return null;

  const groups = [...headGroups, ...Array.from({ length: filler }, () => "0"), ...restGroups];
  if (groups.length !== 8) return null;

  const parsed = groups.map((group) => Number.parseInt(group, 16));
  if (parsed.some((value) => !Number.isFinite(value) || value < 0 || value > 0xffff)) return null;

  return parsed;
}

function groupsToBigInt(groups: number[]): bigint {
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function embeddedIpv4(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function isBlockedIpv6(ip: string): boolean {
  const groups = parseIpv6Groups(ip);
  if (!groups) return true; // unparsable -> treat as unsafe

  const leadingZeroPrefix = (length: number) =>
    groups.slice(0, length).every((group) => group === 0);

  // :: and ::1
  if (groups.every((group) => group === 0)) return true;
  if (leadingZeroPrefix(7) && groups[7] === 1) return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
  const mapped = leadingZeroPrefix(5) && groups[5] === 0xffff;
  const compatible = leadingZeroPrefix(6);
  if (mapped || compatible) {
    return !isPublicIpv4(embeddedIpv4(groups[6], groups[7]));
  }

  // NAT64 (64:ff9b::/96)
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    return !isPublicIpv4(embeddedIpv4(groups[6], groups[7]));
  }

  // 6to4 (2002::/16) embeds an IPv4 address in groups 1-2
  if (groups[0] === 0x2002) {
    return !isPublicIpv4(embeddedIpv4(groups[1], groups[2]));
  }

  const value = groupsToBigInt(groups);
  const inRange = (prefix: string, prefixLength: number) => {
    const [network] = prefix.split("/");
    const networkGroups = parseIpv6Groups(network);
    if (!networkGroups) return false;
    const shifted = value >> BigInt(128 - prefixLength);
    const networkShifted = groupsToBigInt(networkGroups) >> BigInt(128 - prefixLength);
    return shifted === networkShifted;
  };

  const blocked = [
    "fc00::/7", // unique local
    "fe80::/10", // link-local
    "ff00::/8", // multicast
    "fec0::/10", // deprecated site-local
    "2001:db8::/32", // documentation
    "2001::/32", // Teredo
    "2001:10::/28", // ORCHID
    "100::/64", // discard-only
  ];

  return blocked.some((range) => inRange(range, Number(range.split("/")[1])));
}

/** `true` when the address must be blocked (invalid input is blocked). */
export function isBlockedIp(ip: string): boolean {
  const value = ip.trim();

  if (net.isIPv4(value)) return !isPublicIpv4(value);
  if (net.isIPv6(value)) return isBlockedIpv6(value);

  return true;
}

/** Hostnames that resolve internally without needing DNS. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[/, "").replace(/\]$/, "");

  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host.includes("metadata.google.internal")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (net.isIP(host)) return isBlockedIp(host);

  return false;
}
