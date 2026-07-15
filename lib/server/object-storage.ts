import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  deleteWorkspaceExportFile,
  deleteWorkspaceUploadFile,
  getWorkspaceExportFilePath,
  getWorkspaceUploadFilePath
} from "@/lib/server/runtime-data";
import { getClaimGraphStorageDriver } from "@/lib/server/storage/config";
import type { WorkspaceFile } from "@/types/claimgraph";

export type ClaimGraphObjectStorageProvider = "local" | "vercel_blob";

export interface PersistedWorkspaceObject {
  storageProvider: ClaimGraphObjectStorageProvider;
  key: string;
  sizeBytes: number;
  contentType: string;
}

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim();
}

function shouldUseBlobStorage() {
  return getClaimGraphStorageDriver() === "hosted";
}

function requireBlobToken() {
  const token = getBlobToken();

  if (!token) {
    throw new Error(
      "Hosted object storage requires BLOB_READ_WRITE_TOKEN for Vercel Blob."
    );
  }

  return token;
}

function normalizeObjectPathSegment(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "artifact";
}

function isBlobNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if ("name" in error && String(error.name) === "BlobNotFoundError") {
    return true;
  }

  return error instanceof Error && /not found/i.test(error.message);
}

function sourceObjectKey(input: {
  workspaceId: string;
  fileId: string;
  extension: string;
}) {
  const extension = normalizeObjectPathSegment(input.extension);

  return `workspaces/${input.workspaceId}/sources/${input.fileId}.${extension}`;
}

function exportObjectKey(input: {
  workspaceId: string;
  format: "markdown" | "png";
}) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  const extension = input.format === "markdown" ? "md" : "png";

  return `workspaces/${input.workspaceId}/exports/${timestamp}-${crypto.randomUUID()}.${extension}`;
}

async function readBlobToBuffer(pathname: string) {
  const { get } = await import("@vercel/blob");
  const result = await get(pathname, {
    access: "private",
    token: requireBlobToken(),
    useCache: false
  });

  if (!result || result.statusCode !== 200 || !result.stream) {
    return null;
  }

  const reader = result.stream.getReader();
  const chunks: Buffer[] = [];

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

export function getObjectStorageSummary() {
  const provider: ClaimGraphObjectStorageProvider =
    process.env.CLAIMGRAPH_STORAGE_DRIVER?.trim().toLowerCase() === "hosted"
      ? "vercel_blob"
      : "local";
  const blobConfigured = Boolean(getBlobToken());

  return {
    provider,
    blobConfigured,
    ready: provider === "local" || blobConfigured,
    requiredInHostedMode: provider === "vercel_blob"
  };
}

export async function persistWorkspaceFileObject(input: {
  workspaceId: string;
  fileId: string;
  extension: string;
  mimeType: string;
  buffer: Buffer;
}) {
  if (shouldUseBlobStorage()) {
    const { put } = await import("@vercel/blob");
    const key = sourceObjectKey(input);
    const result = await put(key, input.buffer, {
      access: "private",
      allowOverwrite: false,
      contentType: input.mimeType,
      token: requireBlobToken()
    });

    return {
      storageProvider: "vercel_blob",
      key: result.pathname,
      sizeBytes: input.buffer.byteLength,
      contentType: result.contentType ?? input.mimeType
    } satisfies PersistedWorkspaceObject;
  }

  const storedName = `${input.fileId}.${normalizeObjectPathSegment(input.extension)}`;
  const filePath = getWorkspaceUploadFilePath(input.workspaceId, storedName);

  writeFileSync(filePath, input.buffer);

  return {
    storageProvider: "local",
    key: storedName,
    sizeBytes: input.buffer.byteLength,
    contentType: input.mimeType
  } satisfies PersistedWorkspaceObject;
}

export async function readWorkspaceFileObject(file: WorkspaceFile) {
  if (file.storageProvider === "vercel_blob" || file.blobKey) {
    return readBlobToBuffer(file.blobKey ?? file.storedName);
  }

  const filePath = getWorkspaceUploadFilePath(file.workspaceId, file.storedName);

  if (!existsSync(filePath)) {
    return null;
  }

  return readFileSync(filePath);
}

export async function deleteWorkspaceFileObject(file: WorkspaceFile) {
  if (file.storageProvider === "vercel_blob" || file.blobKey) {
    const { del } = await import("@vercel/blob");
    const key = file.blobKey ?? file.storedName;

    try {
      await del(key, {
        token: requireBlobToken()
      });
    } catch (error) {
      if (!isBlobNotFoundError(error)) {
        throw error;
      }
    }

    return {
      deleted: true,
      storageProvider: "vercel_blob" as const,
      key
    };
  }

  return {
    deleted: deleteWorkspaceUploadFile(file.workspaceId, file.storedName),
    storageProvider: "local" as const,
    key: file.storedName
  };
}

export async function deleteHostedWorkspaceObjectPrefix(workspaceId: string) {
  if (!shouldUseBlobStorage()) {
    return {
      attemptedCount: 0,
      deletedCount: 0,
      prefix: null
    };
  }

  const { del, list } = await import("@vercel/blob");
  const prefix = `workspaces/${workspaceId}/`;
  const token = requireBlobToken();
  let cursor: string | undefined;
  let attemptedCount = 0;
  let deletedCount = 0;

  do {
    const page = await list({
      prefix,
      cursor,
      token
    });
    const pathnames = page.blobs.map((blob) => blob.pathname);

    attemptedCount += pathnames.length;

    if (pathnames.length) {
      await del(pathnames, { token });
      deletedCount += pathnames.length;
    }

    cursor = page.cursor;
  } while (cursor);

  return {
    attemptedCount,
    deletedCount,
    prefix
  };
}

export async function deletePersistedWorkspaceObject(input: {
  workspaceId: string;
  storageProvider: ClaimGraphObjectStorageProvider;
  key: string;
  kind: "source" | "export";
}) {
  if (input.storageProvider === "vercel_blob") {
    const { del } = await import("@vercel/blob");

    try {
      await del(input.key, { token: requireBlobToken() });
    } catch (error) {
      if (!isBlobNotFoundError(error)) {
        throw error;
      }
    }

    return true;
  }

  return input.kind === "source"
    ? deleteWorkspaceUploadFile(input.workspaceId, input.key)
    : deleteWorkspaceExportFile(input.workspaceId, input.key);
}

export async function persistWorkspaceExportArtifact(input: {
  workspaceId: string;
  format: "markdown" | "png";
  contentType: string;
  body: Buffer | string;
}) {
  const bodyBuffer = Buffer.isBuffer(input.body)
    ? input.body
    : Buffer.from(input.body, "utf8");

  if (shouldUseBlobStorage()) {
    const { put } = await import("@vercel/blob");
    const key = exportObjectKey(input);
    const result = await put(key, bodyBuffer, {
      access: "private",
      allowOverwrite: false,
      contentType: input.contentType,
      token: requireBlobToken()
    });

    return {
      storageProvider: "vercel_blob",
      key: result.pathname,
      sizeBytes: bodyBuffer.byteLength,
      contentType: result.contentType ?? input.contentType
    } satisfies PersistedWorkspaceObject;
  }

  const key = path.basename(exportObjectKey(input));
  const filePath = getWorkspaceExportFilePath(input.workspaceId, key);

  writeFileSync(filePath, bodyBuffer);

  return {
    storageProvider: "local",
    key,
    sizeBytes: bodyBuffer.byteLength,
    contentType: input.contentType
  } satisfies PersistedWorkspaceObject;
}
