import { inflateRawSync } from "node:zlib";

export interface ExtractedDocxBlock {
  label: string;
  text: string;
  offsetStart: number;
  offsetEnd: number;
}

export interface DeterministicDocxExtractionResult {
  text: string;
  blocks: ExtractedDocxBlock[];
  warnings: string[];
}

export const DOCX_EXTRACTION_LIMITS = {
  maxZipEntries: 512,
  maxDecompressedBytes: 16 * 1024 * 1024,
  maxExtractedTextChars: 200_000,
  maxCompressionRatio: 100
} as const;

interface ZipCentralDirectoryEntry {
  fileName: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface DocxExtractionBudget {
  decompressedBytes: number;
}

const DOCX_XML_SCAN_LIMITS = {
  maxMarkupTokens: 100_000,
  maxParagraphs: 10_000,
  maxRetainedMarkupChars: DOCX_EXTRACTION_LIMITS.maxExtractedTextChars * 2,
  maxTagNameChars: 128
} as const;

const DOCX_TEXT_ENTRY_PATTERNS = [
  { pattern: /^word\/document\.xml$/i, label: "document body", order: 0 },
  { pattern: /^word\/footnotes\.xml$/i, label: "footnotes", order: 1 },
  { pattern: /^word\/endnotes\.xml$/i, label: "endnotes", order: 2 },
  { pattern: /^word\/comments\.xml$/i, label: "comments", order: 3 }
] as const;

function normalizeWhitespace(value: string) {
  return value
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasUsableReadableText(text: string) {
  const normalized = normalizeWhitespace(text);
  const words = normalized.match(/[A-Za-z0-9][A-Za-z0-9'/-]{1,}/g) ?? [];
  const letters = (normalized.match(/[A-Za-z]/g) ?? []).length;

  return normalized.length >= 50 && words.length >= 6 && letters >= 24;
}

function decodeXmlEntities(value: string) {
  return value.replace(
    /&(?:nbsp|amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&nbsp;":
          return " ";
        case "&amp;":
          return "&";
        case "&quot;":
          return "\"";
        case "&apos;":
          return "'";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        default: {
          if (/^&#\d+;$/i.test(entity)) {
            return String.fromCodePoint(Number.parseInt(entity.slice(2, -1), 10));
          }

          if (/^&#x[0-9a-f]+;$/i.test(entity)) {
            return String.fromCodePoint(Number.parseInt(entity.slice(3, -1), 16));
          }

          return " ";
        }
      }
    }
  );
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);

  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}

function parseCentralDirectory(
  buffer: Buffer,
  fileName: string,
  warningSet: Set<string>
) {
  const endOfCentralDirectoryOffset = findEndOfCentralDirectory(buffer);

  if (endOfCentralDirectoryOffset === -1) {
    warningSet.add(`${fileName} is not a valid DOCX file.`);
    return [] as ZipCentralDirectoryEntry[];
  }

  const centralDirectoryEntryCount = buffer.readUInt16LE(
    endOfCentralDirectoryOffset + 10
  );
  const centralDirectorySize = buffer.readUInt32LE(endOfCentralDirectoryOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endOfCentralDirectoryOffset + 16);
  const entries: ZipCentralDirectoryEntry[] = [];
  let cursor = centralDirectoryOffset;

  if (
    centralDirectoryEntryCount > DOCX_EXTRACTION_LIMITS.maxZipEntries ||
    centralDirectoryOffset + centralDirectorySize > endOfCentralDirectoryOffset
  ) {
    warningSet.add(
      `${fileName} exceeds the deterministic DOCX directory budget.`
    );
    return entries;
  }

  for (let index = 0; index < centralDirectoryEntryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      warningSet.add(
        `${fileName} has an unreadable DOCX central directory, so deterministic extraction stayed partial.`
      );
      return entries;
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const fileNameValue = buffer.toString("utf8", cursor + 46, cursor + 46 + fileNameLength);

    entries.push({
      fileName: fileNameValue,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });

    cursor += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}

function readZipEntryData(
  buffer: Buffer,
  fileName: string,
  entry: ZipCentralDirectoryEntry,
  warningSet: Set<string>,
  budget: DocxExtractionBudget
) {
  const localHeaderOffset = entry.localHeaderOffset;

  if (
    localHeaderOffset + 30 > buffer.length ||
    buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
  ) {
    warningSet.add(
      `${fileName} contains an unreadable DOCX entry (${entry.fileName}), so deterministic extraction stayed partial.`
    );
    return null;
  }

  if ((entry.flags & 0x0001) !== 0) {
    warningSet.add(
      `${fileName} uses encrypted DOCX entries, which ClaimGraph does not ground deterministically.`
    );
    return null;
  }

  const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > buffer.length) {
    warningSet.add(
      `${fileName} contains a truncated DOCX entry (${entry.fileName}), so deterministic extraction stayed partial.`
    );
    return null;
  }

  const entryBuffer = buffer.subarray(dataStart, dataEnd);
  const remainingBytes =
    DOCX_EXTRACTION_LIMITS.maxDecompressedBytes - budget.decompressedBytes;

  if (
    remainingBytes <= 0 ||
    entry.uncompressedSize > remainingBytes ||
    (entry.compressedSize === 0 && entry.uncompressedSize > 0) ||
    (entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize >
        DOCX_EXTRACTION_LIMITS.maxCompressionRatio)
  ) {
    warningSet.add(
      `${fileName} contains a DOCX entry (${entry.fileName}) that exceeds the deterministic decompression budget.`
    );
    return null;
  }

  if (entry.compressionMethod === 0) {
    budget.decompressedBytes += entryBuffer.byteLength;
    return entryBuffer;
  }

  if (entry.compressionMethod === 8) {
    try {
      const decompressed = inflateRawSync(entryBuffer, {
        maxOutputLength: remainingBytes
      });

      if (
        (entry.uncompressedSize > 0 && decompressed.byteLength !== entry.uncompressedSize) ||
        decompressed.byteLength > remainingBytes
      ) {
        warningSet.add(
          `${fileName} contains an inconsistent DOCX entry (${entry.fileName}).`
        );
        return null;
      }

      budget.decompressedBytes += decompressed.byteLength;
      return decompressed;
    } catch {
      warningSet.add(
        `${fileName} contains a compressed DOCX entry (${entry.fileName}) that could not be decoded within the deterministic decompression budget.`
      );
      return null;
    }
  }

  warningSet.add(
    `${fileName} uses unsupported DOCX compression method "${entry.compressionMethod}" in ${entry.fileName}.`
  );
  return null;
}

interface ScannedMarkupTag {
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  complete: boolean;
}

function isMarkupNameCharacter(value: string | undefined) {
  if (!value) {
    return false;
  }

  const code = value.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    value === ":" ||
    value === "_" ||
    value === "-"
  );
}

function isMarkupWhitespace(value: string | undefined) {
  return (
    value === " " ||
    value === "\t" ||
    value === "\r" ||
    value === "\n" ||
    value === "\f"
  );
}

function scanMarkupTag(input: string, start: number): ScannedMarkupTag {
  let end = start + 1;

  while (end < input.length && input[end] !== ">") {
    end += 1;
  }

  if (end >= input.length) {
    return {
      end: input.length,
      name: "",
      closing: false,
      selfClosing: false,
      complete: false
    };
  }

  let cursor = start + 1;

  while (cursor < end && isMarkupWhitespace(input[cursor])) {
    cursor += 1;
  }

  const closing = input[cursor] === "/";

  if (closing) {
    cursor += 1;
    while (cursor < end && isMarkupWhitespace(input[cursor])) {
      cursor += 1;
    }
  }

  const nameStart = cursor;
  const nameLimit = Math.min(
    end,
    nameStart + DOCX_XML_SCAN_LIMITS.maxTagNameChars
  );

  while (cursor < nameLimit && isMarkupNameCharacter(input[cursor])) {
    cursor += 1;
  }

  const overlongName =
    cursor === nameLimit &&
    cursor < end &&
    isMarkupNameCharacter(input[cursor]);

  let suffix = end - 1;

  while (suffix > start && isMarkupWhitespace(input[suffix])) {
    suffix -= 1;
  }

  return {
    end: end + 1,
    name: overlongName ? "" : input.slice(nameStart, cursor).toLowerCase(),
    closing,
    selfClosing: input[suffix] === "/",
    complete: true
  };
}

function appendBounded(
  parts: string[],
  value: string,
  retainedChars: number
) {
  const remaining =
    DOCX_XML_SCAN_LIMITS.maxRetainedMarkupChars - retainedChars;

  if (remaining <= 0 || !value) {
    return retainedChars;
  }

  const retained = value.slice(0, remaining);
  parts.push(retained);
  return retainedChars + retained.length;
}

function replacementForWordTag(tag: ScannedMarkupTag) {
  if (
    !tag.closing &&
    tag.selfClosing &&
    (tag.name === "w:tab" || tag.name === "w:br" || tag.name === "w:cr")
  ) {
    return tag.name === "w:tab" ? "\t" : "\n";
  }

  if (tag.closing && (tag.name === "w:tr" || tag.name === "w:tc")) {
    return "\n";
  }

  return " ";
}

function extractParagraphsFromWordXml(xml: string) {
  const fallbackParts: string[] = [];
  const rawParagraphs: string[] = [];
  let currentParagraphParts: string[] | null = null;
  let fallbackChars = 0;
  let paragraphChars = 0;
  let paragraphDepth = 0;
  let markupTokens = 0;
  let cursor = 0;
  let limitReached = false;

  while (cursor < xml.length) {
    if (
      markupTokens >= DOCX_XML_SCAN_LIMITS.maxMarkupTokens ||
      rawParagraphs.length >= DOCX_XML_SCAN_LIMITS.maxParagraphs ||
      (fallbackChars >= DOCX_XML_SCAN_LIMITS.maxRetainedMarkupChars &&
        paragraphChars >= DOCX_XML_SCAN_LIMITS.maxRetainedMarkupChars)
    ) {
      limitReached = true;
      break;
    }

    const tagStart = xml.indexOf("<", cursor);
    const textEnd = tagStart === -1 ? xml.length : tagStart;

    if (textEnd > cursor) {
      const text = xml.slice(cursor, textEnd);
      fallbackChars = appendBounded(fallbackParts, text, fallbackChars);

      if (paragraphDepth > 0 && currentParagraphParts) {
        paragraphChars = appendBounded(
          currentParagraphParts,
          text,
          paragraphChars
        );
      }
    }

    if (tagStart === -1) {
      break;
    }

    const tag = scanMarkupTag(xml, tagStart);
    markupTokens += 1;

    if (!tag.complete) {
      // Consume an unclosed markup suffix once. Retrying from each later '<'
      // would turn malformed DOCX input into quadratic work.
      cursor = tag.end;
      break;
    }

    if (!tag.closing && tag.name === "w:p") {
      if (paragraphDepth === 0) {
        currentParagraphParts = [];
      }
      paragraphDepth += 1;
    }

    const replacement = replacementForWordTag(tag);
    fallbackChars = appendBounded(fallbackParts, replacement, fallbackChars);

    if (paragraphDepth > 0 && currentParagraphParts) {
      paragraphChars = appendBounded(
        currentParagraphParts,
        replacement,
        paragraphChars
      );
    }

    if (tag.closing && tag.name === "w:p" && paragraphDepth > 0) {
      paragraphDepth -= 1;

      if (paragraphDepth === 0 && currentParagraphParts) {
        rawParagraphs.push(currentParagraphParts.join(""));
        currentParagraphParts = null;
      }
    }

    cursor = tag.end;
  }

  const paragraphCandidates = rawParagraphs.length
    ? rawParagraphs
    : [fallbackParts.join("")];

  return {
    paragraphs: paragraphCandidates
      .map((paragraph) =>
        normalizeWhitespace(decodeXmlEntities(paragraph))
      )
      .filter(Boolean),
    limitReached
  };
}

function matchDocxTextEntry(fileName: string) {
  return DOCX_TEXT_ENTRY_PATTERNS.find((entry) => entry.pattern.test(fileName));
}

export function extractDocxTextDeterministically(
  buffer: Buffer,
  fileName: string
): DeterministicDocxExtractionResult {
  const warningSet = new Set<string>();
  const centralDirectoryEntries = parseCentralDirectory(buffer, fileName, warningSet);
  const documentEntry = centralDirectoryEntries.find((entry) =>
    /^word\/document\.xml$/i.test(entry.fileName)
  );

  if (!documentEntry) {
    return {
      text: "",
      blocks: [],
      warnings: [
        ...Array.from(warningSet),
        `${fileName} did not expose a readable Word document body for deterministic grounding.`
      ]
    };
  }

  const candidateEntries = centralDirectoryEntries
    .map((entry) => ({
      entry,
      matched: matchDocxTextEntry(entry.fileName)
    }))
    .filter(
      (
        entry
      ): entry is {
        entry: ZipCentralDirectoryEntry;
        matched: (typeof DOCX_TEXT_ENTRY_PATTERNS)[number];
      } => Boolean(entry.matched)
    )
    .sort(
      (left, right) =>
        left.matched.order - right.matched.order ||
        left.entry.fileName.localeCompare(right.entry.fileName)
    );

  const blocks: ExtractedDocxBlock[] = [];
  const seenBlockTexts = new Set<string>();
  const budget: DocxExtractionBudget = {
    decompressedBytes: 0
  };
  let combinedText = "";

  for (const candidate of candidateEntries) {
    const xmlBytes = readZipEntryData(
      buffer,
      fileName,
      candidate.entry,
      warningSet,
      budget
    );

    if (!xmlBytes) {
      continue;
    }

    const extractedXml = extractParagraphsFromWordXml(xmlBytes.toString("utf8"));

    if (extractedXml.limitReached) {
      warningSet.add(
        `${fileName} reached the DOCX XML scan budget; remaining markup was not retained.`
      );
    }

    for (const paragraph of extractedXml.paragraphs) {
      if (!paragraph) {
        continue;
      }

      const uniqueKey = paragraph.toLowerCase();

      if (seenBlockTexts.has(uniqueKey)) {
        continue;
      }

      const separatorLength = combinedText.length ? 2 : 0;
      const remainingTextChars =
        DOCX_EXTRACTION_LIMITS.maxExtractedTextChars -
        combinedText.length -
        separatorLength;

      if (remainingTextChars <= 0) {
        warningSet.add(
          `${fileName} reached the DOCX extracted-text budget; remaining text was not retained.`
        );
        break;
      }

      const boundedParagraph = paragraph.slice(0, remainingTextChars);

      if (boundedParagraph.length < paragraph.length) {
        warningSet.add(
          `${fileName} reached the DOCX extracted-text budget; later text was truncated.`
        );
      }

      seenBlockTexts.add(uniqueKey);

      const offsetStart = combinedText.length + separatorLength;
      combinedText = combinedText
        ? `${combinedText}\n\n${boundedParagraph}`
        : boundedParagraph;
      blocks.push({
        label: candidate.matched.label,
        text: boundedParagraph,
        offsetStart,
        offsetEnd: offsetStart + boundedParagraph.length
      });
    }
  }

  if (!hasUsableReadableText(combinedText)) {
    warningSet.add(
      `${fileName} did not contain enough readable DOCX text for grounded extraction.`
    );

    return {
      text: "",
      blocks: [],
      warnings: Array.from(warningSet)
    };
  }

  return {
    text: combinedText,
    blocks,
    warnings: Array.from(warningSet)
  };
}
