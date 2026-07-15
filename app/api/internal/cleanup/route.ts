import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { drainDueCleanupJobs } from "@/lib/server/retention-cleanup";
import { hasStrongPublicBetaSecret } from "@/lib/server/public-beta-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function matchesSecret(candidate: string, expected: string) {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const candidate = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (
    !hasStrongPublicBetaSecret(expected) ||
    !candidate ||
    !matchesSecret(candidate, expected!)
  ) {
    return NextResponse.json({ error: "Cleanup authorization required." }, { status: 401 });
  }

  const result = await drainDueCleanupJobs();

  return NextResponse.json(result, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
