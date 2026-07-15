import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_WRITE_CAPABILITY_HEADER,
  hashWorkspaceWriteCapability
} from "@/lib/server/workspace-capability";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "hosted-run-routes"
);
const workspaceCapability = "a".repeat(43);
const workspaceCapabilityHeaders = {
  Origin: "http://localhost",
  [WORKSPACE_WRITE_CAPABILITY_HEADER]: workspaceCapability
};

function workspaceContext(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function runContext(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

describe("hosted run route integrity", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("workflow/api");
    vi.doUnmock("@/lib/server/storage/store-factory");
    vi.doUnmock("@/lib/server/durable-analysis");
    vi.doUnmock("@/lib/claimgraph/config");
    vi.doUnmock("@/workflows/claimgraph-analysis");
    vi.resetModules();
  });

  afterAll(() => {
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
    vi.resetModules();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }
  });

  it("starts one Workflow for two simultaneous Analyze requests", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should Analyze be single-flight?",
      undefined,
      [],
      { writeCapabilityHash: hashWorkspaceWriteCapability(workspaceCapability) }
    );
    const start = vi.fn(async () => ({ runId: "workflow-single-flight" }));

    vi.doMock("workflow/api", () => ({
      start,
      getRun: vi.fn()
    }));
    vi.doMock("@/lib/server/storage/store-factory", () => ({
      getClaimGraphStore: vi.fn(async () => localClaimGraphStore),
      isHostedClaimGraphStoreSelected: vi.fn(() => true)
    }));
    vi.doMock("@/lib/server/durable-analysis", () => ({
      isWorkflowDurableAnalysisEnabled: vi.fn(() => true)
    }));
    vi.doMock("@/lib/claimgraph/config", () => ({
      getClaimGraphRuntimeInfo: vi.fn(() => ({
        mode: "full",
        provider: "openai",
        liveAnalysisEnabled: true,
        supportsUrlIntake: true,
        supportsWebSearch: true
      }))
    }));
    vi.doMock("@/workflows/claimgraph-analysis", () => ({
      runClaimGraphHostedAnalysis: vi.fn()
    }));

    const { POST } = await import("@/app/api/workspaces/[workspaceId]/analyze/route");
    const [leftResponse, rightResponse] = await Promise.all([
      POST(
        new Request(`http://localhost/api/workspaces/${workspace.id}/analyze`, {
          method: "POST",
          headers: workspaceCapabilityHeaders
        }),
        workspaceContext(workspace.id)
      ),
      POST(
        new Request(`http://localhost/api/workspaces/${workspace.id}/analyze`, {
          method: "POST",
          headers: workspaceCapabilityHeaders
        }),
        workspaceContext(workspace.id)
      )
    ]);
    const [left, right] = (await Promise.all([
      leftResponse.json(),
      rightResponse.json()
    ])) as Array<{
      runId: string;
      workflowRunId?: string;
      created: boolean;
      accepted: boolean;
    }>;

    expect(leftResponse.status).toBe(202);
    expect(rightResponse.status).toBe(202);
    expect(left.runId).toBe(right.runId);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.accepted).toBe(true);
    expect(right.accepted).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);

    const persisted = await localClaimGraphStore.getRun(left.runId);
    expect(persisted?.observability?.execution).toMatchObject({
      mode: "vercel_workflow",
      workflowRunId: "workflow-single-flight"
    });
  });

  it("keeps database cancellation terminal when Workflow cancellation fails", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should database cancellation survive an SDK failure?",
      undefined,
      [],
      { writeCapabilityHash: hashWorkspaceWriteCapability(workspaceCapability) }
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    await localClaimGraphStore.recordRunWorkflowDispatch(acquired.run.id, {
      workflowRunId: "workflow-cancel-failure"
    });
    const cancel = vi.fn(async () => {
      throw new Error("Workflow control plane unavailable.");
    });
    const getWorkflowRun = vi.fn(() => ({
      exists: Promise.resolve(true),
      cancel
    }));

    vi.doMock("workflow/api", () => ({
      start: vi.fn(),
      getRun: getWorkflowRun
    }));
    vi.doMock("@/lib/server/storage/store-factory", () => ({
      getClaimGraphStore: vi.fn(async () => localClaimGraphStore),
      isHostedClaimGraphStoreSelected: vi.fn(() => true)
    }));

    const { DELETE } = await import("@/app/api/runs/[runId]/route");
    const response = await DELETE(
      new Request(`http://localhost/api/runs/${acquired.run.id}`, {
        method: "DELETE",
        headers: workspaceCapabilityHeaders
      }),
      runContext(acquired.run.id)
    );
    const payload = (await response.json()) as {
      accepted: boolean;
      workflowCancellation: string;
      run: { id: string; status: string };
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      accepted: true,
      workflowCancellation: "failed",
      run: { id: acquired.run.id, status: "canceled" }
    });
    expect(getWorkflowRun).toHaveBeenCalledWith("workflow-cancel-failure");
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "canceled"
    });

    const staleCompletion = await localClaimGraphStore.transitionRunStatus(
      acquired.run.id,
      {
        expectedStatuses: ["canceled"],
        nextStatus: "completed",
        statusMessage: "A stale workflow attempted to complete."
      }
    );
    expect(staleCompletion).toMatchObject({
      applied: false,
      run: { status: "canceled" }
    });
  });

  it("returns after a bounded wait when public Workflow cancellation never settles", async () => {
    vi.useFakeTimers();
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should public cancellation survive a hung Workflow control plane?",
      undefined,
      [],
      { writeCapabilityHash: hashWorkspaceWriteCapability(workspaceCapability) }
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    await localClaimGraphStore.recordRunWorkflowDispatch(acquired.run.id, {
      workflowRunId: "workflow-cancel-hangs"
    });
    const cancel = vi.fn(() => new Promise<never>(() => undefined));
    const getWorkflowRun = vi.fn(() => ({
      exists: Promise.resolve(true),
      cancel
    }));

    vi.doMock("workflow/api", () => ({
      start: vi.fn(),
      getRun: getWorkflowRun
    }));
    vi.doMock("@/lib/server/storage/store-factory", () => ({
      getClaimGraphStore: vi.fn(async () => localClaimGraphStore),
      isHostedClaimGraphStoreSelected: vi.fn(() => true)
    }));

    const { DELETE } = await import("@/app/api/runs/[runId]/route");
    const responsePromise = DELETE(
      new Request(`http://localhost/api/runs/${acquired.run.id}`, {
        method: "DELETE",
        headers: workspaceCapabilityHeaders
      }),
      runContext(acquired.run.id)
    );

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "canceled"
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await responsePromise;
    const payload = (await response.json()) as {
      accepted: boolean;
      workflowCancellation: string;
      run: { id: string; status: string };
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      accepted: true,
      workflowCancellation: "timed_out",
      run: { id: acquired.run.id, status: "canceled" }
    });
    expect(getWorkflowRun).toHaveBeenCalledWith("workflow-cancel-hangs");
  });

  it("does not cancel a dispatched Workflow when the response graph read fails", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should a response-only graph read failure cancel durable work?",
      undefined,
      [],
      { writeCapabilityHash: hashWorkspaceWriteCapability(workspaceCapability) }
    );
    const cancel = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({
      runId: "workflow-response-read-failure",
      cancel
    }));
    const storeWithFailingPayloadRead = {
      ...localClaimGraphStore,
      getWorkspaceGraphPayload: vi.fn(async () => {
        throw new Error("Transient graph payload read failure.");
      })
    };

    vi.doMock("workflow/api", () => ({
      start,
      getRun: vi.fn()
    }));
    vi.doMock("@/lib/server/storage/store-factory", () => ({
      getClaimGraphStore: vi.fn(async () => storeWithFailingPayloadRead),
      isHostedClaimGraphStoreSelected: vi.fn(() => true)
    }));
    vi.doMock("@/lib/server/durable-analysis", () => ({
      isWorkflowDurableAnalysisEnabled: vi.fn(() => true)
    }));
    vi.doMock("@/lib/claimgraph/config", () => ({
      getClaimGraphRuntimeInfo: vi.fn(() => ({
        mode: "full",
        provider: "openai",
        liveAnalysisEnabled: true,
        supportsUrlIntake: true,
        supportsWebSearch: true
      }))
    }));
    vi.doMock("@/workflows/claimgraph-analysis", () => ({
      runClaimGraphHostedAnalysis: vi.fn()
    }));

    const { POST } = await import("@/app/api/workspaces/[workspaceId]/analyze/route");
    const response = await POST(
      new Request(`http://localhost/api/workspaces/${workspace.id}/analyze`, {
        method: "POST",
        headers: workspaceCapabilityHeaders
      }),
      workspaceContext(workspace.id)
    );
    const payload = (await response.json()) as {
      runId: string;
      status: string;
      accepted: boolean;
      starterMode: boolean;
    };

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({
      status: "queued",
      accepted: true,
      starterMode: true
    });
    expect(cancel).not.toHaveBeenCalled();
    await expect(localClaimGraphStore.getRun(payload.runId)).resolves.toMatchObject({
      status: "queued",
      observability: {
        execution: {
          workflowRunId: "workflow-response-read-failure"
        }
      }
    });
  });

  it("fails the acquired run and releases idempotency when Workflow import initialization fails", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should a failed Workflow import strand a queued run?",
      undefined,
      [],
      { writeCapabilityHash: hashWorkspaceWriteCapability(workspaceCapability) }
    );

    vi.doMock("workflow/api", () => {
      throw new Error("Workflow module initialization failed.");
    });
    vi.doMock("@/lib/server/storage/store-factory", () => ({
      getClaimGraphStore: vi.fn(async () => localClaimGraphStore),
      isHostedClaimGraphStoreSelected: vi.fn(() => true)
    }));
    vi.doMock("@/lib/server/durable-analysis", () => ({
      isWorkflowDurableAnalysisEnabled: vi.fn(() => true)
    }));
    vi.doMock("@/lib/claimgraph/config", () => ({
      getClaimGraphRuntimeInfo: vi.fn(() => ({
        mode: "full",
        provider: "openai",
        liveAnalysisEnabled: true,
        supportsUrlIntake: true,
        supportsWebSearch: true
      }))
    }));
    vi.doMock("@/workflows/claimgraph-analysis", () => ({
      runClaimGraphHostedAnalysis: vi.fn()
    }));

    const { POST } = await import("@/app/api/workspaces/[workspaceId]/analyze/route");
    const request = () =>
      new Request(`http://localhost/api/workspaces/${workspace.id}/analyze`, {
        method: "POST",
        headers: {
          ...workspaceCapabilityHeaders,
          "Idempotency-Key": "workflow-import-failure-1"
        }
      });
    const firstResponse = await POST(request(), workspaceContext(workspace.id));
    const first = (await firstResponse.json()) as {
      runId: string;
      status: string;
      accepted: boolean;
    };

    expect(firstResponse.status).toBe(503);
    expect(first).toMatchObject({ status: "failed", accepted: false });
    await expect(localClaimGraphStore.getRun(first.runId)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "Hosted durable analysis could not be dispatched."
    });

    const secondResponse = await POST(request(), workspaceContext(workspace.id));
    const second = (await secondResponse.json()) as {
      runId: string;
      status: string;
      accepted: boolean;
    };

    expect(secondResponse.status).toBe(503);
    expect(second).toMatchObject({ status: "failed", accepted: false });
    expect(second.runId).not.toBe(first.runId);
    await expect(
      localClaimGraphStore.listRunsByStatuses(["failed"])
    ).resolves.toHaveLength(2);
  });

  it("terminalizes dispatch failure and admits a same-key retry while Workflow cancellation hangs", async () => {
    vi.useFakeTimers();
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();
    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a hung dispatch cleanup retain the analysis idempotency key?",
      undefined,
      [],
      { writeCapabilityHash: hashWorkspaceWriteCapability(workspaceCapability) }
    );
    const cancel = vi.fn(() => new Promise<never>(() => undefined));
    const start = vi.fn(async () => ({
      runId: `workflow-dispatch-${start.mock.calls.length}`,
      cancel
    }));
    const storeWithDispatchFailure = {
      ...localClaimGraphStore,
      recordRunWorkflowDispatch: vi.fn(async () => {
        throw new Error("Workflow dispatch metadata persistence failed.");
      })
    };

    vi.doMock("workflow/api", () => ({
      start,
      getRun: vi.fn()
    }));
    vi.doMock("@/lib/server/storage/store-factory", () => ({
      getClaimGraphStore: vi.fn(async () => storeWithDispatchFailure),
      isHostedClaimGraphStoreSelected: vi.fn(() => true)
    }));
    vi.doMock("@/lib/server/durable-analysis", () => ({
      isWorkflowDurableAnalysisEnabled: vi.fn(() => true)
    }));
    vi.doMock("@/lib/claimgraph/config", () => ({
      getClaimGraphRuntimeInfo: vi.fn(() => ({
        mode: "full",
        provider: "openai",
        liveAnalysisEnabled: true,
        supportsUrlIntake: true,
        supportsWebSearch: true
      }))
    }));
    vi.doMock("@/workflows/claimgraph-analysis", () => ({
      runClaimGraphHostedAnalysis: vi.fn()
    }));

    const { POST } = await import("@/app/api/workspaces/[workspaceId]/analyze/route");
    const request = () =>
      new Request(`http://localhost/api/workspaces/${workspace.id}/analyze`, {
        method: "POST",
        headers: {
          ...workspaceCapabilityHeaders,
          "Idempotency-Key": "workflow-cancel-hang-1"
        }
      });
    const firstResponsePromise = POST(request(), workspaceContext(workspace.id));

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await expect(
      localClaimGraphStore.listRunsByStatuses(["failed"])
    ).resolves.toHaveLength(1);

    // The second request starts before the first cancellation wait times out.
    // It can only acquire a fresh run if terminalization and idempotency release
    // both happened before best-effort Workflow cancellation.
    const secondResponsePromise = POST(request(), workspaceContext(workspace.id));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(2_000);
    const [firstResponse, secondResponse] = await Promise.all([
      firstResponsePromise,
      secondResponsePromise
    ]);
    const [first, second] = (await Promise.all([
      firstResponse.json(),
      secondResponse.json()
    ])) as Array<{
      runId: string;
      status: string;
      accepted: boolean;
    }>;

    expect(firstResponse.status).toBe(503);
    expect(secondResponse.status).toBe(503);
    expect(first).toMatchObject({ status: "failed", accepted: false });
    expect(second).toMatchObject({ status: "failed", accepted: false });
    expect(second.runId).not.toBe(first.runId);
    await expect(
      localClaimGraphStore.listRunsByStatuses(["failed"])
    ).resolves.toHaveLength(2);
  });
});
