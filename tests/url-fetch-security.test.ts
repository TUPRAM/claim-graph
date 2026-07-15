import { describe, expect, it, vi } from "vitest";
import {
  DefaultUrlFetchAdapter,
  URL_FETCH_LIMITS,
  isPublicNetworkAddress,
  parseAllowedOutboundUrl
} from "@/lib/open-model/retrieval/url-fetch";

function bodyFrom(chunks: Array<string | Buffer>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    }
  };
}

describe("outbound URL retrieval policy", () => {
  it("allows only credential-free HTTP(S) URLs", () => {
    expect(parseAllowedOutboundUrl("https://example.com/report").protocol).toBe(
      "https:"
    );
    expect(() => parseAllowedOutboundUrl("file:///etc/passwd")).toThrow(/HTTP or HTTPS/);
    expect(() => parseAllowedOutboundUrl("https://user:secret@example.com/")).toThrow(
      /credentials/
    );
    expect(() => parseAllowedOutboundUrl("http://localhost/admin")).toThrow(
      /non-public/
    );
    expect(() => parseAllowedOutboundUrl("http://metadata.google.internal/")).toThrow(
      /non-public/
    );
  });

  it("rejects private, loopback, link-local, multicast, metadata, and mapped addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.4.3.2",
      "127.0.0.1",
      "168.63.129.16",
      "169.254.169.254",
      "172.31.0.5",
      "192.168.1.1",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "2001::1",
      "2002:7f00:1::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a00:1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::a00:1"
    ]) {
      expect(isPublicNetworkAddress(address), address).toBe(false);
    }

    expect(isPublicNetworkAddress("1.1.1.1")).toBe(true);
    expect(isPublicNetworkAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("fails before transport when DNS returns any non-public address", async () => {
    const transport = vi.fn();
    const adapter = new DefaultUrlFetchAdapter({
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 }
      ],
      transport
    });

    await expect(adapter.fetch("https://example.com/report")).rejects.toThrow(
      /non-public network address/
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("re-resolves and rejects an unsafe redirect before requesting it", async () => {
    const lookup = vi.fn(async (hostname: string) =>
      hostname === "example.com"
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "127.0.0.1", family: 4 as const }]
    );
    const cancel = vi.fn();
    const transport = vi.fn(async () => ({
      status: 302,
      headers: { location: "http://internal.example/private" },
      body: bodyFrom(["redirect body must not be consumed"]),
      cancel
    }));
    const adapter = new DefaultUrlFetchAdapter({ lookup, transport });

    await expect(adapter.fetch("https://example.com/start")).rejects.toThrow(
      /non-public network address/
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("streams responses and aborts at the configured byte ceiling", async () => {
    const cancel = vi.fn();
    const adapter = new DefaultUrlFetchAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: bodyFrom([Buffer.alloc(6, 0x61), Buffer.alloc(6, 0x62)]),
        cancel
      }),
      limits: {
        maxResponseBytes: 10,
        maxBodyTextChars: 100
      }
    });

    await expect(adapter.fetch("https://example.com/large")).rejects.toThrow(
      /10 byte limit/
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("caps redirects and total retrieval time", async () => {
    const redirectAdapter = new DefaultUrlFetchAdapter({
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async ({ url }) => ({
        status: 302,
        headers: { location: `${url.origin}/next` },
        body: bodyFrom([]),
        cancel: vi.fn()
      }),
      limits: { maxRedirects: 1 }
    });

    await expect(redirectAdapter.fetch("https://example.com/start")).rejects.toThrow(
      /1 redirect limit/
    );

    const timeoutAdapter = new DefaultUrlFetchAdapter({
      lookup: async () => new Promise(() => undefined),
      limits: { totalTimeoutMs: 5 }
    });

    await expect(timeoutAdapter.fetch("https://example.com/slow")).rejects.toThrow(
      /exceeded 5 ms/
    );
    expect(URL_FETCH_LIMITS.connectTimeoutMs).toBeLessThan(
      URL_FETCH_LIMITS.totalTimeoutMs
    );
  });
});
