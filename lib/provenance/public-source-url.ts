import { isIP } from "node:net";
import {
  isPublicNetworkAddress,
  parseAllowedOutboundUrl
} from "@/lib/open-model/retrieval/url-fetch";

const MAX_PUBLIC_SOURCE_URL_LENGTH = 4_096;
const NON_PUBLIC_HOST_SUFFIXES = [
  ".internal",
  ".lan",
  ".local",
  ".localhost",
  ".home"
] as const;
const SENSITIVE_QUERY_NAME =
  /(?:^x-amz-|^x-goog-|(?:^|[-_.])(?:access[-_.]?token|token|api[-_.]?key|key|secret|password|passwd|signature|sig|credential|authorization|auth|session|jwt|code|nonce|sas)(?:$|[-_.]))/iu;

/**
 * Public graph links are a stricter boundary than accepted source input. A
 * source URL can be useful for retrieval while still being unsafe to copy into
 * a read-only share (for example a signed Blob URL or a metadata-service IP).
 */
export function sanitizePublicSourceUrl(value: string | null | undefined) {
  if (!value || value.length > MAX_PUBLIC_SOURCE_URL_LENGTH) {
    return undefined;
  }

  let url: URL;

  try {
    url = parseAllowedOutboundUrl(value);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  const addressFamily = isIP(hostname);

  if (
    (addressFamily !== 0 && !isPublicNetworkAddress(hostname)) ||
    (addressFamily === 0 &&
      (!hostname.includes(".") ||
        NON_PUBLIC_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))) ||
    url.port
  ) {
    return undefined;
  }

  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_NAME.test(name)) {
      return undefined;
    }
  }

  // Fragments are navigation state, may contain tokens, and are not needed to
  // identify the fetched source document.
  url.hash = "";
  return url.toString();
}

export function isSafePublicSourceUrl(value: string) {
  return sanitizePublicSourceUrl(value) === value;
}
