import { NextResponse } from "next/server";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const store = await getClaimGraphStore();
  return NextResponse.json({
    workspaces: await store.listWorkspaces(25)
  });
}
