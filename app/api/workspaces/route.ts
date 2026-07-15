import { NextResponse } from "next/server";
import { getClaimGraphRuntimeConfig } from "@/lib/claimgraph/config";
import {
  BoundedRequestBodyError,
  readBoundedJsonBody
} from "@/lib/server/bounded-request-body";
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
  getClaimGraphStore,
  isHostedClaimGraphStoreSelected
} from "@/lib/server/storage/store-factory";
import { deleteHostedWorkspaceObjectPrefix } from "@/lib/server/object-storage";
import {
  deleteWorkspaceExportsDir,
  deleteWorkspaceUploadsDir
} from "@/lib/server/runtime-data";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  consumePublicBetaRateLimit,
  getEffectivePublicBetaControls,
  getPublicClientAddress,
  releaseIdempotentOperation
} from "@/lib/server/public-beta-control-store";
import { getPublicBetaPolicy } from "@/lib/server/public-beta-policy";
import {
  enqueueWorkspaceDeletionCleanup,
  scheduleWorkspaceRetention
} from "@/lib/server/retention-cleanup";
import { workspaceCreateRequestSchema } from "@/lib/validation/schemas";
import {
  attachWorkspaceWriteCapabilityCookie,
  getOrCreateWorkspaceWriteCapability,
  requireWorkspaceCreationOrigin
} from "@/lib/server/workspace-capability";
import {
  HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE,
  isHostedFullModeFileIntakeBlocked
} from "@/lib/server/provider-file-retention";

const MAX_WORKSPACE_CREATE_JSON_BYTES = 64 * 1024;

function invalidWorkspaceResponse(issues: unknown) {
  return NextResponse.json(
    {
      error: "Invalid workspace request.",
      issues
    },
    { status: 400 }
  );
}

function parseSettingsEntry(value: FormDataEntryValue | null) {
  if (value == null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new FileUploadError("Invalid settings payload.");
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new FileUploadError("Invalid settings payload.");
  }
}

function parseSourceUrlsEntry(value: FormDataEntryValue | null) {
  if (value == null || value === "") {
    return [];
  }

  if (typeof value !== "string") {
    throw new FileUploadError("Invalid source URL payload.");
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const parsedFromLines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return parsedFromLines;
  }
}

interface WorkspaceCapabilityInput {
  capability: string;
  writeCapabilityHash: string;
}

interface WorkspaceCreationControl {
  key: string;
  requestFingerprint: string;
}

function getIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();

  return value && /^[A-Za-z0-9._:-]{8,200}$/u.test(value) ? value : null;
}

function isQaWorkspaceRequest(request: Request) {
  return request.headers.get("x-claimgraph-qa-workspace")?.trim() === "1";
}

function rateLimitedResponse(input: {
  error: string;
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
  resetAt: string;
}) {
  return NextResponse.json(
    { error: input.error },
    {
      status: 429,
      headers: {
        "Retry-After": String(input.retryAfterSeconds),
        "X-RateLimit-Limit": String(input.limit),
        "X-RateLimit-Remaining": String(input.remaining),
        "X-RateLimit-Reset": input.resetAt
      }
    }
  );
}

async function prepareWorkspaceCreation(input: {
  request: Request;
  owner: WorkspaceCapabilityInput;
  fingerprint: string;
}): Promise<
  | { response: NextResponse; control: null }
  | { response: null; control: WorkspaceCreationControl | null }
> {
  const key = getIdempotencyKey(input.request);
  let control: WorkspaceCreationControl | null = null;

  if (key) {
    const requestFingerprint = `${input.owner.writeCapabilityHash}:qa=${isQaWorkspaceRequest(input.request)}:${input.fingerprint}`;
    const idempotency = await beginIdempotentOperation({
      scope: "workspace-create",
      key,
      requestFingerprint
    });

    if (idempotency.kind === "replay") {
      const response = idempotency.response as {
        workspaceId?: string;
        starterMode?: boolean;
      };

      if (!response.workspaceId) {
        return {
          response: NextResponse.json(
            { error: "Stored workspace creation response is invalid." },
            { status: 500 }
          ),
          control: null
        };
      }

      await scheduleWorkspaceRetention({
        workspaceId: response.workspaceId,
        qa: isQaWorkspaceRequest(input.request)
      });
      return {
        response: workspaceCreatedResponse(
          response.workspaceId,
          input.owner.capability
        ),
        control: null
      };
    }

    if (idempotency.kind === "conflict") {
      return {
        response: NextResponse.json(
          { error: "This idempotency key was already used for another request." },
          { status: 409 }
        ),
        control: null
      };
    }

    if (idempotency.kind === "in_flight") {
      return {
        response: NextResponse.json(
          { error: "This workspace creation request is still in progress." },
          { status: 409, headers: { "Retry-After": "1" } }
        ),
        control: null
      };
    }

    control = { key, requestFingerprint };
  }

  return { response: null, control };
}

async function finalizeWorkspaceCreation(input: {
  workspaceId: string;
  owner: WorkspaceCapabilityInput;
  control: WorkspaceCreationControl | null;
  qa: boolean;
}) {
  const responsePayload = {
    workspaceId: input.workspaceId,
    starterMode: true
  };

  try {
    await scheduleWorkspaceRetention({
      workspaceId: input.workspaceId,
      qa: input.qa
    });
  } catch (error) {
    try {
      await enqueueWorkspaceDeletionCleanup({
        workspaceId: input.workspaceId,
        reason: "workspace_retention_schedule_failed_after_creation"
      });
    } catch (enqueueError) {
      try {
        const store = await getClaimGraphStore();

        if (isHostedClaimGraphStoreSelected()) {
          await deleteHostedWorkspaceObjectPrefix(input.workspaceId);
        } else {
          deleteWorkspaceUploadsDir(input.workspaceId);
          deleteWorkspaceExportsDir(input.workspaceId);
        }

        await store.deleteWorkspace(input.workspaceId);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, enqueueError, rollbackError],
          "Workspace was created but retention, durable cleanup, and immediate rollback all failed."
        );
      }
    }

    throw error;
  }

  if (input.control) {
    await completeIdempotentOperation({
      scope: "workspace-create",
      ...input.control,
      responseStatus: 200,
      response: responsePayload
    });
  }

  return workspaceCreatedResponse(input.workspaceId, input.owner.capability);
}

async function releaseCreationControl(control: WorkspaceCreationControl | null) {
  if (!control) {
    return;
  }

  await releaseIdempotentOperation({
    scope: "workspace-create",
    ...control
  });
}

function workspaceCreatedResponse(
  workspaceId: string,
  capability: string
) {
  const response = attachWorkspaceWriteCapabilityCookie(
    NextResponse.json({
      workspaceId,
      starterMode: true
    }),
    workspaceId,
    capability
  );
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function handleJsonRequest(
  request: Request,
  owner: WorkspaceCapabilityInput
) {
  let body: unknown;

  try {
    body = await readBoundedJsonBody({
      request,
      maxBytes: MAX_WORKSPACE_CREATE_JSON_BYTES,
      label: "Workspace creation request"
    });
  } catch (error) {
    if (error instanceof BoundedRequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      {
        error: "Invalid JSON."
      },
      { status: 400 }
    );
  }

  const parsed = workspaceCreateRequestSchema.safeParse(body);

  if (!parsed.success) {
    return invalidWorkspaceResponse(parsed.error.flatten());
  }

  const prepared = await prepareWorkspaceCreation({
    request,
    owner,
    fingerprint: JSON.stringify(parsed.data)
  });

  if (prepared.response) {
    return prepared.response;
  }

  try {
    const store = await getClaimGraphStore();
    const workspace = await store.createWorkspace(
      parsed.data.question,
      parsed.data.settings,
      parsed.data.sourceUrls,
      { writeCapabilityHash: owner.writeCapabilityHash }
    );

    return await finalizeWorkspaceCreation({
      workspaceId: workspace.id,
      owner,
      control: prepared.control,
      qa: isQaWorkspaceRequest(request)
    });
  } catch (error) {
    await releaseCreationControl(prepared.control);
    throw error;
  }
}

async function handleMultipartRequest(
  request: Request,
  owner: WorkspaceCapabilityInput
) {
  let formData: FormData;

  try {
    formData = await readBoundedMultipartFormData(request);
  } catch (error) {
    if (error instanceof FileUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      {
        error: "Invalid form data."
      },
      { status: 400 }
    );
  }

  try {
    const parsed = workspaceCreateRequestSchema.safeParse({
      question: formData.get("question"),
      sourceUrls: parseSourceUrlsEntry(formData.get("sourceUrls")),
      settings: parseSettingsEntry(formData.get("settings"))
    });

    if (!parsed.success) {
      return invalidWorkspaceResponse(parsed.error.flatten());
    }

    const files = collectFilesFromFormData(formData);

    if (files.length && isHostedFullModeFileIntakeBlocked()) {
      return NextResponse.json(
        { error: HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE },
        { status: 503 }
      );
    }

    const runtimeDefaults = getClaimGraphRuntimeConfig().defaultWorkspaceSettings;
    const maxFiles = parsed.data.settings?.maxFiles ?? runtimeDefaults.maxFiles;

    const preparedFiles = await validateWorkspaceUpload(files, {
      existingFileCount: 0,
      maxFiles,
      requireFiles: false
    });
    const preparedCreation = await prepareWorkspaceCreation({
      request,
      owner,
      fingerprint: JSON.stringify({
        ...parsed.data,
        files: files.map((file) => ({
          name: file.name,
          size: file.size,
          type: file.type
        }))
      })
    });

    if (preparedCreation.response) {
      return preparedCreation.response;
    }

    try {
      const store = await getClaimGraphStore();
      const workspace = await store.createWorkspace(
        parsed.data.question,
        parsed.data.settings,
        parsed.data.sourceUrls,
        { writeCapabilityHash: owner.writeCapabilityHash }
      );

      if (files.length) {
        const persistedFiles = await persistWorkspaceFiles({
          workspaceId: workspace.id,
          files,
          preparedFiles
        });

        try {
          await store.addWorkspaceFiles(workspace.id, persistedFiles);
        } catch (error) {
          await cleanupPersistedWorkspaceFiles(persistedFiles);
          throw error;
        }

        try {
          await scheduleWorkspaceFileRetention(persistedFiles);
        } catch (error) {
          await enqueueWorkspaceDeletionCleanup({
            workspaceId: workspace.id,
            reason: "workspace_upload_retention_failed_during_creation"
          });
          throw error;
        }
      }

      return await finalizeWorkspaceCreation({
        workspaceId: workspace.id,
        owner,
        control: preparedCreation.control,
        qa: isQaWorkspaceRequest(request)
      });
    } catch (error) {
      await releaseCreationControl(preparedCreation.control);
      throw error;
    }
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

export async function POST(request: Request) {
  const originRejection = requireWorkspaceCreationOrigin(request);

  if (originRejection) {
    return originRejection;
  }

  const controls = await getEffectivePublicBetaControls();
  const policy = getPublicBetaPolicy();
  const globalAttemptLimit = await consumePublicBetaRateLimit({
    scope: "workspace-create-global",
    subject: "global-workspace-create",
    limit: policy.workspaceCreation.globalLimit,
    windowMs: policy.workspaceCreation.globalWindowMs
  });

  if (!globalAttemptLimit.allowed) {
    return rateLimitedResponse({
      error: "Public-beta workspace capacity is full. Try again later.",
      ...globalAttemptLimit
    });
  }

  const attemptLimit = await consumePublicBetaRateLimit({
    scope: "workspace-create",
    subject: getPublicClientAddress(request),
    limit: controls.workspaceCreationLimit,
    windowMs: policy.workspaceCreation.windowMs
  });

  if (!attemptLimit.allowed) {
    return rateLimitedResponse({
      error: "Too many workspace creation attempts came from this network. Try again later.",
      ...attemptLimit
    });
  }

  const owner = getOrCreateWorkspaceWriteCapability(request);
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    return handleMultipartRequest(request, owner);
  }

  return handleJsonRequest(request, owner);
}
