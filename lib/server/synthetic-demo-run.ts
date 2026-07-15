import type { Run } from "@/types/claimgraph";

export const SYNTHETIC_DEMO_RUN_ID = "run_demo";

export function isSyntheticDemoRunId(runId: string) {
  return runId === SYNTHETIC_DEMO_RUN_ID;
}

export function buildSyntheticDemoRun() {
  const timestamp = "1970-01-01T00:00:00.000Z";

  return {
    id: SYNTHETIC_DEMO_RUN_ID,
    workspaceId: "demo",
    status: "completed",
    createdAt: timestamp,
    completedAt: timestamp,
    statusMessage:
      "Starter scaffold is already materialized on the workspace graph. No persisted live analysis run was created for this demo response.",
    metrics: {
      sourceCount: 0,
      snippetCount: 0,
      claimCount: 0,
      counterclaimCount: 0,
      evidenceCount: 0,
      gapCount: 0,
      totalNodeCount: 0,
      durationMs: 0
    }
  } satisfies Run;
}
