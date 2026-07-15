import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { hasDevSessionFromRequest } from "@/lib/server/dev-auth";
import { hasValidCanonicalPublicOrigin } from "@/lib/server/public-beta-policy";
import type { ClaimGraphStore } from "@/lib/server/storage/claimgraph-store";

export const WORKSPACE_WRITE_CAPABILITY_HEADER =
  "x-claimgraph-write-capability";

const WORKSPACE_WRITE_COOKIE_PREFIX = "claimgraph_write_";
const DEFAULT_CAPABILITY_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MIN_CAPABILITY_MAX_AGE_SECONDS = 60 * 60;
const MAX_CAPABILITY_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export type WorkspaceMutationAuthorizationFailure =
  | "invalid_origin"
  | "capability_required";

function parseCookieHeader(cookieHeader: string | null) {
  const values = new Map<string, string>();

  for (const pair of (cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValueParts] = pair.trim().split("=");

    if (!rawName || !rawValueParts.length) {
      continue;
    }

    try {
      values.set(rawName, decodeURIComponent(rawValueParts.join("=")));
    } catch {
      // An invalid cookie cannot confer mutation authority.
    }
  }

  return values;
}

function normalizeOrigin(value: string | null | undefined) {
  if (!value || value === "null") {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getAllowedMutationOrigins(request: Request) {
  const origins = new Set<string>();
  const requestOrigin = normalizeOrigin(request.url);
  const configuredValue =
    process.env.CLAIMGRAPH_PUBLIC_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL;
  const configuredOrigin =
    process.env.NODE_ENV === "production" &&
    !hasValidCanonicalPublicOrigin(configuredValue)
      ? null
      : normalizeOrigin(configuredValue);

  if (process.env.NODE_ENV === "production") {
    // In production the request Host is not an authority boundary: a
    // self-hosted proxy or DNS-rebinding request may supply it. Require one
    // explicit canonical origin and require the routed request to match it.
    if (configuredOrigin && requestOrigin === configuredOrigin) {
      origins.add(configuredOrigin);
    }
  } else {
    if (requestOrigin) {
      origins.add(requestOrigin);
    }

    if (configuredOrigin) {
      origins.add(configuredOrigin);
    }
  }

  return origins;
}

function hasValidMutationOrigin(request: Request, allowNonBrowser: boolean) {
  const requestOrigin = normalizeOrigin(request.url);
  const allowedOrigins = getAllowedMutationOrigins(request);

  if (!requestOrigin || !allowedOrigins.has(requestOrigin)) {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();

  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return false;
  }

  const suppliedOrigin = request.headers.get("origin");

  if (suppliedOrigin) {
    const normalizedOrigin = normalizeOrigin(suppliedOrigin);
    return Boolean(
      normalizedOrigin && allowedOrigins.has(normalizedOrigin)
    );
  }

  if (fetchSite === "same-origin") {
    return true;
  }

  return allowNonBrowser;
}

function getCapabilityMaxAgeSeconds() {
  const configured = Number.parseInt(
    process.env.CLAIMGRAPH_WORKSPACE_CAPABILITY_TTL_SECONDS ?? "",
    10
  );

  if (!Number.isFinite(configured)) {
    return DEFAULT_CAPABILITY_MAX_AGE_SECONDS;
  }

  return Math.max(
    MIN_CAPABILITY_MAX_AGE_SECONDS,
    Math.min(configured, MAX_CAPABILITY_MAX_AGE_SECONDS)
  );
}

export function getWorkspaceWriteCapabilityCookieName(workspaceId: string) {
  return `${WORKSPACE_WRITE_COOKIE_PREFIX}${workspaceId}`;
}

export function isValidWorkspaceWriteCapability(value: string | null | undefined) {
  return Boolean(value && CAPABILITY_PATTERN.test(value));
}

export function generateWorkspaceWriteCapability() {
  return randomBytes(32).toString("base64url");
}

export function hashWorkspaceWriteCapability(capability: string) {
  return createHash("sha256").update(capability, "utf8").digest("base64url");
}

export function getWorkspaceWriteCapabilityFromRequest(
  request: Request,
  workspaceId: string
) {
  const headerCapability = request.headers
    .get(WORKSPACE_WRITE_CAPABILITY_HEADER)
    ?.trim();

  if (isValidWorkspaceWriteCapability(headerCapability)) {
    return headerCapability!;
  }

  const cookieCapability = parseCookieHeader(request.headers.get("cookie")).get(
    getWorkspaceWriteCapabilityCookieName(workspaceId)
  );

  return isValidWorkspaceWriteCapability(cookieCapability)
    ? cookieCapability!
    : null;
}

export function getOrCreateWorkspaceWriteCapability(request: Request) {
  const supplied = request.headers
    .get(WORKSPACE_WRITE_CAPABILITY_HEADER)
    ?.trim();
  const capability = isValidWorkspaceWriteCapability(supplied)
    ? supplied!
    : generateWorkspaceWriteCapability();

  return {
    capability,
    writeCapabilityHash: hashWorkspaceWriteCapability(capability)
  };
}

export function attachWorkspaceWriteCapabilityCookie(
  response: NextResponse,
  workspaceId: string,
  capability: string
) {
  response.cookies.set(
    getWorkspaceWriteCapabilityCookieName(workspaceId),
    capability,
    {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: getCapabilityMaxAgeSeconds()
    }
  );

  return response;
}

export function clearWorkspaceWriteCapabilityCookie(
  response: NextResponse,
  workspaceId: string
) {
  response.cookies.set(
    getWorkspaceWriteCapabilityCookieName(workspaceId),
    "",
    {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0
    }
  );

  return response;
}

export function requireWorkspaceCreationOrigin(request: Request) {
  return requireSameOriginMutation(request, {
    allowNonBrowser: true,
    errorMessage: "Cross-origin workspace creation is not allowed."
  });
}

export function requireSameOriginMutation(
  request: Request,
  options?: {
    allowNonBrowser?: boolean;
    errorMessage?: string;
  }
) {
  if (hasValidMutationOrigin(request, options?.allowNonBrowser === true)) {
    return null;
  }

  return NextResponse.json(
    {
      error:
        options?.errorMessage ??
        "Cross-origin mutations are not allowed."
    },
    { status: 403 }
  );
}

export async function requestCanWriteWorkspace(
  request: Request,
  workspaceId: string,
  store: ClaimGraphStore
) {
  if (hasDevSessionFromRequest(request)) {
    return true;
  }

  const capability = getWorkspaceWriteCapabilityFromRequest(
    request,
    workspaceId
  );

  if (!capability) {
    return false;
  }

  return store.matchesWorkspaceWriteCapability(
    workspaceId,
    hashWorkspaceWriteCapability(capability)
  );
}

export async function requireWorkspaceMutation(
  request: Request,
  workspaceId: string,
  store: ClaimGraphStore
) {
  const hasHeaderCapability = isValidWorkspaceWriteCapability(
    request.headers.get(WORKSPACE_WRITE_CAPABILITY_HEADER)?.trim()
  );

  const originRejection = requireSameOriginMutation(request, {
    allowNonBrowser: hasHeaderCapability,
    errorMessage: "Cross-origin workspace mutations are not allowed."
  });

  if (originRejection) {
    return originRejection;
  }

  if (await requestCanWriteWorkspace(request, workspaceId, store)) {
    return null;
  }

  return NextResponse.json(
    {
      error:
        "This workspace is read-only in this browser. The owner capability is required to make changes."
    },
    { status: 403 }
  );
}
