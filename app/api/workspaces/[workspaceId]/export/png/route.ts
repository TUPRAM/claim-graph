import { NextResponse } from "next/server";
import {
  ExportObservabilityRequestError,
  MAX_PNG_DATA_URL_CHARS,
  MAX_PNG_EXPORT_BYTES,
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
import { tryRecordOperationalEvent } from "@/lib/server/operational-events";
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

export function pngDataUrlToBuffer(
  value: string,
  maxBytes = MAX_PNG_EXPORT_BYTES
) {
  const prefix = "data:image/png;base64,";

  if (!value.startsWith(prefix) || value.length > MAX_PNG_DATA_URL_CHARS) {
    throw new ExportObservabilityRequestError("Invalid PNG export payload.");
  }

  const encoded = value.slice(prefix.length);

  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new ExportObservabilityRequestError("Invalid PNG export encoding.");
  }

  const buffer = Buffer.from(encoded, "base64");

  if (buffer.byteLength > maxBytes) {
    throw new ExportObservabilityRequestError(
      `PNG export exceeds the ${maxBytes} byte limit.`,
      413
    );
  }

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new ExportObservabilityRequestError(
      "PNG export payload does not contain a valid PNG signature."
    );
  }

  return buffer;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const workspaceId = await getWorkspaceId(context);
  const store = await getClaimGraphStore();
  const payload = await store.getWorkspaceGraphPayload(workspaceId);

  if (!payload) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    return NextResponse.json({
      mode: "client_capture",
      details:
        "PNG export is captured in the browser from the currently visible graph viewport, preserving the current focus mode and node filters.",
      workspaceId,
      starterMode: payload.starterMode
    });
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
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    throw error;
  }

  if (!observabilityRequest) {
    return NextResponse.json(
      { error: "Invalid PNG export request." },
      { status: 400 }
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  const requestFingerprint = JSON.stringify({
    workspaceId,
    graphRunId: payload.graphRun?.id ?? null,
    observabilityRequest
  });
  const idempotencyControl =
    idempotencyKey && /^[A-Za-z0-9._:-]{8,200}$/u.test(idempotencyKey)
      ? { key: idempotencyKey, requestFingerprint }
      : null;

  if (idempotencyControl) {
    const started = await beginIdempotentOperation({
      scope: "workspace-export-png",
      ...idempotencyControl
    });

    if (started.kind === "replay") {
      return NextResponse.json(started.response, {
        status: started.responseStatus,
        headers: { "Idempotency-Replayed": "true" }
      });
    }

    if (started.kind === "conflict" || started.kind === "in_flight") {
      return NextResponse.json(
        {
          error: started.kind === "conflict"
            ? "This idempotency key was already used for another export."
            : "This export is still in progress."
        },
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
  const policy = getPublicBetaPolicy();
  const globalExportLimit = await consumePublicBetaRateLimit({
    scope: "workspace-export-global",
    subject: "global-workspace-export",
    limit: policy.export.globalLimit,
    windowMs: policy.export.globalWindowMs
  });

  if (!globalExportLimit.allowed) {
    if (idempotencyControl) {
      await releaseIdempotentOperation({
        scope: "workspace-export-png",
        ...idempotencyControl
      });
    }
    return NextResponse.json(
      { error: "Public-beta export capacity is full. Try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(globalExportLimit.retryAfterSeconds) }
      }
    );
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
        scope: "workspace-export-png",
        ...idempotencyControl
      });
    }
    return NextResponse.json(
      { error: "This workspace has reached its export limit. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(exportLimit.retryAfterSeconds),
          "X-RateLimit-Limit": String(exportLimit.limit),
          "X-RateLimit-Remaining": String(exportLimit.remaining),
          "X-RateLimit-Reset": exportLimit.resetAt
        }
      }
    );
  }

  let artifact = null;
  const maxPayloadBytes = Math.min(
    MAX_PNG_EXPORT_BYTES,
    policy.export.maxPayloadBytes
  );

  try {
    artifact =
      observabilityRequest.success !== false && observabilityRequest.pngDataUrl
        ? await persistWorkspaceExportArtifact({
            workspaceId,
            format: "png",
            contentType: "image/png",
            body: pngDataUrlToBuffer(
              observabilityRequest.pngDataUrl,
              maxPayloadBytes
            )
          })
        : null;
  } catch (error) {
    if (error instanceof ExportObservabilityRequestError) {
      if (idempotencyControl) {
        await releaseIdempotentOperation({
          scope: "workspace-export-png",
          ...idempotencyControl
        });
      }
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (idempotencyControl) {
      await releaseIdempotentOperation({
        scope: "workspace-export-png",
        ...idempotencyControl
      });
    }
    throw error;
  }

  try {
    if (artifact) {
      await scheduleExportRetention({
        workspaceId,
        storageProvider: artifact.storageProvider,
        objectKey: artifact.key
      });
    }

    await store.recordWorkspaceExportEvent({
      workspaceId,
      format: "png",
      mode: "client_capture",
      success: observabilityRequest.success ?? true,
      starterMode: payload.starterMode,
      strongestOnly: observabilityRequest.strongestOnly,
      unresolvedOnly: observabilityRequest.unresolvedOnly,
      hiddenKinds: observabilityRequest.hiddenKinds,
      focusClusterId: observabilityRequest.focusClusterId,
      selectedNodeId: observabilityRequest.selectedNodeId,
      savedReviewStateId: observabilityRequest.savedReviewStateId,
      savedReviewStateLabel: observabilityRequest.savedReviewStateLabel,
      reviewBranchFilter: observabilityRequest.reviewBranchFilter,
      reviewSourceFilterId: observabilityRequest.reviewSourceFilterId,
      reviewSourceFilterLabel: observabilityRequest.reviewSourceFilterLabel,
      viewportWidth: observabilityRequest.viewport?.width,
      viewportHeight: observabilityRequest.viewport?.height,
      errorMessage: observabilityRequest.errorMessage,
      artifactStorageProvider: artifact?.storageProvider,
      artifactKey: artifact?.key,
      artifactSizeBytes: artifact?.sizeBytes,
      artifactContentType: artifact?.contentType
    });
    await tryRecordOperationalEvent({
      eventType: observabilityRequest.success === false
        ? "export-failed"
        : "export-completed",
      value: artifact?.sizeBytes ?? 0
    });
  } catch (error) {
    if (artifact) {
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
            reason: "png_export_database_persistence_failed"
          });
        } catch (enqueueError) {
          throw new AggregateError(
            [error, cleanupError, enqueueError],
            "Failed to record the PNG export, roll it back, or queue durable cleanup."
          );
        }
      }
    }

    if (idempotencyControl) {
      await releaseIdempotentOperation({
        scope: "workspace-export-png",
        ...idempotencyControl
      });
    }
    throw error;
  }

  const responsePayload = {
    ok: true,
    mode: "client_capture",
    details: observabilityRequest.success === false
      ? "PNG export failure was logged for this run."
      : "PNG export usage was logged for this run.",
    workspaceId,
    starterMode: payload.starterMode
  };

  if (idempotencyControl) {
    await completeIdempotentOperation({
      scope: "workspace-export-png",
      ...idempotencyControl,
      responseStatus: 200,
      response: responsePayload
    });
  }

  return NextResponse.json(responsePayload);
}
