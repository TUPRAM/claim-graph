import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { UrlFetchAdapter } from "@/lib/open-model/retrieval/types";

export const URL_FETCH_LIMITS = {
  maxRedirects: 3,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxBodyTextChars: 512_000
} as const;

interface UrlFetchLimits {
  maxRedirects: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxResponseBytes: number;
  maxBodyTextChars: number;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface UrlTransportResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
}

interface UrlTransportInput {
  url: URL;
  address: ResolvedAddress;
  signal: AbortSignal;
  connectTimeoutMs: number;
}

type UrlLookup = (hostname: string) => Promise<ResolvedAddress[]>;
type UrlTransport = (input: UrlTransportInput) => Promise<UrlTransportResponse>;

export interface UrlFetchAdapterOptions {
  lookup?: UrlLookup;
  transport?: UrlTransport;
  limits?: Partial<UrlFetchLimits>;
}

export class UrlFetchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlFetchPolicyError";
  }
}

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["fec0::", 10],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16]
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

const metadataHostnames = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal"
]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function stripIpv6Brackets(value: string) {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function normalizeHostname(value: string) {
  return stripIpv6Brackets(value).replace(/\.$/, "").toLowerCase();
}

function normalizeTitleFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url;
  }
}

function isIpv4MappedAddress(address: string) {
  const match = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return match?.[1];
}

export function isPublicNetworkAddress(address: string) {
  const mappedIpv4 = isIpv4MappedAddress(address);

  if (mappedIpv4) {
    return isIP(mappedIpv4) === 4 && !blockedIpv4Addresses.check(mappedIpv4, "ipv4");
  }

  const family = isIP(address);

  if (family === 4) {
    return !blockedIpv4Addresses.check(address, "ipv4");
  }

  if (family === 6) {
    return !blockedIpv6Addresses.check(address, "ipv6");
  }

  return false;
}

export function parseAllowedOutboundUrl(value: string) {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new UrlFetchPolicyError("Source URL must be a valid absolute URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlFetchPolicyError("Source URLs must use HTTP or HTTPS.");
  }

  if (parsed.username || parsed.password) {
    throw new UrlFetchPolicyError("Source URLs cannot contain credentials.");
  }

  const hostname = normalizeHostname(parsed.hostname);

  if (!hostname) {
    throw new UrlFetchPolicyError("Source URL must include a hostname.");
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    metadataHostnames.has(hostname)
  ) {
    throw new UrlFetchPolicyError("Source URL targets a non-public network host.");
  }

  return parsed;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const normalizedHostname = normalizeHostname(hostname);
  const literalFamily = isIP(normalizedHostname);

  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: normalizedHostname, family: literalFamily }];
  }

  const records = await dnsLookup(normalizedHostname, {
    all: true,
    verbatim: true
  });

  return records
    .filter((record) => record.family === 4 || record.family === 6)
    .map((record) => ({
      address: record.address,
      family: record.family as 4 | 6
    }));
}

function selectValidatedAddress(url: URL, addresses: ResolvedAddress[]) {
  if (!addresses.length) {
    throw new UrlFetchPolicyError(`Source host ${url.hostname} did not resolve.`);
  }

  const unsafeAddress = addresses.find(
    (candidate) => !isPublicNetworkAddress(candidate.address)
  );

  if (unsafeAddress) {
    throw new UrlFetchPolicyError(
      `Source host ${url.hostname} resolves to a non-public network address.`
    );
  }

  return addresses[0]!;
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  return new DOMException("The operation was aborted.", "AbortError");
}

function defaultTransport(input: UrlTransportInput): Promise<UrlTransportResponse> {
  if (input.signal.aborted) {
    return Promise.reject(abortError(input.signal));
  }

  return new Promise((resolve, reject) => {
    const request = input.url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const req = request(
      input.url,
      {
        method: "GET",
        agent: false,
        headers: {
          Accept: "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.2",
          "Accept-Encoding": "identity",
          "User-Agent": "ClaimGraph Source Retrieval"
        },
        lookup: (_hostname, _options, callback) => {
          if (typeof _options === "object" && _options.all) {
            const allCallback = callback as unknown as (
              error: NodeJS.ErrnoException | null,
              addresses: ResolvedAddress[]
            ) => void;
            allCallback(null, [input.address]);
            return;
          }

          callback(null, input.address.address, input.address.family);
        }
      },
      (response: IncomingMessage) => {
        settled = true;

        if (connectTimer) {
          clearTimeout(connectTimer);
        }

        const cleanupAbortListener = () => {
          input.signal.removeEventListener("abort", handleAbort);
        };

        response.once("close", cleanupAbortListener);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          cancel: () => response.destroy()
        });
      }
    );

    function handleAbort() {
      req.destroy(abortError(input.signal));
    }

    input.signal.addEventListener("abort", handleAbort, { once: true });

    connectTimer = setTimeout(() => {
      req.destroy(
        new UrlFetchPolicyError(
          `Source connection exceeded ${input.connectTimeoutMs} ms.`
        )
      );
    }, input.connectTimeoutMs);

    req.once("error", (error) => {
      if (connectTimer) {
        clearTimeout(connectTimer);
      }

      input.signal.removeEventListener("abort", handleAbort);

      if (!settled) {
        reject(error);
      }
    });

    req.end();
  });
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function readBoundedResponseBody(input: {
  response: UrlTransportResponse;
  signal: AbortSignal;
  maxResponseBytes: number;
  maxBodyTextChars: number;
}) {
  const contentLengthValue = firstHeaderValue(input.response.headers["content-length"]);
  const contentLength = contentLengthValue ? Number.parseInt(contentLengthValue, 10) : NaN;

  if (Number.isFinite(contentLength) && contentLength > input.maxResponseBytes) {
    input.response.cancel();
    throw new UrlFetchPolicyError(
      `Source response exceeds the ${input.maxResponseBytes} byte limit.`
    );
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let byteCount = 0;
  let bodyText = "";

  try {
    for await (const value of input.response.body) {
      if (input.signal.aborted) {
        throw abortError(input.signal);
      }

      const chunk = Buffer.from(value);
      byteCount += chunk.byteLength;

      if (byteCount > input.maxResponseBytes) {
        throw new UrlFetchPolicyError(
          `Source response exceeds the ${input.maxResponseBytes} byte limit.`
        );
      }

      bodyText += decoder.decode(chunk, { stream: true });

      if (bodyText.length > input.maxBodyTextChars) {
        throw new UrlFetchPolicyError(
          `Source response text exceeds the ${input.maxBodyTextChars} character limit.`
        );
      }
    }

    bodyText += decoder.decode();
    return bodyText;
  } catch (error) {
    input.response.cancel();
    throw error;
  }
}

function combineAbortSignals(signals: AbortSignal[]) {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }

    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller.signal;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject<T>(abortError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    function handleAbort() {
      reject(abortError(signal));
    }

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      }
    );
  });
}

export class DefaultUrlFetchAdapter implements UrlFetchAdapter {
  readonly kind = "url-fetch" as const;
  private readonly lookup: UrlLookup;
  private readonly transport: UrlTransport;
  private readonly limits: UrlFetchLimits;

  constructor(options: UrlFetchAdapterOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup;
    this.transport = options.transport ?? defaultTransport;
    this.limits = {
      ...URL_FETCH_LIMITS,
      ...options.limits
    };
  }

  async fetch(url: string, signal?: AbortSignal) {
    const totalController = new AbortController();
    const totalTimer = setTimeout(() => {
      totalController.abort(
        new UrlFetchPolicyError(
          `Source retrieval exceeded ${this.limits.totalTimeoutMs} ms.`
        )
      );
    }, this.limits.totalTimeoutMs);
    const combinedSignal = combineAbortSignals(
      signal ? [signal, totalController.signal] : [totalController.signal]
    );
    let currentUrl = parseAllowedOutboundUrl(url);

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        if (combinedSignal.aborted) {
          throw abortError(combinedSignal);
        }

        const addresses = await abortable(
          this.lookup(normalizeHostname(currentUrl.hostname)),
          combinedSignal
        );
        const address = selectValidatedAddress(currentUrl, addresses);
        const response = await abortable(
          this.transport({
            url: currentUrl,
            address,
            signal: combinedSignal,
            connectTimeoutMs: this.limits.connectTimeoutMs
          }),
          combinedSignal
        );
        const location = firstHeaderValue(response.headers.location);

        if (redirectStatuses.has(response.status) && location) {
          response.cancel();

          if (redirectCount >= this.limits.maxRedirects) {
            throw new UrlFetchPolicyError(
              `Source URL exceeded the ${this.limits.maxRedirects} redirect limit.`
            );
          }

          currentUrl = parseAllowedOutboundUrl(new URL(location, currentUrl).toString());
          continue;
        }

        const bodyText = await readBoundedResponseBody({
          response,
          signal: combinedSignal,
          maxResponseBytes: this.limits.maxResponseBytes,
          maxBodyTextChars: this.limits.maxBodyTextChars
        });

        return {
          url,
          resolvedUrl: currentUrl.toString(),
          status: response.status,
          contentType: firstHeaderValue(response.headers["content-type"]),
          title: normalizeTitleFromUrl(currentUrl.toString()),
          bodyText
        };
      }
    } finally {
      clearTimeout(totalTimer);
    }
  }
}
