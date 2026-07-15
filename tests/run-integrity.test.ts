import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CLAIMGRAPH_NEON_SCHEMA_SQL } from "@/lib/server/storage/neon-schema";
import { withClaimGraphDatabase } from "@/lib/server/database";
import { localClaimGraphStore } from "@/lib/server/storage/local-store";
import {
  isAllowedRunTransition,
  transitionRunOrThrow
} from "@/lib/server/run-lifecycle";
import { resetStoreForTests } from "@/lib/server/store";
import type {
  ClaimInventoryRecord,
  EvidencePackRecord,
  RunStatus,
  WorkspaceFile,
  WorkspaceGraphRecord
} from "@/types/claimgraph";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "run-integrity"
);

function buildEvidence(
  runId: string,
  question: string,
  suffix: string
): EvidencePackRecord {
  return {
    runId,
    createdAt: new Date().toISOString(),
    model: `evidence-model-${suffix}`,
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
          text: `Grounded evidence ${suffix}.`,
          rationale: `Relevant evidence ${suffix}.`,
          relevance: 0.84,
          origin: "web_search_result_excerpt"
        }
      ],
      openQuestions: [],
      warnings: []
    }
  };
}

function buildClaimInventory(
  runId: string,
  question: string,
  suffix: string
): ClaimInventoryRecord {
  return {
    runId,
    createdAt: new Date().toISOString(),
    model: `claim-model-${suffix}`,
    responseId: `claim-response-${suffix}`,
    claimInventory: {
      question,
      claims: [
        {
          id: `claim-${suffix}`,
          kind: "claim",
          title: `Claim ${suffix}`,
          summary: `Claim summary ${suffix}.`,
          topic: "Run integrity",
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

function buildGraph(
  runId: string,
  question: string,
  suffix: string
): WorkspaceGraphRecord {
  return {
    origin: "live",
    mode: "full",
    provider: "openai",
    createdAt: new Date().toISOString(),
    model: `graph-model-${suffix}`,
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
          topic: "Run integrity",
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
        text: `Grounded evidence ${suffix}.`,
        rationale: `Relevant evidence ${suffix}.`,
        relevance: 0.84,
        origin: "web_search_result_excerpt"
      }
    ]
  };
}

async function transition(
  runId: string,
  expectedStatuses: RunStatus[],
  nextStatus: RunStatus
) {
  const result = await localClaimGraphStore.transitionRunStatus(runId, {
    expectedStatuses,
    nextStatus,
    statusMessage: `${nextStatus} in the integrity contract.`
  });

  expect(result.applied).toBe(true);
  expect(result.run.status).toBe(nextStatus);
  return result.run;
}

function workspaceFile(workspaceId: string, suffix: string): WorkspaceFile {
  return {
    id: `file-${suffix}`,
    workspaceId,
    originalName: `${suffix}.txt`,
    storedName: `file-${suffix}.txt`,
    mimeType: "text/plain",
    extension: "txt",
    sizeBytes: 12,
    uploadedAt: new Date().toISOString()
  };
}

describe("run-integrity storage contract", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
    resetStoreForTests();
  });

  afterAll(() => {
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
    resetStoreForTests();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }
  });

  it("atomically acquires one active run for simultaneous callers", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should one workspace allow concurrent builds?"
    );

    const [left, right] = await Promise.all([
      localClaimGraphStore.acquireActiveRun(workspace.id),
      localClaimGraphStore.acquireActiveRun(workspace.id)
    ]);

    expect(left.run.id).toBe(right.run.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run.status).toBe("queued");

    const third = await localClaimGraphStore.acquireActiveRun(workspace.id);
    expect(third).toMatchObject({
      created: false,
      run: { id: left.run.id, status: "queued" }
    });
  });

  it("serializes local workspace deletion with active-run acquisition", async () => {
    const runFirstWorkspace = await localClaimGraphStore.createWorkspace(
      "Can workspace deletion race a local analysis start?"
    );
    const retainedFile = workspaceFile(runFirstWorkspace.id, "workspace-delete-race");
    await localClaimGraphStore.addWorkspaceFiles(runFirstWorkspace.id, [retainedFile]);
    const [acquisition, deletion] = await Promise.all([
      localClaimGraphStore.acquireActiveRun(runFirstWorkspace.id),
      localClaimGraphStore.deleteWorkspaceIfNoActiveRun(runFirstWorkspace.id)
    ]);

    expect(acquisition.created).toBe(true);
    expect(deletion).toMatchObject({
      applied: false,
      reason: "active_run",
      activeRun: { id: acquisition.run.id }
    });
    await expect(
      localClaimGraphStore.getWorkspace(runFirstWorkspace.id)
    ).resolves.toMatchObject({ id: runFirstWorkspace.id });

    const deleteFirstWorkspace = await localClaimGraphStore.createWorkspace(
      "Can a local analysis start after workspace deletion commits?"
    );
    const deletedFile = workspaceFile(deleteFirstWorkspace.id, "deleted-workspace");
    await localClaimGraphStore.addWorkspaceFiles(deleteFirstWorkspace.id, [deletedFile]);
    const [acceptedDeletion, rejectedAcquisition] = await Promise.allSettled([
      localClaimGraphStore.deleteWorkspaceIfNoActiveRun(deleteFirstWorkspace.id),
      localClaimGraphStore.acquireActiveRun(deleteFirstWorkspace.id)
    ]);

    expect(acceptedDeletion).toMatchObject({
      status: "fulfilled",
      value: {
        applied: true,
        workspace: { id: deleteFirstWorkspace.id },
        files: [{ id: deletedFile.id }]
      }
    });
    expect(rejectedAcquisition).toMatchObject({ status: "rejected" });
    await expect(
      localClaimGraphStore.getWorkspace(deleteFirstWorkspace.id)
    ).resolves.toBeNull();
  });

  it("keeps local starter fallback reads free of graph persistence side effects", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Should a shared graph read mutate storage?"
    );
    await expect(
      localClaimGraphStore.getWorkspaceGraphPayload(workspace.id)
    ).resolves.toMatchObject({ starterMode: true });
    expect(
      withClaimGraphDatabase((db) =>
        db.prepare("SELECT count(*) AS count FROM graphs WHERE workspace_id = ?")
          .get(workspace.id) as { count: number }
      ).count
    ).toBe(0);

    withClaimGraphDatabase((db) => {
      db.prepare(`
        INSERT INTO graphs (workspace_id, created_at, origin, run_id, data)
        VALUES (?, ?, 'live', null, ?)
      `).run(workspace.id, workspace.createdAt, "{");
    });
    const before = withClaimGraphDatabase((db) =>
      db.prepare("SELECT data FROM graphs WHERE workspace_id = ?")
        .get(workspace.id) as { data: string }
    );
    await expect(
      localClaimGraphStore.getWorkspaceGraphPayload(workspace.id)
    ).resolves.toMatchObject({ starterMode: true });
    const after = withClaimGraphDatabase((db) =>
      db.prepare("SELECT data FROM graphs WHERE workspace_id = ?")
        .get(workspace.id) as { data: string }
    );
    expect(after).toEqual(before);
  });

  it("serializes local file additions with active-run acquisition", async () => {
    const runFirstWorkspace = await localClaimGraphStore.createWorkspace(
      "Can upload metadata appear after an analysis starts?"
    );
    const runFirstFile = workspaceFile(runFirstWorkspace.id, "run-first");
    const [acquired, concurrentAdd] = await Promise.all([
      localClaimGraphStore.acquireActiveRun(runFirstWorkspace.id),
      localClaimGraphStore.addWorkspaceFilesIfNoActiveRun(
        runFirstWorkspace.id,
        [runFirstFile]
      )
    ]);

    expect(acquired.created).toBe(true);
    if (concurrentAdd.applied) {
      await expect(
        localClaimGraphStore.getWorkspaceFiles(runFirstWorkspace.id)
      ).resolves.toMatchObject([{ id: runFirstFile.id }]);
    } else {
      expect(concurrentAdd).toMatchObject({
        reason: "active_run",
        activeRun: { id: acquired.run.id }
      });
      await expect(
        localClaimGraphStore.getWorkspaceFiles(runFirstWorkspace.id)
      ).resolves.toEqual([]);
    }
    const blockedFile = workspaceFile(runFirstWorkspace.id, "blocked-after-run");
    await expect(
      localClaimGraphStore.addWorkspaceFilesIfNoActiveRun(
        runFirstWorkspace.id,
        [blockedFile]
      )
    ).resolves.toMatchObject({
      applied: false,
      reason: "active_run",
      activeRun: { id: acquired.run.id }
    });

    const fileFirstWorkspace = await localClaimGraphStore.createWorkspace(
      "Does analysis wait for a committed upload metadata mutation?"
    );
    const fileFirst = workspaceFile(fileFirstWorkspace.id, "file-first");
    const [acceptedAdd, nextRun] = await Promise.all([
      localClaimGraphStore.addWorkspaceFilesIfNoActiveRun(
        fileFirstWorkspace.id,
        [fileFirst]
      ),
      localClaimGraphStore.acquireActiveRun(fileFirstWorkspace.id)
    ]);

    expect(acceptedAdd).toMatchObject({
      applied: true,
      files: [{ id: fileFirst.id }]
    });
    expect(nextRun.created).toBe(true);
    await expect(
      localClaimGraphStore.getWorkspaceFiles(fileFirstWorkspace.id)
    ).resolves.toMatchObject([{ id: fileFirst.id }]);
  });

  it("serializes local file removals with active-run acquisition", async () => {
    const runFirstWorkspace = await localClaimGraphStore.createWorkspace(
      "Can deletion remove an input from an active analysis?"
    );
    const retainedFile = workspaceFile(runFirstWorkspace.id, "retained");
    await localClaimGraphStore.addWorkspaceFiles(runFirstWorkspace.id, [retainedFile]);
    const [acquired, concurrentRemoval] = await Promise.all([
      localClaimGraphStore.acquireActiveRun(runFirstWorkspace.id),
      localClaimGraphStore.removeWorkspaceFileIfNoActiveRun(
        runFirstWorkspace.id,
        retainedFile.id
      )
    ]);

    if (concurrentRemoval.applied) {
      await expect(
        localClaimGraphStore.getWorkspaceFiles(runFirstWorkspace.id)
      ).resolves.toEqual([]);
    } else {
      expect(concurrentRemoval).toMatchObject({
        reason: "active_run",
        activeRun: { id: acquired.run.id }
      });
      await expect(
        localClaimGraphStore.getWorkspaceFiles(runFirstWorkspace.id)
      ).resolves.toMatchObject([{ id: retainedFile.id }]);
    }

    const deleteFirstWorkspace = await localClaimGraphStore.createWorkspace(
      "Does analysis start after committed file deletion?"
    );
    const removedFile = workspaceFile(deleteFirstWorkspace.id, "removed");
    await localClaimGraphStore.addWorkspaceFiles(deleteFirstWorkspace.id, [removedFile]);
    const acceptedRemoval = await localClaimGraphStore.removeWorkspaceFileIfNoActiveRun(
      deleteFirstWorkspace.id,
      removedFile.id,
      { invalidateArtifacts: true }
    );
    const nextRun = await localClaimGraphStore.acquireActiveRun(
      deleteFirstWorkspace.id
    );

    expect(acceptedRemoval).toMatchObject({
      applied: true,
      file: { id: removedFile.id },
      files: [],
      artifactsInvalidated: true
    });
    expect(nextRun.created).toBe(true);
    await expect(localClaimGraphStore.getRun(nextRun.run.id)).resolves.toMatchObject({
      status: "queued"
    });
    await expect(
      localClaimGraphStore.getWorkspaceFiles(deleteFirstWorkspace.id)
    ).resolves.toEqual([]);

    const blockedWorkspace = await localClaimGraphStore.createWorkspace(
      "Does an established run block file removal?"
    );
    const blockedFile = workspaceFile(blockedWorkspace.id, "blocked-removal");
    await localClaimGraphStore.addWorkspaceFiles(blockedWorkspace.id, [blockedFile]);
    const blockedRun = await localClaimGraphStore.acquireActiveRun(
      blockedWorkspace.id
    );
    await expect(
      localClaimGraphStore.removeWorkspaceFileIfNoActiveRun(
        blockedWorkspace.id,
        blockedFile.id
      )
    ).resolves.toMatchObject({
      applied: false,
      reason: "active_run",
      activeRun: { id: blockedRun.run.id }
    });
  });

  it("uses compare-and-set transitions and never revives a terminal run", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a canceled run be revived?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);

    await transition(acquired.run.id, ["queued"], "gathering");
    await transition(acquired.run.id, ["gathering"], "canceled");

    const staleStage = await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["gathering"],
      nextStatus: "extracting",
      statusMessage: "A stale workflow attempted extraction."
    });
    const explicitRevival = await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["canceled"],
      nextStatus: "completed",
      statusMessage: "A stale workflow attempted completion."
    });

    expect(staleStage.applied).toBe(false);
    expect(staleStage.run.status).toBe("canceled");
    expect(explicitRevival.applied).toBe(false);
    expect(explicitRevival.run.status).toBe("canceled");
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "canceled"
    });
  });

  it("rejects stale local artifact writes after the owning stage advances", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a stale local stage overwrite run artifacts?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    await transition(acquired.run.id, ["queued"], "gathering");
    await localClaimGraphStore.saveEvidencePack(
      buildEvidence(acquired.run.id, workspace.question, "accepted")
    );
    await transition(acquired.run.id, ["gathering"], "extracting");
    await expect(
      localClaimGraphStore.saveEvidencePack(
        buildEvidence(acquired.run.id, workspace.question, "stale")
      )
    ).rejects.toThrow(/left gathering/i);
    await localClaimGraphStore.saveClaimInventory(
      buildClaimInventory(acquired.run.id, workspace.question, "accepted")
    );
    await transition(acquired.run.id, ["extracting"], "assembling");
    await expect(
      localClaimGraphStore.saveClaimInventory(
        buildClaimInventory(acquired.run.id, workspace.question, "stale")
      )
    ).rejects.toThrow(/left extracting/i);
  });

  it("ignores stale local stage-model writes after another attempt advances the run", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Can stale local provider metadata overwrite a later stage?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    await transition(acquired.run.id, ["queued"], "gathering");
    await localClaimGraphStore.recordRunStageModel(
      acquired.run.id,
      "gathering",
      "accepted-evidence-model"
    );
    await transition(acquired.run.id, ["gathering"], "extracting");

    const staleResult = await localClaimGraphStore.recordRunStageModel(
      acquired.run.id,
      "gathering",
      "stale-evidence-model"
    );
    const reloaded = await localClaimGraphStore.getRun(acquired.run.id);

    expect(staleResult.status).toBe("extracting");
    expect(
      reloaded?.observability?.stages.find((stage) => stage.stage === "gathering")
        ?.model
    ).toBe("accepted-evidence-model");
  });

  it("applies the shared lifecycle transition graph before touching storage", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a workflow skip required lifecycle stages?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);

    expect(isAllowedRunTransition("queued", "ingesting")).toBe(true);
    expect(isAllowedRunTransition("queued", "assembling")).toBe(false);
    expect(isAllowedRunTransition("canceled", "completed")).toBe(false);

    await expect(
      transitionRunOrThrow(localClaimGraphStore, {
        runId: acquired.run.id,
        workspaceId: workspace.id,
        expectedStatuses: ["queued"],
        nextStatus: "assembling",
        operation: "skipping directly to assembly"
      })
    ).rejects.toMatchObject({
      name: "RunLifecycleGuardError",
      reason: "invalid_transition"
    });
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "queued"
    });
  });

  it("keeps displayed graph artifacts on one run snapshot while a newer run is active", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Do graph payloads mix artifacts between runs?"
    );
    const first = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const firstEvidence = buildEvidence(first.run.id, workspace.question, "first");
    const firstClaims = buildClaimInventory(first.run.id, workspace.question, "first");
    const firstGraph = buildGraph(first.run.id, workspace.question, "first");

    await transition(first.run.id, ["queued"], "gathering");
    await localClaimGraphStore.saveEvidencePack(firstEvidence);
    await transition(first.run.id, ["gathering"], "extracting");
    await localClaimGraphStore.saveClaimInventory(firstClaims);
    await transition(first.run.id, ["extracting"], "assembling");
    const completed = await localClaimGraphStore.completeRunWithGraph(
      first.run.id,
      workspace.id,
      firstGraph
    );
    expect(completed).toMatchObject({
      applied: true,
      run: { id: first.run.id, status: "completed" },
      graph: { runId: first.run.id }
    });

    const second = await localClaimGraphStore.acquireActiveRun(workspace.id);
    await transition(second.run.id, ["queued"], "gathering");
    await localClaimGraphStore.saveEvidencePack(
      buildEvidence(second.run.id, workspace.question, "second")
    );

    const payload = await localClaimGraphStore.getWorkspaceGraphPayload(workspace.id);

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
    await expect(localClaimGraphStore.getEvidencePackForRun(first.run.id)).resolves.toMatchObject({
      runId: first.run.id,
      responseId: "evidence-response-first"
    });
    await expect(localClaimGraphStore.getClaimInventoryForRun(first.run.id)).resolves.toMatchObject({
      runId: first.run.id,
      responseId: "claim-response-first"
    });
    await expect(localClaimGraphStore.getWorkspaceGraphForRun(first.run.id)).resolves.toMatchObject({
      runId: first.run.id,
      responseId: "graph-response-first"
    });
    await expect(localClaimGraphStore.getEvidencePackForRun(second.run.id)).resolves.toMatchObject({
      runId: second.run.id,
      responseId: "evidence-response-second"
    });
    await expect(localClaimGraphStore.getClaimInventoryForRun(second.run.id)).resolves.toBeNull();
    await expect(localClaimGraphStore.getWorkspaceGraphForRun(second.run.id)).resolves.toBeNull();
  });

  it("rejects a stale graph write after a newer run owns the workspace graph", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a stale run overwrite the current graph?"
    );
    const first = await localClaimGraphStore.acquireActiveRun(workspace.id);

    await transition(first.run.id, ["queued"], "gathering");
    await transition(first.run.id, ["gathering"], "extracting");
    await transition(first.run.id, ["extracting"], "assembling");
    await localClaimGraphStore.completeRunWithGraph(
      first.run.id,
      workspace.id,
      buildGraph(first.run.id, workspace.question, "old")
    );

    const second = await localClaimGraphStore.acquireActiveRun(workspace.id);
    await transition(second.run.id, ["queued"], "gathering");
    await transition(second.run.id, ["gathering"], "extracting");
    await transition(second.run.id, ["extracting"], "assembling");
    const currentGraph = buildGraph(second.run.id, workspace.question, "current");
    const completed = await localClaimGraphStore.completeRunWithGraph(
      second.run.id,
      workspace.id,
      currentGraph
    );
    expect(completed.applied).toBe(true);

    await expect(
      localClaimGraphStore.saveWorkspaceGraph(
        workspace.id,
        buildGraph(first.run.id, workspace.question, "stale-retry")
      )
    ).rejects.toThrow(/terminal|active|newer|supersed/i);

    await expect(localClaimGraphStore.getWorkspaceGraphForRun(first.run.id)).resolves.toBeNull();
    await expect(localClaimGraphStore.getWorkspaceGraphForRun(second.run.id)).resolves.toMatchObject({
      runId: second.run.id,
      responseId: "graph-response-current"
    });
  });

  it("records concurrent exports without losing cancellation or either event", async () => {
    const workspace = await localClaimGraphStore.createWorkspace(
      "Can export logging overwrite terminal state?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);

    await transition(acquired.run.id, ["queued"], "canceled");

    await Promise.all([
      localClaimGraphStore.recordWorkspaceExportEvent({
        workspaceId: workspace.id,
        format: "markdown",
        mode: "server_markdown",
        success: true,
        starterMode: true
      }),
      localClaimGraphStore.recordWorkspaceExportEvent({
        workspaceId: workspace.id,
        format: "png",
        mode: "client_capture",
        success: true,
        starterMode: true
      })
    ]);

    const reloaded = await localClaimGraphStore.getRun(acquired.run.id);

    expect(reloaded?.status).toBe("canceled");
    expect(reloaded?.observability?.exportEvents).toHaveLength(2);
    expect(
      new Set(reloaded?.observability?.exportEvents.map((event) => event.id)).size
    ).toBe(2);
    expect(
      reloaded?.observability?.exportEvents.map((event) => event.format).sort()
    ).toEqual(["markdown", "png"]);
  });
});

describe("hosted run-integrity schema and adapter contract", () => {
  it("keeps local and hosted adapters on the same public run-integrity surface", async () => {
    const { hostedClaimGraphStore } = await import("@/lib/server/storage/hosted-store");
    const requiredMethods = [
      "acquireActiveRun",
      "getActiveRunForWorkspace",
      "transitionRunStatus",
      "completeRunWithGraph",
      "getEvidencePackForRun",
      "getClaimInventoryForRun",
      "getWorkspaceGraphForRun"
    ] as const;

    for (const method of requiredMethods) {
      expect(localClaimGraphStore[method]).toBeTypeOf("function");
      expect(hostedClaimGraphStore[method]).toBeTypeOf("function");
    }
  });

  it("commits the hosted CAS and single-flight invariants to both schema copies", () => {
    const checkedInSchema = readFileSync(
      path.join(process.cwd(), "lib", "server", "storage", "schema", "neon.sql"),
      "utf8"
    );

    for (const schema of [CLAIMGRAPH_NEON_SCHEMA_SQL, checkedInSchema]) {
      expect(schema).toMatch(/\bversion\s+(?:big)?int(?:eger)?\b/i);
      expect(schema).toMatch(/CREATE UNIQUE INDEX[\s\S]+claimgraph_runs[\s\S]+WHERE[\s\S]+status/i);
      expect(schema).toContain("'queued'");
      expect(schema).toContain("'gathering'");
      expect(schema).toContain("'assembling'");
    }
  });

});
