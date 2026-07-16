import { NextResponse } from "next/server";
import { requireMonitorApiAuthorization } from "@/lib/server/internal-api-auth";
import { getOperationsMonitorSnapshot } from "@/lib/server/operations-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireMonitorApiAuthorization(request);

  if (unauthorized) {
    return unauthorized;
  }

  const snapshot = await getOperationsMonitorSnapshot();
  const status = snapshot.status === "critical" ? 503 : 200;

  return NextResponse.json(snapshot, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
