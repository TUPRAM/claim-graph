import { NextResponse } from "next/server";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import { getRuntimeReadinessSummary } from "@/lib/server/runtime-readiness";

export async function GET(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  return NextResponse.json(await getRuntimeReadinessSummary());
}
