import { NextResponse } from "next/server";
import { reconcileLatestWorkspaceRunForRead } from "@/lib/server/analyze-runner";
import {
  FileUploadError,
  cleanupPersistedWorkspaceFiles,
  collectFilesFromFormData,
  persistWorkspaceFiles,
  readBoundedMultipartFormData,
  scheduleWorkspaceFileRetention,
  validateWorkspaceUpload
} from "@/lib/server/workspace-files";
import {
  deleteWorkspaceFileRetentionSafe,
  WorkspaceFileMutationConflictError
} from "@/lib/server/workspace-retention";
import { deleteWorkspaceFileObject } from "@/lib/server/object-storage";
import {
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";
import { requireWorkspaceMutation } from "@/lib/server/workspace-capability";
import {
  sanitizeCleanupSummaryForPublic,
  sanitizeWorkspaceFileForPublic
} from "@/lib/server/public-workspace-payload";
import { MAX_MULTIPART_UPLOAD_SIZE_BYTES } from "@/lib/files/policy";
import {
  BoundedRequestBodyError,
  readBoundedJsonBody
} from "@/lib/server/bounded-request-body";
import {
  consumePublicBetaRateLimit
} from "@/lib/server/public-beta-control-store";
import { getPublicBetaPolicy } from "@/lib/server/public-beta-policy";
import {
  completeScheduledCleanupJob,
  enqueueUploadDeletion
} from "@/lib/server/retention-cleanup";
import {
  HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE,
  isHostedFullModeFileIntakeBlocked
} from "@/lib/server/provider-file-retention";

async function getWorkspaceId(
  context: { params: Promise<{ workspaceId: string }> }
) {
  return (await context.params).workspaceId;
}

async function hasActiveRun(workspaceId: string) {
  if (isHostedClaimGraphStoreSelected()) {
    const store = await getClaimGraphStore();
    const run = await store.getLatestRunForWorkspace(workspaceId);

    return run?.status === "queued" ||
      run?.status === "ingesting" ||
      run?.status === "gathering" ||
      run?.status === "extracting" ||
      run?.status === "assembling";
  }

  const run = reconcileLatestWorkspaceRunForRead(workspaceId);

  return run?.status === "queued" ||
    run?.status === "ingesting" ||
    run?.status === "gathering" ||
    run?.status === "extracting" ||
    run?.status === "assembling";
}

async function enforceWorkspaceFileBudget(input: {
  workspaceId: string;
  request: Request;
  includeUploadBytes: boolean;
}) {
  const policy = getPublicBetaPolicy();
  const globalMutation = await consumePublicBetaRateLimit({
    scope: "workspace-file-mutation-global",
    subject: "global-workspace-file-mutation",
    limit: policy.workspaceFiles.globalMutationLimit,
    windowMs: policy.workspaceFiles.globalMutationWindowMs
  });

  if (!globalMutation.allowed) {
    return NextResponse.json(
      { error: "Public-beta file-mutation capacity is full." },
      {
        status: 429,
        headers: { "Retry-After": String(globalMutation.retryAfterSeconds) }
      }
    );
  }

  const mutation = await consumePublicBetaRateLimit({
    scope: "workspace-file-mutation",
    subject: input.workspaceId,
    limit: policy.workspaceFiles.mutationLimit,
    windowMs: policy.workspaceFiles.mutationWindowMs
  });

  if (!mutation.allowed) {
    return NextResponse.json(
      { error: "This workspace has reached its file-mutation limit." },
      { status: 429, headers: { "Retry-After": String(mutation.retryAfterSeconds) } }
    );
  }

  if (!input.includeUploadBytes) {
    return null;
  }

  const contentLength = Number.parseInt(
    input.request.headers.get("content-length") ?? "",
    10
  );
  const chargedBytes = Number.isFinite(contentLength) && contentLength > 0
    ? Math.min(contentLength, MAX_MULTIPART_UPLOAD_SIZE_BYTES)
    : MAX_MULTIPART_UPLOAD_SIZE_BYTES;
  const byteBudget = await consumePublicBetaRateLimit({
    scope: "workspace-upload-bytes",
    subject: input.workspaceId,
    limit: policy.workspaceFiles.uploadedByteLimit,
    windowMs: policy.workspaceFiles.uploadedByteWindowMs,
    amount: chargedBytes
  });

  if (!byteBudget.allowed) {
    return NextResponse.json(
      { error: "This workspace has reached its uploaded-byte budget." },
      { status: 429, headers: { "Retry-After": String(byteBudget.retryAfterSeconds) } }
    );
  }

  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const workspaceId = await getWorkspaceId(context);
  const store = await getClaimGraphStore();
  const workspace = await store.getWorkspace(workspaceId);

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  if (workspace.id === "demo") {
    return NextResponse.json(
      { error: "The demo workspace is read-only." },
      { status: 400 }
    );
  }

  const unauthorized = await requireWorkspaceMutation(
    request,
    workspaceId,
    store
  );

  if (unauthorized) {
    return unauthorized;
  }

  if (isHostedFullModeFileIntakeBlocked()) {
    return NextResponse.json(
      { error: HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE },
      { status: 503 }
    );
  }

  if (await hasActiveRun(workspaceId)) {
    return NextResponse.json(
      {
        error: "Cancel the active analysis run before changing workspace files."
      },
      { status: 409 }
    );
  }

  const budgetRejection = await enforceWorkspaceFileBudget({
    workspaceId,
    request,
    includeUploadBytes: true
  });

  if (budgetRejection) {
    return budgetRejection;
  }

  let formData: FormData;

  try {
    formData = await readBoundedMultipartFormData(request);
  } catch (error) {
    if (error instanceof FileUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  try {
    const files = collectFilesFromFormData(formData);
    const existingFiles = await store.getWorkspaceFiles(workspaceId);

    const preparedFiles = await validateWorkspaceUpload(files, {
      existingFileCount: existingFiles.length,
      maxFiles: workspace.settings.maxFiles,
      requireFiles: true
    });

    const persistedFiles = await persistWorkspaceFiles({
      workspaceId,
      files,
      preparedFiles
    });
    let nextFiles;

    try {
      const mutation = await store.addWorkspaceFilesIfNoActiveRun(
        workspaceId,
        persistedFiles
      );

      if (!mutation.applied) {
        await cleanupPersistedWorkspaceFiles(persistedFiles);
        return NextResponse.json(
          {
            error: "Cancel the active analysis run before changing workspace files."
          },
          { status: 409 }
        );
      }

      nextFiles = mutation.files;
    } catch (error) {
      await cleanupPersistedWorkspaceFiles(persistedFiles);
      throw error;
    }

    try {
      await scheduleWorkspaceFileRetention(persistedFiles);
    } catch (error) {
      try {
        await Promise.all(
          persistedFiles.map((file) =>
            enqueueUploadDeletion({
              workspaceId,
              fileId: file.id,
              storageProvider:
                file.storageProvider ?? (file.blobKey ? "vercel_blob" : "local"),
              objectKey: file.blobKey ?? file.storedName,
              reason: "upload_retention_schedule_failed_after_database_persistence"
            })
          )
        );
      } catch (enqueueError) {
        try {
          for (const file of persistedFiles) {
            const rollback = await store.removeWorkspaceFileIfNoActiveRun(
              workspaceId,
              file.id
            );

            if (!rollback.applied) {
              throw new Error(
                `Upload rollback was blocked by active run ${rollback.activeRun.id}.`
              );
            }
          }
          await cleanupPersistedWorkspaceFiles(persistedFiles);
          await store.recordWorkspaceArtifactsInvalidated(workspaceId, {
            statusMessage:
              "Uploaded files were rolled back because retention could not be scheduled."
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, enqueueError, rollbackError],
            "Upload retention, durable cleanup, and immediate rollback all failed."
          );
        }
      }
      throw error;
    }

    return NextResponse.json({
      files: nextFiles.map(sanitizeWorkspaceFileForPublic),
      starterMode: true
    });
  } catch (error) {
    if (error instanceof FileUploadError) {
      return NextResponse.json(
        {
          error: error.message
        },
        { status: error.status }
      );
    }

    throw error;
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const workspaceId = await getWorkspaceId(context);
  const store = await getClaimGraphStore();
  const workspace = await store.getWorkspace(workspaceId);

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  if (workspace.id === "demo") {
    return NextResponse.json(
      { error: "The demo workspace is read-only." },
      { status: 400 }
    );
  }

  const unauthorized = await requireWorkspaceMutation(
    request,
    workspaceId,
    store
  );

  if (unauthorized) {
    return unauthorized;
  }

  if (await hasActiveRun(workspaceId)) {
    return NextResponse.json(
      {
        error: "Cancel the active analysis run before deleting workspace files."
      },
      { status: 409 }
    );
  }

  const budgetRejection = await enforceWorkspaceFileBudget({
    workspaceId,
    request,
    includeUploadBytes: false
  });

  if (budgetRejection) {
    return budgetRejection;
  }

  let payload: { fileId?: string } | null = null;

  try {
    payload = (await readBoundedJsonBody({
      request,
      maxBytes: 4 * 1024,
      label: "Workspace file deletion request"
    })) as { fileId?: string };
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!payload?.fileId?.trim()) {
    return NextResponse.json({ error: "fileId is required." }, { status: 400 });
  }

  if (isHostedClaimGraphStoreSelected()) {
    try {
      const files = await store.getWorkspaceFiles(workspaceId);
      const file = files.find((candidate) => candidate.id === payload.fileId?.trim());

      if (!file) {
        return NextResponse.json(
          { error: "Workspace file not found." },
          { status: 404 }
        );
      }

      const removal = await store.removeWorkspaceFileIfNoActiveRun(
        workspaceId,
        file.id,
        {
          invalidateArtifacts: true,
          statusMessage: `Workspace file "${file.originalName}" was deleted. Previous live artifacts were cleared because they may have depended on that file.`
        }
      );

      if (!removal.applied) {
        return NextResponse.json(
          {
            error: "Cancel the active analysis run before deleting workspace files."
          },
          { status: 409 }
        );
      }

      let objectDelete;

      try {
        objectDelete = await deleteWorkspaceFileObject(file);
        await completeScheduledCleanupJob(`upload:${file.id}`);
      } catch (error) {
        const cleanupJob = await enqueueUploadDeletion({
          workspaceId,
          fileId: file.id,
          storageProvider:
            file.storageProvider ?? (file.blobKey ? "vercel_blob" : "local"),
          objectKey: file.blobKey ?? file.storedName,
          reason: "owner_file_delete_failed_during_object_or_database_cleanup"
        });

        return NextResponse.json(
          {
            workspaceId,
            fileId: file.id,
            deletedFileName: file.originalName,
            deleted: false,
            pendingDeletion: true,
            cleanupJobId: cleanupJob?.id ?? null,
            error:
              "File deletion is pending durable cleanup. Live artifacts will be invalidated when cleanup completes."
          },
          { status: 202 }
        );
      }

      const nextPayload = await store.getWorkspaceGraphPayload(workspaceId);

      return NextResponse.json({
        workspaceId,
        fileId: file.id,
        deletedFileName: file.originalName,
        files: removal.files.map(sanitizeWorkspaceFileForPublic),
        localFileDeleted: objectDelete.storageProvider === "local" && objectDelete.deleted,
        objectStorageDeleted: objectDelete.deleted,
        objectStorageProvider: objectDelete.storageProvider,
        invalidatedLiveArtifacts: true,
        starterMode: nextPayload?.starterMode ?? true,
        cleanup: {
          attemptedCount: 0,
          deletedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          pendingCount: 0,
          events: []
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Workspace file not found.") {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }

      throw error;
    }
  }

  try {
    const result = await deleteWorkspaceFileRetentionSafe({
      workspaceId,
      fileId: payload.fileId.trim()
    });
    const nextPayload = await store.getWorkspaceGraphPayload(workspaceId);

    return NextResponse.json({
      workspaceId,
      fileId: result.file.id,
      deletedFileName: result.file.originalName,
      files: result.files.map(sanitizeWorkspaceFileForPublic),
      localFileDeleted: result.localFileDeleted,
      invalidatedLiveArtifacts: result.invalidatedLiveArtifacts,
      starterMode: nextPayload?.starterMode ?? true,
      cleanup: sanitizeCleanupSummaryForPublic(result.cleanup)
    });
  } catch (error) {
    if (error instanceof WorkspaceFileMutationConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    if (error instanceof Error && error.message === "Workspace file not found.") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    throw error;
  }
}
