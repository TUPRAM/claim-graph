import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BoundedRequestBodyError,
  readBoundedJsonBody
} from "@/lib/server/bounded-request-body";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";
import {
  STAGING_REHEARSAL_ACTIONS,
  STAGING_REHEARSAL_DEFAULT_TTL_SECONDS,
  STAGING_REHEARSAL_MAX_TTL_SECONDS,
  STAGING_REHEARSAL_MIN_TTL_SECONDS,
  StagingRehearsalUnavailableError,
  activateStagingRehearsalAction,
  getStagingRehearsalSnapshot,
  releaseStagingRehearsalBarriers
} from "@/lib/server/staging-rehearsal";
import { requireSameOriginMutation } from "@/lib/server/workspace-capability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(STAGING_REHEARSAL_ACTIONS),
    ttlSeconds: z.number().int()
      .min(STAGING_REHEARSAL_MIN_TTL_SECONDS)
      .max(STAGING_REHEARSAL_MAX_TTL_SECONDS)
      .default(STAGING_REHEARSAL_DEFAULT_TTL_SECONDS)
  }).strict(),
  z.object({
    action: z.literal("release_barriers")
  }).strict(),
  z.object({
    action: z.literal("start_stale_workflow"),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid()
  }).strict()
]);

async function startStaleWorkflow(input: {
  workspaceId: string;
  runId: string;
}) {
  const snapshot = await getStagingRehearsalSnapshot();

  if (!snapshot.availability.enabled) {
    throw new StagingRehearsalUnavailableError(snapshot.availability);
  }

  const store = await getClaimGraphStore();
  const run = await store.getRun(input.runId);

  if (!run || run.workspaceId !== input.workspaceId) {
    return NextResponse.json(
      { error: "The staging rehearsal run was not found." },
      { status: 404 }
    );
  }

  if (run.status !== "canceled") {
    return NextResponse.json(
      { error: "Only a canceled run can be used for the stale Workflow rehearsal." },
      { status: 409 }
    );
  }

  const [{ start }, { runClaimGraphHostedAnalysis }] = await Promise.all([
    import("workflow/api"),
    import("@/workflows/claimgraph-analysis")
  ]);
  const workflowRun = await start(
    runClaimGraphHostedAnalysis,
    [{ workspaceId: input.workspaceId, runId: input.runId }],
    { deploymentId: "latest" }
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      workflowRun.returnValue,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The stale Workflow rehearsal timed out.")),
          45_000
        );
      })
    ]);

    return NextResponse.json({
      updated: true,
      staleWorkflow: {
        dispatched: true,
        resultStatus:
          result && typeof result === "object" && "status" in result
            ? result.status
            : null
      }
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function GET(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  return NextResponse.json(await getStagingRehearsalSnapshot());
}

export async function PUT(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const crossOrigin = requireSameOriginMutation(request, {
    errorMessage: "Cross-origin staging rehearsal changes are not allowed."
  });

  if (crossOrigin) {
    return crossOrigin;
  }

  let body: unknown;

  try {
    body = await readBoundedJsonBody({
      request,
      maxBytes: 4 * 1024,
      label: "Staging rehearsal control request"
    });
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = mutationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid staging rehearsal action.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    if (parsed.data.action === "start_stale_workflow") {
      return startStaleWorkflow(parsed.data);
    }

    const snapshot =
      parsed.data.action === "release_barriers"
        ? await releaseStagingRehearsalBarriers()
        : await activateStagingRehearsalAction(parsed.data);

    return NextResponse.json({ updated: true, ...snapshot });
  } catch (error) {
    if (error instanceof StagingRehearsalUnavailableError) {
      return NextResponse.json(
        {
          error: "Staging rehearsal controls are unavailable.",
          reason: error.reason
        },
        { status: error.status }
      );
    }

    throw error;
  }
}
