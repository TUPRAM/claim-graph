import { NextResponse } from "next/server";
import { deleteHostedWorkspaceObjectPrefix } from "@/lib/server/object-storage";
import {
  cleanupDeletedWorkspaceRetention,
  prepareWorkspaceDeletionRetention
} from "@/lib/server/workspace-retention";
import { sanitizeCleanupSummaryForPublic } from "@/lib/server/public-workspace-payload";
import {
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";
import {
  clearWorkspaceWriteCapabilityCookie,
  requireWorkspaceMutation
} from "@/lib/server/workspace-capability";
import { throwIfStagingRehearsalFault } from "@/lib/server/staging-rehearsal";

async function getWorkspaceId(
  context: { params: Promise<{ workspaceId: string }> }
) {
  return (await context.params).workspaceId;
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

  const hosted = isHostedClaimGraphStoreSelected();
  const localRetention = hosted
    ? null
    : prepareWorkspaceDeletionRetention(workspaceId);
  const deletion = await store.deleteWorkspaceIfNoActiveRun(workspaceId);

  if (!deletion.applied && deletion.reason === "active_run") {
    return NextResponse.json(
      {
        error: "Cancel the active analysis run before deleting this workspace."
      },
      { status: 409 }
    );
  }

  if (!deletion.applied) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  if (hosted) {
    try {
      await throwIfStagingRehearsalFault("fail_next_blob_deletion");
      const objectCleanup = await deleteHostedWorkspaceObjectPrefix(workspaceId);
      await throwIfStagingRehearsalFault(
        "fail_next_db_cleanup_finalization"
      );
      await store.deleteWorkspace(workspaceId);

      return clearWorkspaceWriteCapabilityCookie(NextResponse.json({
        deleted: true,
        workspaceId: deletion.workspace.id,
        question: deletion.workspace.question,
        deletedLocalFilesCount: 0,
        totalFiles: objectCleanup.attemptedCount,
        deletedObjectCount: objectCleanup.deletedCount,
        cleanup: {
          attemptedCount: objectCleanup.attemptedCount,
          deletedCount: objectCleanup.deletedCount,
          skippedCount: 0,
          failedCount: 0,
          pendingCount: 0,
          events: []
        }
      }), workspaceId);
    } catch {
      return clearWorkspaceWriteCapabilityCookie(NextResponse.json(
        {
          deleted: true,
          pendingDeletion: true,
          workspaceId,
          question: deletion.workspace.question,
          cleanupJobId: deletion.cleanupJobId ?? null,
          error:
            "Workspace access is deleted. Durable Blob or database cleanup is still pending."
        },
        { status: 202 }
      ), workspaceId);
    }
  }

  if (!localRetention) {
    throw new Error("Local workspace retention snapshot is missing.");
  }

  const result = await cleanupDeletedWorkspaceRetention({
    ...localRetention,
    workspace: deletion.workspace,
    files: deletion.files
  });

  return clearWorkspaceWriteCapabilityCookie(NextResponse.json({
    deleted: true,
    workspaceId: result.workspace.id,
    question: result.workspace.question,
    deletedLocalFilesCount: result.deletedLocalFilesCount,
    totalFiles: result.totalFiles,
    cleanup: sanitizeCleanupSummaryForPublic(result.cleanup)
  }), workspaceId);
}
