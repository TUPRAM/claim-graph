import { NextResponse } from "next/server";
import { reconcileLatestWorkspaceRunForRead } from "@/lib/server/analyze-runner";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import {
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";

export const runtime = "nodejs";

async function getWorkspaceId(
  context: { params: Promise<{ workspaceId: string }> }
) {
  return (await context.params).workspaceId;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const workspaceId = await getWorkspaceId(context);

  if (!isHostedClaimGraphStoreSelected()) {
    reconcileLatestWorkspaceRunForRead(workspaceId);
  }

  const store = await getClaimGraphStore();
  const payload = await store.getWorkspaceGraphPayload(workspaceId);

  if (!payload) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  return NextResponse.json(payload);
}
