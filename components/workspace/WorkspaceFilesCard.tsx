"use client";

import { useId, useState, type ChangeEvent } from "react";
import {
  ACCEPTED_FILE_INPUT,
  ALLOWED_UPLOAD_LABEL,
  MAX_UPLOAD_FILE_SIZE_BYTES,
  formatFileSize,
  getFileExtension,
  isAllowedUploadExtension
} from "@/lib/files/policy";
import type { RetrievalCleanupSummary, WorkspaceFile } from "@/types/claimgraph";

function formatSourceUrl(url: string) {
  try {
    const parsed = new URL(url);

    return {
      label: parsed.hostname,
      detail: parsed.toString()
    };
  } catch {
    return {
      label: url,
      detail: url
    };
  }
}

function validateFiles(files: File[], existingCount: number, maxFiles: number) {
  if (!files.length) {
    return "Choose at least one file to upload.";
  }

  if (existingCount + files.length > maxFiles) {
    return `This workspace supports at most ${maxFiles} uploaded files.`;
  }

  for (const file of files) {
    const extension = getFileExtension(file.name);

    if (!isAllowedUploadExtension(extension)) {
      return `Unsupported file type for "${file.name}". Allowed types: ${ALLOWED_UPLOAD_LABEL}.`;
    }

    if (file.size <= 0) {
      return `"${file.name}" is empty.`;
    }

    if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
      return `"${file.name}" exceeds the ${Math.round(MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024))} MB upload limit.`;
    }
  }

  return null;
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

function formatCleanupSummary(cleanup: RetrievalCleanupSummary) {
  if (cleanup.attemptedCount === 0) {
    return "No known remote retrieval artifacts needed cleanup.";
  }

  const parts = [
    `${cleanup.attemptedCount} checked`,
    `${cleanup.deletedCount} deleted`,
    `${cleanup.skippedCount} already missing`
  ];

  if (cleanup.failedCount > 0) {
    parts.push(`${cleanup.failedCount} failed`);
  }

  if (cleanup.pendingCount > 0) {
    parts.push(`${cleanup.pendingCount} pending`);
  }

  return parts.join(" - ");
}

interface FileDeleteResponse {
  workspaceId: string;
  fileId: string;
  deletedFileName: string;
  files: WorkspaceFile[];
  localFileDeleted: boolean;
  invalidatedLiveArtifacts: boolean;
  starterMode: boolean;
  cleanup: RetrievalCleanupSummary;
}

interface WorkspaceDeleteResponse {
  deleted: true;
  workspaceId: string;
  question: string;
  deletedLocalFilesCount: number;
  totalFiles: number;
  cleanup: RetrievalCleanupSummary;
}

export interface WorkspaceFilesCardProps {
  workspaceId: string;
  files: WorkspaceFile[];
  sourceUrls: string[];
  maxFiles: number;
  canMutate?: boolean;
  onFilesChanged: () => Promise<void>;
  onWorkspaceDeleted: (payload: WorkspaceDeleteResponse) => void;
}

export function WorkspaceFilesCard({
  workspaceId,
  files,
  sourceUrls,
  maxFiles,
  canMutate = true,
  onFilesChanged,
  onWorkspaceDeleted
}: WorkspaceFilesCardProps) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [isDeletingWorkspace, setIsDeletingWorkspace] = useState(false);
  const limitReached = files.length >= maxFiles;
  const isBusy = isUploading || isDeletingWorkspace || Boolean(deletingFileId);

  async function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (!selectedFiles.length) {
      return;
    }

    const validationError = validateFiles(selectedFiles, files.length, maxFiles);

    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }

    setError(null);
    setMessage(null);
    setIsUploading(true);

    try {
      const formData = new FormData();

      for (const file of selectedFiles) {
        formData.append("files", file);
      }

      const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to upload files."));
      }

      await onFilesChanged();
      setMessage("Files uploaded successfully.");
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Failed to upload files."
      );
      setMessage(null);
    } finally {
      setIsUploading(false);
    }
  }

  async function deleteFile(file: WorkspaceFile) {
    if (!canMutate || isBusy) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${file.originalName}" from this workspace? If this file was already indexed, ClaimGraph will clear the current live analysis and fall back to starter mode until you rerun analysis.`
    );

    if (!confirmed) {
      return;
    }

    setDeletingFileId(file.id);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fileId: file.id
        })
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to delete file."));
      }

      const payload = (await response.json()) as FileDeleteResponse;
      await onFilesChanged();

      const localStatus = payload.localFileDeleted
        ? ""
        : " The local upload was already missing from disk.";
      const invalidationStatus = payload.invalidatedLiveArtifacts
        ? " Previous live analysis artifacts were cleared because they may have depended on this file."
        : "";

      setMessage(
        `Deleted "${payload.deletedFileName}". ${formatCleanupSummary(payload.cleanup)}.${invalidationStatus}${localStatus}`
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete file."
      );
      setMessage(null);
    } finally {
      setDeletingFileId(null);
    }
  }

  async function deleteWorkspace() {
    if (!canMutate || isBusy) {
      return;
    }

    const confirmed = window.confirm(
      "Delete this entire workspace? This removes its local files, persisted metadata, saved live artifacts, and any known remote retrieval artifacts that can be cleaned up."
    );

    if (!confirmed) {
      return;
    }

    setIsDeletingWorkspace(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Failed to delete workspace."));
      }

      onWorkspaceDeleted((await response.json()) as WorkspaceDeleteResponse);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete workspace."
      );
    } finally {
      setIsDeletingWorkspace(false);
    }
  }

  return (
    <section className="content-card workspace-files-card">
      <div className="workspace-files-card__header">
        <div>
          <p className="eyebrow">Workspace inputs</p>
          <h2>Persisted files and source URLs</h2>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void deleteWorkspace()}
            disabled={!canMutate || isBusy}
          >
            {isDeletingWorkspace ? "Deleting workspace..." : "Delete workspace"}
          </button>
          <label
            htmlFor={inputId}
            className={[
              "button",
              "button--ghost",
              "button--small",
              !canMutate || isBusy || limitReached ? "button--disabled" : ""
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {isUploading ? "Uploading..." : "Add files"}
          </label>
        </div>
      </div>

      <input
        id={inputId}
        type="file"
        multiple
        accept={ACCEPTED_FILE_INPUT}
        onChange={onFileInputChange}
        disabled={!canMutate || isBusy || limitReached}
        style={{ display: "none" }}
      />

      <p className="muted">
        Uploaded files are stored locally. In full mode they may also be mirrored
        to OpenAI retrieval artifacts after analysis. In open-model mode,
        ClaimGraph uses the pasted source URLs and uploaded files as the
        deterministic retrieval boundary.
      </p>
      <p className="muted">
        {sourceUrls.length} source URLs saved. {files.length} / {maxFiles} files attached.
        Accepted types: {ALLOWED_UPLOAD_LABEL}. Max {formatFileSize(MAX_UPLOAD_FILE_SIZE_BYTES)} each.
      </p>
      {!canMutate ? (
        <p className="muted">
          Cancel the active analysis run before uploading or deleting files.
        </p>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
      {!error && message ? <p className="muted">{message}</p> : null}

      {sourceUrls.length ? (
        <div className="file-list">
          {sourceUrls.map((url) => {
            const formattedUrl = formatSourceUrl(url);

            return (
              <article key={url} className="file-card">
                <div>
                  <h3 className="file-card__title">{formattedUrl.label}</h3>
                  <p className="file-card__meta">{formattedUrl.detail}</p>
                </div>
                <div className="hero-actions">
                  <span className="pill pill--neutral">Source URL</span>
                  <a
                    className="button button--ghost button--small"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="muted">
          No source URLs are saved with this workspace.
        </p>
      )}

      <div className="file-list">
        {files.length ? (
          files.map((file) => (
            <article key={file.id} className="file-card">
              <div>
                <h3 className="file-card__title">{file.originalName}</h3>
                <p className="file-card__meta">
                  {file.extension.toUpperCase()} - {formatFileSize(file.sizeBytes)} - uploaded{" "}
                  {new Date(file.uploadedAt).toLocaleString()}
                </p>
              </div>
              <div className="hero-actions">
                <span className="pill pill--neutral">{file.mimeType}</span>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => void deleteFile(file)}
                  disabled={!canMutate || isBusy}
                >
                  {deletingFileId === file.id ? "Deleting..." : "Delete"}
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className="muted">
            No files are attached to this workspace yet.
          </p>
        )}
      </div>
    </section>
  );
}
