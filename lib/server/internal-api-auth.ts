import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { hasDevSessionFromRequest } from "@/lib/server/dev-auth";
import { hasStrongPublicBetaSecret } from "@/lib/server/public-beta-policy";

function matchesSecret(candidate: string, expected: string) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function bearerCandidate(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
}

export function hasInternalApiAuthorization(request: Request) {
  if (hasDevSessionFromRequest(request)) {
    return true;
  }

  return hasCronApiAuthorization(request);
}

export function hasCronApiAuthorization(request: Request) {

  const expected = process.env.CRON_SECRET?.trim();
  const candidate = bearerCandidate(request);

  return Boolean(
    hasStrongPublicBetaSecret(expected) &&
      candidate &&
      matchesSecret(candidate, expected!)
  );
}

export function requireCronApiAuthorization(
  request: Request,
  errorMessage = "Scheduled operation authorization required."
) {
  if (hasCronApiAuthorization(request)) {
    return null;
  }

  return NextResponse.json({ error: errorMessage }, { status: 401 });
}

export function hasMonitorApiAuthorization(request: Request) {
  const expected = process.env.CLAIMGRAPH_MONITOR_SECRET?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const candidate = bearerCandidate(request);

  return Boolean(
    hasStrongPublicBetaSecret(expected) &&
      expected !== cronSecret &&
      candidate &&
      matchesSecret(candidate, expected!)
  );
}

export function requireMonitorApiAuthorization(
  request: Request,
  errorMessage = "Operations monitor authorization required."
) {
  if (hasMonitorApiAuthorization(request)) {
    return null;
  }

  return NextResponse.json({ error: errorMessage }, { status: 401 });
}

export function requireInternalApiAuthorization(
  request: Request,
  errorMessage = "Internal API authorization required."
) {
  if (hasInternalApiAuthorization(request)) {
    return null;
  }

  return NextResponse.json({ error: errorMessage }, { status: 401 });
}
