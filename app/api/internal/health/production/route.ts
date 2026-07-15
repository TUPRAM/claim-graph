import { NextResponse } from "next/server";
import { requireInternalApiAuthorization } from "@/lib/server/internal-api-auth";
import { getProductionHealthSummary } from "@/lib/server/production-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireInternalApiAuthorization(
    request,
    "Production health authorization required."
  );

  if (unauthorized) {
    return unauthorized;
  }

  const health = await getProductionHealthSummary();
  const status = health.status === "unhealthy" ? 503 : 200;

  return NextResponse.json(health, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
