import { NextResponse } from "next/server";
import { cancelAnalysisRun, reconcileRunForRead } from "@/lib/server/analyze-runner";
import { sanitizeRunForPublic } from "@/lib/server/public-workspace-payload";
import { ACTIVE_RUN_STATUSES, isActiveRunStatus } from "@/lib/server/run-lifecycle";
import {
  buildSyntheticDemoRun,
  isSyntheticDemoRunId
} from "@/lib/server/synthetic-demo-run";
import {
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";
import { requireWorkspaceMutation } from "@/lib/server/workspace-capability";
import {
  cancelWorkflowRunBestEffort,
  type WorkflowCancellationOutcome
} from "@/lib/server/workflow-control";

async function getRunId(
  context: { params: Promise<{ runId: string }> }
) {
  return (await context.params).runId;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const runId = await getRunId(context);

  if (isSyntheticDemoRunId(runId)) {
    return NextResponse.json(sanitizeRunForPublic(buildSyntheticDemoRun()));
  }

  if (!isHostedClaimGraphStoreSelected()) {
    reconcileRunForRead(runId);
  }

  const store = await getClaimGraphStore();
  const run = await store.getRun(runId);

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json(sanitizeRunForPublic(run));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const runId = await getRunId(context);
  const hosted = isHostedClaimGraphStoreSelected();

  if (isSyntheticDemoRunId(runId)) {
    return NextResponse.json({
      accepted: false,
      run: sanitizeRunForPublic(buildSyntheticDemoRun())
    });
  }

  if (!hosted) {
    reconcileRunForRead(runId);
  }

  const store = await getClaimGraphStore();
  const run = await store.getRun(runId);

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const unauthorized = await requireWorkspaceMutation(
    request,
    run.workspaceId,
    store
  );

  if (unauthorized) {
    return unauthorized;
  }

  const cancelable = isActiveRunStatus(run.status);
  let accepted = false;
  let nextRun = run;
  let workflowCancellation:
    | "not_applicable"
    | "not_dispatched"
    | WorkflowCancellationOutcome = hosted ? "not_dispatched" : "not_applicable";

  if (cancelable) {
    if (hosted) {
      const cancellation = await store.transitionRunStatus(runId, {
        expectedStatuses: [...ACTIVE_RUN_STATUSES],
        nextStatus: "canceled",
        statusMessage:
          "Analysis canceled. The workspace remains on the most recent safe graph path.",
        fallbackReason: "analysis_canceled"
      });
      accepted = cancellation.applied;
      nextRun = cancellation.run;

      const workflowRunId = nextRun.observability?.execution?.workflowRunId;

      if (accepted && workflowRunId) {
        workflowCancellation = await cancelWorkflowRunBestEffort(async () => {
          const { getRun: getWorkflowRun } = await import("workflow/api");
          return getWorkflowRun(workflowRunId);
        });
      }
    } else {
      nextRun = cancelAnalysisRun(runId);
      accepted = nextRun.status === "canceled";
    }
  }

  return NextResponse.json({
    accepted,
    workflowCancellation,
    run: sanitizeRunForPublic(nextRun)
  });
}
