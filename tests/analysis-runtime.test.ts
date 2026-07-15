import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@/types/claimgraph";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalStaleAfterMs = process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "analysis-runtime");

async function importModules() {
  const runnerModule = await import("@/lib/server/analyze-runner");
  const storeModule = await import("@/lib/server/store");

  return {
    runnerModule,
    storeModule
  };
}

async function waitForRunStatus(
  getRun: (runId: string) => Run | null,
  runId: string,
  status: Run["status"]
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = getRun(runId);

    if (run?.status === status) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for run ${runId} to reach ${status}.`);
}

describe("analysis runtime bootstrap", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS = "30";
    rmSync(testDataDir, { recursive: true, force: true });
    vi.resetModules();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    vi.resetModules();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }

    if (originalStaleAfterMs === undefined) {
      delete process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS;
    } else {
      process.env.CLAIMGRAPH_RUN_STALE_AFTER_MS = originalStaleAfterMs;
    }
  });

  it("reconciles already-stale runs during runtime bootstrap", async () => {
    const { runnerModule, storeModule } = await importModules();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const workspace = storeModule.createWorkspace("Should cities ban cars downtown?");
    const run = storeModule.createRun(workspace.id, {
      staleAfterMs: 30
    });

    storeModule.markRunExecutionStarted(run.id, {
      ownerId: "stale-runner",
      startedAt: new Date(Date.now() - 120).toISOString(),
      heartbeatAt: new Date(Date.now() - 120).toISOString(),
      staleAfterMs: 30
    });
    storeModule.updateRunStatus(run.id, "gathering", "Gathering evidence.");

    runnerModule.ensureAnalysisRuntimeBootstrapped();

    const failedRun = storeModule.getRun(run.id);

    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.observability?.fallbackReason).toBe("analysis_stale");
    expect(failedRun?.statusMessage).toContain("stopped updating");
  });

  it("marks stalled runs failed even when no later read route is hit", async () => {
    const { runnerModule, storeModule } = await importModules();
    runnerModule.resetAnalysisRunnerForTests();
    storeModule.resetStoreForTests();

    const workspace = storeModule.createWorkspace("Should cities ban cars downtown?");
    const run = storeModule.createRun(workspace.id, {
      staleAfterMs: 30
    });

    storeModule.markRunExecutionStarted(run.id, {
      ownerId: "stale-runner",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      staleAfterMs: 30
    });
    storeModule.updateRunStatus(run.id, "extracting", "Extracting claims.");

    runnerModule.ensureAnalysisRuntimeBootstrapped();

    const failedRun = await waitForRunStatus(storeModule.getRun, run.id, "failed");

    expect(failedRun.observability?.fallbackReason).toBe("analysis_stale");
    expect(failedRun.errorMessage).toContain("stopped heartbeating");
    expect(failedRun.observability?.execution?.finishedAt).toBeTruthy();
  });
});
