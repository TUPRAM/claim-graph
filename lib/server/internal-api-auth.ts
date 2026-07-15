import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { hasDevSessionFromRequest } from "@/lib/server/dev-auth";
import { hasStrongPublicBetaSecret } from "@/lib/server/public-beta-policy";

function matchesSecret(candidate: string, expected: string) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

export function hasInternalApiAuthorization(request: Request) {
  if (hasDevSessionFromRequest(request)) {
    return true;
  }

  const expected = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const candidate = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  return Boolean(
    hasStrongPublicBetaSecret(expected) &&
      candidate &&
      matchesSecret(candidate, expected!)
  );
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
