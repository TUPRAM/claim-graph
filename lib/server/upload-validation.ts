import type { AllowedUploadExtension } from "@/lib/files/policy";

const MAX_DOCX_ENTRY_COUNT = 512;
const MAX_DOCX_DECLARED_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 100;
const PDF_HEADER = Buffer.from("%PDF-");
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export class UploadContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadContentValidationError";
  }
}

function findZipEndOfCentralDirectory(buffer: Buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);

  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (offset + 22 <= buffer.length && buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }

  return -1;
}

function validatePdf(buffer: Buffer, fileName: string) {
  if (!buffer.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) {
    throw new UploadContentValidationError(
      `"${fileName}" does not contain a valid PDF signature.`
    );
  }

  const trailerStart = Math.max(0, buffer.length - 2_048);
  const trailer = buffer.toString("latin1", trailerStart);

  if (!trailer.includes("%%EOF")) {
    throw new UploadContentValidationError(
      `"${fileName}" does not contain a complete PDF trailer.`
    );
  }
}

function validateDocx(buffer: Buffer, fileName: string) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER) {
    throw new UploadContentValidationError(
      `"${fileName}" does not contain a valid DOCX container signature.`
    );
  }

  const endOffset = findZipEndOfCentralDirectory(buffer);

  if (endOffset === -1) {
    throw new UploadContentValidationError(
      `"${fileName}" does not contain a complete DOCX central directory.`
    );
  }

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);

  if (
    entryCount <= 0 ||
    entryCount > MAX_DOCX_ENTRY_COUNT ||
    centralDirectoryOffset + centralDirectorySize > endOffset
  ) {
    throw new UploadContentValidationError(
      `"${fileName}" contains an invalid or oversized DOCX directory.`
    );
  }

  const entries = new Set<string>();
  let cursor = centralDirectoryOffset;
  let declaredUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > endOffset ||
      buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER
    ) {
      throw new UploadContentValidationError(
        `"${fileName}" contains an unreadable DOCX directory entry.`
      );
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength;

    if (entryEnd > endOffset) {
      throw new UploadContentValidationError(
        `"${fileName}" contains a truncated DOCX directory entry.`
      );
    }

    if ((flags & 0x0001) !== 0) {
      throw new UploadContentValidationError(
        `"${fileName}" contains encrypted DOCX entries, which are not accepted.`
      );
    }

    declaredUncompressedBytes += uncompressedSize;

    if (
      declaredUncompressedBytes > MAX_DOCX_DECLARED_UNCOMPRESSED_BYTES ||
      (compressedSize === 0 && uncompressedSize > 0) ||
      (compressedSize > 0 &&
        uncompressedSize / compressedSize > MAX_DOCX_COMPRESSION_RATIO)
    ) {
      throw new UploadContentValidationError(
        `"${fileName}" exceeds the accepted DOCX decompression budget.`
      );
    }

    const entryName = buffer
      .toString("utf8", cursor + 46, cursor + 46 + fileNameLength)
      .replace(/\\/g, "/")
      .toLowerCase();

    if (
      entryName.startsWith("/") ||
      entryName.split("/").some((segment) => segment === "..")
    ) {
      throw new UploadContentValidationError(
        `"${fileName}" contains an unsafe DOCX entry path.`
      );
    }

    entries.add(entryName);
    cursor = entryEnd;
  }

  if (!entries.has("[content_types].xml") || !entries.has("word/document.xml")) {
    throw new UploadContentValidationError(
      `"${fileName}" is a ZIP file but not a valid Word document container.`
    );
  }
}

function validateUtf8Text(buffer: Buffer, fileName: string) {
  if (
    buffer.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) ||
    (buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL_HEADER)
  ) {
    throw new UploadContentValidationError(
      `"${fileName}" content does not match its text-file extension.`
    );
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new UploadContentValidationError(
      `"${fileName}" must contain valid UTF-8 text.`
    );
  }

  if (text.includes("\0")) {
    throw new UploadContentValidationError(
      `"${fileName}" appears to contain binary data instead of text.`
    );
  }

  const maxControlCharacters = Math.floor(text.length * 0.02);
  let controlCharacters = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) {
      controlCharacters += 1;

      if (controlCharacters > maxControlCharacters) {
        throw new UploadContentValidationError(
          `"${fileName}" appears to contain binary control data instead of text.`
        );
      }
    }
  }
}

export function validateUploadBuffer(input: {
  extension: AllowedUploadExtension;
  fileName: string;
  buffer: Buffer;
}) {
  if (input.extension === "pdf") {
    validatePdf(input.buffer, input.fileName);
    return;
  }

  if (input.extension === "docx") {
    validateDocx(input.buffer, input.fileName);
    return;
  }

  validateUtf8Text(input.buffer, input.fileName);
}
