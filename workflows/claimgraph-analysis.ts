import { sleep } from "workflow";
import { getClaimGraphRuntimeConfig } from "@/lib/claimgraph/config";
import { resolveClaimGraphProvider } from "@/lib/providers/registry";
import {
  ACTIVE_RUN_STATUSES,
  isActiveRunStatus,
  isRunLifecycleGuardError,
  requireCurrentRunAtStatus,
  transitionRunOrThrow
} from "@/lib/server/run-lifecycle";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";
import type { ClaimGraphStore } from "@/lib/server/storage/claimgraph-store";
import type {
  EvidencePackRecord,
  Run,
  RunFallbackReason,
  RunStage
} from "@/types/claimgraph";
import type { StagingRehearsalBarrierAction } from "@/lib/server/staging-rehearsal";

export interface ClaimGraphHostedAnalysisInput {
  workspaceId: string;
  runId: string;
}

export type ClaimGraphHostedAnalysisResult =
  | { status: "continue" }
  | { status: "completed" }
  | { status: "failed" }
  | { status: "insufficient_evidence" }
  | { status: "stopped" };

function fallbackForStage(stage: RunStage | "runtime"): RunFallbackReason {
  switch (stage) {
    case "gathering":
      return "gathering_failed";
    case "extracting":
      return "extracting_failed";
    case "assembling":
      return "assembling_failed";
    case "queued":
    case "ingesting":
    case "runtime":
      return "gathering_failed";
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Hosted analysis failed.";
}

const ALL_RUN_STATUSES = [
  ...ACTIVE_RUN_STATUSES,
  "canceled",
  "insufficient_evidence",
  "completed",
  "failed"
] as const satisfies readonly Run["status"][];

async function loadWorkflowRun(
  store: ClaimGraphStore,
  input: ClaimGraphHostedAnalysisInput,
  operation: string
) {
  return requireCurrentRunAtStatus(store, {
    ...input,
    expectedStatuses: ALL_RUN_STATUSES,
    operation
  });
}

async function readStagingRehearsalBarrier(
  action: StagingRehearsalBarrierAction
) {
  "use step";

  const { isStagingRehearsalBarrierActive } = await import(
    "@/lib/server/staging-rehearsal"
  );
  return isStagingRehearsalBarrierActive(action);
}

async function waitForStagingRehearsalBarrier(
  action: StagingRehearsalBarrierAction
) {
  while (await readStagingRehearsalBarrier(action)) {
    // Workflow sleep is durable and consumes no provider capacity while the
    // protected operator inspects or cancels the checkpointed run.
    await sleep(1_000);
  }
}

function resultForTerminalRun(
  run: Run
): ClaimGraphHostedAnalysisResult | null {
  switch (run.status) {
    case "completed":
      return { status: "completed" };
    case "failed":
      return { status: "failed" };
    case "insufficient_evidence":
      return { status: "insufficient_evidence" };
    case "canceled":
      return { status: "stopped" };
    case "queued":
    case "ingesting":
    case "gathering":
    case "extracting":
    case "assembling":
      return null;
  }
}

function stopForLifecycleGuard(error: unknown): ClaimGraphHostedAnalysisResult {
  if (
    isRunLifecycleGuardError(error) &&
    error.reason !== "invalid_transition"
  ) {
    return { status: "stopped" };
  }

  throw error;
}

async function finishRun(
  store: ClaimGraphStore,
  input: ClaimGraphHostedAnalysisInput & {
    expectedStatuses: readonly Run["status"][];
    status: "completed" | "failed" | "insufficient_evidence";
    statusMessage: string;
    fallbackReason?: RunFallbackReason;
    operation: string;
  }
) {
  await transitionRunOrThrow(store, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    expectedStatuses: input.expectedStatuses,
    nextStatus: input.status,
    statusMessage: input.statusMessage,
    fallbackReason: input.fallbackReason,
    operation: input.operation
  });

  return { status: input.status } satisfies ClaimGraphHostedAnalysisResult;
}

async function resultForSavedEvidence(
  store: ClaimGraphStore,
  input: ClaimGraphHostedAnalysisInput,
  evidence: EvidencePackRecord,
  sealedStatus: "gathering" | "extracting"
): Promise<ClaimGraphHostedAnalysisResult> {
  if (evidence.evidencePack.groundingStatus === "insufficient_grounding") {
    return finishRun(store, {
      ...input,
      expectedStatuses: [sealedStatus],
      status: "insufficient_evidence",
      statusMessage:
        "Not enough grounded snippets were available to build a trustworthy live graph. ClaimGraph kept the most recent safe graph path.",
      fallbackReason: "insufficient_grounding",
      operation: "marking hosted evidence insufficient"
    });
  }

  if (!evidence.evidencePack.snippets.length) {
    return finishRun(store, {
      ...input,
      expectedStatuses: [sealedStatus],
      status: "insufficient_evidence",
      statusMessage:
        "No usable snippets were saved, so ClaimGraph kept the most recent safe graph path.",
      fallbackReason: "insufficient_grounding",
      operation: "marking an empty hosted evidence pack insufficient"
    });
  }

  return { status: "continue" };
}

async function prepareHostedAnalysis(input: ClaimGraphHostedAnalysisInput) {
  "use step";

  try {
    const store = await getClaimGraphStore();
    const run = await loadWorkflowRun(
      store,
      input,
      "hosted analysis preparation"
    );
    const terminalResult = resultForTerminalRun(run);

    if (terminalResult) {
      return terminalResult;
    }

    if (run.status !== "queued") {
      return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
    }

    const workspace = await store.getWorkspace(input.workspaceId);

    if (!workspace) {
      return await finishRun(store, {
        ...input,
        expectedStatuses: ["queued"],
        status: "failed",
        statusMessage: "The workspace could not be loaded for hosted analysis.",
        operation: "marking a missing hosted workspace failed"
      });
    }

    const runtimeConfig = getClaimGraphRuntimeConfig();

    if (runtimeConfig.mode === "full" && !process.env.OPENAI_API_KEY) {
      return await finishRun(store, {
        ...input,
        expectedStatuses: ["queued"],
        status: "completed",
        statusMessage:
          "OPENAI_API_KEY is missing. ClaimGraph kept the most recent safe graph path.",
        fallbackReason: "openai_api_key_missing",
        operation: "completing an unavailable premium run"
      });
    }

    const providerResolution = resolveClaimGraphProvider();

    if (!providerResolution.provider) {
      if (providerResolution.runtime.mode === "demo") {
        return await finishRun(store, {
          ...input,
          expectedStatuses: ["queued"],
          status: "completed",
          statusMessage:
            "ClaimGraph is running in demo mode. The workspace stayed on the starter path and did not attempt live analysis.",
          operation: "completing a demo-mode hosted run"
        });
      }

      return await finishRun(store, {
        ...input,
        expectedStatuses: ["queued"],
        status: "failed",
        statusMessage:
          providerResolution.unavailableReason ??
          "The configured live provider is unavailable.",
        fallbackReason:
          providerResolution.runtime.mode === "open-model"
            ? providerResolution.unavailableFallbackReason ?? "open_model_unavailable"
            : "gathering_failed",
        operation: "failing an unavailable hosted provider run"
      });
    }

    await transitionRunOrThrow(store, {
      ...input,
      expectedStatuses: ["queued"],
      nextStatus: "ingesting",
      statusMessage:
        "Hosted Workflow accepted the analysis run and is loading workspace inputs.",
      operation: "starting hosted input ingestion"
    });

    return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
  } catch (error) {
    return stopForLifecycleGuard(error);
  }
}

async function gatherHostedEvidence(input: ClaimGraphHostedAnalysisInput) {
  "use step";

  try {
    const store = await getClaimGraphStore();
    const run = await loadWorkflowRun(
      store,
      input,
      "loading hosted evidence inputs"
    );
    const terminalResult = resultForTerminalRun(run);

    if (terminalResult) {
      return terminalResult;
    }

    if (run.status === "assembling") {
      return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (
      run.status !== "ingesting" &&
      run.status !== "gathering" &&
      run.status !== "extracting"
    ) {
      return { status: "stopped" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (run.status === "extracting") {
      const savedEvidence = await store.getEvidencePackForRun(input.runId);

      if (savedEvidence) {
        return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
      }

      return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (run.status === "gathering") {
      const savedEvidence = await store.getEvidencePackForRun(input.runId);

      if (savedEvidence) {
        return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
      }
    }

    const workspace = await store.getWorkspace(input.workspaceId);

    if (!workspace) {
      throw new Error("Workspace not found.");
    }

    const providerResolution = resolveClaimGraphProvider();

    if (!providerResolution.provider) {
      throw new Error(
        providerResolution.unavailableReason ??
          "Live provider configuration is unavailable."
      );
    }

    const runtimeConfig = getClaimGraphRuntimeConfig();
    const files = await store.getWorkspaceFiles(workspace.id);

    if (run.status === "ingesting") {
      await transitionRunOrThrow(store, {
        ...input,
        expectedStatuses: ["ingesting"],
        nextStatus: "gathering",
        statusMessage:
          runtimeConfig.mode === "open-model"
            ? "Gathering deterministic evidence from provided URLs and uploaded files."
            : files.length
              ? "Gathering evidence with OpenAI web search and file search."
              : "Gathering evidence with OpenAI web search.",
        operation: "starting hosted evidence gathering"
      });
    }

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["gathering"],
      operation: "calling the hosted evidence provider"
    });

    const { withProviderLease } = await import(
      "@/lib/server/public-beta-control-store"
    );
    const evidence = await withProviderLease({
      runId: input.runId,
      execute: () => providerResolution.provider!.gatherEvidence({
        workspace,
        files,
        runId: input.runId
      })
    });

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["gathering"],
      operation: "recording the hosted evidence model"
    });
    await store.recordRunStageModel(input.runId, "gathering", evidence.model);

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["gathering"],
      operation: "saving the hosted evidence pack"
    });
    await store.saveEvidencePack({
      runId: input.runId,
      createdAt: new Date().toISOString(),
      model: evidence.model,
      responseId: evidence.responseId,
      vectorStoreId: evidence.vectorStoreId,
      evidencePack: evidence.evidencePack
    });
    return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
  } catch (error) {
    return stopForLifecycleGuard(error);
  }
}

async function sealHostedEvidence(input: ClaimGraphHostedAnalysisInput) {
  "use step";

  try {
    const store = await getClaimGraphStore();
    const run = await loadWorkflowRun(
      store,
      input,
      "sealing hosted evidence after the rehearsal boundary"
    );
    const terminalResult = resultForTerminalRun(run);

    if (terminalResult) {
      return terminalResult;
    }

    if (run.status === "assembling") {
      return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (run.status !== "gathering" && run.status !== "extracting") {
      return { status: "stopped" } satisfies ClaimGraphHostedAnalysisResult;
    }

    const evidence = await store.getEvidencePackForRun(input.runId);

    if (!evidence || evidence.runId !== input.runId) {
      throw new Error(
        "Hosted evidence persistence completed without a matching run-scoped snapshot."
      );
    }

    if (run.status === "gathering") {
      await transitionRunOrThrow(store, {
        ...input,
        expectedStatuses: ["gathering"],
        nextStatus: "extracting",
        statusMessage:
          "Evidence gathering completed; the saved run-scoped evidence snapshot is sealed for claim extraction.",
        operation: "sealing hosted evidence for extraction"
      });
    }

    const sealedEvidence = await store.getEvidencePackForRun(input.runId);

    if (!sealedEvidence) {
      throw new Error("The sealed hosted evidence snapshot could not be reloaded.");
    }

    return resultForSavedEvidence(
      store,
      input,
      sealedEvidence,
      "extracting"
    );
  } catch (error) {
    return stopForLifecycleGuard(error);
  }
}

async function extractHostedClaims(input: ClaimGraphHostedAnalysisInput) {
  "use step";

  try {
    const store = await getClaimGraphStore();
    const run = await loadWorkflowRun(
      store,
      input,
      "loading hosted claim-extraction inputs"
    );
    const terminalResult = resultForTerminalRun(run);

    if (terminalResult) {
      return terminalResult;
    }

    if (run.status === "assembling") {
      return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (run.status !== "gathering" && run.status !== "extracting") {
      return { status: "stopped" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (run.status === "gathering") {
      await transitionRunOrThrow(store, {
        ...input,
        expectedStatuses: ["gathering"],
        nextStatus: "extracting",
        statusMessage:
          "Extracting atomic claims, counterclaims, contradictions, and gaps from the sealed evidence snapshot.",
        operation: "starting hosted claim extraction"
      });
    }

    const workspace = await store.getWorkspace(input.workspaceId);
    const evidence = await store.getEvidencePackForRun(input.runId);

    if (!workspace || !evidence || evidence.runId !== input.runId) {
      throw new Error(
        "Hosted evidence pack could not be loaded for this run's claim extraction."
      );
    }

    const savedClaimInventory = await store.getClaimInventoryForRun(input.runId);

    if (savedClaimInventory) {
      return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
    }

    const providerResolution = resolveClaimGraphProvider();

    if (!providerResolution.provider) {
      throw new Error(
        providerResolution.unavailableReason ??
          "Live provider configuration is unavailable."
      );
    }

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["extracting"],
      operation: "calling the hosted claim-extraction provider"
    });

    const { withProviderLease } = await import(
      "@/lib/server/public-beta-control-store"
    );
    const claimInventory = await withProviderLease({
      runId: input.runId,
      execute: () => providerResolution.provider!.extractClaims({
        workspace,
        evidencePack: evidence.evidencePack
      })
    });

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["extracting"],
      operation: "recording the hosted claim-extraction model"
    });
    await store.recordRunStageModel(
      input.runId,
      "extracting",
      claimInventory.model
    );

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["extracting"],
      operation: "saving the hosted claim inventory"
    });
    await store.saveClaimInventory({
      runId: input.runId,
      createdAt: new Date().toISOString(),
      model: claimInventory.model,
      responseId: claimInventory.responseId,
      claimInventory: claimInventory.claimInventory
    });
    return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
  } catch (error) {
    return stopForLifecycleGuard(error);
  }
}

async function sealHostedClaimInventory(input: ClaimGraphHostedAnalysisInput) {
  "use step";

  try {
    const store = await getClaimGraphStore();
    const run = await loadWorkflowRun(
      store,
      input,
      "sealing hosted claim inventory after the rehearsal boundary"
    );
    const terminalResult = resultForTerminalRun(run);

    if (terminalResult) {
      return terminalResult;
    }

    if (run.status === "assembling") {
      return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (run.status !== "extracting") {
      return { status: "stopped" } satisfies ClaimGraphHostedAnalysisResult;
    }

    const claimInventory = await store.getClaimInventoryForRun(input.runId);

    if (!claimInventory || claimInventory.runId !== input.runId) {
      throw new Error(
        "Hosted claim persistence completed without a matching run-scoped inventory."
      );
    }

    await transitionRunOrThrow(store, {
      ...input,
      expectedStatuses: ["extracting"],
      nextStatus: "assembling",
      statusMessage:
        "Claim extraction completed; the saved run-scoped claim inventory is sealed for graph assembly.",
      operation: "sealing hosted claim inventory for graph assembly"
    });

    return { status: "continue" } satisfies ClaimGraphHostedAnalysisResult;
  } catch (error) {
    return stopForLifecycleGuard(error);
  }
}

async function assembleHostedGraph(input: ClaimGraphHostedAnalysisInput) {
  "use step";

  try {
    const store = await getClaimGraphStore();
    const run = await loadWorkflowRun(
      store,
      input,
      "loading hosted graph-assembly inputs"
    );
    const terminalResult = resultForTerminalRun(run);

    if (terminalResult) {
      return terminalResult;
    }

    if (run.status !== "extracting" && run.status !== "assembling") {
      return { status: "stopped" } satisfies ClaimGraphHostedAnalysisResult;
    }

    if (run.status === "extracting") {
      await transitionRunOrThrow(store, {
        ...input,
        expectedStatuses: ["extracting"],
        nextStatus: "assembling",
        statusMessage:
          "Assembling a schema-valid live ClaimGraph from the sealed claim inventory.",
        operation: "starting hosted graph assembly"
      });
    }

    const workspace = await store.getWorkspace(input.workspaceId);
    const evidence = await store.getEvidencePackForRun(input.runId);
    const claimInventory = await store.getClaimInventoryForRun(input.runId);

    if (
      !workspace ||
      !evidence ||
      evidence.runId !== input.runId ||
      !claimInventory ||
      claimInventory.runId !== input.runId
    ) {
      throw new Error("Hosted graph inputs could not be loaded for this run.");
    }

    const providerResolution = resolveClaimGraphProvider();

    if (!providerResolution.provider) {
      throw new Error(
        providerResolution.unavailableReason ??
          "Live provider configuration is unavailable."
      );
    }

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["assembling"],
      operation: "calling the hosted graph-assembly provider"
    });

    const { withProviderLease } = await import(
      "@/lib/server/public-beta-control-store"
    );
    const assembledGraph = await withProviderLease({
      runId: input.runId,
      execute: () => providerResolution.provider!.assembleGraph({
        workspace,
        claimInventory: claimInventory.claimInventory,
        evidencePack: evidence.evidencePack
      })
    });

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["assembling"],
      operation: "recording the hosted graph-assembly model"
    });
    await store.recordRunStageModel(
      input.runId,
      "assembling",
      assembledGraph.model
    );

    await requireCurrentRunAtStatus(store, {
      ...input,
      expectedStatuses: ["assembling"],
      operation: "atomically saving and completing the hosted graph"
    });
    const completion = await store.completeRunWithGraph(
      input.runId,
      workspace.id,
      {
        origin: "live",
        mode: providerResolution.runtime.mode,
        provider: providerResolution.provider.id,
        backend: providerResolution.provider.backend,
        createdAt: new Date().toISOString(),
        model: assembledGraph.model,
        responseId: assembledGraph.responseId,
        runId: input.runId,
        graph: assembledGraph.graph,
        sources: evidence.evidencePack.sources,
        snippets: evidence.evidencePack.snippets
      },
      {
        expectedStatuses: ["assembling"],
        statusMessage:
          "Live evidence, claim inventory, and graph assembly completed in the hosted workflow."
      }
    );

    return completion.applied
      ? ({ status: "completed" } satisfies ClaimGraphHostedAnalysisResult)
      : ({ status: "stopped" } satisfies ClaimGraphHostedAnalysisResult);
  } catch (error) {
    return stopForLifecycleGuard(error);
  }
}

function failureExpectedStatuses(
  stage: RunStage | "runtime"
): readonly Run["status"][] {
  switch (stage) {
    case "ingesting":
      return ["queued", "ingesting"];
    case "gathering":
      return ["ingesting", "gathering"];
    case "extracting":
      return ["gathering", "extracting"];
    case "assembling":
      return ["extracting", "assembling"];
    case "queued":
      return ["queued"];
    case "runtime":
      return ACTIVE_RUN_STATUSES;
  }
}

async function markHostedAnalysisFailed(input: {
  workspaceId: string;
  runId: string;
  stage: RunStage | "runtime";
  message: string;
}) {
  "use step";

  const store = await getClaimGraphStore();
  const run = await store.getRun(input.runId);

  if (
    !run ||
    run.workspaceId !== input.workspaceId ||
    !isActiveRunStatus(run.status)
  ) {
    return { marked: false, status: run?.status ?? null };
  }

  const transition = await store.transitionRunStatus(input.runId, {
    expectedStatuses: [...failureExpectedStatuses(input.stage)],
    nextStatus: "failed",
    statusMessage: input.message || "Hosted analysis failed.",
    fallbackReason: fallbackForStage(input.stage),
    errorMessage: input.message || "Hosted analysis failed."
  });

  return {
    marked: transition.applied,
    status: transition.run.status
  };
}

export async function runClaimGraphHostedAnalysis(
  input: ClaimGraphHostedAnalysisInput
): Promise<ClaimGraphHostedAnalysisResult> {
  "use workflow";

  let stage: RunStage | "runtime" = "runtime";

  try {
    stage = "ingesting";
    const prepared = await prepareHostedAnalysis(input);

    if (prepared.status !== "continue") {
      return prepared;
    }

    stage = "gathering";
    const gathered = await gatherHostedEvidence(input);

    if (gathered.status !== "continue") {
      return gathered;
    }

    await waitForStagingRehearsalBarrier(
      "pause_after_evidence_persistence"
    );
    stage = "extracting";
    const sealedEvidence = await sealHostedEvidence(input);

    if (sealedEvidence.status !== "continue") {
      return sealedEvidence;
    }

    const extracted = await extractHostedClaims(input);

    if (extracted.status !== "continue") {
      return extracted;
    }

    await waitForStagingRehearsalBarrier(
      "pause_after_inventory_persistence"
    );
    stage = "assembling";
    const sealedInventory = await sealHostedClaimInventory(input);

    if (sealedInventory.status !== "continue") {
      return sealedInventory;
    }

    return await assembleHostedGraph(input);
  } catch (error) {
    if (error instanceof Error && error.name === "PublicBetaCapacityError") {
      // Workflow may retry this transient capacity boundary. Keep the run at
      // its current stage rather than converting throttling into a terminal
      // provider failure.
      throw error;
    }

    const failure = await markHostedAnalysisFailed({
      workspaceId: input.workspaceId,
      runId: input.runId,
      stage,
      message: errorMessage(error)
    });

    if (!failure.marked) {
      return { status: "stopped" };
    }

    throw error;
  }
}
