import { createHash } from "node:crypto";
import { buildPublicGraphMarkdown } from "@/lib/server/export-markdown";
import {
  ExportObservabilityRequestError,
  readExportObservabilityRequest
} from "@/lib/server/export-observability";
import {
  deletePersistedWorkspaceObject,
  persistWorkspaceExportArtifact
} from "@/lib/server/object-storage";
import {
  enqueueOrphanObjectCleanup,
  scheduleExportRetention
} from "@/lib/server/retention-cleanup";
import { getPublicBetaPolicy } from "@/lib/server/public-beta-policy";
import { getClaimGraphStore } from "@/lib/server/storage/store-factory";
import { requireWorkspaceMutation } from "@/lib/server/workspace-capability";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  consumePublicBetaRateLimit,
  getEffectivePublicBetaControls,
  releaseIdempotentOperation
} from "@/lib/server/public-beta-control-store";

async function getWorkspaceId(
  context: { params: Promise<{ workspaceId: string }> }
) {
  return (await context.params).workspaceId;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const workspaceId = await getWorkspaceId(context);
  const store = await getClaimGraphStore();
  const payload = await store.getWorkspaceGraphPayload(workspaceId);

  if (!payload) {
    return new Response("Workspace not found.", { status: 404 });
  }

  const unauthorized = await requireWorkspaceMutation(
    request,
    workspaceId,
    store
  );

  if (unauthorized) {
    return unauthorized;
  }

  let observabilityRequest;

  try {
    observabilityRequest = await readExportObservabilityRequest(request);
  } catch (error) {
    if (error instanceof ExportObservabilityRequestError) {
      return new Response(error.message, { status: error.status });
    }

    throw error;
  }

  const policy = getPublicBetaPolicy();
  const markdown = buildPublicGraphMarkdown(payload, {
    strongestOnly: observabilityRequest?.strongestOnly,
    unresolvedOnly: observabilityRequest?.unresolvedOnly,
    hiddenKinds: observabilityRequest?.hiddenKinds,
    focusClusterId: observabilityRequest?.focusClusterId,
    selectedNodeId: observabilityRequest?.selectedNodeId,
    savedReviewStateId: observabilityRequest?.savedReviewStateId,
    savedReviewStateLabel: observabilityRequest?.savedReviewStateLabel,
    reviewBranchFilter: observabilityRequest?.reviewBranchFilter,
    reviewSourceFilterId: observabilityRequest?.reviewSourceFilterId,
    reviewSourceFilterLabel: observabilityRequest?.reviewSourceFilterLabel
  });
  const markdownSizeBytes = Buffer.byteLength(markdown, "utf8");

  if (markdownSizeBytes > policy.export.maxPayloadBytes) {
    return new Response(
      `Markdown export exceeds the ${policy.export.maxPayloadBytes} byte payload limit.`,
      { status: 413 }
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  const requestFingerprint = JSON.stringify({
    workspaceId,
    graphRunId: payload.graphRun?.id ?? null,
    observabilityRequest,
    markdownSha256: createHash("sha256").update(markdown).digest("hex")
  });
  const idempotencyControl =
    idempotencyKey && /^[A-Za-z0-9._:-]{8,200}$/u.test(idempotencyKey)
      ? { key: idempotencyKey, requestFingerprint }
      : null;

  if (idempotencyControl) {
    const started = await beginIdempotentOperation({
      scope: "workspace-export-markdown",
      ...idempotencyControl
    });

    if (started.kind === "replay") {
      return new Response(markdown, {
        status: started.responseStatus,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="claimgraph-${workspaceId}.md"`,
          "Idempotency-Replayed": "true"
        }
      });
    }

    if (started.kind === "conflict" || started.kind === "in_flight") {
      return new Response(
        started.kind === "conflict"
          ? "This idempotency key was already used for another export."
          : "This export is still in progress.",
        {
          status: 409,
          headers: {
            "Retry-After": "1",
            "Idempotency-Status":
              started.kind === "conflict" ? "conflict" : "in-flight"
          }
        }
      );
    }
  }

  const controls = await getEffectivePublicBetaControls();
  const globalExportLimit = await consumePublicBetaRateLimit({
    scope: "workspace-export-global",
    subject: "global-workspace-export",
    limit: policy.export.globalLimit,
    windowMs: policy.export.globalWindowMs
  });

  if (!globalExportLimit.allowed) {
    if (idempotencyControl) {
      await releaseIdempotentOperation({
        scope: "workspace-export-markdown",
        ...idempotencyControl
      });
    }
    return new Response("Public-beta export capacity is full. Try again later.", {
      status: 429,
      headers: { "Retry-After": String(globalExportLimit.retryAfterSeconds) }
    });
  }

  const exportLimit = await consumePublicBetaRateLimit({
    scope: "workspace-export",
    subject: workspaceId,
    limit: controls.exportLimit,
    windowMs: policy.export.windowMs
  });

  if (!exportLimit.allowed) {
    if (idempotencyControl) {
      await releaseIdempotentOperation({
        scope: "workspace-export-markdown",
        ...idempotencyControl
      });
    }
    return new Response("This workspace has reached its export limit. Try again later.", {
      status: 429,
      headers: {
        "Retry-After": String(exportLimit.retryAfterSeconds),
        "X-RateLimit-Limit": String(exportLimit.limit),
        "X-RateLimit-Remaining": String(exportLimit.remaining),
        "X-RateLimit-Reset": exportLimit.resetAt
      }
    });
  }

  let artifact;

  try {
    artifact = await persistWorkspaceExportArtifact({
      workspaceId,
      format: "markdown",
      contentType: "text/markdown; charset=utf-8",
      body: markdown
    });
  } catch (error) {
    if (idempotencyControl) {
      await releaseIdempotentOperation({
        scope: "workspace-export-markdown",
        ...idempotencyControl
      });
    }
    throw error;
  }

  try {
    await scheduleExportRetention({
      workspaceId,
      storageProvider: artifact.storageProvider,
      objectKey: artifact.key
    });
    await store.recordWorkspaceExportEvent({
      workspaceId,
      format: "markdown",
      mode: "server_markdown",
      success: true,
      starterMode: payload.starterMode,
      strongestOnly: observabilityRequest?.strongestOnly,
      unresolvedOnly: observabilityRequest?.unresolvedOnly,
      hiddenKinds: observabilityRequest?.hiddenKinds,
      focusClusterId: observabilityRequest?.focusClusterId,
      selectedNodeId: observabilityRequest?.selectedNodeId,
      savedReviewStateId: observabilityRequest?.savedReviewStateId,
      savedReviewStateLabel: observabilityRequest?.savedReviewStateLabel,
      reviewBranchFilter: observabilityRequest?.reviewBranchFilter,
      reviewSourceFilterId: observabilityRequest?.reviewSourceFilterId,
      reviewSourceFilterLabel: observabilityRequest?.reviewSourceFilterLabel,
      viewportWidth: observabilityRequest?.viewport?.width,
      viewportHeight: observabilityRequest?.viewport?.height,
      artifactStorageProvider: artifact.storageProvider,
      artifactKey: artifact.key,
      artifactSizeBytes: artifact.sizeBytes,
      artifactContentType: artifact.contentType
    });
  } catch (error) {
    try {
      await deletePersistedWorkspaceObject({
        workspaceId,
        storageProvider: artifact.storageProvider,
        key: artifact.key,
        kind: "export"
      });
    } catch (cleanupError) {
      try {
        await enqueueOrphanObjectCleanup({
          workspaceId,
          storageProvider: artifact.storageProvider,
          objectKey: artifact.key,
          objectKind: "export",
          reason: "markdown_export_database_persistence_failed"
        });
      } catch (enqueueError) {
        throw new AggregateError(
          [error, cleanupError, enqueueError],
          "Failed to record the Markdown export, roll it back, or queue durable cleanup."
        );
      }
    }

    if (idempotencyControl) {
      await releaseIdempotentOperation({
        scope: "workspace-export-markdown",
        ...idempotencyControl
      });
    }
    throw error;
  }

  if (idempotencyControl) {
    await completeIdempotentOperation({
      scope: "workspace-export-markdown",
      ...idempotencyControl,
      responseStatus: 200,
      response: {
        format: "markdown",
        artifactKey: artifact.key,
        sizeBytes: artifact.sizeBytes
      }
    });
  }

  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="claimgraph-${workspaceId}.md"`
    }
  });
}
