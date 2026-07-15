export const ALLOWED_UPLOAD_EXTENSIONS = ["pdf", "txt", "md", "docx"] as const;
export type AllowedUploadExtension = (typeof ALLOWED_UPLOAD_EXTENSIONS)[number];

export const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPART_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_FILE_INPUT = ALLOWED_UPLOAD_EXTENSIONS.map((extension) => `.${extension}`).join(",");
export const ALLOWED_UPLOAD_LABEL = "PDF, TXT, MD, DOCX";

export function getFileExtension(fileName: string) {
  const segments = fileName.split(".");

  if (segments.length < 2) {
    return "";
  }

  return segments[segments.length - 1].trim().toLowerCase();
}

export function isAllowedUploadExtension(extension: string): extension is AllowedUploadExtension {
  return ALLOWED_UPLOAD_EXTENSIONS.includes(extension as AllowedUploadExtension);
}

export function formatFileSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
