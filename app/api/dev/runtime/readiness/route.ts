import { NextResponse } from "next/server";
import { getRuntimeReadinessSummary } from "@/lib/server/runtime-readiness";
import { requireDevApiSession } from "@/lib/server/dev-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  return NextResponse.json(await getRuntimeReadinessSummary());
}
