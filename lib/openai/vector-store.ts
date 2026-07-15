import { toFile } from "openai";
import { getOpenAIClient } from "@/lib/openai/client";
import { readWorkspaceFileObject } from "@/lib/server/object-storage";
import {
  getRun,
  getWorkspaceRetrievalState,
  recordRunRetrievalCleanupEvent,
  saveWorkspaceRetrievalState,
  type WorkspaceRetrievalState
} from "@/lib/server/store";
import type {
  RetrievalArtifactRecord,
  RetrievalCleanupEvent,
  RetrievalCleanupReason,
  RetrievalCleanupStatus,
  WorkspaceFile
} from "@/types/claimgraph";

function nowIso() {
  return new Date().toISOString();
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isNotFoundError(error: unknown) {
  if (typeof error === "object" && error && "status" in error) {
    return (error as { status?: number }).status === 404;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("404") || message.includes("not found");
  }

  return false;
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function normalizeRetrievalState(
  workspaceId: string,
  state?: WorkspaceRetrievalState | null
): WorkspaceRetrievalState {
  return {
    workspaceId,
    vectorStoreId: state?.vectorStoreId,
    fileBindings: state?.fileBindings ?? [],
    transientArtifacts: state?.transientArtifacts ?? [],
    pendingCleanup: state?.pendingCleanup ?? [],
    cleanupHistory: state?.cleanupHistory ?? []
  };
}

function artifactKey(input: {
  kind: RetrievalArtifactRecord["kind"] | RetrievalCleanupEvent["kind"];
  remoteId: string;
}) {
  return `${input.kind}:${input.remoteId}`;
}

function createArtifactRecord(input: {
  kind: RetrievalArtifactRecord["kind"];
  remoteId: string;
  vectorStoreId?: string;
  workspaceFileId?: string;
  runId?: string;
}) {
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    remoteId: input.remoteId,
    vectorStoreId: input.vectorStoreId,
    workspaceFileId: input.workspaceFileId,
    runId: input.runId,
    createdAt: nowIso()
  } satisfies RetrievalArtifactRecord;
}

function createCleanupEvent(input: {
  kind: RetrievalCleanupEvent["kind"];
  remoteId: string;
  vectorStoreId?: string;
  workspaceFileId?: string;
  runId?: string;
  reason: RetrievalCleanupReason;
  status?: RetrievalCleanupStatus;
  errorMessage?: string;
  attemptedAt?: string;
  completedAt?: string;
}) {
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    remoteId: input.remoteId,
    vectorStoreId: input.vectorStoreId,
    workspaceFileId: input.workspaceFileId,
    runId: input.runId,
    reason: input.reason,
    status: input.status ?? "pending",
    createdAt: nowIso(),
    attemptedAt: input.attemptedAt,
    completedAt: input.completedAt,
    errorMessage: input.errorMessage
  } satisfies RetrievalCleanupEvent;
}

function updateCleanupEvent(
  event: RetrievalCleanupEvent,
  input: {
    status: RetrievalCleanupStatus;
    errorMessage?: string;
  }
) {
  const attemptedAt = nowIso();

  return {
    ...event,
    status: input.status,
    attemptedAt,
    completedAt: input.status === "deleted" || input.status === "skipped" ? attemptedAt : undefined,
    errorMessage: input.errorMessage
  } satisfies RetrievalCleanupEvent;
}

function addTransientArtifacts(
  state: WorkspaceRetrievalState,
  artifacts: RetrievalArtifactRecord[]
) {
  if (!artifacts.length) {
    return state;
  }

  const existingKeys = new Set(
    (state.transientArtifacts ?? []).map((artifact) => artifactKey(artifact))
  );
  const nextArtifacts = artifacts.filter((artifact) => {
    const key = artifactKey(artifact);

    if (existingKeys.has(key)) {
      return false;
    }

    existingKeys.add(key);
    return true;
  });

  if (!nextArtifacts.length) {
    return state;
  }

  return {
    ...state,
    transientArtifacts: [...(state.transientArtifacts ?? []), ...nextArtifacts]
  } satisfies WorkspaceRetrievalState;
}

function removeTransientArtifacts(
  state: WorkspaceRetrievalState,
  artifacts: Array<RetrievalArtifactRecord | undefined>
) {
  const keys = new Set(
    artifacts
      .filter((artifact): artifact is RetrievalArtifactRecord => Boolean(artifact))
      .map((artifact) => artifactKey(artifact))
  );

  if (!keys.size) {
    return state;
  }

  return {
    ...state,
    transientArtifacts: (state.transientArtifacts ?? []).filter(
      (artifact) => !keys.has(artifactKey(artifact))
    )
  } satisfies WorkspaceRetrievalState;
}

function pushPendingCleanup(
  state: WorkspaceRetrievalState,
  events: RetrievalCleanupEvent[]
) {
  const existingKeys = new Set(
    [...(state.pendingCleanup ?? []), ...(state.cleanupHistory ?? [])].map((event) =>
      artifactKey(event)
    )
  );

  const nextEvents = events.filter((event) => {
    const key = artifactKey(event);

    if (existingKeys.has(key)) {
      return false;
    }

    existingKeys.add(key);
    return true;
  });

  if (!nextEvents.length) {
    return state;
  }

  return {
    ...state,
    pendingCleanup: [...(state.pendingCleanup ?? []), ...nextEvents]
  } satisfies WorkspaceRetrievalState;
}

function saveCleanupQueue(input: {
  state: WorkspaceRetrievalState;
  runId?: string;
  events: RetrievalCleanupEvent[];
}) {
  if (!input.events.length) {
    return input.state;
  }

  const savedState = saveWorkspaceRetrievalState(
    pushPendingCleanup(input.state, input.events)
  );

  if (input.runId) {
    for (const event of input.events) {
      recordRunRetrievalCleanupEvent(input.runId, event);
    }
  }

  return savedState;
}

function resolveTransientCleanupReason(artifact: RetrievalArtifactRecord): RetrievalCleanupReason {
  const sourceRun = artifact.runId ? getRun(artifact.runId) : null;

  if (sourceRun?.status === "canceled") {
    return "run_canceled";
  }

  if (sourceRun?.observability?.fallbackReason === "analysis_stale") {
    return "analysis_stale";
  }

  return "superseded";
}

function promoteTransientArtifactsToCleanup(input: {
  state: WorkspaceRetrievalState;
  runId?: string;
  artifacts: RetrievalArtifactRecord[];
  reason?:
    | RetrievalCleanupReason
    | ((artifact: RetrievalArtifactRecord) => RetrievalCleanupReason);
}) {
  if (!input.artifacts.length) {
    return input.state;
  }

  const nextState = removeTransientArtifacts(input.state, input.artifacts);
  const events = input.artifacts.map((artifact) =>
    createCleanupEvent({
      kind: artifact.kind,
      remoteId: artifact.remoteId,
      vectorStoreId: artifact.vectorStoreId,
      workspaceFileId: artifact.workspaceFileId,
      runId: artifact.runId,
      reason:
        typeof input.reason === "function"
          ? input.reason(artifact)
          : (input.reason ?? resolveTransientCleanupReason(artifact))
    })
  );

  return saveCleanupQueue({
    state: nextState,
    runId: input.runId,
    events
  });
}

async function sleepWithAbort(delayMs: number, signal?: AbortSignal) {
  abortIfNeeded(signal);

  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    function handleAbort() {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", handleAbort);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function waitForFileProcessing(input: {
  fileId: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}) {
  const client = getOpenAIClient();
  const pollIntervalMs = input.pollIntervalMs ?? 1000;
  const maxWaitMs = input.maxWaitMs ?? 10 * 60 * 1000;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= maxWaitMs) {
    abortIfNeeded(input.signal);

    const file = await client.files.retrieve(input.fileId, {
      signal: input.signal
    });

    if (file.status === "processed") {
      return file;
    }

    if (file.status === "error") {
      throw new Error(`OpenAI file processing failed for ${file.filename}.`);
    }

    await sleepWithAbort(pollIntervalMs, input.signal);
  }

  throw new Error(`Timed out waiting for OpenAI file ${input.fileId} to finish processing.`);
}

async function flushPendingRetrievalCleanup(input: {
  workspaceId: string;
  runId?: string;
}) {
  const state = normalizeRetrievalState(
    input.workspaceId,
    getWorkspaceRetrievalState(input.workspaceId)
  );

  if (!state.pendingCleanup?.length) {
    return state;
  }

  const client = getOpenAIClient();
  const nextPending: RetrievalCleanupEvent[] = [];
  const cleanupHistory = [...(state.cleanupHistory ?? [])];

  for (const event of state.pendingCleanup) {
    let updatedEvent: RetrievalCleanupEvent;

    try {
      switch (event.kind) {
        case "openai_file":
          await client.files.delete(event.remoteId);
          updatedEvent = updateCleanupEvent(event, { status: "deleted" });
          break;
        case "vector_store_file":
          if (!event.vectorStoreId) {
            updatedEvent = updateCleanupEvent(event, {
              status: "skipped",
              errorMessage: "Missing vector_store_id for vector-store file cleanup."
            });
            break;
          }

          await client.vectorStores.files.delete(event.remoteId, {
            vector_store_id: event.vectorStoreId
          });
          updatedEvent = updateCleanupEvent(event, { status: "deleted" });
          break;
        case "vector_store":
          await client.vectorStores.delete(event.remoteId);
          updatedEvent = updateCleanupEvent(event, { status: "deleted" });
          break;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        updatedEvent = updateCleanupEvent(event, {
          status: "skipped",
          errorMessage: "Remote retrieval artifact was already missing."
        });
      } else {
        updatedEvent = updateCleanupEvent(event, {
          status: "delete_failed",
          errorMessage: error instanceof Error ? error.message : "Cleanup failed."
        });
      }
    }

    if (updatedEvent.status === "delete_failed") {
      nextPending.push(updatedEvent);
    } else {
      cleanupHistory.push(updatedEvent);
    }

    if (input.runId) {
      recordRunRetrievalCleanupEvent(input.runId, updatedEvent);
    }
  }

  const nextState: WorkspaceRetrievalState = {
    ...state,
    pendingCleanup: nextPending,
    cleanupHistory
  };

  if (
    nextState.vectorStoreId &&
    cleanupHistory.some(
      (event) =>
        event.kind === "vector_store" &&
        event.remoteId === nextState.vectorStoreId &&
        (event.status === "deleted" || event.status === "skipped")
    )
  ) {
    nextState.vectorStoreId = undefined;
  }

  return saveWorkspaceRetrievalState(nextState);
}

export async function ensureWorkspaceVectorStore(input: {
  workspaceId: string;
  runId?: string;
  files: WorkspaceFile[];
  signal?: AbortSignal;
}): Promise<WorkspaceRetrievalState | null> {
  if (!input.files.length) {
    return null;
  }

  abortIfNeeded(input.signal);
  const client = getOpenAIClient();
  let retrievalState = normalizeRetrievalState(
    input.workspaceId,
    getWorkspaceRetrievalState(input.workspaceId)
  );

  retrievalState = promoteTransientArtifactsToCleanup({
    state: retrievalState,
    runId: input.runId,
    artifacts: retrievalState.transientArtifacts ?? []
  });
  retrievalState = await flushPendingRetrievalCleanup({
    workspaceId: input.workspaceId,
    runId: input.runId
  });

  let createdVectorStoreId: string | undefined;

  if (!retrievalState.vectorStoreId) {
    const vectorStore = await client.vectorStores.create(
      {
        name: `claimgraph-${input.workspaceId}`
      },
      {
        signal: input.signal
      }
    );

    createdVectorStoreId = vectorStore.id;
    retrievalState = saveWorkspaceRetrievalState({
      ...retrievalState,
      vectorStoreId: vectorStore.id
    });
  }

  for (const file of input.files) {
    abortIfNeeded(input.signal);
    const alreadySynced = retrievalState.fileBindings.some(
      (binding) => binding.workspaceFileId === file.id
    );

    if (alreadySynced) {
      continue;
    }

    const uploadBuffer = await readWorkspaceFileObject(file);

    if (!uploadBuffer) {
      throw new Error(`Uploaded file is missing from workspace storage: ${file.originalName}.`);
    }

    let openAIArtifact: RetrievalArtifactRecord | undefined;
    let vectorStoreArtifact: RetrievalArtifactRecord | undefined;

    try {
      const openAIFile = await client.files.create(
        {
          file: await toFile(uploadBuffer, file.originalName, {
            type: file.mimeType
          }),
          purpose: "user_data"
        },
        {
          signal: input.signal
        }
      );

      openAIArtifact = createArtifactRecord({
        kind: "openai_file",
        remoteId: openAIFile.id,
        workspaceFileId: file.id,
        runId: input.runId
      });
      retrievalState = saveWorkspaceRetrievalState(
        addTransientArtifacts(retrievalState, [openAIArtifact])
      );

      await waitForFileProcessing({
        fileId: openAIFile.id,
        signal: input.signal,
        pollIntervalMs: 1000,
        maxWaitMs: 10 * 60 * 1000
      });

      abortIfNeeded(input.signal);

      const vectorStoreFile = await client.vectorStores.files.create(
        retrievalState.vectorStoreId!,
        {
          file_id: openAIFile.id,
          attributes: {
            workspace_file_id: file.id,
            original_name: file.originalName
          }
        },
        {
          signal: input.signal
        }
      );

      vectorStoreArtifact = createArtifactRecord({
        kind: "vector_store_file",
        remoteId: vectorStoreFile.id,
        vectorStoreId: retrievalState.vectorStoreId,
        workspaceFileId: file.id,
        runId: input.runId
      });
      retrievalState = saveWorkspaceRetrievalState(
        addTransientArtifacts(retrievalState, [vectorStoreArtifact])
      );

      const processedVectorStoreFile = await client.vectorStores.files.poll(
        retrievalState.vectorStoreId!,
        vectorStoreFile.id,
        {
          signal: input.signal,
          pollIntervalMs: 1000
        }
      );

      abortIfNeeded(input.signal);

      if (processedVectorStoreFile.status !== "completed") {
        throw new Error(
          processedVectorStoreFile.last_error?.message ??
            `Vector store indexing did not complete for ${file.originalName}.`
        );
      }

      retrievalState = saveWorkspaceRetrievalState(
        removeTransientArtifacts(
          {
            ...retrievalState,
            fileBindings: [
              ...retrievalState.fileBindings,
              {
                workspaceFileId: file.id,
                openAIFileId: openAIFile.id,
                vectorStoreFileId: processedVectorStoreFile.id,
                syncedAt: nowIso()
              }
            ]
          },
          [openAIArtifact, vectorStoreArtifact]
        )
      );
    } catch (error) {
      const cleanupReason: RetrievalCleanupReason =
        isAbortError(error) ? "run_canceled" : "sync_failed";

      retrievalState = promoteTransientArtifactsToCleanup({
        state: retrievalState,
        runId: input.runId,
        artifacts: [openAIArtifact, vectorStoreArtifact].filter(
          (artifact): artifact is RetrievalArtifactRecord => Boolean(artifact)
        ),
        reason: cleanupReason
      });

      const cleanupEvents: RetrievalCleanupEvent[] = [];

      if (
        createdVectorStoreId &&
        retrievalState.vectorStoreId === createdVectorStoreId &&
        retrievalState.fileBindings.length === 0
      ) {
        cleanupEvents.push(
          createCleanupEvent({
            kind: "vector_store",
            remoteId: createdVectorStoreId,
            runId: input.runId,
            reason: cleanupReason
          })
        );

        retrievalState = saveWorkspaceRetrievalState({
          ...retrievalState,
          vectorStoreId: undefined
        });
      }

      retrievalState = saveCleanupQueue({
        state: retrievalState,
        runId: input.runId,
        events: cleanupEvents
      });
      await flushPendingRetrievalCleanup({
        workspaceId: input.workspaceId,
        runId: input.runId
      });

      throw error;
    }
  }

  return retrievalState;
}
