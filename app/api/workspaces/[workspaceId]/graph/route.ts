import { NextResponse } from "next/server";
import { reconcileLatestWorkspaceRunForRead } from "@/lib/server/analyze-runner";
import { sanitizeWorkspaceGraphPayloadForPublic } from "@/lib/server/public-workspace-payload";
import {
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";
import {
  requestCanWriteWorkspace,
  WORKSPACE_WRITE_CAPABILITY_HEADER
} from "@/lib/server/workspace-capability";

async function getWorkspaceId(
  context: { params: Promise<{ workspaceId: string }> }
) {
  return (await context.params).workspaceId;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const workspaceId = await getWorkspaceId(context);

  if (!isHostedClaimGraphStoreSelected()) {
    reconcileLatestWorkspaceRunForRead(workspaceId);
  }

  const store = await getClaimGraphStore();
  const payload = await store.getWorkspaceGraphPayload(workspaceId);

  if (!payload) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const canWrite = await requestCanWriteWorkspace(request, workspaceId, store);

  const response = NextResponse.json(
    sanitizeWorkspaceGraphPayloadForPublic(payload, { canWrite })
  );
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set(
    "Vary",
    `Cookie, ${WORKSPACE_WRITE_CAPABILITY_HEADER}`
  );
  return response;
}
