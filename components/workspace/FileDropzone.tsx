"use client";

import { useId, useState, type ChangeEvent, type DragEvent } from "react";
import {
  ACCEPTED_FILE_INPUT,
  ALLOWED_UPLOAD_LABEL,
  MAX_UPLOAD_FILE_SIZE_BYTES,
  formatFileSize,
  getFileExtension,
  isAllowedUploadExtension
} from "@/lib/files/policy";

export interface DraftWorkspaceFile {
  id: string;
  file: File;
}

export interface FileDropzoneProps {
  files: DraftWorkspaceFile[];
  maxFiles: number;
  disabled?: boolean;
  onChange: (files: DraftWorkspaceFile[]) => void;
}

function validateFiles(files: File[], existingCount: number, maxFiles: number) {
  if (existingCount + files.length > maxFiles) {
    return `You can attach at most ${maxFiles} files to a workspace.`;
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

export function FileDropzone({
  files,
  maxFiles,
  disabled = false,
  onChange
}: FileDropzoneProps) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  function appendFiles(nextFiles: File[]) {
    const validationError = validateFiles(nextFiles, files.length, maxFiles);

    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    onChange([
      ...files,
      ...nextFiles.map((file) => ({
        id: crypto.randomUUID(),
        file
      }))
    ]);
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (!selectedFiles.length) {
      return;
    }

    appendFiles(selectedFiles);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    if (disabled) {
      return;
    }

    const selectedFiles = Array.from(event.dataTransfer.files ?? []);

    if (!selectedFiles.length) {
      return;
    }

    appendFiles(selectedFiles);
  }

  function removeFile(fileId: string) {
    setError(null);
    onChange(files.filter((file) => file.id !== fileId));
  }

  return (
    <div
      className={[
        "dropzone",
        isDragging ? "dropzone--active" : "",
        disabled ? "dropzone--disabled" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (!disabled) {
          setIsDragging(true);
        }
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
    >
      <input
        id={inputId}
        type="file"
        multiple
        accept={ACCEPTED_FILE_INPUT}
        onChange={onFileInputChange}
        disabled={disabled}
        style={{ display: "none" }}
      />

      <div className="dropzone__header">
        <div>
          <p className="dropzone__title">Attach supporting files</p>
          <p className="muted">
            Accepted types: {ALLOWED_UPLOAD_LABEL}. Up to {maxFiles} files, {formatFileSize(MAX_UPLOAD_FILE_SIZE_BYTES)} each.
          </p>
        </div>
        <label htmlFor={inputId} className="button button--ghost button--small">
          Choose files
        </label>
      </div>

      <p className="muted">
        Add source files now or keep the workspace question-only.
      </p>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="file-list">
        {files.length ? (
          files.map((item) => (
            <article key={item.id} className="file-card">
              <div>
                <h3 className="file-card__title">{item.file.name}</h3>
                <p className="file-card__meta">
                  {getFileExtension(item.file.name).toUpperCase() || "FILE"} / {formatFileSize(item.file.size)}
                </p>
              </div>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => removeFile(item.id)}
                disabled={disabled}
              >
                Remove
              </button>
            </article>
          ))
        ) : (
          <p className="muted">
            No files selected yet. Add PDFs, DOCX, Markdown, or text sources
            when they help explain the disagreement.
          </p>
        )}
      </div>
    </div>
  );
}
