import { NextResponse } from "next/server";
import { getProductionHealthSummary } from "@/lib/server/production-health";
import { sanitizeProductionHealthForPublic } from "@/lib/validation/public-production-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getProductionHealthSummary();
  const status = health.status === "unhealthy" ? 503 : 200;

  return NextResponse.json(sanitizeProductionHealthForPublic(health), {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
