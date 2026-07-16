import {
  buildStarterDataset,
  DEFAULT_DEMO_QUESTION
} from "@/lib/demo/graph-template";
import { computeRunMetrics } from "@/lib/graph/score";
import { DEFAULT_WORKSPACE_SETTINGS } from "@/lib/workspace/defaults";
import type { Run, Workspace } from "@/types/claimgraph";

export const SYNTHETIC_DEMO_WORKSPACE_ID = "demo";
export const SYNTHETIC_DEMO_RUN_ID = "run_demo";
export const SYNTHETIC_DEMO_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export function isSyntheticDemoWorkspaceId(workspaceId: string) {
  return workspaceId === SYNTHETIC_DEMO_WORKSPACE_ID;
}

export function isSyntheticDemoRunId(runId: string) {
  return runId === SYNTHETIC_DEMO_RUN_ID;
}

export function buildSyntheticDemoWorkspace() {
  return {
    id: SYNTHETIC_DEMO_WORKSPACE_ID,
    question: DEFAULT_DEMO_QUESTION,
    createdAt: SYNTHETIC_DEMO_TIMESTAMP,
    updatedAt: SYNTHETIC_DEMO_TIMESTAMP,
    settings: { ...DEFAULT_WORKSPACE_SETTINGS },
    sourceUrls: []
  } satisfies Workspace;
}

export function buildSyntheticDemoRun() {
  const dataset = buildStarterDataset(DEFAULT_DEMO_QUESTION);

  return {
    id: SYNTHETIC_DEMO_RUN_ID,
    workspaceId: SYNTHETIC_DEMO_WORKSPACE_ID,
    status: "completed",
    createdAt: SYNTHETIC_DEMO_TIMESTAMP,
    completedAt: SYNTHETIC_DEMO_TIMESTAMP,
    statusMessage:
      "Starter scaffold is already materialized on the workspace graph. No persisted live analysis run was created for this demo response.",
    metrics: {
      ...computeRunMetrics(
        dataset.graph,
        dataset.sources.length,
        dataset.snippets.length
      ),
      durationMs: 0
    }
  } satisfies Run;
}
