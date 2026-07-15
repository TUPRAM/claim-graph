import { NextResponse } from "next/server";
import { getClaimGraphRuntimeInfo } from "@/lib/claimgraph/config";
import { isWorkflowDurableAnalysisEnabled } from "@/lib/server/durable-analysis";
import { scheduleWorkspaceAnalysis } from "@/lib/server/analyze-runner";
import {
  ACTIVE_RUN_STATUSES,
  isActiveRunStatus
} from "@/lib/server/run-lifecycle";
import {
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";
import { requireWorkspaceMutation } from "@/lib/server/workspace-capability";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  consumePublicBetaRateLimit,
  getEffectivePublicBetaControls,
  getProviderCapacitySnapshot,
  releaseIdempotentOperation
} from "@/lib/server/public-beta-control-store";
import {
  getPublicBetaPolicy,
  isCostBearingAnalysisRuntime
} from "@/lib/server/public-beta-policy";
import {
  HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE,
  isHostedFullModeFileIntakeBlocked
} from "@/lib/server/provider-file-retention";
import { cancelWorkflowRunBestEffort } from "@/lib/server/workflow-control";

async function getWorkspaceId(
  context: { params: Promise<{ workspaceId: string }> }
) {
  return (await context.params).workspaceId;
}

interface AnalysisIdempotencyControl {
  key: string;
  requestFingerprint: string;
}

function getIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  return value && /^[A-Za-z0-9._:-]{8,200}$/u.test(value) ? value : null;
}

function analysisResponse(payload: Record<string, unknown>, status = 202) {
  return NextResponse.json(payload, { status });
}

async function completeAnalysisIdempotency(
  control: AnalysisIdempotencyControl | null,
  payload: Record<string, unknown>,
  status = 202
) {
  if (control) {
    await completeIdempotentOperation({
      scope: "workspace-analysis",
      ...control,
      responseStatus: status,
      response: payload
    });
  }

  return analysisResponse(payload, status);
}

async function releaseAnalysisIdempotency(
  control: AnalysisIdempotencyControl | null
) {
  if (control) {
    await releaseIdempotentOperation({
      scope: "workspace-analysis",
      ...control
    });
  }
}

function throttledAnalysisResponse(input: {
  error: string;
  retryAfterSeconds: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
}) {
  return NextResponse.json(
    { error: input.error },
    {
      status: 429,
      headers: {
        "Retry-After": String(input.retryAfterSeconds),
        ...(input.limit == null
          ? {}
          : {
              "X-RateLimit-Limit": String(input.limit),
              "X-RateLimit-Remaining": String(input.remaining ?? 0),
              "X-RateLimit-Reset": input.resetAt ?? ""
            })
      }
    }
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const workspaceId = await getWorkspaceId(context);
  const store = await getClaimGraphStore();
  const workspace = await store.getWorkspace(workspaceId);

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const runtime = getClaimGraphRuntimeInfo();

  if (workspace.id === "demo") {
    return NextResponse.json({
      runId: "run_demo",
      status: "completed",
      starterMode: true,
      accepted: false,
      created: false
    });
  }

  if (!runtime.liveAnalysisEnabled) {
    const unauthorized = await requireWorkspaceMutation(
      request,
      workspaceId,
      store
    );

    if (unauthorized) {
      return unauthorized;
    }

    const payload = await store.materializeStarterGraphForWorkspace(workspaceId);

    return NextResponse.json({
      runId: payload.run?.id ?? "run_demo",
      status: payload.run?.status ?? "completed",
      starterMode: true,
      accepted: false,
      created: false
    });
  }

  const unauthorized = await requireWorkspaceMutation(
    request,
    workspaceId,
    store
  );

  if (unauthorized) {
    return unauthorized;
  }

  const idempotencyKey = getIdempotencyKey(request);
  const requestFingerprint = `${workspaceId}:analyze`;
  let idempotencyControl: AnalysisIdempotencyControl | null = null;

  if (idempotencyKey) {
    const idempotency = await beginIdempotentOperation({
      scope: "workspace-analysis",
      key: idempotencyKey,
      requestFingerprint
    });

    if (idempotency.kind === "replay") {
      return analysisResponse(
        idempotency.response as Record<string, unknown>,
        idempotency.responseStatus
      );
    }

    if (idempotency.kind === "conflict") {
      return NextResponse.json(
        { error: "This idempotency key was already used for another request." },
        { status: 409 }
      );
    }

    if (idempotency.kind === "in_flight") {
      const activeRun = await store.getActiveRunForWorkspace(workspaceId);

      if (activeRun) {
        const payload = await store.getWorkspaceGraphPayload(workspaceId);
        return analysisResponse({
          runId: activeRun.id,
          status: activeRun.status,
          starterMode: payload?.starterMode ?? true,
          accepted: true,
          created: false
        });
      }

      return NextResponse.json(
        { error: "This analysis request is still being accepted." },
        { status: 409, headers: { "Retry-After": "1" } }
      );
    }

    idempotencyControl = {
      key: idempotencyKey,
      requestFingerprint
    };
  }

  const alreadyActive = await store.getActiveRunForWorkspace(workspaceId);

  if (alreadyActive) {
    const payload = await store.getWorkspaceGraphPayload(workspaceId);
    return completeAnalysisIdempotency(idempotencyControl, {
      runId: alreadyActive.id,
      status: alreadyActive.status,
      starterMode: payload?.starterMode ?? true,
      accepted: true,
      created: false
    });
  }

  if (
    isHostedFullModeFileIntakeBlocked({ mode: runtime.mode }) &&
    (await store.getWorkspaceFiles(workspaceId)).length > 0
  ) {
    await releaseAnalysisIdempotency(idempotencyControl);
    return NextResponse.json(
      { error: HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE },
      { status: 503 }
    );
  }

  const controls = await getEffectivePublicBetaControls();
  const policy = getPublicBetaPolicy();

  if (!controls.analysisEnabled) {
    await releaseAnalysisIdempotency(idempotencyControl);
    return NextResponse.json(
      { error: "Analysis is temporarily disabled by the operator." },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }

  const capacity = await getProviderCapacitySnapshot();

  if (!capacity.available) {
    await releaseAnalysisIdempotency(idempotencyControl);
    return throttledAnalysisResponse({
      error: "Analysis capacity is currently full. Try again shortly.",
      retryAfterSeconds: 15
    });
  }

  const analysisLimit = await consumePublicBetaRateLimit({
    scope: "workspace-analysis",
    subject: workspaceId,
    limit: controls.workspaceAnalysisLimit,
    windowMs: policy.workspaceAnalysis.windowMs
  });

  if (!analysisLimit.allowed) {
    await releaseAnalysisIdempotency(idempotencyControl);
    return throttledAnalysisResponse({
      error: "This workspace has reached its analysis limit. Try again later.",
      ...analysisLimit
    });
  }

  if (isCostBearingAnalysisRuntime(runtime)) {
    const paidLimit = await consumePublicBetaRateLimit({
      scope: "paid-analysis",
      subject: "global-paid-analysis",
      limit: controls.dailyPaidAnalysisLimit,
      windowMs: policy.paidAnalysis.windowMs
    });

    if (!paidLimit.allowed) {
      await releaseAnalysisIdempotency(idempotencyControl);
      return throttledAnalysisResponse({
        error: "The daily paid-analysis ceiling has been reached.",
        ...paidLimit
      });
    }
  }

  if (isHostedClaimGraphStoreSelected()) {
    const acquired = await store.acquireActiveRun(workspaceId);
    const run = acquired.run;

    if (!acquired.created) {
      const payload = await store.getWorkspaceGraphPayload(workspaceId);

      return completeAnalysisIdempotency(
        idempotencyControl,
        {
          runId: run.id,
          status: run.status,
          starterMode: payload?.starterMode ?? true,
          accepted: isActiveRunStatus(run.status),
          created: false
        }
      );
    }

    if (isWorkflowDurableAnalysisEnabled()) {
      // Workflow's Node runtime performs deployment-path discovery at module
      // initialization. Loading it eagerly breaks local Next dev routes that
      // never use the hosted runner, so keep both Workflow modules behind the
      // durable-runner branch.
      let workflowRun: { runId: string; cancel(): Promise<unknown> } | null = null;
      let dispatchedRun = run;

      try {
        const [{ start }, { runClaimGraphHostedAnalysis }] = await Promise.all([
          import("workflow/api"),
          import("@/workflows/claimgraph-analysis")
        ]);
        workflowRun = await start(
          runClaimGraphHostedAnalysis,
          [
            {
              workspaceId,
              runId: run.id
            }
          ],
          {
            deploymentId: "latest"
          }
        );
        dispatchedRun = await store.recordRunWorkflowDispatch(run.id, {
          workflowRunId: workflowRun.runId
        });
      } catch {
        const failed = await store.transitionRunStatus(run.id, {
          expectedStatuses: [...ACTIVE_RUN_STATUSES],
          nextStatus: "failed",
          statusMessage:
            "The hosted Workflow could not be dispatched. Retry analysis to start a fresh run.",
          errorMessage: "Hosted durable analysis could not be dispatched.",
          fallbackReason: "gathering_failed"
        });
        // Seal the run before reopening the idempotency key. Otherwise a retry
        // can observe the old run as active and persist a stale queued replay
        // while this failure path is still terminalizing it.
        await releaseAnalysisIdempotency(idempotencyControl);
        if (workflowRun) {
          await cancelWorkflowRunBestEffort(() => workflowRun, {
            checkExists: false
          });
        }
        const payload = await store.getWorkspaceGraphPayload(workspaceId);

        return NextResponse.json(
          {
            runId: failed.run.id,
            status: failed.run.status,
            starterMode: payload?.starterMode ?? true,
            accepted: false,
            created: true,
            error: "Hosted durable analysis could not be dispatched."
          },
          { status: 503 }
        );
      }

      if (!isActiveRunStatus(dispatchedRun.status)) {
        await cancelWorkflowRunBestEffort(() => workflowRun, {
          checkExists: false
        });
      }

      let starterMode = true;

      try {
        starterMode =
          (await store.getWorkspaceGraphPayload(workspaceId))?.starterMode ?? true;
      } catch {
        // Dispatch is already durable. A response-only graph read must not
        // cancel or fail the Workflow that was successfully started.
      }

      return completeAnalysisIdempotency(
        idempotencyControl,
        {
          runId: dispatchedRun.id,
          status: dispatchedRun.status,
          starterMode,
          accepted: isActiveRunStatus(dispatchedRun.status),
          created: true
        }
      );
    }

    const failed = await store.transitionRunStatus(run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "failed",
      statusMessage:
        "Hosted durable analysis is implemented but not enabled. Configure CLAIMGRAPH_DURABLE_RUNNER=workflow after Vercel Workflow is ready.",
      errorMessage: "Hosted durable analysis runner is not enabled."
    });
    const payload = await store.getWorkspaceGraphPayload(workspaceId);
    await releaseAnalysisIdempotency(idempotencyControl);

    return NextResponse.json(
      {
        runId: failed.run.id,
        status: failed.run.status,
        starterMode: payload?.starterMode ?? true,
        accepted: false,
        created: true,
        error: "Hosted durable analysis runner is not enabled."
      },
      { status: 501 }
    );
  }

  const { run, created } = scheduleWorkspaceAnalysis(workspaceId);
  const payload = await store.getWorkspaceGraphPayload(workspaceId);

  return completeAnalysisIdempotency(
    idempotencyControl,
    {
      runId: run.id,
      status: run.status,
      starterMode: payload?.starterMode ?? true,
      accepted: true,
      created
    }
  );
}
