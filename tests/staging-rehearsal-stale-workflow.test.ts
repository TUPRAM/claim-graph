import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  getRun: vi.fn(),
  workflow: vi.fn()
}));

vi.mock("@/lib/server/dev-auth", () => ({
  requireDevApiSession: vi.fn(() => null)
}));

vi.mock("@/lib/server/workspace-capability", () => ({
  requireSameOriginMutation: vi.fn(() => null)
}));

vi.mock("@/lib/server/storage/store-factory", () => ({
  getClaimGraphStore: vi.fn(() => ({ getRun: mocks.getRun }))
}));

vi.mock("workflow/api", () => ({ start: mocks.start }));

vi.mock("@/workflows/claimgraph-analysis", () => ({
  runClaimGraphHostedAnalysis: mocks.workflow
}));

vi.mock("@/lib/server/staging-rehearsal", () => {
  class StagingRehearsalUnavailableError extends Error {
    readonly status = 403;
    readonly reason: string;

    constructor(availability: { reason: string }) {
      super("Staging rehearsal controls are unavailable.");
      this.reason = availability.reason;
    }
  }

  return {
    STAGING_REHEARSAL_ACTIONS: [
      "pause_after_evidence_persistence",
      "pause_after_inventory_persistence",
      "fail_next_blob_deletion",
      "fail_next_db_cleanup_finalization"
    ],
    STAGING_REHEARSAL_DEFAULT_TTL_SECONDS: 180,
    STAGING_REHEARSAL_MAX_TTL_SECONDS: 600,
    STAGING_REHEARSAL_MIN_TTL_SECONDS: 5,
    StagingRehearsalUnavailableError,
    activateStagingRehearsalAction: vi.fn(),
    releaseStagingRehearsalBarriers: vi.fn(),
    getStagingRehearsalSnapshot: vi.fn(async () => ({
      availability: {
        enabled: true,
        reason: "ready",
        deploymentRole: "staging",
        canonicalOrigin: "https://staging.claimgraph.example"
      },
      actions: {},
      updatedAt: null
    }))
  };
});

import { PUT } from "@/app/api/dev/staging-rehearsal/route";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000002";

function request(body: unknown) {
  return new Request("https://staging.claimgraph.example/api/dev/staging-rehearsal", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://staging.claimgraph.example"
    },
    body: JSON.stringify(body)
  });
}

describe("staging stale Workflow rehearsal dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRun.mockResolvedValue({
      id: runId,
      workspaceId,
      status: "canceled"
    });
    mocks.start.mockResolvedValue({
      returnValue: Promise.resolve({ status: "stopped" })
    });
  });

  it("starts the deployed workflow only for the exact canceled run", async () => {
    const response = await PUT(
      request({ action: "start_stale_workflow", workspaceId, runId })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      updated: true,
      staleWorkflow: { dispatched: true, resultStatus: "stopped" }
    });
    expect(mocks.start).toHaveBeenCalledWith(
      mocks.workflow,
      [{ workspaceId, runId }],
      { deploymentId: "latest" }
    );
  });

  it("refuses a run that does not belong to the supplied workspace", async () => {
    mocks.getRun.mockResolvedValue({
      id: runId,
      workspaceId: "30000000-0000-4000-8000-000000000003",
      status: "canceled"
    });

    const response = await PUT(
      request({ action: "start_stale_workflow", workspaceId, runId })
    );

    expect(response.status).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("refuses a non-canceled run", async () => {
    mocks.getRun.mockResolvedValue({ id: runId, workspaceId, status: "failed" });

    const response = await PUT(
      request({ action: "start_stale_workflow", workspaceId, runId })
    );

    expect(response.status).toBe(409);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
