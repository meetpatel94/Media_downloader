import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedHostname, isBlockedIp, isPublicIpv4 } from "@/lib/ip";

test("public IPv4 addresses are allowed", () => {
  for (const address of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1", "11.0.0.1"]) {
    assert.equal(isPublicIpv4(address), true, address);
    assert.equal(isBlockedIp(address), false, address);
  }
});

test("reserved IPv4 ranges are blocked", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.4",
    "172.31.255.255",
    "192.168.0.1",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
  ];

  for (const address of blocked) {
    assert.equal(isBlockedIp(address), true, address);
  }
});

test("IPv6 loopback, link-local, unique-local and multicast are blocked", () => {
  const blocked = [
    "::",
    "::1",
    "[::1]",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "ff02::1",
    "fec0::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "64:ff9b::7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.1",
    "0:0:0:0:0:0:0:1",
  ];

  for (const address of blocked) {
    assert.equal(isBlockedIp(address), true, address);
  }
});

test("public IPv6 addresses are allowed", () => {
  for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedIp(address), false, address);
  }
});

test("malformed IP literals are blocked", () => {
  for (const value of ["", "999.1.1.1", "1.2.3", "not-an-ip", "::gggg"]) {
    assert.equal(isBlockedIp(value), true, value);
  }
});

test("internal hostnames are blocked, public hostnames are not", () => {
  for (const host of ["localhost", "api.localhost", "printer.local", "metadata.google.internal", "service.internal", "0.0.0.0", "127.0.0.1", "::1"]) {
    assert.equal(isBlockedHostname(host), true, host);
  }

  for (const host of ["samplelib.com", "www.samplelib.com", "youtu.be"]) {
    assert.equal(isBlockedHostname(host), false, host);
  }
});
