import { NextResponse } from "next/server";
import { requireCronApiAuthorization } from "@/lib/server/internal-api-auth";
import { tryDeliverOperationsNotification } from "@/lib/server/operations-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireCronApiAuthorization(
    request,
    "Notification scheduler authorization required."
  );

  if (unauthorized) {
    return unauthorized;
  }

  const notification = await tryDeliverOperationsNotification();
  const status = notification.kind === "failed" ||
    notification.kind === "not-configured"
    ? 503
    : 200;

  return NextResponse.json({ notification }, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
