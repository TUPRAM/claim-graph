import { NextResponse } from "next/server";
import { z } from "zod";
import { requireDevApiSession } from "@/lib/server/dev-auth";
import {
  listCleanupJobs,
  getCleanupBacklogSummary,
  retryCleanupJob,
  runDueCleanupJobs,
  type CleanupJobStatus
} from "@/lib/server/retention-cleanup";
import { requireSameOriginMutation } from "@/lib/server/workspace-capability";
import {
  BoundedRequestBodyError,
  readBoundedJsonBody
} from "@/lib/server/bounded-request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retrySchema = z.object({
  jobId: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional()
}).strict();

const allowedStatuses = new Set<CleanupJobStatus>([
  "pending",
  "running",
  "failed",
  "completed",
  "dead"
]);

export async function GET(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const statuses = (url.searchParams.get("status") ?? "pending,running,failed,dead")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is CleanupJobStatus =>
      allowedStatuses.has(value as CleanupJobStatus)
    );
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const jobs = await listCleanupJobs({
    statuses,
    limit: Number.isFinite(limit) ? limit : 100
  });

  return NextResponse.json({
    jobs,
    backlog: await getCleanupBacklogSummary(),
    summary: {
      pending: jobs.filter((job) => job.status === "pending").length,
      running: jobs.filter((job) => job.status === "running").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      dead: jobs.filter((job) => job.status === "dead").length
    }
  });
}

export async function POST(request: Request) {
  const unauthorized = requireDevApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const crossOrigin = requireSameOriginMutation(request, {
    errorMessage: "Cross-origin cleanup operations are not allowed."
  });

  if (crossOrigin) {
    return crossOrigin;
  }

  let body: unknown = {};

  if (request.body) {
    try {
      body = await readBoundedJsonBody({
        request,
        maxBytes: 4 * 1024,
        label: "Cleanup operator request"
      });
    } catch (error) {
      if (error instanceof BoundedRequestBodyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
    }
  }

  const parsed = retrySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid cleanup request.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const retried = parsed.data.jobId
    ? await retryCleanupJob(parsed.data.jobId)
    : null;
  const result = await runDueCleanupJobs({ limit: parsed.data.limit });

  return NextResponse.json({ retried, result });
}
