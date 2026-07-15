import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as runCleanupCron } from "@/app/api/internal/cleanup/route";
import { POST as createWorkspaceRoute } from "@/app/api/workspaces/route";
import { withClaimGraphDatabase } from "@/lib/server/database";
import {
  persistWorkspaceExportArtifact,
  persistWorkspaceFileObject,
  readWorkspaceFileObject
} from "@/lib/server/object-storage";
import {
  acquireProviderLease,
  beginIdempotentOperation,
  completeIdempotentOperation,
  consumePublicBetaRateLimit,
  getEffectivePublicBetaControls,
  getProviderCapacitySnapshot,
  hashPublicBetaSubject,
  releaseProviderLease,
  updatePublicBetaOperatorOverrides
} from "@/lib/server/public-beta-control-store";
import {
  isCostBearingAnalysisRuntime,
  getPublicBetaSafetyConfiguration,
  publicBetaPrivacyCopy
} from "@/lib/server/public-beta-policy";
import {
  drainDueCleanupJobs,
  getCleanupBacklogSummary,
  runDueCleanupJobs,
  scheduleExportRetention,
  scheduleUploadRetention
} from "@/lib/server/retention-cleanup";
import { getWorkspaceExportFilePath } from "@/lib/server/runtime-data";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";
import { resetStoreForTests } from "@/lib/server/store";
import {
  WORKSPACE_WRITE_CAPABILITY_HEADER,
  generateWorkspaceWriteCapability
} from "@/lib/server/workspace-capability";
import { isHostedFullModeFileIntakeBlocked } from "@/lib/server/provider-file-retention";
import { OpenAIProvider } from "@/lib/providers/openai-provider";
import type { WorkspaceFile } from "@/types/claimgraph";

const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "public-beta-controls"
);
const originalEnv = {
  dataDir: process.env.CLAIMGRAPH_DATA_DIR,
  storageDriver: process.env.CLAIMGRAPH_STORAGE_DRIVER,
  abuseSecret: process.env.CLAIMGRAPH_ABUSE_HASH_SECRET,
  creationLimit: process.env.CLAIMGRAPH_CREATE_LIMIT_PER_IP,
  providerConcurrency: process.env.CLAIMGRAPH_PROVIDER_CONCURRENCY,
  cronSecret: process.env.CRON_SECRET
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("durable public-beta controls", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "local";
    process.env.CLAIMGRAPH_ABUSE_HASH_SECRET = "test-abuse-hash-secret-32-bytes!";
    delete process.env.CLAIMGRAPH_CREATE_LIMIT_PER_IP;
    delete process.env.CLAIMGRAPH_PROVIDER_CONCURRENCY;
    delete process.env.CRON_SECRET;
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
    restore("CLAIMGRAPH_DATA_DIR", originalEnv.dataDir);
    restore("CLAIMGRAPH_STORAGE_DRIVER", originalEnv.storageDriver);
    restore("CLAIMGRAPH_ABUSE_HASH_SECRET", originalEnv.abuseSecret);
    restore("CLAIMGRAPH_CREATE_LIMIT_PER_IP", originalEnv.creationLimit);
    restore("CLAIMGRAPH_PROVIDER_CONCURRENCY", originalEnv.providerConcurrency);
    restore("CRON_SECRET", originalEnv.cronSecret);
  });

  it("atomically bounds a hashed subject without persisting its raw IP", async () => {
    const first = await consumePublicBetaRateLimit({
      scope: "workspace-create",
      subject: "203.0.113.42",
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-07-12T00:00:05.000Z")
    });
    const second = await consumePublicBetaRateLimit({
      scope: "workspace-create",
      subject: "203.0.113.42",
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-07-12T00:00:06.000Z")
    });
    const denied = await consumePublicBetaRateLimit({
      scope: "workspace-create",
      subject: "203.0.113.42",
      limit: 2,
      windowMs: 60_000,
      now: new Date("2026-07-12T00:00:07.000Z")
    });

    expect(first).toMatchObject({ allowed: true, count: 1, remaining: 1 });
    expect(second).toMatchObject({ allowed: true, count: 2, remaining: 0 });
    expect(denied).toMatchObject({ allowed: false, count: 2, remaining: 0 });
    const persisted = withClaimGraphDatabase((db) =>
      db.prepare("SELECT subject_hash FROM public_beta_rate_limit_buckets").all()
    );
    expect(JSON.stringify(persisted)).not.toContain("203.0.113.42");
  });

  it("rejects a first weighted charge that exceeds its bucket ceiling", async () => {
    const denied = await consumePublicBetaRateLimit({
      scope: "workspace-upload-bytes",
      subject: "workspace-weighted-limit",
      limit: 10,
      amount: 20,
      windowMs: 60_000,
      now: new Date("2026-07-12T00:00:05.000Z")
    });
    const next = await consumePublicBetaRateLimit({
      scope: "workspace-upload-bytes",
      subject: "workspace-weighted-limit",
      limit: 10,
      amount: 1,
      windowMs: 60_000,
      now: new Date("2026-07-12T00:00:06.000Z")
    });

    expect(denied).toMatchObject({ allowed: false, remaining: 0 });
    expect(next).toMatchObject({ allowed: true, count: 1, remaining: 9 });
  });

  it("bounds aggregate uploaded bytes independently from file-mutation attempts", async () => {
    const first = await consumePublicBetaRateLimit({
      scope: "workspace-upload-bytes",
      subject: "workspace-bytes",
      limit: 10 * 1024 * 1024,
      windowMs: 24 * 60 * 60_000,
      amount: 8 * 1024 * 1024,
      now: new Date("2026-07-12T01:00:00.000Z")
    });
    const denied = await consumePublicBetaRateLimit({
      scope: "workspace-upload-bytes",
      subject: "workspace-bytes",
      limit: 10 * 1024 * 1024,
      windowMs: 24 * 60 * 60_000,
      amount: 8 * 1024 * 1024,
      now: new Date("2026-07-12T01:00:01.000Z")
    });
    expect(first.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
  });

  it("replays completed idempotent operations and rejects key reuse with another fingerprint", async () => {
    const acquired = await beginIdempotentOperation({
      scope: "workspace-analysis",
      key: "request-key-1234",
      requestFingerprint: "workspace-a:analyze"
    });
    expect(acquired.kind).toBe("acquired");

    expect(await completeIdempotentOperation({
      scope: "workspace-analysis",
      key: "request-key-1234",
      requestFingerprint: "workspace-a:analyze",
      responseStatus: 202,
      response: { runId: "run-1", created: true }
    })).toBe(true);

    await expect(beginIdempotentOperation({
      scope: "workspace-analysis",
      key: "request-key-1234",
      requestFingerprint: "workspace-a:analyze"
    })).resolves.toMatchObject({
      kind: "replay",
      responseStatus: 202,
      response: { runId: "run-1", created: true }
    });
    await expect(beginIdempotentOperation({
      scope: "workspace-analysis",
      key: "request-key-1234",
      requestFingerprint: "workspace-b:analyze"
    })).resolves.toMatchObject({ kind: "conflict" });
  });

  it("persists the operator kill switch and counts concurrent provider calls, not runs", async () => {
    process.env.CLAIMGRAPH_PROVIDER_CONCURRENCY = "2";
    const first = await acquireProviderLease({ runId: "same-run" });
    const second = await acquireProviderLease({ runId: "same-run" });
    const denied = await acquireProviderLease({ runId: "another-run" });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(first.lease?.id).not.toBe(second.lease?.id);
    expect(denied.acquired).toBe(false);
    expect((await getProviderCapacitySnapshot()).activeLeases).toBe(2);

    await releaseProviderLease(first.lease!.id);
    expect((await acquireProviderLease({ runId: "another-run" })).acquired).toBe(true);

    await updatePublicBetaOperatorOverrides({ analysisEnabled: false });
    expect((await getEffectivePublicBetaControls()).analysisEnabled).toBe(false);
    expect((await acquireProviderLease({ runId: "disabled-run" })).acquired).toBe(false);
  });

  it("rate-limits repeated invalid workspace bodies before parsing them", async () => {
    process.env.CLAIMGRAPH_CREATE_LIMIT_PER_IP = "1";
    const capability = generateWorkspaceWriteCapability();
    const request = () => new Request("http://localhost/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "x-forwarded-for": "198.51.100.9",
        [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability
      },
      body: "not-json"
    });

    expect((await createWorkspaceRoute(request())).status).toBe(400);
    const denied = await createWorkspaceRoute(request());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
  });

  it("schedules the shorter QA workspace TTL from the explicit QA creation header", async () => {
    const capability = generateWorkspaceWriteCapability();
    const response = await createWorkspaceRoute(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability,
          "Idempotency-Key": "qa-workspace-request-1",
          "X-ClaimGraph-QA-Workspace": "1"
        },
        body: JSON.stringify({
          question: "Should QA workspaces expire quickly?",
          sourceUrls: []
        })
      })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { workspaceId: string };
    const row = withClaimGraphDatabase((db) =>
      db.prepare(`
        SELECT job_type, data
        FROM cleanup_jobs
        WHERE workspace_id = ?
      `).get(payload.workspaceId) as { job_type: string; data: string }
    );
    expect(row.job_type).toBe("qa_workspace_delete");
    expect(JSON.parse(row.data)).toMatchObject({ reason: "qa_workspace_ttl" });
  });

  it("reclaims a cleanup job whose prior worker lease expired", async () => {
    const store = await getClaimGraphStore();
    const workspace = await store.createWorkspace(
      "Should cleanup jobs survive worker loss?",
      undefined,
      [],
      { writeCapabilityHash: "test-write-hash" }
    );
    const artifact = await persistWorkspaceExportArtifact({
      workspaceId: workspace.id,
      format: "markdown",
      contentType: "text/markdown",
      body: "# cleanup"
    });
    const now = new Date("2026-07-12T12:00:00.000Z");
    const scheduled = await scheduleExportRetention({
      workspaceId: workspace.id,
      storageProvider: artifact.storageProvider,
      objectKey: artifact.key,
      createdAt: new Date(now.getTime() - 25 * 60 * 60_000)
    });

    withClaimGraphDatabase((db) => {
      db.prepare(`
        UPDATE cleanup_jobs
        SET status = 'running', lease_expires_at = ?, next_attempt_at = ?
        WHERE id = ?
      `).run(
        new Date(now.getTime() - 60_000).toISOString(),
        new Date(now.getTime() - 60_000).toISOString(),
        scheduled!.id
      );
    });

    const result = await runDueCleanupJobs({ now });
    expect(result).toMatchObject({ claimedCount: 1, completedCount: 1 });
    expect(existsSync(getWorkspaceExportFilePath(workspace.id, artifact.key))).toBe(false);
  });

  it("reclaims legacy running cleanup jobs whose lease is null", async () => {
    const store = await getClaimGraphStore();
    const workspace = await store.createWorkspace(
      "Should legacy cleanup leases recover?",
      undefined,
      [],
      { writeCapabilityHash: "test-write-hash" }
    );
    const artifact = await persistWorkspaceExportArtifact({
      workspaceId: workspace.id,
      format: "markdown",
      contentType: "text/markdown",
      body: "# legacy cleanup"
    });
    const now = new Date("2026-07-12T12:00:00.000Z");
    const scheduled = await scheduleExportRetention({
      workspaceId: workspace.id,
      storageProvider: artifact.storageProvider,
      objectKey: artifact.key,
      createdAt: new Date(now.getTime() - 25 * 60 * 60_000)
    });

    withClaimGraphDatabase((db) => {
      db.prepare(`
        UPDATE cleanup_jobs
        SET status = 'running', lease_expires_at = NULL, next_attempt_at = ?
        WHERE id = ?
      `).run(new Date(now.getTime() - 60_000).toISOString(), scheduled!.id);
    });

    const result = await runDueCleanupJobs({ now });
    expect(result).toMatchObject({ claimedCount: 1, completedCount: 1 });
  });

  it("drains more than one cleanup batch and reports remaining backlog", async () => {
    const store = await getClaimGraphStore();
    const workspace = await store.createWorkspace(
      "Can cleanup capacity stay ahead of admitted exports?",
      undefined,
      [],
      { writeCapabilityHash: "test-write-hash" }
    );
    const createdAt = new Date(Date.now() - 25 * 60 * 60_000);

    for (let index = 0; index < 30; index += 1) {
      const artifact = await persistWorkspaceExportArtifact({
        workspaceId: workspace.id,
        format: "markdown",
        contentType: "text/markdown",
        body: `# cleanup ${index}`
      });
      await scheduleExportRetention({
        workspaceId: workspace.id,
        storageProvider: artifact.storageProvider,
        objectKey: artifact.key,
        createdAt
      });
    }

    expect((await getCleanupBacklogSummary()).dueCount).toBe(30);
    const drained = await drainDueCleanupJobs({ maxJobs: 50, maxDurationMs: 30_000 });
    expect(drained.claimedCount).toBe(30);
    expect(drained.completedCount).toBe(30);
    expect(drained.backlog.dueCount).toBe(0);
  });

  it("marks upload TTL cleanup to invalidate any graph that cited the removed file", async () => {
    const store = await getClaimGraphStore();
    const workspace = await store.createWorkspace(
      "Should expired uploads invalidate dependent graphs?",
      undefined,
      [],
      { writeCapabilityHash: "test-write-hash" }
    );
    const job = await scheduleUploadRetention({
      workspaceId: workspace.id,
      fileId: "file-retention",
      storageProvider: "local",
      objectKey: "file-retention.txt",
      uploadedAt: new Date("2026-07-12T00:00:00.000Z")
    });

    expect(job?.data.invalidateArtifacts).toBe(true);
  });

  it("serializes an upload TTL cleanup with active-run acquisition", async () => {
    const store = await getClaimGraphStore();
    const workspace = await store.createWorkspace(
      "Can upload expiry race analysis acquisition?",
      undefined,
      [],
      { writeCapabilityHash: "test-write-hash" }
    );
    const fileId = "ttl-race-file";
    const persisted = await persistWorkspaceFileObject({
      workspaceId: workspace.id,
      fileId,
      extension: "txt",
      mimeType: "text/plain",
      buffer: Buffer.from("bounded cleanup race")
    });
    const uploadedAt = new Date("2026-05-01T00:00:00.000Z");
    const file: WorkspaceFile = {
      id: fileId,
      workspaceId: workspace.id,
      originalName: "ttl-race.txt",
      storedName: persisted.key,
      mimeType: "text/plain",
      extension: "txt",
      sizeBytes: persisted.sizeBytes,
      uploadedAt: uploadedAt.toISOString(),
      storageProvider: persisted.storageProvider
    };
    await store.addWorkspaceFiles(workspace.id, [file]);
    await scheduleUploadRetention({
      workspaceId: workspace.id,
      fileId,
      storageProvider: persisted.storageProvider,
      objectKey: persisted.key,
      uploadedAt
    });
    const now = new Date("2026-07-12T14:00:00.000Z");
    const [cleanup] = await Promise.all([
      runDueCleanupJobs({ now }),
      store.acquireActiveRun(workspace.id)
    ]);
    const activeAfterRace = await store.getActiveRunForWorkspace(workspace.id);
    const filesAfterRace = await store.getWorkspaceFiles(workspace.id);

    if (cleanup.deferredCount === 1) {
      expect(activeAfterRace).not.toBeNull();
      expect(filesAfterRace).toMatchObject([{ id: fileId }]);
      await expect(readWorkspaceFileObject(file)).resolves.not.toBeNull();
      await store.transitionRunStatus(activeAfterRace!.id, {
        expectedStatuses: [activeAfterRace!.status],
        nextStatus: "canceled",
        statusMessage: "Release the TTL cleanup race fixture."
      });
      const retry = await runDueCleanupJobs({
        now: new Date(now.getTime() + 61 * 60_000)
      });
      expect(retry.completedCount).toBe(1);
    } else {
      expect(cleanup.completedCount).toBe(1);
      expect(filesAfterRace).toEqual([]);
    }

    await expect(store.getWorkspaceFiles(workspace.id)).resolves.toEqual([]);
    await expect(readWorkspaceFileObject(file)).resolves.toBeNull();
  });

  it("keeps the scheduled cleanup trigger secret and exposes accurate privacy copy", async () => {
    process.env.CRON_SECRET = "cron-test-secret-with-at-least-32-bytes";
    expect((await runCleanupCron(new Request("http://localhost/api/internal/cleanup"))).status)
      .toBe(401);
    expect((await runCleanupCron(new Request("http://localhost/api/internal/cleanup", {
      headers: { Authorization: "Bearer cron-test-secret-with-at-least-32-bytes" }
    }))).status).toBe(200);

    const copy = publicBetaPrivacyCopy();
    expect(copy).toContain("Raw uploads and private storage URLs are not downloadable");
    expect(copy).toContain("file names");
    expect(copy).toContain("cited excerpts");
    expect(isCostBearingAnalysisRuntime({ mode: "full" })).toBe(true);
    expect(isCostBearingAnalysisRuntime({
      mode: "open-model",
      openModelBackend: "vllm"
    })).toBe(true);
    expect(isCostBearingAnalysisRuntime({
      mode: "open-model",
      openModelBackend: "tgi"
    })).toBe(true);
    expect(isCostBearingAnalysisRuntime({
      mode: "open-model",
      openModelBackend: "ollama"
    })).toBe(false);
  });

  it("rejects weak public-beta secrets and reports them as unsafe", async () => {
    expect(() =>
      hashPublicBetaSubject("workspace-create", "203.0.113.9", {
        ...process.env,
        NODE_ENV: "production",
        CLAIMGRAPH_ABUSE_HASH_SECRET: "short"
      })
    ).toThrow(/at least 32 bytes/);

    const safety = getPublicBetaSafetyConfiguration({
      ...process.env,
      NODE_ENV: "production",
      CLAIMGRAPH_STORAGE_DRIVER: "hosted",
      CLAIMGRAPH_ABUSE_HASH_SECRET: "short",
      CRON_SECRET: "short",
      CLAIMGRAPH_PUBLIC_ORIGIN: "http://claimgraph.example"
    });

    expect(safety).toMatchObject({
      ready: false,
      abuseHashConfigured: false,
      cleanupCronConfigured: false,
      canonicalOriginConfigured: false
    });
    expect(safety.missingConfiguration).toEqual([
      "CLAIMGRAPH_ABUSE_HASH_SECRET",
      "CRON_SECRET",
      "CLAIMGRAPH_PUBLIC_ORIGIN"
    ]);

    process.env.CRON_SECRET = "short";
    expect((await runCleanupCron(new Request("http://localhost/api/internal/cleanup", {
      headers: { Authorization: "Bearer short" }
    }))).status).toBe(401);
  });

  it("fails closed for hosted full-mode files until provider cleanup is durable", () => {
    expect(isHostedFullModeFileIntakeBlocked({
      storageDriver: "hosted",
      mode: "full"
    })).toBe(true);
    expect(isHostedFullModeFileIntakeBlocked({
      storageDriver: "hosted",
      mode: "open-model"
    })).toBe(false);
    expect(isHostedFullModeFileIntakeBlocked({
      storageDriver: "local",
      mode: "full"
    })).toBe(false);
  });

  it("blocks direct hosted full provider file intake before remote upload", async () => {
    const previousDriver = process.env.CLAIMGRAPH_STORAGE_DRIVER;
    const previousMode = process.env.CLAIMGRAPH_MODE;
    const previousDatabaseUrl = process.env.DATABASE_URL;

    try {
      process.env.CLAIMGRAPH_STORAGE_DRIVER = "hosted";
      process.env.CLAIMGRAPH_MODE = "full";
      process.env.DATABASE_URL = "postgresql://hosted-file-gate.invalid/claimgraph";

      await expect(OpenAIProvider.gatherEvidence({
        workspace: {
          id: "workspace-hosted-full-file-gate",
          question: "Should remote provider files require durable deletion?",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sourceUrls: [],
          settings: {
            maxWebSources: 4,
            maxFiles: 1,
            freshnessBias: "medium",
            preferPrimarySources: true,
            includeOpposingEvidence: true
          }
        },
        runId: "run-hosted-full-file-gate",
        files: [{
          id: "file-hosted-full-file-gate",
          workspaceId: "workspace-hosted-full-file-gate",
          originalName: "private.txt",
          storedName: "private.txt",
          mimeType: "text/plain; charset=utf-8",
          extension: "txt",
          sizeBytes: 12,
          uploadedAt: new Date().toISOString()
        }]
      })).rejects.toThrow(/provider-side file and vector-store deletion/);
    } finally {
      if (previousDriver === undefined) delete process.env.CLAIMGRAPH_STORAGE_DRIVER;
      else process.env.CLAIMGRAPH_STORAGE_DRIVER = previousDriver;
      if (previousMode === undefined) delete process.env.CLAIMGRAPH_MODE;
      else process.env.CLAIMGRAPH_MODE = previousMode;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });
});
