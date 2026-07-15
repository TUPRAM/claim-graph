import { NextResponse } from "next/server";
import { reconcileRunForRead } from "@/lib/server/analyze-runner";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import {
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";

export const runtime = "nodejs";

async function getRunId(
  context: { params: Promise<{ runId: string }> }
) {
  return (await context.params).runId;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const runId = await getRunId(context);

  if (!isHostedClaimGraphStoreSelected()) {
    reconcileRunForRead(runId);
  }

  const store = await getClaimGraphStore();
  const run = await store.getRun(runId);

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json(run);
}
