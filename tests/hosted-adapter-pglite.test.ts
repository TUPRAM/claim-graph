import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimGraphStore } from "@/lib/server/storage/claimgraph-store";
import type {
  ClaimInventoryRecord,
  EvidencePackRecord,
  WorkspaceFile,
  WorkspaceGraphRecord
} from "@/types/claimgraph";
import { createPgliteNeonClient } from "./helpers/pglite-neon";

function evidenceRecord(
  runId: string,
  question: string,
  suffix: string
): EvidencePackRecord {
  return {
    runId,
    createdAt: new Date().toISOString(),
    model: `evidence-${suffix}`,
    responseId: `evidence-response-${suffix}`,
    evidencePack: {
      question,
      summary: `Evidence summary ${suffix}.`,
      groundingStatus: "grounded",
      subquestions: [],
      evidenceAxes: [],
      sources: [
        {
          id: `source-${suffix}`,
          type: "web",
          title: `Source ${suffix}`,
          url: `https://example.com/${suffix}`,
          domain: "example.com"
        }
      ],
      snippets: [
        {
          id: `snippet-${suffix}`,
          sourceId: `source-${suffix}`,
          text: `Evidence text ${suffix}.`,
          rationale: `Evidence rationale ${suffix}.`,
          relevance: 0.86,
          origin: "web_search_result_excerpt"
        }
      ],
      openQuestions: [],
      warnings: []
    }
  };
}

function claimInventoryRecord(
  runId: string,
  question: string,
  suffix: string
): ClaimInventoryRecord {
  return {
    runId,
    createdAt: new Date().toISOString(),
    model: `claims-${suffix}`,
    responseId: `claims-response-${suffix}`,
    claimInventory: {
      question,
      claims: [
        {
          id: `claim-${suffix}`,
          kind: "claim",
          title: `Claim ${suffix}`,
          summary: `Claim summary ${suffix}.`,
          topic: "Hosted integrity",
          stance: "pro",
          confidence: 0.8,
          evidenceQuality: "high",
          sourceIds: [`source-${suffix}`],
          snippetIds: [`snippet-${suffix}`],
          qualifiers: [],
          dependsOnGapIds: []
        }
      ],
      contradictionPairs: [],
      unresolvedGaps: []
    }
  };
}

function graphRecord(
  runId: string,
  question: string,
  suffix: string
): WorkspaceGraphRecord {
  return {
    origin: "live",
    mode: "full",
    provider: "openai",
    createdAt: new Date().toISOString(),
    model: `graph-${suffix}`,
    responseId: `graph-response-${suffix}`,
    runId,
    graph: {
      question,
      graphSummary: `Graph summary ${suffix}.`,
      nodes: [
        {
          id: `question-${suffix}`,
          kind: "question",
          title: question,
          summary: "The workspace question.",
          sourceIds: [],
          snippetIds: []
        },
        {
          id: `claim-${suffix}`,
          kind: "claim",
          title: `Claim ${suffix}`,
          summary: `Claim summary ${suffix}.`,
          topic: "Hosted integrity",
          stance: "pro",
          confidence: 0.8,
          sourceIds: [`source-${suffix}`],
          snippetIds: [`snippet-${suffix}`]
        }
      ],
      edges: [
        {
          id: `edge-${suffix}`,
          from: `claim-${suffix}`,
          to: `question-${suffix}`,
          relation: "supports",
          strength: 0.8
        }
      ],
      disagreementClusters: []
    },
    sources: [
      {
        id: `source-${suffix}`,
        type: "web",
        title: `Source ${suffix}`,
        url: `https://example.com/${suffix}`,
        domain: "example.com"
      }
    ],
    snippets: [
      {
        id: `snippet-${suffix}`,
        sourceId: `source-${suffix}`,
        text: `Evidence text ${suffix}.`,
        rationale: `Evidence rationale ${suffix}.`,
        relevance: 0.86,
        origin: "web_search_result_excerpt"
      }
    ]
  };
}

function workspaceFile(workspaceId: string, suffix: string): WorkspaceFile {
  return {
    id: `hosted-file-${suffix}`,
    workspaceId,
    originalName: `${suffix}.txt`,
    storedName: `hosted-file-${suffix}.txt`,
    mimeType: "text/plain",
    extension: "txt",
    sizeBytes: 18,
    uploadedAt: new Date().toISOString(),
    storageProvider: "vercel_blob",
    blobKey: `workspaces/${workspaceId}/sources/hosted-file-${suffix}.txt`
  };
}

describe("hosted ClaimGraphStore on ephemeral PostgreSQL", () => {
  let database: PGlite;
  let store: ClaimGraphStore;
  let neonClient: ReturnType<typeof createPgliteNeonClient>;

  beforeEach(async () => {
    vi.resetModules();
    database = new PGlite();

    const checkedInSchema = readFileSync(
      path.join(process.cwd(), "lib", "server", "storage", "schema", "neon.sql"),
      "utf8"
    );
    await database.exec(checkedInSchema);

    neonClient = createPgliteNeonClient(database);
    vi.doMock("@/lib/server/storage/neon-client", () => ({
      getNeonSql: vi.fn(async () => neonClient),
      resetCachedNeonSqlForTests: vi.fn()
    }));

    store = (await import("@/lib/server/storage/hosted-store")).hostedClaimGraphStore;
  });

  afterEach(async () => {
    vi.doUnmock("@/lib/server/storage/neon-client");
    vi.doUnmock("@/lib/server/storage/config");
    vi.doUnmock("@/lib/server/storage/hosted-schema");
    vi.doUnmock("@/lib/server/storage/store-factory");
    vi.doUnmock("@/lib/server/object-storage");
    vi.resetModules();
    await database.close();
  });

  it("migrates pre-sequence hosted runs without retaining an older active run", async () => {
    const migrationDatabase = new PGlite();

    try {
      await migrationDatabase.exec(`
        CREATE TABLE claimgraph_workspaces (
          id text primary key,
          question text not null,
          created_at timestamptz not null,
          updated_at timestamptz not null,
          settings jsonb not null,
          source_urls jsonb not null default '[]'::jsonb,
          data jsonb not null,
          deleted_at timestamptz
        );

        CREATE TABLE claimgraph_runs (
          id text primary key,
          workspace_id text not null references claimgraph_workspaces(id) on delete cascade,
          created_at timestamptz not null,
          completed_at timestamptz,
          status text not null,
          status_message text,
          error_message text,
          metrics jsonb,
          observability jsonb,
          execution jsonb,
          workflow_id text,
          data jsonb not null
        );

        INSERT INTO claimgraph_workspaces
          (id, question, created_at, updated_at, settings, source_urls, data)
        VALUES
          (
            'workspace-migration',
            'Which active run should survive migration?',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            '{}'::jsonb,
            '[]'::jsonb,
            '{}'::jsonb
          );

        -- Insert the newer logical run first so its generated migration seq is
        -- lower. The migration must use created_at before seq.
        INSERT INTO claimgraph_runs
          (id, workspace_id, created_at, status, data)
        VALUES
          (
            'newer-active',
            'workspace-migration',
            '2026-01-03T00:00:00.000Z',
            'gathering',
            '{"id":"newer-active","workspaceId":"workspace-migration","status":"gathering","createdAt":"2026-01-03T00:00:00.000Z"}'::jsonb
          ),
          (
            'older-active',
            'workspace-migration',
            '2026-01-02T00:00:00.000Z',
            'extracting',
            '{"id":"older-active","workspaceId":"workspace-migration","status":"extracting","createdAt":"2026-01-02T00:00:00.000Z"}'::jsonb
          );
      `);

      const checkedInSchema = readFileSync(
        path.join(process.cwd(), "lib", "server", "storage", "schema", "neon.sql"),
        "utf8"
      );
      await migrationDatabase.exec(checkedInSchema);

      const migratedRuns = await migrationDatabase.query<{
        id: string;
        status: string;
        version: number;
      }>(
        `
          SELECT id, status, version
          FROM claimgraph_runs
          WHERE workspace_id = 'workspace-migration'
          ORDER BY created_at DESC
        `
      );

      expect(migratedRuns.rows).toEqual([
        { id: "newer-active", status: "gathering", version: 1 },
        { id: "older-active", status: "failed", version: 2 }
      ]);
      await expect(
        migrationDatabase.query(
          `
            INSERT INTO claimgraph_runs
              (id, workspace_id, created_at, status, data)
            VALUES
              (
                'competing-active',
                'workspace-migration',
                now(),
                'queued',
                '{}'::jsonb
              )
          `
        )
      ).rejects.toThrow(/unique|duplicate/i);
    } finally {
      await migrationDatabase.close();
    }
  });

  it("executes the checked-in Neon schema and enforces one active run", async () => {
    const workspace = await store.createWorkspace(
      "Should the hosted adapter admit two active runs?"
    );
    const [left, right] = await Promise.all([
      store.acquireActiveRun(workspace.id),
      store.acquireActiveRun(workspace.id)
    ]);

    expect(left.run.id).toBe(right.run.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);

    const persisted = await database.query<{
      version: number;
      status: string;
    }>(
      "SELECT version, status FROM claimgraph_runs WHERE id = $1",
      [left.run.id]
    );
    expect(persisted.rows).toEqual([{ version: 1, status: "queued" }]);

    await expect(
      database.query(
        `
          INSERT INTO claimgraph_runs
            (id, workspace_id, created_at, status, version, data)
          VALUES ($1, $2, now(), 'queued', 1, '{}'::jsonb)
        `,
        ["duplicate-active-run", workspace.id]
      )
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("serializes hosted workspace tombstoning with active-run acquisition", async () => {
    const workspace = await store.createWorkspace(
      "Can hosted workspace deletion race an analysis start?"
    );
    const file = workspaceFile(workspace.id, "workspace-delete-race");
    await store.addWorkspaceFiles(workspace.id, [file]);
    const [acquisition, deletion] = await Promise.allSettled([
      store.acquireActiveRun(workspace.id),
      store.deleteWorkspaceIfNoActiveRun(workspace.id)
    ]);

    if (acquisition.status === "fulfilled") {
      expect(deletion).toMatchObject({
        status: "fulfilled",
        value: {
          applied: false,
          reason: "active_run",
          activeRun: { id: acquisition.value.run.id }
        }
      });
      await expect(store.getWorkspace(workspace.id)).resolves.toMatchObject({
        id: workspace.id
      });
    } else {
      expect(deletion).toMatchObject({
        status: "fulfilled",
        value: {
          applied: true,
          workspace: { id: workspace.id },
          files: [{ id: file.id }]
        }
      });
      await expect(store.getWorkspace(workspace.id)).resolves.toBeNull();
      const persisted = await database.query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM claimgraph_workspaces WHERE id = $1",
        [workspace.id]
      );
      expect(persisted.rows).toEqual([{ deleted: true }]);
      await expect(store.deleteWorkspace(workspace.id)).resolves.toMatchObject({
        id: workspace.id
      });
    }

    const deleteFirstWorkspace = await store.createWorkspace(
      "Can hosted analysis recreate a tombstoned workspace?"
    );
    const deletedFile = workspaceFile(deleteFirstWorkspace.id, "delete-first");
    await store.addWorkspaceFiles(deleteFirstWorkspace.id, [deletedFile]);
    const acceptedDeletion = await store.deleteWorkspaceIfNoActiveRun(
      deleteFirstWorkspace.id
    );

    expect(acceptedDeletion).toMatchObject({
      applied: true,
      workspace: { id: deleteFirstWorkspace.id },
      files: [{ id: deletedFile.id }]
    });
    await expect(store.getWorkspace(deleteFirstWorkspace.id)).resolves.toBeNull();
    await expect(store.acquireActiveRun(deleteFirstWorkspace.id)).rejects.toThrow(
      /workspace|acquire/i
    );
    const tombstone = await database.query<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM claimgraph_workspaces WHERE id = $1",
      [deleteFirstWorkspace.id]
    );
    expect(tombstone.rows).toEqual([{ deleted: true }]);
    await expect(store.deleteWorkspace(deleteFirstWorkspace.id)).resolves.toMatchObject({
      id: deleteFirstWorkspace.id
    });
  });

  it("atomically commits the hosted tombstone with its deterministic cleanup job", async () => {
    const workspace = await store.createWorkspace(
      "Must hosted deletion always leave durable cleanup work?"
    );
    const deletion = await store.deleteWorkspaceIfNoActiveRun(workspace.id);

    expect(deletion).toMatchObject({
      applied: true,
      workspace: { id: workspace.id },
      cleanupJobId: `workspace-delete:${workspace.id}`
    });
    const persisted = await database.query<{
      deleted: boolean;
      cleanup_job_id: string;
      status: string;
      job_type: string;
      reason: string;
    }>(
      `
        SELECT
          workspace.deleted_at IS NOT NULL AS deleted,
          cleanup.id AS cleanup_job_id,
          cleanup.status,
          cleanup.job_type,
          cleanup.data->>'reason' AS reason
        FROM claimgraph_workspaces AS workspace
        INNER JOIN claimgraph_cleanup_jobs AS cleanup
          ON cleanup.workspace_id = workspace.id
        WHERE workspace.id = $1
      `,
      [workspace.id]
    );

    expect(persisted.rows).toEqual([
      {
        deleted: true,
        cleanup_job_id: `workspace-delete:${workspace.id}`,
        status: "pending",
        job_type: "workspace_delete",
        reason: "owner_requested_workspace_deletion"
      }
    ]);
  });

  it("rolls back the hosted tombstone when durable cleanup cannot be scheduled", async () => {
    const workspace = await store.createWorkspace(
      "Can cleanup persistence failure leave a stranded tombstone?"
    );
    await database.exec("DROP TABLE claimgraph_cleanup_jobs");

    await expect(
      store.deleteWorkspaceIfNoActiveRun(workspace.id)
    ).rejects.toThrow(/cleanup|relation|table/i);
    const persisted = await database.query<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM claimgraph_workspaces WHERE id = $1",
      [workspace.id]
    );

    expect(persisted.rows).toEqual([{ deleted: false }]);
    await expect(store.getWorkspace(workspace.id)).resolves.toMatchObject({
      id: workspace.id
    });
  });

  it("retries interrupted hosted object cleanup and finally purges the tombstone", async () => {
    const workspace = await store.createWorkspace(
      "Can cron resume an interrupted hosted workspace purge?"
    );
    const deletion = await store.deleteWorkspaceIfNoActiveRun(workspace.id);

    if (!deletion.applied) {
      throw new Error("Expected hosted workspace deletion to be accepted.");
    }

    const deleteHostedWorkspaceObjectPrefix = vi
      .fn()
      .mockRejectedValueOnce(new Error("Transient Blob outage."))
      .mockResolvedValue({ attemptedCount: 1, deletedCount: 1, prefix: "test" });
    vi.doMock("@/lib/server/storage/config", () => ({
      getClaimGraphStorageDriver: vi.fn(() => "hosted")
    }));
    vi.doMock("@/lib/server/storage/hosted-schema", () => ({
      getReadyHostedSql: vi.fn(async () => neonClient)
    }));
    vi.doMock("@/lib/server/storage/store-factory", () => ({
      getClaimGraphStore: vi.fn(async () => store)
    }));
    vi.doMock("@/lib/server/object-storage", () => ({
      deleteHostedWorkspaceObjectPrefix,
      deletePersistedWorkspaceObject: vi.fn(async () => true)
    }));

    const { retryCleanupJob, runDueCleanupJobs } = await import(
      "@/lib/server/retention-cleanup"
    );
    const firstAttemptAt = new Date(Date.now() + 60_000);
    const firstAttempt = await runDueCleanupJobs({ now: firstAttemptAt });

    expect(firstAttempt).toMatchObject({
      claimedCount: 1,
      completedCount: 0,
      failedCount: 1
    });
    const failedJob = await database.query<{
      status: string;
      attempt_count: number;
    }>(
      "SELECT status, attempt_count FROM claimgraph_cleanup_jobs WHERE id = $1",
      [deletion.cleanupJobId]
    );
    expect(failedJob.rows).toEqual([{ status: "failed", attempt_count: 1 }]);
    await expect(store.getWorkspace(workspace.id)).resolves.toBeNull();

    const retryAt = new Date(firstAttemptAt.getTime() + 120_000);
    await expect(
      retryCleanupJob(deletion.cleanupJobId!, retryAt)
    ).resolves.toMatchObject({ status: "pending", attemptCount: 1 });
    const secondAttempt = await runDueCleanupJobs({ now: retryAt });

    expect(secondAttempt).toMatchObject({
      claimedCount: 1,
      completedCount: 1,
      failedCount: 0
    });
    expect(deleteHostedWorkspaceObjectPrefix).toHaveBeenCalledTimes(2);
    const finalState = await database.query<{
      workspace_count: number;
      cleanup_count: number;
    }>(
      `
        SELECT
          (SELECT count(*)::integer FROM claimgraph_workspaces WHERE id = $1) AS workspace_count,
          (SELECT count(*)::integer FROM claimgraph_cleanup_jobs WHERE id = $2) AS cleanup_count
      `,
      [workspace.id, deletion.cleanupJobId]
    );
    expect(finalState.rows).toEqual([{ workspace_count: 0, cleanup_count: 0 }]);
  });

  it("keeps hosted starter fallback reads free of graph persistence side effects", async () => {
    const workspace = await store.createWorkspace(
      "Should a hosted shared graph read mutate storage?"
    );
    await expect(store.getWorkspaceGraphPayload(workspace.id)).resolves.toMatchObject({
      starterMode: true
    });
    const missingCount = await database.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM claimgraph_graph_records WHERE workspace_id = $1",
      [workspace.id]
    );
    expect(missingCount.rows).toEqual([{ count: 0 }]);

    const incompatible = { recordVersion: 999, secretCanary: "leave-unchanged" };
    await database.query(
      `
        INSERT INTO claimgraph_graph_records
          (
            workspace_id, run_id, record_version, origin, mode, provider,
            model, created_at, graph, sources, snippets, data
          )
        VALUES ($1, null, 999, 'live', 'full', 'openai', 'future-model', now(),
          '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, $2::jsonb)
      `,
      [workspace.id, JSON.stringify(incompatible)]
    );
    const before = await database.query<{ record_version: number; data: unknown }>(
      "SELECT record_version, data FROM claimgraph_graph_records WHERE workspace_id = $1",
      [workspace.id]
    );
    await expect(store.getWorkspaceGraphPayload(workspace.id)).resolves.toMatchObject({
      starterMode: true
    });
    const after = await database.query<{ record_version: number; data: unknown }>(
      "SELECT record_version, data FROM claimgraph_graph_records WHERE workspace_id = $1",
      [workspace.id]
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("serializes hosted file additions with active-run acquisition", async () => {
    const runFirstWorkspace = await store.createWorkspace(
      "Can a hosted upload race an active run?"
    );
    const runFirstFile = workspaceFile(runFirstWorkspace.id, "run-first");
    const [acquired, concurrentAdd] = await Promise.all([
      store.acquireActiveRun(runFirstWorkspace.id),
      store.addWorkspaceFilesIfNoActiveRun(runFirstWorkspace.id, [runFirstFile])
    ]);

    expect(acquired.created).toBe(true);
    if (concurrentAdd.applied) {
      await expect(store.getWorkspaceFiles(runFirstWorkspace.id)).resolves.toMatchObject([
        { id: runFirstFile.id }
      ]);
    } else {
      expect(concurrentAdd).toMatchObject({
        reason: "active_run",
        activeRun: { id: acquired.run.id }
      });
      await expect(store.getWorkspaceFiles(runFirstWorkspace.id)).resolves.toEqual([]);
    }
    const blockedFile = workspaceFile(runFirstWorkspace.id, "blocked-after-run");
    await expect(
      store.addWorkspaceFilesIfNoActiveRun(runFirstWorkspace.id, [blockedFile])
    ).resolves.toMatchObject({
      applied: false,
      reason: "active_run",
      activeRun: { id: acquired.run.id }
    });

    const fileFirstWorkspace = await store.createWorkspace(
      "Does a hosted run start after upload metadata commits?"
    );
    const fileFirst = workspaceFile(fileFirstWorkspace.id, "file-first");
    const [acceptedAdd, nextRun] = await Promise.all([
      store.addWorkspaceFilesIfNoActiveRun(fileFirstWorkspace.id, [fileFirst]),
      store.acquireActiveRun(fileFirstWorkspace.id)
    ]);

    expect(acceptedAdd).toMatchObject({
      applied: true,
      files: [{ id: fileFirst.id }]
    });
    expect(nextRun.created).toBe(true);
    await expect(store.getWorkspaceFiles(fileFirstWorkspace.id)).resolves.toMatchObject([
      { id: fileFirst.id }
    ]);
  });

  it("serializes hosted file removals with active-run acquisition", async () => {
    const runFirstWorkspace = await store.createWorkspace(
      "Can hosted retention delete an active run input?"
    );
    const retainedFile = workspaceFile(runFirstWorkspace.id, "retained");
    await store.addWorkspaceFiles(runFirstWorkspace.id, [retainedFile]);
    const [acquired, concurrentRemoval] = await Promise.all([
      store.acquireActiveRun(runFirstWorkspace.id),
      store.removeWorkspaceFileIfNoActiveRun(runFirstWorkspace.id, retainedFile.id)
    ]);

    if (concurrentRemoval.applied) {
      await expect(store.getWorkspaceFiles(runFirstWorkspace.id)).resolves.toEqual([]);
    } else {
      expect(concurrentRemoval).toMatchObject({
        reason: "active_run",
        activeRun: { id: acquired.run.id }
      });
      await expect(store.getWorkspaceFiles(runFirstWorkspace.id)).resolves.toMatchObject([
        { id: retainedFile.id }
      ]);
    }

    const deleteFirstWorkspace = await store.createWorkspace(
      "Does hosted analysis wait for metadata deletion?"
    );
    const removedFile = workspaceFile(deleteFirstWorkspace.id, "removed");
    await store.addWorkspaceFiles(deleteFirstWorkspace.id, [removedFile]);
    const acceptedRemoval = await store.removeWorkspaceFileIfNoActiveRun(
      deleteFirstWorkspace.id,
      removedFile.id,
      { invalidateArtifacts: true }
    );
    const nextRun = await store.acquireActiveRun(deleteFirstWorkspace.id);

    expect(acceptedRemoval).toMatchObject({
      applied: true,
      file: { id: removedFile.id },
      files: [],
      artifactsInvalidated: true
    });
    expect(nextRun.created).toBe(true);
    await expect(store.getRun(nextRun.run.id)).resolves.toMatchObject({
      status: "queued"
    });
    await expect(store.getWorkspaceFiles(deleteFirstWorkspace.id)).resolves.toEqual([]);

    const blockedWorkspace = await store.createWorkspace(
      "Does an established hosted run block file removal?"
    );
    const blockedFile = workspaceFile(blockedWorkspace.id, "blocked-removal");
    await store.addWorkspaceFiles(blockedWorkspace.id, [blockedFile]);
    const blockedRun = await store.acquireActiveRun(blockedWorkspace.id);
    await expect(
      store.removeWorkspaceFileIfNoActiveRun(blockedWorkspace.id, blockedFile.id)
    ).resolves.toMatchObject({
      applied: false,
      reason: "active_run",
      activeRun: { id: blockedRun.run.id }
    });
  });

  it("stores and verifies only the hosted workspace capability hash", async () => {
    const capabilityHash = "hosted-capability-hash-test";
    const workspace = await store.createWorkspace(
      "Should anonymous hosted workspaces separate reads from writes?",
      undefined,
      [],
      { writeCapabilityHash: capabilityHash }
    );

    await expect(
      store.matchesWorkspaceWriteCapability(workspace.id, capabilityHash)
    ).resolves.toBe(true);
    await expect(
      store.matchesWorkspaceWriteCapability(workspace.id, "wrong-hash")
    ).resolves.toBe(false);

    const persisted = await database.query<{
      write_capability_hash: string;
    }>(
      `
        SELECT write_capability_hash
        FROM claimgraph_workspace_capabilities
        WHERE workspace_id = $1
      `,
      [workspace.id]
    );

    expect(persisted.rows).toEqual([
      { write_capability_hash: capabilityHash }
    ]);
    expect(JSON.stringify(await store.getWorkspace(workspace.id))).not.toContain(
      capabilityHash
    );
  });

  it("retires a logically superseded active run before acquiring a replacement", async () => {
    const workspace = await store.createWorkspace(
      "Should an active run older than workspace state be reused?"
    );
    const oldActive = {
      id: "old-active-run",
      workspaceId: workspace.id,
      status: "gathering",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const newerCompleted = {
      id: "newer-completed-run",
      workspaceId: workspace.id,
      status: "completed",
      createdAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-02T00:01:00.000Z"
    };
    await database.query(
      `
        INSERT INTO claimgraph_runs
          (id, workspace_id, created_at, completed_at, status, data)
        VALUES
          ($1, $2, $3, null, 'gathering', $4::jsonb),
          ($5, $2, $6, $7, 'completed', $8::jsonb)
      `,
      [
        oldActive.id,
        workspace.id,
        oldActive.createdAt,
        JSON.stringify(oldActive),
        newerCompleted.id,
        newerCompleted.createdAt,
        newerCompleted.completedAt,
        JSON.stringify(newerCompleted)
      ]
    );

    const acquired = await store.acquireActiveRun(workspace.id);

    expect(acquired.created).toBe(true);
    expect(acquired.run.id).not.toBe(oldActive.id);
    await expect(store.getRun(oldActive.id)).resolves.toMatchObject({
      status: "failed"
    });
    await expect(store.getActiveRunForWorkspace(workspace.id)).resolves.toMatchObject({
      id: acquired.run.id,
      status: "queued"
    });
  });

  it("expires an undispatched queued run so Analyze can recover after a crash", async () => {
    const workspace = await store.createWorkspace(
      "Can a queued run recover when its dispatcher disappears?"
    );
    const staleRun = {
      id: "stale-undispatched-run",
      workspaceId: workspace.id,
      status: "queued",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    await database.query(
      `
        INSERT INTO claimgraph_runs
          (id, workspace_id, created_at, status, data)
        VALUES ($1, $2, $3, 'queued', $4::jsonb)
      `,
      [
        staleRun.id,
        workspace.id,
        staleRun.createdAt,
        JSON.stringify(staleRun)
      ]
    );

    const acquired = await store.acquireActiveRun(workspace.id, {
      staleAfterMs: 1
    });

    expect(acquired).toMatchObject({
      created: true,
      run: { status: "queued" }
    });
    expect(acquired.run.id).not.toBe(staleRun.id);
    await expect(store.getRun(staleRun.id)).resolves.toMatchObject({
      status: "failed",
      statusMessage: "Undispatched hosted run expired before Workflow start."
    });
  });

  it("keeps terminal state and both export events across concurrent CAS updates", async () => {
    const workspace = await store.createWorkspace(
      "Can hosted export logging revive a canceled run?"
    );
    const acquired = await store.acquireActiveRun(workspace.id);
    const canceled = await store.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "canceled",
      statusMessage: "Canceled in the hosted adapter contract."
    });

    expect(canceled).toMatchObject({ applied: true, run: { status: "canceled" } });

    const revival = await store.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["canceled"],
      nextStatus: "completed",
      statusMessage: "A stale worker attempted completion."
    });
    expect(revival).toMatchObject({ applied: false, run: { status: "canceled" } });

    await Promise.all([
      store.recordWorkspaceExportEvent({
        workspaceId: workspace.id,
        format: "markdown",
        mode: "server_markdown",
        success: true,
        starterMode: true
      }),
      store.recordWorkspaceExportEvent({
        workspaceId: workspace.id,
        format: "png",
        mode: "client_capture",
        success: true,
        starterMode: true
      })
    ]);

    const reloaded = await store.getRun(acquired.run.id);
    expect(reloaded?.status).toBe("canceled");
    expect(reloaded?.observability?.exportEvents).toHaveLength(2);
    expect(
      reloaded?.observability?.exportEvents.map((event) => event.format).sort()
    ).toEqual(["markdown", "png"]);

    const persisted = await database.query<{ version: number }>(
      "SELECT version FROM claimgraph_runs WHERE id = $1",
      [acquired.run.id]
    );
    expect(persisted.rows[0]?.version).toBeGreaterThanOrEqual(4);
  });

  it("returns a graph-bound evidence and inventory snapshot while a newer run gathers", async () => {
    const workspace = await store.createWorkspace(
      "Can hosted payloads mix run artifacts?"
    );
    const first = await store.acquireActiveRun(workspace.id);

    await store.transitionRunStatus(first.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "gathering"
    });
    await store.saveEvidencePack(evidenceRecord(first.run.id, workspace.question, "first"));
    await store.transitionRunStatus(first.run.id, {
      expectedStatuses: ["gathering"],
      nextStatus: "extracting"
    });
    await store.saveClaimInventory(
      claimInventoryRecord(first.run.id, workspace.question, "first")
    );
    await store.transitionRunStatus(first.run.id, {
      expectedStatuses: ["extracting"],
      nextStatus: "assembling"
    });
    const completed = await store.completeRunWithGraph(
      first.run.id,
      workspace.id,
      graphRecord(first.run.id, workspace.question, "first")
    );
    expect(completed).toMatchObject({ applied: true, run: { status: "completed" } });

    const second = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(second.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "gathering"
    });
    await store.saveEvidencePack(evidenceRecord(second.run.id, workspace.question, "second"));

    const payload = await store.getWorkspaceGraphPayload(workspace.id);
    expect(payload?.run?.id).toBe(first.run.id);
    expect(payload?.graphRun?.id).toBe(first.run.id);
    expect(payload?.latestRun?.id).toBe(second.run.id);
    expect(payload?.activeRun?.id).toBe(second.run.id);
    expect(payload?.graphBuild.runId).toBe(first.run.id);
    expect(payload?.evidence?.runId).toBe(first.run.id);
    expect(payload?.claimInventory?.runId).toBe(first.run.id);
    expect(payload?.inProgressArtifacts).toMatchObject({
      runId: second.run.id,
      evidence: { runId: second.run.id },
      claimInventory: null
    });
    await expect(store.getEvidencePackForRun(second.run.id)).resolves.toMatchObject({
      runId: second.run.id,
      responseId: "evidence-response-second"
    });
    await expect(store.getClaimInventoryForRun(second.run.id)).resolves.toBeNull();
    await expect(store.getWorkspaceGraphForRun(second.run.id)).resolves.toBeNull();
  });

  it("rejects stale-stage artifact overwrites within the same hosted run", async () => {
    const workspace = await store.createWorkspace(
      "Can a stale stage overwrite a later stage artifact?"
    );
    const acquired = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "gathering"
    });
    await store.saveEvidencePack(
      evidenceRecord(acquired.run.id, workspace.question, "accepted")
    );
    await store.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["gathering"],
      nextStatus: "extracting"
    });

    await expect(
      store.saveEvidencePack(
        evidenceRecord(acquired.run.id, workspace.question, "stale")
      )
    ).rejects.toThrow(/left the owning stage/i);
    await store.saveClaimInventory(
      claimInventoryRecord(acquired.run.id, workspace.question, "accepted")
    );
    await store.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["extracting"],
      nextStatus: "assembling"
    });
    await expect(
      store.saveClaimInventory(
        claimInventoryRecord(acquired.run.id, workspace.question, "stale")
      )
    ).rejects.toThrow(/left the owning stage/i);

    await expect(store.getEvidencePackForRun(acquired.run.id)).resolves.toMatchObject({
      responseId: "evidence-response-accepted"
    });
    await expect(store.getClaimInventoryForRun(acquired.run.id)).resolves.toMatchObject({
      responseId: "claims-response-accepted"
    });
  });

  it("ignores stale hosted stage-model writes after another attempt advances the run", async () => {
    const workspace = await store.createWorkspace(
      "Can stale hosted provider metadata overwrite a later stage?"
    );
    const acquired = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "gathering"
    });
    await store.recordRunStageModel(
      acquired.run.id,
      "gathering",
      "accepted-evidence-model"
    );
    await store.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["gathering"],
      nextStatus: "extracting"
    });

    const staleResult = await store.recordRunStageModel(
      acquired.run.id,
      "gathering",
      "stale-evidence-model"
    );
    const reloaded = await store.getRun(acquired.run.id);

    expect(staleResult.status).toBe("extracting");
    expect(
      reloaded?.observability?.stages.find((stage) => stage.stage === "gathering")
        ?.model
    ).toBe("accepted-evidence-model");
  });

  it("cannot overwrite a newer completed graph from a stale run", async () => {
    const workspace = await store.createWorkspace(
      "Can a stale hosted retry overwrite a newer graph?"
    );
    const first = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(first.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "assembling"
    });
    await store.completeRunWithGraph(
      first.run.id,
      workspace.id,
      graphRecord(first.run.id, workspace.question, "old")
    );

    const second = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(second.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "assembling"
    });
    await store.completeRunWithGraph(
      second.run.id,
      workspace.id,
      graphRecord(second.run.id, workspace.question, "current")
    );

    await expect(
      store.saveWorkspaceGraph(
        workspace.id,
        graphRecord(first.run.id, workspace.question, "stale")
      )
    ).rejects.toThrow(/terminal|active|newer|supersed/i);
    await expect(store.getWorkspaceGraphForRun(first.run.id)).resolves.toBeNull();
    await expect(store.getWorkspaceGraphForRun(second.run.id)).resolves.toMatchObject({
      runId: second.run.id,
      responseId: "graph-response-current"
    });
  });

  it("cannot let concurrent starter materialization overwrite atomic completion", async () => {
    const workspace = await store.createWorkspace(
      "Can a fallback read race hosted graph completion?"
    );
    const first = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(first.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "assembling"
    });

    const [, firstCompletion] = await Promise.all([
      store.getWorkspaceGraphPayload(workspace.id),
      store.completeRunWithGraph(
        first.run.id,
        workspace.id,
        graphRecord(first.run.id, workspace.question, "stable-ids")
      )
    ]);

    expect(firstCompletion).toMatchObject({
      applied: true,
      run: { status: "completed" }
    });
    await expect(store.getWorkspaceGraphForRun(first.run.id)).resolves.toMatchObject({
      runId: first.run.id,
      responseId: "graph-response-stable-ids"
    });

    const second = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(second.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "assembling"
    });
    const secondCompletion = await store.completeRunWithGraph(
      second.run.id,
      workspace.id,
      graphRecord(second.run.id, workspace.question, "stable-ids")
    );

    expect(secondCompletion).toMatchObject({
      applied: true,
      run: { status: "completed" }
    });
    await expect(store.getWorkspaceGraphForRun(second.run.id)).resolves.toMatchObject({
      runId: second.run.id,
      responseId: "graph-response-stable-ids"
    });
  });

  it("invalidates hosted artifacts and the active run in one lifecycle transaction", async () => {
    const workspace = await store.createWorkspace(
      "Can hosted input invalidation race new analysis artifacts?"
    );
    const active = await store.acquireActiveRun(workspace.id);
    await store.transitionRunStatus(active.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "gathering"
    });
    await store.saveEvidencePack(
      evidenceRecord(active.run.id, workspace.question, "before-invalidation")
    );

    const invalidationRun = await store.recordWorkspaceArtifactsInvalidated(
      workspace.id,
      { statusMessage: "Inputs changed during the integrity test." }
    );

    expect(invalidationRun.status).toBe("completed");
    await expect(store.getRun(active.run.id)).resolves.toMatchObject({
      status: "failed",
      observability: { fallbackReason: "workspace_inputs_changed" }
    });
    await expect(store.getEvidencePackForRun(active.run.id)).resolves.toBeNull();
    await expect(store.getWorkspaceGraphForRun(invalidationRun.id)).resolves.toMatchObject({
      origin: "starter",
      runId: invalidationRun.id
    });

    const next = await store.acquireActiveRun(workspace.id);
    expect(next.created).toBe(true);
    await store.transitionRunStatus(next.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "gathering"
    });
    await store.saveEvidencePack(
      evidenceRecord(next.run.id, workspace.question, "after-invalidation")
    );
    await expect(store.getEvidencePackForRun(next.run.id)).resolves.toMatchObject({
      runId: next.run.id,
      responseId: "evidence-response-after-invalidation"
    });
  });
});
