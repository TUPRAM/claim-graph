import { getOpenAIClient } from "@/lib/openai/client";
import {
  deleteWorkspaceUploadFile,
  deleteWorkspaceUploadsDir,
  removeWorkspaceUploadsDirIfEmpty
} from "@/lib/server/runtime-data";
import {
  getLatestEvidencePack,
  getWorkspace,
  getWorkspaceFile,
  getWorkspaceFiles,
  getWorkspaceRetrievalState,
  recordRunRetrievalCleanupEvent,
  removeWorkspaceFileIfNoActiveRun,
  saveWorkspaceRetrievalState,
  type WorkspaceRetrievalState
} from "@/lib/server/store";
import type {
  RetrievalArtifactRecord,
  RetrievalCleanupEvent,
  RetrievalCleanupReason,
  RetrievalCleanupSummary,
  Workspace,
  WorkspaceFile
} from "@/types/claimgraph";

function nowIso() {
  return new Date().toISOString();
}

export class WorkspaceFileMutationConflictError extends Error {
  constructor(readonly activeRunId: string) {
    super("Cancel the active analysis run before deleting workspace files.");
    this.name = "WorkspaceFileMutationConflictError";
  }
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

function artifactKey(input: {
  kind: RetrievalCleanupEvent["kind"] | RetrievalArtifactRecord["kind"];
  remoteId: string;
}) {
  return `${input.kind}:${input.remoteId}`;
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

function createCleanupEvent(input: {
  kind: RetrievalCleanupEvent["kind"];
  remoteId: string;
  vectorStoreId?: string;
  workspaceFileId?: string;
  runId?: string;
  reason: RetrievalCleanupReason;
  createdAt?: string;
}) {
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    remoteId: input.remoteId,
    vectorStoreId: input.vectorStoreId,
    workspaceFileId: input.workspaceFileId,
    runId: input.runId,
    reason: input.reason,
    status: "pending" as const,
    createdAt: input.createdAt ?? nowIso()
  } satisfies RetrievalCleanupEvent;
}

function updateCleanupEvent(
  event: RetrievalCleanupEvent,
  input: {
    status: RetrievalCleanupEvent["status"];
    errorMessage?: string;
  }
) {
  const attemptedAt = nowIso();

  return {
    ...event,
    status: input.status,
    attemptedAt,
    completedAt:
      input.status === "deleted" || input.status === "skipped" ? attemptedAt : undefined,
    errorMessage: input.errorMessage
  } satisfies RetrievalCleanupEvent;
}

function summarizeCleanupEvents(events: RetrievalCleanupEvent[]): RetrievalCleanupSummary {
  return {
    attemptedCount: events.length,
    deletedCount: events.filter((event) => event.status === "deleted").length,
    skippedCount: events.filter((event) => event.status === "skipped").length,
    failedCount: events.filter((event) => event.status === "delete_failed").length,
    pendingCount: events.filter((event) => event.status === "pending").length,
    events
  };
}

function dedupeCleanupEvents(events: RetrievalCleanupEvent[]) {
  const deduped = new Map<string, RetrievalCleanupEvent>();

  for (const event of events) {
    deduped.set(artifactKey(event), event);
  }

  return [...deduped.values()];
}

function sortCleanupEvents(events: RetrievalCleanupEvent[]) {
  const priority: Record<RetrievalCleanupEvent["kind"], number> = {
    vector_store_file: 0,
    openai_file: 1,
    vector_store: 2
  };

  return [...events].sort(
    (left, right) => priority[left.kind] - priority[right.kind]
  );
}

async function attemptCleanupEvents(events: RetrievalCleanupEvent[]) {
  if (!events.length) {
    return events;
  }

  if (!process.env.OPENAI_API_KEY) {
    return events.map((event) => ({
      ...event,
      errorMessage:
        "OPENAI_API_KEY is missing, so known remote retrieval artifacts could not be deleted."
    }));
  }

  const client = getOpenAIClient();
  const attemptedEvents: RetrievalCleanupEvent[] = [];

  for (const event of sortCleanupEvents(events)) {
    try {
      switch (event.kind) {
        case "openai_file":
          await client.files.delete(event.remoteId);
          attemptedEvents.push(updateCleanupEvent(event, { status: "deleted" }));
          break;
        case "vector_store_file":
          if (!event.vectorStoreId) {
            attemptedEvents.push(
              updateCleanupEvent(event, {
                status: "skipped",
                errorMessage: "Missing vector_store_id for vector-store file cleanup."
              })
            );
            break;
          }

          await client.vectorStores.files.delete(event.remoteId, {
            vector_store_id: event.vectorStoreId
          });
          attemptedEvents.push(updateCleanupEvent(event, { status: "deleted" }));
          break;
        case "vector_store":
          await client.vectorStores.delete(event.remoteId);
          attemptedEvents.push(updateCleanupEvent(event, { status: "deleted" }));
          break;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        attemptedEvents.push(
          updateCleanupEvent(event, {
            status: "skipped",
            errorMessage: "Remote retrieval artifact was already missing."
          })
        );
      } else {
        attemptedEvents.push(
          updateCleanupEvent(event, {
            status: "delete_failed",
            errorMessage: error instanceof Error ? error.message : "Cleanup failed."
          })
        );
      }
    }
  }

  return attemptedEvents;
}

function createBindingCleanupEvents(
  state: WorkspaceRetrievalState,
  binding: WorkspaceRetrievalState["fileBindings"][number],
  reason: RetrievalCleanupReason
) {
  return dedupeCleanupEvents([
    createCleanupEvent({
      kind: "vector_store_file",
      remoteId: binding.vectorStoreFileId,
      vectorStoreId: state.vectorStoreId,
      workspaceFileId: binding.workspaceFileId,
      reason
    }),
    createCleanupEvent({
      kind: "openai_file",
      remoteId: binding.openAIFileId,
      workspaceFileId: binding.workspaceFileId,
      reason
    })
  ]);
}

function createArtifactCleanupEvent(
  artifact: RetrievalArtifactRecord,
  reason: RetrievalCleanupReason
) {
  return createCleanupEvent({
    kind: artifact.kind,
    remoteId: artifact.remoteId,
    vectorStoreId: artifact.vectorStoreId,
    workspaceFileId: artifact.workspaceFileId,
    runId: artifact.runId,
    reason,
    createdAt: artifact.createdAt
  });
}

function appendCleanupResults(
  state: WorkspaceRetrievalState,
  events: RetrievalCleanupEvent[]
) {
  const pendingCleanup = [...(state.pendingCleanup ?? [])];
  const cleanupHistory = [...(state.cleanupHistory ?? [])];

  for (const event of events) {
    if (event.status === "deleted" || event.status === "skipped") {
      cleanupHistory.push(event);
      continue;
    }

    const existingIndex = pendingCleanup.findIndex(
      (pendingEvent) => artifactKey(pendingEvent) === artifactKey(event)
    );

    if (existingIndex >= 0) {
      pendingCleanup[existingIndex] = event;
    } else {
      pendingCleanup.push(event);
    }
  }

  return {
    ...state,
    pendingCleanup,
    cleanupHistory
  } satisfies WorkspaceRetrievalState;
}

function removeRelatedPendingCleanup(
  state: WorkspaceRetrievalState,
  workspaceFileId: string
) {
  return {
    ...state,
    pendingCleanup: (state.pendingCleanup ?? []).filter(
      (event) => event.workspaceFileId !== workspaceFileId
    )
  } satisfies WorkspaceRetrievalState;
}

export async function deleteWorkspaceFileRetentionSafe(input: {
  workspaceId: string;
  fileId: string;
}) {
  const workspace = getWorkspace(input.workspaceId);

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const file = getWorkspaceFile(input.workspaceId, input.fileId);

  if (!file) {
    throw new Error("Workspace file not found.");
  }

  let retrievalState = normalizeRetrievalState(
    input.workspaceId,
    getWorkspaceRetrievalState(input.workspaceId)
  );

  const matchingBinding = retrievalState.fileBindings.find(
    (binding) => binding.workspaceFileId === input.fileId
  );
  const matchingTransientArtifacts = (retrievalState.transientArtifacts ?? []).filter(
    (artifact) => artifact.workspaceFileId === input.fileId
  );
  const matchingPendingCleanup = (retrievalState.pendingCleanup ?? []).filter(
    (event) => event.workspaceFileId === input.fileId
  );
  const invalidatedLiveArtifacts =
    Boolean(matchingBinding) ||
    matchingTransientArtifacts.length > 0 ||
    matchingPendingCleanup.length > 0;

  let cleanupEvents = [...matchingPendingCleanup];

  if (matchingBinding) {
    cleanupEvents.push(
      ...createBindingCleanupEvents(retrievalState, matchingBinding, "file_deleted")
    );
  }

  cleanupEvents.push(
    ...matchingTransientArtifacts.map((artifact) =>
      createArtifactCleanupEvent(artifact, "file_deleted")
    )
  );
  cleanupEvents = dedupeCleanupEvents(cleanupEvents);

  const nextBindings = retrievalState.fileBindings.filter(
    (binding) => binding.workspaceFileId !== input.fileId
  );
  const nextTransientArtifacts = (retrievalState.transientArtifacts ?? []).filter(
    (artifact) => artifact.workspaceFileId !== input.fileId
  );

  retrievalState = removeRelatedPendingCleanup(retrievalState, input.fileId);
  retrievalState = {
    ...retrievalState,
    fileBindings: nextBindings,
    transientArtifacts: nextTransientArtifacts
  };

  const shouldDeleteVectorStore =
    Boolean(retrievalState.vectorStoreId) &&
    nextBindings.length === 0 &&
    nextTransientArtifacts.length === 0;

  if (shouldDeleteVectorStore && retrievalState.vectorStoreId) {
    cleanupEvents.push(
      createCleanupEvent({
        kind: "vector_store",
        remoteId: retrievalState.vectorStoreId,
        reason: "file_deleted"
      })
    );
  }

  const removal = removeWorkspaceFileIfNoActiveRun(
    input.workspaceId,
    input.fileId,
    {
      invalidateArtifacts: invalidatedLiveArtifacts,
      statusMessage: invalidatedLiveArtifacts
        ? `Workspace file "${file.originalName}" was deleted. Previous live analysis artifacts were cleared because they may have depended on that file. Run analysis again to rebuild from the remaining inputs.`
        : undefined,
      cleanupEvents: dedupeCleanupEvents(cleanupEvents)
    }
  );

  if (!removal.applied) {
    throw new WorkspaceFileMutationConflictError(removal.activeRun.id);
  }

  const attemptedCleanupEvents = await attemptCleanupEvents(
    dedupeCleanupEvents(cleanupEvents)
  );

  if (removal.invalidationRunId) {
    for (const event of attemptedCleanupEvents) {
      recordRunRetrievalCleanupEvent(removal.invalidationRunId, event);
    }
  }
  retrievalState = appendCleanupResults(retrievalState, attemptedCleanupEvents);

  if (
    shouldDeleteVectorStore &&
    attemptedCleanupEvents.some(
      (event) =>
        event.kind === "vector_store" &&
        (event.status === "deleted" ||
          event.status === "skipped" ||
          event.status === "pending" ||
          event.status === "delete_failed")
    )
  ) {
    retrievalState.vectorStoreId = undefined;
  }

  saveWorkspaceRetrievalState(retrievalState);
  const localFileDeleted = deleteWorkspaceUploadFile(input.workspaceId, file.storedName);
  removeWorkspaceUploadsDirIfEmpty(input.workspaceId);

  return {
    workspace,
    file,
    files: removal.files,
    localFileDeleted,
    invalidatedLiveArtifacts,
    cleanup: summarizeCleanupEvents(attemptedCleanupEvents)
  };
}

function buildWorkspaceDeletionCleanupEvents(input: {
  workspace: Workspace;
  files: WorkspaceFile[];
  retrievalState: WorkspaceRetrievalState;
}) {
  const events: RetrievalCleanupEvent[] = [...(input.retrievalState.pendingCleanup ?? [])];
  const knownKeys = new Set(events.map((event) => artifactKey(event)));

  for (const binding of input.retrievalState.fileBindings) {
    for (const event of createBindingCleanupEvents(
      input.retrievalState,
      binding,
      "workspace_deleted"
    )) {
      const key = artifactKey(event);

      if (!knownKeys.has(key)) {
        knownKeys.add(key);
        events.push(event);
      }
    }
  }

  for (const artifact of input.retrievalState.transientArtifacts ?? []) {
    const event = createArtifactCleanupEvent(artifact, "workspace_deleted");
    const key = artifactKey(event);

    if (!knownKeys.has(key)) {
      knownKeys.add(key);
      events.push(event);
    }
  }

  const evidencePack = getLatestEvidencePack(input.workspace.id);

  if (input.retrievalState.vectorStoreId) {
    const event = createCleanupEvent({
      kind: "vector_store",
      remoteId: input.retrievalState.vectorStoreId,
      reason: "workspace_deleted"
    });
    const key = artifactKey(event);

    if (!knownKeys.has(key)) {
      knownKeys.add(key);
      events.push(event);
    }
  } else if (evidencePack?.vectorStoreId) {
    const event = createCleanupEvent({
      kind: "vector_store",
      remoteId: evidencePack.vectorStoreId,
      reason: "workspace_deleted"
    });
    const key = artifactKey(event);

    if (!knownKeys.has(key)) {
      knownKeys.add(key);
      events.push(event);
    }
  }

  return dedupeCleanupEvents(events);
}

export function prepareWorkspaceDeletionRetention(workspaceId: string) {
  const workspace = getWorkspace(workspaceId);

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const files = getWorkspaceFiles(workspaceId);
  const retrievalState = normalizeRetrievalState(
    workspaceId,
    getWorkspaceRetrievalState(workspaceId)
  );
  const cleanupEvents = buildWorkspaceDeletionCleanupEvents({
    workspace,
    files,
    retrievalState
  });

  return {
    workspace,
    files,
    cleanupEvents
  };
}

export async function cleanupDeletedWorkspaceRetention(input: {
  workspace: Workspace;
  files: WorkspaceFile[];
  cleanupEvents: RetrievalCleanupEvent[];
}) {
  const attemptedCleanupEvents = await attemptCleanupEvents(
    input.cleanupEvents
  );

  let deletedLocalFilesCount = 0;

  for (const file of input.files) {
    if (deleteWorkspaceUploadFile(input.workspace.id, file.storedName)) {
      deletedLocalFilesCount += 1;
    }
  }

  deleteWorkspaceUploadsDir(input.workspace.id);

  return {
    workspace: input.workspace,
    deletedLocalFilesCount,
    totalFiles: input.files.length,
    cleanup: summarizeCleanupEvents(attemptedCleanupEvents)
  };
}
