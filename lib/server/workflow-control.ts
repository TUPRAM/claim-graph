export const DEFAULT_WORKFLOW_CANCELLATION_TIMEOUT_MS = 2_000;

export type WorkflowCancellationOutcome =
  | "requested"
  | "not_found"
  | "failed"
  | "timed_out";

export interface WorkflowCancellationTarget {
  exists?: PromiseLike<boolean> | boolean;
  cancel(): PromiseLike<unknown> | unknown;
}

/**
 * Keeps Workflow control-plane outages outside the database lifecycle boundary.
 * The internally caught attempt may settle after the timeout without creating an
 * unhandled rejection.
 */
export async function cancelWorkflowRunBestEffort(
  getTarget: () =>
    | WorkflowCancellationTarget
    | null
    | PromiseLike<WorkflowCancellationTarget | null>,
  options?: {
    timeoutMs?: number;
    checkExists?: boolean;
  }
): Promise<WorkflowCancellationOutcome> {
  const timeoutMs = Math.max(
    1,
    Math.min(
      options?.timeoutMs ?? DEFAULT_WORKFLOW_CANCELLATION_TIMEOUT_MS,
      30_000
    )
  );
  const attempt = (async (): Promise<WorkflowCancellationOutcome> => {
    try {
      const target = await getTarget();

      if (!target) {
        return "not_found";
      }

      if (options?.checkExists !== false && target.exists != null) {
        if (!(await target.exists)) {
          return "not_found";
        }
      }

      await target.cancel();
      return "requested";
    } catch {
      return "failed";
    }
  })();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<WorkflowCancellationOutcome>((resolve) => {
    timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  const outcome = await Promise.race([attempt, timedOut]);

  if (timeout) {
    clearTimeout(timeout);
  }

  return outcome;
}
