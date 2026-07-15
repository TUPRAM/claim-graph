import { getClaimGraphRuntimeConfig } from "@/lib/claimgraph/config";
import {
  OpenModelBackendUnavailableError,
  OpenModelConfigurationError,
  OpenModelModelUnavailableError,
  OpenModelResponseValidationError,
  OpenModelRequestTimeoutError
} from "@/lib/open-model/client";
import { resolveClaimGraphProvider } from "@/lib/providers/registry";
import { withProviderLease } from "@/lib/server/public-beta-control-store";
import {
  createRun,
  completeRunWithGraph,
  getLatestRunForWorkspace,
  getRun,
  getStarterGraphPayload,
  getWorkspace,
  getWorkspaceFiles,
  heartbeatRunExecution,
  listRunsByStatuses,
  markRunExecutionStarted,
  recordRunProviderFailureEvent,
  recordRunHostedOpenModelHealth,
  recordRunStageModel,
  saveClaimInventory,
  saveEvidencePack,
  transitionRunStatus
} from "@/lib/server/store";
import {
  ACTIVE_RUN_STATUSES,
  isActiveRunStatus,
  isAllowedRunTransition
} from "@/lib/server/run-lifecycle";
import type {
  HostedOpenModelHealthCheck,
  ProviderFailureEvent,
  Run,
  RunFallbackReason
} from "@/types/claimgraph";

interface ActiveRunHandle {
  heartbeatHandle: NodeJS.Timeout;
  controller: AbortController;
  task: Promise<void>;
}

declare global {
  var __claimgraphAnalysisRunnerId: string | undefined;
  var __claimgraphActiveRuns: Map<string, ActiveRunHandle> | undefined;
  var __claimgraphAnalysisRuntimeBootstrapped: boolean | undefined;
  var __claimgraphStaleRunReconcilerHandle: NodeJS.Timeout | undefined;
}

class AnalysisCanceledError extends Error {
  constructor(message = "Analysis canceled.") {
    super(message);
    this.name = "AnalysisCanceledError";
  }
}

function getRunnerId() {
  globalThis.__claimgraphAnalysisRunnerId ??= `claimgraph-${process.pid}-${crypto.randomUUID()}`;
  return globalThis.__claimgraphAnalysisRunnerId;
}

function getActiveRuns() {
  globalThis.__claimgraphActiveRuns ??= new Map<string, ActiveRunHandle>();
  return globalThis.__claimgraphActiveRuns;
}

function readDurationMs(name: string, fallback: number) {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : Number.NaN;

  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function getRunStaleAfterMs() {
  return readDurationMs("CLAIMGRAPH_RUN_STALE_AFTER_MS", 90_000);
}

function getRunHeartbeatMs(staleAfterMs: number) {
  const fallback = Math.max(1_000, Math.min(5_000, Math.floor(staleAfterMs / 3)));
  const configured = readDurationMs("CLAIMGRAPH_RUN_HEARTBEAT_MS", fallback);

  return Math.max(1, Math.min(configured, Math.max(1, staleAfterMs - 1)));
}

function getRunReconcileIntervalMs() {
  return getRunHeartbeatMs(getRunStaleAfterMs());
}

function isAbortError(error: unknown) {
  if (error instanceof AnalysisCanceledError) {
    return true;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof Error) {
    return error.name === "AbortError" ||
      error.message.includes("aborted") ||
      error.message.includes("canceled");
  }

  return false;
}

function getHostedOpenModelHealthFromError(error: unknown) {
  if (!error || typeof error !== "object" || !("hostedOpenModelHealth" in error)) {
    return null;
  }

  const health = (error as { hostedOpenModelHealth?: unknown }).hostedOpenModelHealth;
  return health && typeof health === "object"
    ? (health as HostedOpenModelHealthCheck)
    : null;
}

function buildHostedOpenModelFailureStatusMessage(error: unknown) {
  const health = getHostedOpenModelHealthFromError(error);

  if (!health) {
    return null;
  }

  if (error instanceof OpenModelRequestTimeoutError) {
    return `Hosted vllm did not respond from ${health.completionRoute} within CLAIMGRAPH_OPEN_MODEL_TIMEOUT_MS=${health.timeoutMs} on attempt ${health.requestAttempt ?? 1} of ${health.requestMaxAttempts ?? 1}, so ClaimGraph kept the most recent safe graph path.`;
  }

  if (error instanceof OpenModelBackendUnavailableError) {
    if (health.catalogStatus === "unreachable") {
      return `Hosted vllm could not reach a healthy /models preflight at ${health.catalogRoute}, so ClaimGraph kept the most recent safe graph path.`;
    }

    if (health.requestStatus === "unreachable" || health.requestStatus === "response_error") {
      return `Hosted vllm did not return a healthy OpenAI-compatible chat completion from ${health.completionRoute}, so ClaimGraph kept the most recent safe graph path.`;
    }
  }

  if (error instanceof OpenModelConfigurationError) {
    if (health.catalogStatus === "auth_rejected" || health.requestStatus === "auth_rejected") {
      return `Hosted vllm rejected the configured OPEN_MODEL_API_KEY during the verified OpenAI-compatible preflight, so ClaimGraph kept the most recent safe graph path.`;
    }

    if (health.catalogStatus === "route_missing" || health.requestStatus === "route_missing") {
      return `Hosted vllm did not expose the verified OpenAI-compatible routes under ${health.apiBaseUrl}, so ClaimGraph kept the most recent safe graph path.`;
    }

    if (health.catalogStatus === "invalid_payload" || health.requestStatus === "invalid_payload") {
      return `Hosted vllm responded at ${health.apiBaseUrl}, but it did not return the verified OpenAI-compatible payload shape ClaimGraph requires, so the workspace stayed on the most recent safe graph path.`;
    }
  }

  if (error instanceof OpenModelModelUnavailableError) {
    return `Hosted vllm responded, but the configured model ${health.model} was not available there, so ClaimGraph kept the most recent safe graph path.`;
  }

  return null;
}

function buildHostedProviderFailureEvent(input: {
  stage: "gathering" | "extracting" | "assembling" | "runtime";
  error: unknown;
}): ProviderFailureEvent | null {
  const health = getHostedOpenModelHealthFromError(input.error);

  if (!health) {
    return null;
  }

  let reason: ProviderFailureEvent["reason"];

  if (input.error instanceof OpenModelRequestTimeoutError) {
    reason = "request_timeout";
  } else if (input.error instanceof OpenModelBackendUnavailableError) {
    reason = "backend_unavailable";
  } else if (input.error instanceof OpenModelModelUnavailableError) {
    reason = "model_unavailable";
  } else if (input.error instanceof OpenModelConfigurationError) {
    reason = "configuration_error";
  } else if (input.error instanceof OpenModelResponseValidationError) {
    reason = "response_validation_failed";
  } else {
    reason = "runner_crash";
  }

  return {
    id: crypto.randomUUID(),
    provider: "open-model",
    backend: health.backend,
    stage: input.stage,
    createdAt: new Date().toISOString(),
    reason,
    message:
      input.error instanceof Error
        ? input.error.message
        : "Hosted open-model failure.",
    cleanupStatus: "not_required",
    cleanupMessage:
      "Hosted vllm failures in this repo do not create persisted remote retrieval artifacts, so no cleanup step was required."
  };
}

function getFailureForStage(
  stage: "gathering" | "extracting" | "assembling"
): {
  fallbackReason: RunFallbackReason;
  statusMessage: string;
} {
  switch (stage) {
    case "assembling":
      return {
        fallbackReason: "assembling_failed",
        statusMessage:
          "Graph assembly failed after evidence gathering and claim extraction. Persisted live evidence and claim inventory remain available while the visible graph falls back to the most recent safe path."
      };
    case "extracting":
      return {
        fallbackReason: "extracting_failed",
        statusMessage:
          "Claim extraction failed after evidence gathering. Persisted live evidence remains available below while the curated starter graph stays visible."
      };
    case "gathering":
      return {
        fallbackReason: "gathering_failed",
        statusMessage:
          "Live analysis failed. Showing the curated starter graph fallback."
      };
  }
}

function buildStaleFailure(run: Run) {
  if (run.status === "queued") {
    return {
      errorMessage:
        "The queued analysis never started before its in-process runner went stale.",
      statusMessage:
        "The queued analysis never started and was marked failed after a reload or process restart. Retry analysis to start a fresh run."
    };
  }

  return {
    errorMessage: `The in-process analysis runner stopped heartbeating during ${run.status}.`,
    statusMessage:
      "This hosted single-instance app runs analysis in process. The previous run stopped updating and was marked failed so the workspace does not pretend work is still progressing."
  };
}

function getStaleReference(run: Run) {
  const execution = run.observability?.execution;
  return execution?.heartbeatAt ??
    execution?.startedAt ??
    execution?.scheduledAt ??
    run.createdAt;
}

function assertRunCanProceed(runId: string, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new AnalysisCanceledError("Analysis canceled while a network request was in flight.");
  }

  const run = getRun(runId);

  if (!run) {
    throw new Error("Run not found.");
  }

  if (!isActiveRunStatus(run.status)) {
    throw new AnalysisCanceledError(
      run.statusMessage ?? `Analysis stopped because the run is ${run.status}.`
    );
  }
}

function transitionLocalRunOrStop(input: {
  runId: string;
  expectedStatuses: Run["status"][];
  nextStatus: Run["status"];
  statusMessage?: string;
  fallbackReason?: RunFallbackReason;
  errorMessage?: string;
  operation: string;
}) {
  const invalidStatus = input.expectedStatuses.find(
    (status) => !isAllowedRunTransition(status, input.nextStatus)
  );

  if (invalidStatus) {
    throw new Error(
      `Invalid run transition ${invalidStatus} -> ${input.nextStatus} during ${input.operation}.`
    );
  }

  const result = transitionRunStatus(input.runId, {
    expectedStatuses: input.expectedStatuses,
    nextStatus: input.nextStatus,
    statusMessage: input.statusMessage,
    fallbackReason: input.fallbackReason,
    errorMessage: input.errorMessage
  });

  if (!result.applied) {
    throw new AnalysisCanceledError(
      result.run.statusMessage ??
        `Analysis stopped at ${result.run.status} before ${input.operation}.`
    );
  }

  return result.run;
}

function tryTransitionLocalRun(input: {
  runId: string;
  expectedStatuses: Run["status"][];
  nextStatus: Run["status"];
  statusMessage?: string;
  fallbackReason?: RunFallbackReason;
  errorMessage?: string;
}) {
  return transitionRunStatus(input.runId, {
    expectedStatuses: input.expectedStatuses,
    nextStatus: input.nextStatus,
    statusMessage: input.statusMessage,
    fallbackReason: input.fallbackReason,
    errorMessage: input.errorMessage
  });
}

async function executeRun(runId: string, signal: AbortSignal) {
  const run = getRun(runId);

  if (!run) {
    return;
  }

  const workspace = getWorkspace(run.workspaceId);

  if (!workspace) {
    tryTransitionLocalRun({
      runId,
      expectedStatuses: [...ACTIVE_RUN_STATUSES],
      nextStatus: "failed",
      errorMessage: "Workspace not found.",
      statusMessage: "The workspace could not be loaded for analysis.",
      fallbackReason: "gathering_failed"
    });
    return;
  }

  const starterPayload = getStarterGraphPayload(workspace.id);

  if (!starterPayload) {
    tryTransitionLocalRun({
      runId,
      expectedStatuses: [...ACTIVE_RUN_STATUSES],
      nextStatus: "failed",
      errorMessage: "Workspace not found.",
      statusMessage: "The workspace starter graph could not be loaded.",
      fallbackReason: "gathering_failed"
    });
    return;
  }

  assertRunCanProceed(runId, signal);
  const runtimeConfig = getClaimGraphRuntimeConfig();

  if (runtimeConfig.mode === "full" && !process.env.OPENAI_API_KEY) {
    transitionLocalRunOrStop({
      runId: run.id,
      expectedStatuses: ["queued"],
      nextStatus: "completed",
      fallbackReason: "openai_api_key_missing",
      statusMessage:
        "OPENAI_API_KEY is missing. Skipping new live analysis and keeping the most recent safe graph path.",
      operation: "completing a run without a premium API key"
    });

    return;
  }

  const providerResolution = resolveClaimGraphProvider();

  if (!providerResolution.provider) {
    if (providerResolution.runtime.mode === "demo") {
      transitionLocalRunOrStop({
        runId: run.id,
        expectedStatuses: ["queued"],
        nextStatus: "completed",
        statusMessage:
          "ClaimGraph is running in demo mode. The workspace stayed on the curated starter path and did not attempt live analysis.",
        operation: "completing a demo-mode run"
      });
      return;
    }

    const unavailableMessage =
      providerResolution.unavailableReason ??
      "Live provider configuration is unavailable.";
    transitionLocalRunOrStop({
      runId: run.id,
      expectedStatuses: ["queued"],
      nextStatus: "failed",
      errorMessage: unavailableMessage,
      fallbackReason:
        providerResolution.runtime.mode === "open-model"
          ? providerResolution.unavailableFallbackReason ?? "open_model_unavailable"
          : "gathering_failed",
      statusMessage:
        providerResolution.unavailableReason ??
        "The configured live provider is unavailable. ClaimGraph kept the most recent safe graph path.",
      operation: "failing an unavailable provider run"
    });
    return;
  }

  let analysisStage: "gathering" | "extracting" | "assembling" = "gathering";

  try {
    const workspaceFiles = getWorkspaceFiles(workspace.id);

    analysisStage = "gathering";
    transitionLocalRunOrStop({
      runId: run.id,
      expectedStatuses: ["queued"],
      nextStatus: "gathering",
      statusMessage: runtimeConfig.mode === "open-model"
        ? "Gathering deterministic evidence from the provided URLs and uploaded files."
        : workspaceFiles.length
          ? "Gathering evidence with OpenAI web search and file search."
          : "Gathering evidence with OpenAI web search.",
      operation: "starting local evidence gathering"
    });
    assertRunCanProceed(runId, signal);

    const evidence = await withProviderLease({
      runId: run.id,
      execute: () => providerResolution.provider!.gatherEvidence({
        workspace,
        files: workspaceFiles,
        runId: run.id,
        signal
      })
    });
    assertRunCanProceed(runId, signal);
    if (evidence.hostedOpenModelHealth) {
      recordRunHostedOpenModelHealth(run.id, evidence.hostedOpenModelHealth);
    }
    recordRunStageModel(run.id, "gathering", evidence.model);

    const savedEvidence = saveEvidencePack({
      runId: run.id,
      createdAt: new Date().toISOString(),
      model: evidence.model,
      responseId: evidence.responseId,
      vectorStoreId: evidence.vectorStoreId,
      evidencePack: evidence.evidencePack
    });

    if (evidence.groundingStatus === "insufficient_grounding") {
      assertRunCanProceed(runId, signal);

      transitionLocalRunOrStop({
        runId: run.id,
        expectedStatuses: ["gathering"],
        nextStatus: "insufficient_evidence",
        statusMessage:
          "The run preserved open questions and warnings, but not enough grounded snippets to build a trustworthy live graph. ClaimGraph kept the most recent safe graph path instead of fabricating one.",
        fallbackReason: "insufficient_grounding",
        operation: "marking local evidence insufficient"
      });

      return;
    }

    analysisStage = "extracting";
    transitionLocalRunOrStop({
      runId: run.id,
      expectedStatuses: ["gathering"],
      nextStatus: "extracting",
      statusMessage:
        "Extracting atomic claims, counterclaims, contradictions, and gaps from the saved evidence pack.",
      operation: "starting local claim extraction"
    });
    assertRunCanProceed(runId, signal);

    const claimInventory = await withProviderLease({
      runId: run.id,
      execute: () => providerResolution.provider!.extractClaims({
        workspace,
        evidencePack: savedEvidence.evidencePack,
        signal
      })
    });
    assertRunCanProceed(runId, signal);
    if (claimInventory.hostedOpenModelHealth) {
      recordRunHostedOpenModelHealth(run.id, claimInventory.hostedOpenModelHealth);
    }
    recordRunStageModel(run.id, "extracting", claimInventory.model);

    saveClaimInventory({
      runId: run.id,
      createdAt: new Date().toISOString(),
      model: claimInventory.model,
      responseId: claimInventory.responseId,
      claimInventory: claimInventory.claimInventory
    });

    analysisStage = "assembling";
    transitionLocalRunOrStop({
      runId: run.id,
      expectedStatuses: ["extracting"],
      nextStatus: "assembling",
      statusMessage:
        "Assembling a schema-valid live ClaimGraph from the saved claim inventory.",
      operation: "starting local graph assembly"
    });
    assertRunCanProceed(runId, signal);

    const assembledGraph = await withProviderLease({
      runId: run.id,
      execute: () => providerResolution.provider!.assembleGraph({
        workspace,
        claimInventory: claimInventory.claimInventory,
        evidencePack: savedEvidence.evidencePack,
        signal
      })
    });
    assertRunCanProceed(runId, signal);
    if (assembledGraph.hostedOpenModelHealth) {
      recordRunHostedOpenModelHealth(run.id, assembledGraph.hostedOpenModelHealth);
    }
    recordRunStageModel(run.id, "assembling", assembledGraph.model);

    assertRunCanProceed(runId, signal);
    const completion = completeRunWithGraph(
      run.id,
      workspace.id,
      {
        origin: "live",
        mode: providerResolution.runtime.mode,
        provider: providerResolution.provider.id,
        backend: providerResolution.provider.backend,
        createdAt: new Date().toISOString(),
        model: assembledGraph.model,
        responseId: assembledGraph.responseId,
        runId: run.id,
        graph: assembledGraph.graph,
        sources: savedEvidence.evidencePack.sources,
        snippets: savedEvidence.evidencePack.snippets
      },
      {
        expectedStatuses: ["assembling"],
        statusMessage:
          "Live evidence, claim inventory, and graph assembly completed. The visible graph is assembled from the saved claim inventory."
      }
    );

    if (!completion.applied) {
      throw new AnalysisCanceledError(
        completion.run.statusMessage ??
          `Analysis stopped at ${completion.run.status} before graph completion.`
      );
    }
  } catch (error) {
    if (isAbortError(error) || getRun(runId)?.status === "canceled") {
      tryTransitionLocalRun({
        runId,
        expectedStatuses: [...ACTIVE_RUN_STATUSES],
        nextStatus: "canceled",
        statusMessage:
          "Analysis canceled. The workspace remains on the most recent safe graph path and any orphaned retrieval artifacts are cleaned up on a best-effort basis.",
        fallbackReason: "analysis_canceled"
      });
      return;
    }

    const hostedOpenModelHealth = getHostedOpenModelHealthFromError(error);

    if (hostedOpenModelHealth) {
      recordRunHostedOpenModelHealth(run.id, hostedOpenModelHealth);
    }

    const providerFailureEvent = buildHostedProviderFailureEvent({
      stage: analysisStage,
      error
    });

    if (providerFailureEvent) {
      recordRunProviderFailureEvent(run.id, providerFailureEvent);
    }

    if (
      runtimeConfig.mode === "open-model" &&
      (error instanceof OpenModelBackendUnavailableError ||
        error instanceof OpenModelRequestTimeoutError)
    ) {
      tryTransitionLocalRun({
        runId: run.id,
        expectedStatuses: [analysisStage],
        nextStatus: "failed",
        errorMessage: error.message,
        fallbackReason: "open_model_unavailable",
        statusMessage:
          buildHostedOpenModelFailureStatusMessage(error) ??
          "Open-model mode could not reach a responsive configured backend within the configured limits, so ClaimGraph kept the most recent safe graph path."
      });
      return;
    }

    if (
      runtimeConfig.mode === "open-model" &&
      (error instanceof OpenModelConfigurationError ||
        error instanceof OpenModelModelUnavailableError)
    ) {
      tryTransitionLocalRun({
        runId: run.id,
        expectedStatuses: [analysisStage],
        nextStatus: "failed",
        errorMessage: error.message,
        fallbackReason: "open_model_misconfigured",
        statusMessage:
          buildHostedOpenModelFailureStatusMessage(error) ??
          "Open-model mode is configured, but the selected backend or model is not ready for this repo configuration, so ClaimGraph kept the most recent safe graph path."
      });
      return;
    }

    const failure = getFailureForStage(analysisStage);

    tryTransitionLocalRun({
      runId: run.id,
      expectedStatuses: [analysisStage],
      nextStatus: "failed",
      errorMessage:
        error instanceof Error ? error.message : "Live analysis failed.",
      ...failure
    });
  }
}

function ensureRunScheduled(runId: string) {
  const activeRuns = getActiveRuns();

  if (activeRuns.has(runId)) {
    return false;
  }

  const run = getRun(runId);

  if (!run || run.status !== "queued") {
    return false;
  }

  const staleAfterMs = run.observability?.execution?.staleAfterMs ?? getRunStaleAfterMs();
  const runnerId = getRunnerId();
  const controller = new AbortController();

  markRunExecutionStarted(runId, {
    ownerId: runnerId,
    staleAfterMs
  });

  const heartbeatHandle = setInterval(() => {
    try {
      heartbeatRunExecution(runId, { staleAfterMs });
    } catch {
      clearInterval(heartbeatHandle);
      activeRuns.delete(runId);
    }
  }, getRunHeartbeatMs(staleAfterMs));

  const task = executeRun(runId, controller.signal)
    .catch((error) => {
      if (isAbortError(error) || getRun(runId)?.status === "canceled") {
        tryTransitionLocalRun({
          runId,
          expectedStatuses: [...ACTIVE_RUN_STATUSES],
          nextStatus: "canceled",
          statusMessage:
            "Analysis canceled. The workspace remains on the most recent safe graph path and any orphaned retrieval artifacts are cleaned up on a best-effort basis.",
          fallbackReason: "analysis_canceled"
        });
        return;
      }

      const providerFailureEvent = buildHostedProviderFailureEvent({
        stage: "runtime",
        error
      });

      if (providerFailureEvent) {
        recordRunProviderFailureEvent(runId, providerFailureEvent);
      }

      const message =
        error instanceof Error ? error.message : "The detached analysis runner crashed.";
      tryTransitionLocalRun({
        runId,
        expectedStatuses: [...ACTIVE_RUN_STATUSES],
        nextStatus: "failed",
        errorMessage: message,
        fallbackReason: "gathering_failed",
        statusMessage:
          "The in-process analysis runner crashed before the run could finish. Retry analysis to start a fresh run."
      });
    })
    .finally(() => {
      clearInterval(heartbeatHandle);
      activeRuns.delete(runId);
    });

  activeRuns.set(runId, {
    heartbeatHandle,
    controller,
    task
  });

  return true;
}

export function reconcileRunForRead(runId: string) {
  const run = getRun(runId);

  if (!run || !isActiveRunStatus(run.status)) {
    return run;
  }

  if (getActiveRuns().has(run.id)) {
    return run;
  }

  const staleAfterMs = run.observability?.execution?.staleAfterMs ?? getRunStaleAfterMs();
  const referenceAt = getStaleReference(run);
  const ageMs = Date.now() - new Date(referenceAt).getTime();

  if (ageMs < staleAfterMs) {
    return run;
  }

  const failure = buildStaleFailure(run);

  return tryTransitionLocalRun({
    runId: run.id,
    expectedStatuses: [run.status],
    nextStatus: "failed",
    errorMessage: failure.errorMessage,
    statusMessage: failure.statusMessage,
    fallbackReason: "analysis_stale"
  }).run;
}

export function reconcileActiveRunsInStore() {
  const runs = listRunsByStatuses([
    "queued",
    "ingesting",
    "gathering",
    "extracting",
    "assembling"
  ]);

  return runs.map((run) => reconcileRunForRead(run.id) ?? run);
}

export function ensureAnalysisRuntimeBootstrapped() {
  if (globalThis.__claimgraphAnalysisRuntimeBootstrapped) {
    return;
  }

  globalThis.__claimgraphAnalysisRuntimeBootstrapped = true;
  reconcileActiveRunsInStore();

  const handle = setInterval(() => {
    reconcileActiveRunsInStore();
  }, getRunReconcileIntervalMs());
  handle.unref?.();
  globalThis.__claimgraphStaleRunReconcilerHandle = handle;
}

export function reconcileLatestWorkspaceRunForRead(workspaceId: string) {
  const run = getLatestRunForWorkspace(workspaceId);

  if (!run) {
    return null;
  }

  return reconcileRunForRead(run.id);
}

export function scheduleWorkspaceAnalysis(workspaceId: string) {
  ensureAnalysisRuntimeBootstrapped();
  const existingRun = reconcileLatestWorkspaceRunForRead(workspaceId);

  if (existingRun && isActiveRunStatus(existingRun.status)) {
    if (existingRun.status === "queued") {
      ensureRunScheduled(existingRun.id);
    }

    return {
      run: getRun(existingRun.id) ?? existingRun,
      created: false
    };
  }

  const run = createRun(workspaceId, {
    staleAfterMs: getRunStaleAfterMs()
  });
  ensureRunScheduled(run.id);

  return {
    run: getRun(run.id) ?? run,
    created: true
  };
}

export function cancelAnalysisRun(runId: string) {
  const run = getRun(runId);

  if (!run) {
    throw new Error("Run not found.");
  }

  if (!isActiveRunStatus(run.status)) {
    return run;
  }

  const activeHandle = getActiveRuns().get(runId);

  if (activeHandle) {
    clearInterval(activeHandle.heartbeatHandle);
    activeHandle.controller.abort("ClaimGraph run canceled by the user.");
  }

  return tryTransitionLocalRun({
    runId,
    expectedStatuses: [...ACTIVE_RUN_STATUSES],
    nextStatus: "canceled",
    statusMessage:
      run.status === "queued"
        ? "Queued analysis canceled before it started. The workspace remains on the most recent safe graph path."
        : "Analysis canceled. The workspace remains on the most recent safe graph path and any orphaned retrieval artifacts are cleaned up on a best-effort basis.",
    fallbackReason: "analysis_canceled"
  }).run;
}

export function resetAnalysisRunnerForTests() {
  for (const handle of getActiveRuns().values()) {
    clearInterval(handle.heartbeatHandle);
    handle.controller.abort("ClaimGraph test reset.");
  }

  getActiveRuns().clear();
  clearInterval(globalThis.__claimgraphStaleRunReconcilerHandle);
  globalThis.__claimgraphStaleRunReconcilerHandle = undefined;
  globalThis.__claimgraphAnalysisRuntimeBootstrapped = undefined;
  globalThis.__claimgraphAnalysisRunnerId = undefined;
}
