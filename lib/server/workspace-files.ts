import {
  ALLOWED_UPLOAD_LABEL,
  MAX_MULTIPART_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_FILE_SIZE_BYTES,
  getFileExtension,
  isAllowedUploadExtension,
  type AllowedUploadExtension
} from "@/lib/files/policy";
import {
  deleteWorkspaceFileObject,
  persistWorkspaceFileObject
} from "@/lib/server/object-storage";
import {
  UploadContentValidationError,
  validateUploadBuffer
} from "@/lib/server/upload-validation";
import {
  enqueueOrphanObjectCleanup,
  scheduleUploadRetention
} from "@/lib/server/retention-cleanup";
import type { WorkspaceFile } from "@/types/claimgraph";

export interface PreparedWorkspaceUpload {
  file: File;
  extension: AllowedUploadExtension;
  mimeType: string;
  buffer: Buffer;
}

const CANONICAL_UPLOAD_MIME_TYPES: Record<AllowedUploadExtension, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8"
};

export class FileUploadError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "FileUploadError";
    this.status = status;
  }
}

export function collectFilesFromFormData(formData: FormData, fieldName = "files") {
  const values = formData.getAll(fieldName);
  const files = values.filter((value): value is File => value instanceof File);

  if (files.length !== values.length) {
    throw new FileUploadError("Invalid file payload.");
  }

  return files;
}

export async function readBoundedMultipartFormData(
  request: Request,
  maxBytes = MAX_MULTIPART_UPLOAD_SIZE_BYTES
) {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : NaN;

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new FileUploadError(
      `Multipart request exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB aggregate limit.`,
      413
    );
  }

  if (!request.body) {
    throw new FileUploadError("Invalid form data.");
  }

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let byteCount = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      byteCount += chunk.byteLength;

      if (byteCount > maxBytes) {
        await reader.cancel();
        throw new FileUploadError(
          `Multipart request exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB aggregate limit.`,
          413
        );
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return await new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks, byteCount)
    }).formData();
  } catch {
    throw new FileUploadError("Invalid form data.");
  }
}

function validateUploadFileMetadata(file: File) {
  const extension = getFileExtension(file.name);

  if (!isAllowedUploadExtension(extension)) {
    throw new FileUploadError(
      `Unsupported file type for "${file.name}". Allowed types: ${ALLOWED_UPLOAD_LABEL}.`
    );
  }

  if (file.size <= 0) {
    throw new FileUploadError(`"${file.name}" is empty.`);
  }

  if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw new FileUploadError(
      `"${file.name}" exceeds the ${Math.round(MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024))} MB upload limit.`
    );
  }
}

async function prepareUploadFile(file: File): Promise<PreparedWorkspaceUpload> {
  validateUploadFileMetadata(file);
  const extension = getFileExtension(file.name);

  if (!isAllowedUploadExtension(extension)) {
    throw new FileUploadError(`Unsupported file type for "${file.name}".`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    validateUploadBuffer({
      extension,
      fileName: file.name,
      buffer
    });
  } catch (error) {
    if (error instanceof UploadContentValidationError) {
      throw new FileUploadError(error.message);
    }

    throw error;
  }

  return {
    file,
    extension,
    mimeType: CANONICAL_UPLOAD_MIME_TYPES[extension],
    buffer
  };
}

async function prepareUploadFilesSequentially(files: File[]) {
  const preparedFiles: PreparedWorkspaceUpload[] = [];

  for (const file of files) {
    preparedFiles.push(await prepareUploadFile(file));
  }

  return preparedFiles;
}

export async function validateWorkspaceUpload(
  files: File[],
  input: {
    existingFileCount: number;
    maxFiles: number;
    requireFiles: boolean;
  }
): Promise<PreparedWorkspaceUpload[]> {
  if (input.requireFiles && !files.length) {
    throw new FileUploadError("Choose at least one file to upload.");
  }

  if (!files.length) {
    return [];
  }

  if (input.existingFileCount + files.length > input.maxFiles) {
    throw new FileUploadError(
      `This workspace supports at most ${input.maxFiles} uploaded files.`
    );
  }

  const aggregateFileBytes = files.reduce((total, file) => total + file.size, 0);

  if (aggregateFileBytes > MAX_MULTIPART_UPLOAD_SIZE_BYTES) {
    throw new FileUploadError(
      `Uploaded files exceed the ${Math.round(MAX_MULTIPART_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB aggregate limit.`,
      413
    );
  }

  files.forEach(validateUploadFileMetadata);
  return prepareUploadFilesSequentially(files);
}

export async function cleanupPersistedWorkspaceFiles(files: WorkspaceFile[]) {
  const rollbackFailures: unknown[] = [];

  for (const file of files) {
    try {
      await deleteWorkspaceFileObject(file);
    } catch (deleteError) {
      try {
        await enqueueOrphanObjectCleanup({
          workspaceId: file.workspaceId,
          storageProvider: file.storageProvider ?? (file.blobKey ? "vercel_blob" : "local"),
          objectKey: file.blobKey ?? file.storedName,
          objectKind: "source",
          reason: "workspace_file_database_persistence_failed"
        });
      } catch (enqueueError) {
        rollbackFailures.push(deleteError, enqueueError);
      }
    }
  }

  if (rollbackFailures.length) {
    throw new AggregateError(
      rollbackFailures,
      "Failed to roll back persisted workspace objects or queue durable cleanup."
    );
  }

  return { cleanedOrQueuedCount: files.length };
}

export async function scheduleWorkspaceFileRetention(files: WorkspaceFile[]) {
  for (const file of files) {
    await scheduleUploadRetention({
      workspaceId: file.workspaceId,
      fileId: file.id,
      storageProvider: file.storageProvider ?? (file.blobKey ? "vercel_blob" : "local"),
      objectKey: file.blobKey ?? file.storedName,
      uploadedAt: new Date(file.uploadedAt)
    });
  }
}

export async function persistWorkspaceFiles(input: {
  workspaceId: string;
  files: File[];
  preparedFiles?: PreparedWorkspaceUpload[];
}): Promise<WorkspaceFile[]> {
  const uploadedAt = new Date().toISOString();
  const persistedFiles: WorkspaceFile[] = [];
  const preparedFiles =
    input.preparedFiles ?? (await prepareUploadFilesSequentially(input.files));

  try {
    for (const prepared of preparedFiles) {
      const id = crypto.randomUUID();
      const storedObject = await persistWorkspaceFileObject({
        workspaceId: input.workspaceId,
        fileId: id,
        extension: prepared.extension,
        mimeType: prepared.mimeType,
        buffer: prepared.buffer
      });

      persistedFiles.push({
        id,
        workspaceId: input.workspaceId,
        originalName: prepared.file.name,
        storedName: storedObject.key,
        mimeType: prepared.mimeType,
        extension: prepared.extension,
        sizeBytes: storedObject.sizeBytes,
        uploadedAt,
        storageProvider: storedObject.storageProvider,
        ...(storedObject.storageProvider === "vercel_blob"
          ? { blobKey: storedObject.key }
          : {})
      });
    }
  } catch (error) {
    await cleanupPersistedWorkspaceFiles(persistedFiles);
    throw error;
  }

  return persistedFiles;
}
