import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "staging-rehearsal-cleanup"
);
const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalStorageDriver = process.env.CLAIMGRAPH_STORAGE_DRIVER;

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function configureCleanupFaultTest(
  armedAction:
    | "fail_next_blob_deletion"
    | "fail_next_db_cleanup_finalization"
) {
  let armed = true;
  const deletePersistedWorkspaceObject = vi.fn(async () => true);
  const throwIfStagingRehearsalFault = vi.fn(async (action: string) => {
    if (armed && action === armedAction) {
      armed = false;
      throw new Error(`Staging rehearsal injected ${action}.`);
    }
  });

  vi.doMock("@/lib/server/object-storage", () => ({
    deleteHostedWorkspaceObjectPrefix: vi.fn(async () => ({
      attemptedCount: 0,
      deletedCount: 0,
      prefix: null
    })),
    deletePersistedWorkspaceObject
  }));
  vi.doMock("@/lib/server/staging-rehearsal", () => ({
    throwIfStagingRehearsalFault
  }));

  const { getClaimGraphStore } = await import(
    "@/lib/server/storage/store-factory"
  );
  const { resetStoreForTests } = await import("@/lib/server/store");
  const { runDueCleanupJobs, scheduleExportRetention } = await import(
    "@/lib/server/retention-cleanup"
  );
  resetStoreForTests();
  const store = await getClaimGraphStore();
  const workspace = await store.createWorkspace(
    "Should staged cleanup failures remain retryable?"
  );
  const now = new Date("2026-07-15T12:00:00.000Z");
  const job = await scheduleExportRetention({
    workspaceId: workspace.id,
    storageProvider: "vercel_blob",
    objectKey: `workspaces/${workspace.id}/exports/rehearsal.md`,
    createdAt: new Date(now.getTime() - 25 * 60 * 60_000)
  });

  return {
    job,
    now,
    runDueCleanupJobs,
    deletePersistedWorkspaceObject,
    throwIfStagingRehearsalFault
  };
}

describe("staging rehearsal cleanup fault consumption", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "local";
    rmSync(testDataDir, { recursive: true, force: true });
    vi.resetModules();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    vi.doUnmock("@/lib/server/object-storage");
    vi.doUnmock("@/lib/server/staging-rehearsal");
    vi.resetModules();
    restore("CLAIMGRAPH_DATA_DIR", originalDataDir);
    restore("CLAIMGRAPH_STORAGE_DRIVER", originalStorageDriver);
  });

  it("fails the next Blob deletion once and completes the retry", async () => {
    const fixture = await configureCleanupFaultTest(
      "fail_next_blob_deletion"
    );

    const first = await fixture.runDueCleanupJobs({ now: fixture.now });
    expect(first).toMatchObject({
      claimedCount: 1,
      failedCount: 1,
      completedCount: 0
    });
    expect(first.results[0]?.error).toContain("fail_next_blob_deletion");
    expect(fixture.deletePersistedWorkspaceObject).not.toHaveBeenCalled();

    const retry = await fixture.runDueCleanupJobs({
      now: new Date(fixture.now.getTime() + 61_000)
    });
    expect(retry).toMatchObject({ claimedCount: 1, completedCount: 1 });
    expect(fixture.deletePersistedWorkspaceObject).toHaveBeenCalledTimes(1);
    expect(fixture.throwIfStagingRehearsalFault).toHaveBeenCalledWith(
      "fail_next_blob_deletion"
    );
  });

  it("fails database cleanup finalization once after deletion and retries idempotently", async () => {
    const fixture = await configureCleanupFaultTest(
      "fail_next_db_cleanup_finalization"
    );

    const first = await fixture.runDueCleanupJobs({ now: fixture.now });
    expect(first).toMatchObject({ failedCount: 1, completedCount: 0 });
    expect(first.results[0]?.error).toContain(
      "fail_next_db_cleanup_finalization"
    );
    expect(fixture.deletePersistedWorkspaceObject).toHaveBeenCalledTimes(1);

    const retry = await fixture.runDueCleanupJobs({
      now: new Date(fixture.now.getTime() + 61_000)
    });
    expect(retry).toMatchObject({ claimedCount: 1, completedCount: 1 });
    expect(fixture.deletePersistedWorkspaceObject).toHaveBeenCalledTimes(2);
    expect(fixture.throwIfStagingRehearsalFault).toHaveBeenCalledWith(
      "fail_next_db_cleanup_finalization"
    );
  });
});
