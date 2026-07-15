import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimGraphProvider } from "@/lib/providers/types";
import type { ClaimGraphStore } from "@/lib/server/storage/claimgraph-store";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalMode = process.env.CLAIMGRAPH_MODE;
const originalApiKey = process.env.OPENAI_API_KEY;
const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "hosted-workflow-integrity"
);

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function providerArtifacts(question: string) {
  const evidencePack = {
    question,
    summary: "Grounded evidence for a workflow cancellation test.",
    groundingStatus: "grounded" as const,
    subquestions: [],
    evidenceAxes: [],
    sources: [
      {
        id: "source-workflow",
        type: "web" as const,
        title: "Workflow integrity source",
        url: "https://example.com/workflow",
        domain: "example.com"
      }
    ],
    snippets: [
      {
        id: "snippet-workflow",
        sourceId: "source-workflow",
        text: "The workflow uses this grounded test evidence.",
        rationale: "Relevant to workflow integrity.",
        relevance: 0.9,
        origin: "web_search_result_excerpt" as const
      }
    ],
    openQuestions: [],
    warnings: []
  };
  const claimInventory = {
    question,
    claims: [
      {
        id: "claim-workflow",
        kind: "claim" as const,
        title: "Workflow state remains monotonic",
        summary: "Canceled workflow stages cannot resume writing artifacts.",
        topic: "Run integrity",
        stance: "pro" as const,
        confidence: 0.88,
        evidenceQuality: "high" as const,
        sourceIds: ["source-workflow"],
        snippetIds: ["snippet-workflow"],
        qualifiers: [],
        dependsOnGapIds: []
      }
    ],
    contradictionPairs: [],
    unresolvedGaps: []
  };

  return {
    evidence: {
      model: "evidence-workflow-model",
      responseId: "evidence-workflow-response",
      evidencePack,
      groundingStatus: "grounded" as const
    },
    claims: {
      model: "claims-workflow-model",
      responseId: "claims-workflow-response",
      claimInventory
    },
    graph: {
      model: "graph-workflow-model",
      responseId: "graph-workflow-response",
      graph: {
        question,
        graphSummary: "A graph that should only persist for an active run.",
        nodes: [
          {
            id: "question-workflow",
            kind: "question" as const,
            title: question,
            summary: "The workspace question.",
            sourceIds: [],
            snippetIds: []
          },
          {
            id: "claim-workflow",
            kind: "claim" as const,
            title: "Workflow state remains monotonic",
            summary: "Canceled workflow stages cannot resume writing artifacts.",
            topic: "Run integrity",
            stance: "pro" as const,
            confidence: 0.88,
            sourceIds: ["source-workflow"],
            snippetIds: ["snippet-workflow"]
          }
        ],
        edges: [
          {
            id: "edge-workflow",
            from: "claim-workflow",
            to: "question-workflow",
            relation: "supports" as const,
            strength: 0.88
          }
        ],
        disagreementClusters: []
      }
    }
  };
}

async function configureWorkflowTest(
  store: ClaimGraphStore,
  provider: ClaimGraphProvider
) {
  vi.doMock("@/lib/server/storage/store-factory", () => ({
    getClaimGraphStore: vi.fn(async () => store),
    isHostedClaimGraphStoreSelected: vi.fn(() => true)
  }));
  vi.doMock("@/lib/providers/registry", () => ({
    resolveClaimGraphProvider: vi.fn(() => ({
      runtime: {
        mode: "full",
        provider: "openai",
        liveAnalysisEnabled: true,
        supportsUrlIntake: true,
        supportsWebSearch: true
      },
      provider
    }))
  }));

  return import("@/workflows/claimgraph-analysis");
}

describe("hosted workflow lifecycle integrity", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_MODE = "full";
    process.env.OPENAI_API_KEY = "workflow-integrity-test-key";
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
    vi.doUnmock("@/lib/server/staging-rehearsal");
    vi.doUnmock("workflow");
    vi.resetModules();
  });

  afterAll(() => {
    rmSync(testDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    });
    vi.doUnmock("@/lib/server/storage/store-factory");
    vi.doUnmock("@/lib/providers/registry");
    vi.doUnmock("@/lib/server/staging-rehearsal");
    vi.doUnmock("workflow");
    vi.resetModules();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }

    if (originalMode === undefined) {
      delete process.env.CLAIMGRAPH_MODE;
    } else {
      process.env.CLAIMGRAPH_MODE = originalMode;
    }

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("stops after cancellation during provider work and a retry cannot revive the run", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a canceled hosted workflow resume?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const artifacts = providerArtifacts(workspace.question);
    const providerStarted = createDeferred<void>();
    const providerResult = createDeferred<typeof artifacts.evidence>();
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => {
        providerStarted.resolve();
        return providerResult.promise;
      }),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      localClaimGraphStore,
      provider
    );

    const workflow = runClaimGraphHostedAnalysis({
      workspaceId: workspace.id,
      runId: acquired.run.id
    });
    await providerStarted.promise;

    const canceled = await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["gathering"],
      nextStatus: "canceled",
      statusMessage: "Canceled while the provider request was in flight."
    });
    expect(canceled.applied).toBe(true);
    providerResult.resolve(artifacts.evidence);

    await expect(workflow).resolves.toEqual({ status: "stopped" });
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "canceled"
    });
    await expect(
      localClaimGraphStore.getEvidencePackForRun(acquired.run.id)
    ).resolves.toBeNull();
    expect(provider.extractClaims).not.toHaveBeenCalled();
    expect(provider.assembleGraph).not.toHaveBeenCalled();

    await expect(
      runClaimGraphHostedAnalysis({
        workspaceId: workspace.id,
        runId: acquired.run.id
      })
    ).resolves.toEqual({ status: "stopped" });
    expect(provider.gatherEvidence).toHaveBeenCalledTimes(1);
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "canceled"
    });
  });

  it("stops between evidence and extraction when cancellation wins the stage boundary", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can cancellation win between hosted stages?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const artifacts = providerArtifacts(workspace.question);
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => artifacts.evidence),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const cancelAfterEvidenceStore: ClaimGraphStore = {
      ...localClaimGraphStore,
      async saveEvidencePack(record) {
        const saved = await localClaimGraphStore.saveEvidencePack(record);
        const cancellation = await localClaimGraphStore.transitionRunStatus(record.runId, {
          expectedStatuses: ["gathering"],
          nextStatus: "canceled",
          statusMessage: "Canceled after evidence persistence."
        });
        expect(cancellation.applied).toBe(true);
        return saved;
      }
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      cancelAfterEvidenceStore,
      provider
    );

    await expect(
      runClaimGraphHostedAnalysis({
        workspaceId: workspace.id,
        runId: acquired.run.id
      })
    ).resolves.toEqual({ status: "stopped" });

    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "canceled"
    });
    await expect(
      localClaimGraphStore.getEvidencePackForRun(acquired.run.id)
    ).resolves.toMatchObject({ runId: acquired.run.id });
    await expect(
      localClaimGraphStore.getClaimInventoryForRun(acquired.run.id)
    ).resolves.toBeNull();
    expect(provider.extractClaims).not.toHaveBeenCalled();
    expect(provider.assembleGraph).not.toHaveBeenCalled();
  });

  it("cannot persist an assembled graph when cancellation wins before atomic completion", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can cancellation beat hosted graph completion?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const artifacts = providerArtifacts(workspace.question);
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => artifacts.evidence),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const cancelBeforeCompletionStore: ClaimGraphStore = {
      ...localClaimGraphStore,
      async completeRunWithGraph(runId, workspaceId, record, options) {
        const cancellation = await localClaimGraphStore.transitionRunStatus(runId, {
          expectedStatuses: ["assembling"],
          nextStatus: "canceled",
          statusMessage: "Canceled after assembly and before graph completion."
        });
        expect(cancellation.applied).toBe(true);
        return localClaimGraphStore.completeRunWithGraph(
          runId,
          workspaceId,
          record,
          options
        );
      }
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      cancelBeforeCompletionStore,
      provider
    );

    await expect(
      runClaimGraphHostedAnalysis({
        workspaceId: workspace.id,
        runId: acquired.run.id
      })
    ).resolves.toEqual({ status: "stopped" });

    expect(provider.assembleGraph).toHaveBeenCalledTimes(1);
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "canceled"
    });
    await expect(
      localClaimGraphStore.getWorkspaceGraphForRun(acquired.run.id)
    ).resolves.toBeNull();
    const payload = await localClaimGraphStore.getWorkspaceGraphPayload(workspace.id);
    expect(payload?.starterMode).toBe(true);
    expect(payload?.graphBuild.runId).not.toBe(acquired.run.id);
  });

  it("resumes a gathering checkpoint when a Workflow step retries", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a hosted evidence step resume after checkpointing its status?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "ingesting"
    });
    await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["ingesting"],
      nextStatus: "gathering"
    });
    const artifacts = providerArtifacts(workspace.question);
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => artifacts.evidence),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      localClaimGraphStore,
      provider
    );

    await expect(
      runClaimGraphHostedAnalysis({
        workspaceId: workspace.id,
        runId: acquired.run.id
      })
    ).resolves.toEqual({ status: "completed" });

    expect(provider.gatherEvidence).toHaveBeenCalledTimes(1);
    expect(provider.extractClaims).toHaveBeenCalledTimes(1);
    expect(provider.assembleGraph).toHaveBeenCalledTimes(1);
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "completed"
    });
  });

  it("reuses run-scoped artifacts and terminal completion across Workflow retries", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can hosted retries reuse committed stage artifacts?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const artifacts = providerArtifacts(workspace.question);
    await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["queued"],
      nextStatus: "ingesting"
    });
    await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["ingesting"],
      nextStatus: "gathering"
    });
    await localClaimGraphStore.saveEvidencePack({
      runId: acquired.run.id,
      createdAt: new Date().toISOString(),
      model: artifacts.evidence.model,
      responseId: artifacts.evidence.responseId,
      evidencePack: artifacts.evidence.evidencePack
    });
    await localClaimGraphStore.transitionRunStatus(acquired.run.id, {
      expectedStatuses: ["gathering"],
      nextStatus: "extracting"
    });
    await localClaimGraphStore.saveClaimInventory({
      runId: acquired.run.id,
      createdAt: new Date().toISOString(),
      model: artifacts.claims.model,
      responseId: artifacts.claims.responseId,
      claimInventory: artifacts.claims.claimInventory
    });
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => artifacts.evidence),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      localClaimGraphStore,
      provider
    );
    const input = {
      workspaceId: workspace.id,
      runId: acquired.run.id
    };

    await expect(runClaimGraphHostedAnalysis(input)).resolves.toEqual({
      status: "completed"
    });
    await expect(runClaimGraphHostedAnalysis(input)).resolves.toEqual({
      status: "completed"
    });

    expect(provider.gatherEvidence).not.toHaveBeenCalled();
    expect(provider.extractClaims).not.toHaveBeenCalled();
    expect(provider.assembleGraph).toHaveBeenCalledTimes(1);
  });

  it("terminalizes a seal-step reload failure instead of stranding an active run", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can a failed hosted seal step strand an active run?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const artifacts = providerArtifacts(workspace.question);
    let persistedEvidenceReads = 0;
    const reloadFailureStore: ClaimGraphStore = {
      ...localClaimGraphStore,
      async getEvidencePackForRun(runId) {
        const evidence = await localClaimGraphStore.getEvidencePackForRun(runId);

        if (!evidence) {
          return null;
        }

        persistedEvidenceReads += 1;
        return persistedEvidenceReads === 1 ? evidence : null;
      }
    };
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => artifacts.evidence),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      reloadFailureStore,
      provider
    );

    await expect(
      runClaimGraphHostedAnalysis({
        workspaceId: workspace.id,
        runId: acquired.run.id
      })
    ).rejects.toThrow(/sealed hosted evidence snapshot/i);
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "failed"
    });
    await expect(
      localClaimGraphStore.getActiveRunForWorkspace(workspace.id)
    ).resolves.toBeNull();
    expect(provider.extractClaims).not.toHaveBeenCalled();
  });

  it("observes the durable evidence barrier and lets cancellation win before extraction", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can staging pause after hosted evidence persistence?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const artifacts = providerArtifacts(workspace.question);
    const sleepEntered = createDeferred<void>();
    const releaseSleep = createDeferred<void>();
    let barrierReleased = false;
    const sleep = vi.fn(async () => {
      sleepEntered.resolve();
      await releaseSleep.promise;
    });
    const isStagingRehearsalBarrierActive = vi.fn(
      async (action: string) =>
        action === "pause_after_evidence_persistence" && !barrierReleased
    );
    vi.doMock("workflow", () => ({ sleep }));
    vi.doMock("@/lib/server/staging-rehearsal", () => ({
      isStagingRehearsalBarrierActive
    }));
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => artifacts.evidence),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      localClaimGraphStore,
      provider
    );
    const workflow = runClaimGraphHostedAnalysis({
      workspaceId: workspace.id,
      runId: acquired.run.id
    });

    await sleepEntered.promise;
    await expect(
      localClaimGraphStore.getEvidencePackForRun(acquired.run.id)
    ).resolves.toMatchObject({ runId: acquired.run.id });
    await expect(
      localClaimGraphStore.getClaimInventoryForRun(acquired.run.id)
    ).resolves.toBeNull();
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "gathering"
    });

    const cancellation = await localClaimGraphStore.transitionRunStatus(
      acquired.run.id,
      {
        expectedStatuses: ["gathering"],
        nextStatus: "canceled",
        statusMessage: "Canceled at the staging evidence barrier."
      }
    );
    expect(cancellation.applied).toBe(true);
    barrierReleased = true;
    releaseSleep.resolve();

    await expect(workflow).resolves.toEqual({ status: "stopped" });
    expect(sleep).toHaveBeenCalled();
    expect(provider.extractClaims).not.toHaveBeenCalled();
    expect(provider.assembleGraph).not.toHaveBeenCalled();
  });

  it("observes and releases the durable inventory barrier before graph assembly", async () => {
    const { localClaimGraphStore } = await import("@/lib/server/storage/local-store");
    const { resetStoreForTests } = await import("@/lib/server/store");
    resetStoreForTests();

    const workspace = await localClaimGraphStore.createWorkspace(
      "Can staging pause after hosted inventory persistence?"
    );
    const acquired = await localClaimGraphStore.acquireActiveRun(workspace.id);
    const artifacts = providerArtifacts(workspace.question);
    const sleepEntered = createDeferred<void>();
    const releaseSleep = createDeferred<void>();
    let barrierReleased = false;
    const sleep = vi.fn(async () => {
      sleepEntered.resolve();
      await releaseSleep.promise;
    });
    const isStagingRehearsalBarrierActive = vi.fn(
      async (action: string) =>
        action === "pause_after_inventory_persistence" && !barrierReleased
    );
    vi.doMock("workflow", () => ({ sleep }));
    vi.doMock("@/lib/server/staging-rehearsal", () => ({
      isStagingRehearsalBarrierActive
    }));
    const provider: ClaimGraphProvider = {
      id: "openai",
      mode: "full",
      gatherEvidence: vi.fn(async () => artifacts.evidence),
      extractClaims: vi.fn(async () => artifacts.claims),
      assembleGraph: vi.fn(async () => artifacts.graph)
    };
    const { runClaimGraphHostedAnalysis } = await configureWorkflowTest(
      localClaimGraphStore,
      provider
    );
    const workflow = runClaimGraphHostedAnalysis({
      workspaceId: workspace.id,
      runId: acquired.run.id
    });

    await sleepEntered.promise;
    await expect(
      localClaimGraphStore.getClaimInventoryForRun(acquired.run.id)
    ).resolves.toMatchObject({ runId: acquired.run.id });
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "extracting"
    });
    await expect(
      localClaimGraphStore.getWorkspaceGraphForRun(acquired.run.id)
    ).resolves.toBeNull();

    barrierReleased = true;
    releaseSleep.resolve();

    await expect(workflow).resolves.toEqual({ status: "completed" });
    expect(provider.assembleGraph).toHaveBeenCalledTimes(1);
    await expect(localClaimGraphStore.getRun(acquired.run.id)).resolves.toMatchObject({
      status: "completed"
    });
  });
});
