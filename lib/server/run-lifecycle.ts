import type { Run, RunFallbackReason } from "@/types/claimgraph";
import type { ClaimGraphStore } from "@/lib/server/storage/claimgraph-store";

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "ingesting",
  "gathering",
  "extracting",
  "assembling"
] as const satisfies readonly Run["status"][];

export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number];

const ACTIVE_RUN_STATUS_SET = new Set<Run["status"]>(ACTIVE_RUN_STATUSES);

const ALLOWED_RUN_TRANSITIONS: Record<Run["status"], readonly Run["status"][]> = {
  queued: ["ingesting", "gathering", "canceled", "completed", "failed"],
  ingesting: ["gathering", "canceled", "failed"],
  gathering: ["extracting", "canceled", "insufficient_evidence", "failed"],
  extracting: ["assembling", "canceled", "insufficient_evidence", "failed"],
  assembling: ["canceled", "completed", "failed"],
  canceled: [],
  insufficient_evidence: [],
  completed: [],
  failed: []
};

export type RunLifecycleGuardReason =
  | "run_not_found"
  | "workspace_mismatch"
  | "status_mismatch"
  | "superseded"
  | "invalid_transition";

export class RunLifecycleGuardError extends Error {
  readonly code = "CLAIMGRAPH_RUN_LIFECYCLE_GUARD";

  constructor(
    message: string,
    readonly reason: RunLifecycleGuardReason,
    readonly runId: string,
    readonly operation: string,
    readonly run?: Run
  ) {
    super(message);
    this.name = "RunLifecycleGuardError";
  }
}

export function isRunLifecycleGuardError(
  error: unknown
): error is RunLifecycleGuardError {
  return error instanceof RunLifecycleGuardError ||
    Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "CLAIMGRAPH_RUN_LIFECYCLE_GUARD"
    );
}

export function isActiveRunStatus(
  status: Run["status"]
): status is ActiveRunStatus {
  return ACTIVE_RUN_STATUS_SET.has(status);
}

export function isAllowedRunTransition(
  currentStatus: Run["status"],
  nextStatus: Run["status"]
) {
  return ALLOWED_RUN_TRANSITIONS[currentStatus].includes(nextStatus);
}

export function assertRunAtStatus(
  run: Run | null,
  input: {
    runId: string;
    workspaceId: string;
    expectedStatuses: readonly Run["status"][];
    operation: string;
  }
): Run {
  if (!run) {
    throw new RunLifecycleGuardError(
      `Run ${input.runId} was not found before ${input.operation}.`,
      "run_not_found",
      input.runId,
      input.operation
    );
  }

  if (run.workspaceId !== input.workspaceId) {
    throw new RunLifecycleGuardError(
      `Run ${input.runId} does not belong to workspace ${input.workspaceId}.`,
      "workspace_mismatch",
      input.runId,
      input.operation,
      run
    );
  }

  if (!input.expectedStatuses.includes(run.status)) {
    throw new RunLifecycleGuardError(
      `Run ${input.runId} is ${run.status}; ${input.operation} requires ${input.expectedStatuses.join(
        " or "
      )}.`,
      "status_mismatch",
      input.runId,
      input.operation,
      run
    );
  }

  return run;
}

export async function requireRunAtStatus(
  store: ClaimGraphStore,
  input: {
    runId: string;
    workspaceId: string;
    expectedStatuses: readonly Run["status"][];
    operation: string;
  }
) {
  const run = await store.getRun(input.runId);
  return assertRunAtStatus(run, input);
}

export async function requireCurrentRunAtStatus(
  store: ClaimGraphStore,
  input: {
    runId: string;
    workspaceId: string;
    expectedStatuses: readonly Run["status"][];
    operation: string;
  }
) {
  const run = await requireRunAtStatus(store, input);

  if (!isActiveRunStatus(run.status)) {
    return run;
  }

  const [activeRun, latestRun] = await Promise.all([
    store.getActiveRunForWorkspace(input.workspaceId),
    store.getLatestRunForWorkspace(input.workspaceId)
  ]);

  if (activeRun?.id !== run.id || latestRun?.id !== run.id) {
    throw new RunLifecycleGuardError(
      `Run ${input.runId} was superseded before ${input.operation}.`,
      "superseded",
      input.runId,
      input.operation,
      run
    );
  }

  return run;
}

function assertTransitionIsAllowed(input: {
  runId: string;
  expectedStatuses: readonly Run["status"][];
  nextStatus: Run["status"];
  operation: string;
}) {
  const invalidStatus = input.expectedStatuses.find(
    (status) => !isAllowedRunTransition(status, input.nextStatus)
  );

  if (invalidStatus) {
    throw new RunLifecycleGuardError(
      `Run transition ${invalidStatus} -> ${input.nextStatus} is not allowed for ${input.operation}.`,
      "invalid_transition",
      input.runId,
      input.operation
    );
  }
}

export async function tryTransitionRun(
  store: ClaimGraphStore,
  input: {
    runId: string;
    workspaceId: string;
    expectedStatuses: readonly Run["status"][];
    nextStatus: Run["status"];
    statusMessage?: string;
    fallbackReason?: RunFallbackReason;
    errorMessage?: string;
    operation: string;
  }
) {
  assertTransitionIsAllowed(input);
  const currentRun = await requireRunAtStatus(store, input);
  const result = await store.transitionRunStatus(input.runId, {
    expectedStatuses: [...input.expectedStatuses],
    nextStatus: input.nextStatus,
    statusMessage: input.statusMessage,
    fallbackReason: input.fallbackReason,
    errorMessage: input.errorMessage
  });

  if (result.run.workspaceId !== input.workspaceId) {
    throw new RunLifecycleGuardError(
      `Run ${input.runId} changed workspace ownership during ${input.operation}.`,
      "workspace_mismatch",
      input.runId,
      input.operation,
      result.run
    );
  }

  return {
    ...result,
    previousRun: currentRun
  };
}

export async function transitionRunOrThrow(
  store: ClaimGraphStore,
  input: {
    runId: string;
    workspaceId: string;
    expectedStatuses: readonly Run["status"][];
    nextStatus: Run["status"];
    statusMessage?: string;
    fallbackReason?: RunFallbackReason;
    errorMessage?: string;
    operation: string;
  }
) {
  const result = await tryTransitionRun(store, input);

  if (!result.applied) {
    throw new RunLifecycleGuardError(
      `Run ${input.runId} changed to ${result.run.status} before ${input.operation} could finish.`,
      "status_mismatch",
      input.runId,
      input.operation,
      result.run
    );
  }

  return result.run;
}
