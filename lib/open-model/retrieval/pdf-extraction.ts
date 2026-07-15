import { inflateSync } from "node:zlib";

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
}

export interface DeterministicPdfExtractionResult {
  pages: ExtractedPdfPage[];
  warnings: string[];
}

export const PDF_EXTRACTION_LIMITS = {
  maxPages: 100,
  maxDecompressedBytes: 16 * 1024 * 1024,
  maxExtractedTextChars: 200_000
} as const;

interface PdfObjectRecord {
  objectId: string;
  body: string;
  stream: Buffer | null;
  filters: string[];
}

interface PdfExtractionBudget {
  decompressedBytes: number;
}

const PDF_TEXT_SCAN_LIMITS = {
  maxContentBlocks: 10_000,
  maxTokens: 10_000,
  maxTokenBytes: PDF_EXTRACTION_LIMITS.maxExtractedTextChars * 2,
  maxRetainedTextChars: PDF_EXTRACTION_LIMITS.maxExtractedTextChars
} as const;

const PDF_DICTIONARY_SCAN_LIMITS = {
  maxArrayChars: 256 * 1024,
  maxArrayEntries: 1_024,
  maxTokenChars: 128
} as const;

const PDF_OBJECT_SCAN_LIMITS = {
  maxRetainedObjects: 10_000
} as const;

class BoundedByteWriter {
  private buffer = Buffer.allocUnsafe(0);
  private length = 0;

  constructor(private readonly maxBytes: number) {}

  push(value: number) {
    if (this.length >= this.maxBytes) {
      return;
    }

    if (this.length === this.buffer.length) {
      const nextLength = Math.min(
        this.maxBytes,
        Math.max(64, this.buffer.length * 2)
      );
      const nextBuffer = Buffer.allocUnsafe(nextLength);
      this.buffer.copy(nextBuffer, 0, 0, this.length);
      this.buffer = nextBuffer;
    }

    this.buffer[this.length] = value & 0xff;
    this.length += 1;
  }

  toBuffer() {
    return this.buffer.subarray(0, this.length);
  }
}

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

function decodePdfTextBytes(bytes: Buffer) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const beBytes = Buffer.from(bytes.subarray(2));

    if (beBytes.length % 2 === 0) {
      beBytes.swap16();
      return beBytes.toString("utf16le");
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }

  return bytes.toString("latin1");
}

function isOctalDigit(value: string | undefined) {
  return value !== undefined && value >= "0" && value <= "7";
}

function readLiteralString(input: string, start: number, maxBytes: number) {
  if (input[start] !== "(") {
    return null;
  }

  const bytes = new BoundedByteWriter(maxBytes);
  let depth = 1;
  let index = start + 1;

  while (index < input.length) {
    const char = input[index];

    if (char === "\\") {
      const next = input[index + 1];

      if (next === undefined) {
        index += 1;
        continue;
      }

      if (next === "\r") {
        index += input[index + 2] === "\n" ? 3 : 2;
        continue;
      }

      if (next === "\n") {
        index += 2;
        continue;
      }

      if (isOctalDigit(next)) {
        let octal = next;
        let cursor = index + 2;

        while (
          cursor < input.length &&
          octal.length < 3 &&
          isOctalDigit(input[cursor])
        ) {
          octal += input[cursor]!;
          cursor += 1;
        }

        bytes.push(Number.parseInt(octal, 8));
        index = cursor;
        continue;
      }

      switch (next) {
        case "n":
          bytes.push(0x0a);
          break;
        case "r":
          bytes.push(0x0d);
          break;
        case "t":
          bytes.push(0x09);
          break;
        case "b":
          bytes.push(0x08);
          break;
        case "f":
          bytes.push(0x0c);
          break;
        default:
          bytes.push(next.charCodeAt(0));
          break;
      }

      index += 2;
      continue;
    }

    if (char === "(") {
      depth += 1;
      bytes.push(char.charCodeAt(0));
      index += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;

      if (depth === 0) {
        return {
          value: decodePdfTextBytes(bytes.toBuffer()),
          end: index + 1,
          closed: true
        };
      }

      bytes.push(char.charCodeAt(0));
      index += 1;
      continue;
    }

    bytes.push(char.charCodeAt(0));
    index += 1;
  }

  return {
    value: "",
    end: input.length,
    closed: false
  };
}

function hexNibble(value: string) {
  const code = value.charCodeAt(0);

  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }

  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10;
  }

  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10;
  }

  return -1;
}

function isPdfWhitespace(value: string) {
  return value === " " || value === "\t" || value === "\r" || value === "\n" || value === "\f";
}

function readHexString(input: string, start: number, maxBytes: number) {
  if (input[start] !== "<" || input[start + 1] === "<") {
    return null;
  }

  const bytes = new BoundedByteWriter(maxBytes);
  let highNibble: number | null = null;
  let valid = true;

  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index]!;

    if (char === ">") {
      if (valid && highNibble !== null) {
        bytes.push(highNibble << 4);
      }

      return {
        value: decodePdfTextBytes(bytes.toBuffer()),
        end: index + 1,
        closed: true
      };
    }

    if (!valid || isPdfWhitespace(char)) {
      continue;
    }

    const nibble = hexNibble(char);

    if (nibble === -1) {
      // Buffer.from(hex, "hex") stops at the first non-hex token. Keep
      // scanning only to consume this malformed token exactly once.
      valid = false;
      continue;
    }

    if (highNibble === null) {
      highNibble = nibble;
    } else {
      bytes.push((highNibble << 4) | nibble);
      highNibble = null;
    }
  }

  return {
    value: "",
    end: input.length,
    closed: false
  };
}

function extractTextTokens(input: string) {
  const tokens: string[] = [];
  let retainedTextChars = 0;
  let scannedTokens = 0;
  let index = 0;

  while (
    index < input.length &&
    scannedTokens < PDF_TEXT_SCAN_LIMITS.maxTokens &&
    retainedTextChars < PDF_TEXT_SCAN_LIMITS.maxRetainedTextChars
  ) {
    const char = input[index];

    if (char === "(") {
      scannedTokens += 1;
      const parsed = readLiteralString(
        input,
        index,
        Math.min(
          PDF_TEXT_SCAN_LIMITS.maxTokenBytes,
          (PDF_TEXT_SCAN_LIMITS.maxRetainedTextChars - retainedTextChars) * 2
        )
      );

      if (parsed) {
        const value = normalizeWhitespace(parsed.value).slice(
          0,
          PDF_TEXT_SCAN_LIMITS.maxRetainedTextChars - retainedTextChars
        );

        if (value) {
          tokens.push(value);
          retainedTextChars += value.length;
        }

        index = parsed.end;
        continue;
      }
    }

    if (char === "<") {
      if (input[index + 1] === "<") {
        index += 2;
        continue;
      }

      scannedTokens += 1;
      const parsed = readHexString(
        input,
        index,
        Math.min(
          PDF_TEXT_SCAN_LIMITS.maxTokenBytes,
          (PDF_TEXT_SCAN_LIMITS.maxRetainedTextChars - retainedTextChars) * 2
        )
      );

      if (parsed) {
        const value = normalizeWhitespace(parsed.value).slice(
          0,
          PDF_TEXT_SCAN_LIMITS.maxRetainedTextChars - retainedTextChars
        );

        if (value) {
          tokens.push(value);
          retainedTextChars += value.length;
        }

        index = parsed.end;
        continue;
      }
    }

    index += 1;
  }

  return tokens;
}

function extractTextBlocks(content: string) {
  const blocks: string[] = [];
  let cursor = 0;

  while (blocks.length < PDF_TEXT_SCAN_LIMITS.maxContentBlocks) {
    const blockStart = content.indexOf("BT", cursor);

    if (blockStart === -1) {
      break;
    }

    const blockEnd = content.indexOf("ET", blockStart + 2);

    if (blockEnd === -1) {
      break;
    }

    blocks.push(content.slice(blockStart + 2, blockEnd));
    cursor = blockEnd + 2;
  }

  return blocks;
}

function extractTextFromContentStream(content: string) {
  const blocks = extractTextBlocks(content);
  const textBlocks = (blocks.length ? blocks : [content])
    .map((block) => normalizeWhitespace(extractTextTokens(block).join(" ")))
    .filter(Boolean);

  return normalizeWhitespace(textBlocks.join("\n\n"));
}

type ScannedPdfDictionaryValue =
  | {
      kind: "array";
      start: number;
      end: number;
      hadWhitespace: boolean;
    }
  | {
      kind: "single";
      start: number;
      hadWhitespace: boolean;
    }
  | {
      kind: "malformed";
      hadWhitespace: boolean;
    };

function scanPdfDictionaryValue(
  input: string,
  keyword: string
): ScannedPdfDictionaryValue | null {
  let searchFrom = 0;

  while (searchFrom < input.length) {
    const keywordStart = input.indexOf(keyword, searchFrom);

    if (keywordStart === -1) {
      return null;
    }

    let cursor = keywordStart + keyword.length;
    const whitespaceStart = cursor;

    while (isPdfPatternWhitespace(input[cursor])) {
      cursor += 1;
    }

    const hadWhitespace = cursor > whitespaceStart;

    if (!hadWhitespace && input[cursor] !== "[" && input[cursor] !== "/") {
      searchFrom = keywordStart + keyword.length;
      continue;
    }

    if (input[cursor] !== "[") {
      return {
        kind: "single",
        start: cursor,
        hadWhitespace
      };
    }

    const arrayStart = cursor + 1;
    const arrayEnd = input.indexOf("]", arrayStart);

    if (
      arrayEnd === -1 ||
      arrayEnd - arrayStart > PDF_DICTIONARY_SCAN_LIMITS.maxArrayChars
    ) {
      return {
        kind: "malformed",
        hadWhitespace
      };
    }

    return {
      kind: "array",
      start: arrayStart,
      end: arrayEnd,
      hadWhitespace
    };
  }

  return null;
}

function isAsciiAlphaNumeric(value: string | undefined) {
  if (!value) {
    return false;
  }

  const code = value.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function readPdfName(input: string, start: number, end: number) {
  if (input[start] !== "/") {
    return null;
  }

  let cursor = start + 1;

  while (cursor < end && isAsciiAlphaNumeric(input[cursor])) {
    cursor += 1;
  }

  const nameLength = cursor - start - 1;

  if (
    nameLength === 0 ||
    nameLength > PDF_DICTIONARY_SCAN_LIMITS.maxTokenChars
  ) {
    return null;
  }

  return {
    value: input.slice(start + 1, cursor),
    end: cursor
  };
}

function extractPdfNames(input: string, start: number, end: number) {
  const names: string[] = [];
  let cursor = start;

  while (
    cursor < end &&
    names.length < PDF_DICTIONARY_SCAN_LIMITS.maxArrayEntries
  ) {
    const nameStart = input.indexOf("/", cursor);

    if (nameStart === -1 || nameStart >= end) {
      break;
    }

    const parsed = readPdfName(input, nameStart, end);

    if (parsed) {
      names.push(parsed.value);
      cursor = parsed.end;
    } else {
      cursor = nameStart + 1;
    }
  }

  return names;
}

function extractStreamFilters(input: string) {
  const value = scanPdfDictionaryValue(input, "/Filter");

  if (!value || value.kind === "malformed") {
    return [];
  }

  if (value.kind === "array") {
    return extractPdfNames(input, value.start, value.end);
  }

  const name = readPdfName(input, value.start, input.length);
  return name ? [name.value] : [];
}

function extractObjectStream(input: string) {
  const streamIndex = input.indexOf("stream");

  if (streamIndex === -1) {
    return {
      stream: null,
      filters: [] as string[]
    };
  }

  const endStreamIndex = input.indexOf("endstream", streamIndex);

  if (endStreamIndex === -1) {
    return {
      stream: null,
      filters: extractStreamFilters(input.slice(0, streamIndex))
    };
  }

  let streamText = input.slice(streamIndex + "stream".length, endStreamIndex);

  if (streamText.startsWith("\r\n")) {
    streamText = streamText.slice(2);
  } else if (streamText.startsWith("\n") || streamText.startsWith("\r")) {
    streamText = streamText.slice(1);
  }

  if (streamText.endsWith("\r\n")) {
    streamText = streamText.slice(0, -2);
  } else if (streamText.endsWith("\n") || streamText.endsWith("\r")) {
    streamText = streamText.slice(0, -1);
  }

  return {
    stream: Buffer.from(streamText, "latin1"),
    filters: extractStreamFilters(input.slice(0, streamIndex))
  };
}

function isAsciiDigit(value: string | undefined) {
  return value !== undefined && value >= "0" && value <= "9";
}

function isPdfPatternWhitespace(value: string | undefined) {
  return (
    value !== undefined &&
    (isPdfWhitespace(value) || value === "\v" || value === "\u00a0")
  );
}

interface PdfObjectHeader {
  objectId: string;
  bodyStart: number;
}

function findNextPdfObjectHeader(
  input: string,
  start: number
): PdfObjectHeader | null {
  let cursor = start;

  while (cursor < input.length) {
    if (!isAsciiDigit(input[cursor])) {
      cursor += 1;
      continue;
    }

    const objectNumberStart = cursor;

    while (isAsciiDigit(input[cursor])) {
      cursor += 1;
    }

    const objectNumberEnd = cursor;

    if (!isPdfPatternWhitespace(input[cursor])) {
      continue;
    }

    while (isPdfPatternWhitespace(input[cursor])) {
      cursor += 1;
    }

    const generationNumberStart = cursor;

    if (!isAsciiDigit(input[cursor])) {
      cursor += 1;
      continue;
    }

    while (isAsciiDigit(input[cursor])) {
      cursor += 1;
    }

    const generationNumberEnd = cursor;

    if (!isPdfPatternWhitespace(input[cursor])) {
      cursor = generationNumberStart;
      continue;
    }

    while (isPdfPatternWhitespace(input[cursor])) {
      cursor += 1;
    }

    if (!input.startsWith("obj", cursor)) {
      // The generation number may itself begin a later valid object header.
      // Retrying from there examines every numeric/whitespace run at most a
      // constant number of times instead of restarting across the full suffix.
      cursor = generationNumberStart;
      continue;
    }

    return {
      objectId: `${input.slice(objectNumberStart, objectNumberEnd)} ${input.slice(
        generationNumberStart,
        generationNumberEnd
      )}`,
      bodyStart: cursor + "obj".length
    };
  }

  return null;
}

function parsePdfObjects(buffer: Buffer) {
  const pdfText = buffer.toString("latin1");
  const objects = new Map<string, PdfObjectRecord>();
  let cursor = 0;
  let retentionLimitReached = false;

  while (cursor < pdfText.length) {
    const header = findNextPdfObjectHeader(pdfText, cursor);

    if (!header) {
      break;
    }

    const bodyEnd = pdfText.indexOf("endobj", header.bodyStart);

    if (bodyEnd === -1) {
      // No later object can be complete without an end marker. Consume this
      // malformed suffix once rather than retrying each nested header prefix.
      break;
    }

    if (
      objects.size >= PDF_OBJECT_SCAN_LIMITS.maxRetainedObjects &&
      !objects.has(header.objectId)
    ) {
      retentionLimitReached = true;
      break;
    }

    const body = pdfText.slice(header.bodyStart, bodyEnd);
    const { stream, filters } = extractObjectStream(body);

    objects.set(header.objectId, {
      objectId: header.objectId,
      body,
      stream,
      filters
    });

    cursor = bodyEnd + "endobj".length;
  }

  return {
    objects,
    retentionLimitReached
  };
}

function isPageObject(record: PdfObjectRecord) {
  return /\/Type\s*\/Page\b/.test(record.body) && !/\/Type\s*\/Pages\b/.test(record.body);
}

function readPdfIndirectReference(input: string, start: number, end: number) {
  if (!isAsciiDigit(input[start])) {
    return null;
  }

  let cursor = start;

  while (cursor < end && isAsciiDigit(input[cursor])) {
    cursor += 1;
  }

  const objectNumberEnd = cursor;

  if (!isPdfPatternWhitespace(input[cursor])) {
    return null;
  }

  while (cursor < end && isPdfPatternWhitespace(input[cursor])) {
    cursor += 1;
  }

  const generationNumberStart = cursor;

  if (!isAsciiDigit(input[cursor])) {
    return null;
  }

  while (cursor < end && isAsciiDigit(input[cursor])) {
    cursor += 1;
  }

  const generationNumberEnd = cursor;

  if (!isPdfPatternWhitespace(input[cursor])) {
    return null;
  }

  while (cursor < end && isPdfPatternWhitespace(input[cursor])) {
    cursor += 1;
  }

  if (cursor >= end || input[cursor] !== "R") {
    return null;
  }

  if (
    objectNumberEnd - start > PDF_DICTIONARY_SCAN_LIMITS.maxTokenChars ||
    generationNumberEnd - generationNumberStart >
      PDF_DICTIONARY_SCAN_LIMITS.maxTokenChars
  ) {
    return null;
  }

  return {
    value: `${input.slice(start, objectNumberEnd)} ${input.slice(
      generationNumberStart,
      generationNumberEnd
    )}`,
    end: cursor + 1
  };
}

function extractPdfIndirectReferences(
  input: string,
  start: number,
  end: number
) {
  const references: string[] = [];
  let cursor = start;

  while (
    cursor < end &&
    references.length < PDF_DICTIONARY_SCAN_LIMITS.maxArrayEntries
  ) {
    if (!isAsciiDigit(input[cursor])) {
      cursor += 1;
      continue;
    }

    const parsed = readPdfIndirectReference(input, cursor, end);

    if (parsed) {
      references.push(parsed.value);
      cursor = parsed.end;
      continue;
    }

    while (cursor < end && isAsciiDigit(input[cursor])) {
      cursor += 1;
    }
  }

  return references;
}

function extractContentRefs(record: PdfObjectRecord) {
  const value = scanPdfDictionaryValue(record.body, "/Contents");

  if (!value || value.kind === "malformed") {
    return [];
  }

  if (value.kind === "array") {
    return extractPdfIndirectReferences(record.body, value.start, value.end);
  }

  if (!value.hadWhitespace) {
    return [];
  }

  const reference = readPdfIndirectReference(
    record.body,
    value.start,
    record.body.length
  );
  return reference ? [reference.value] : [];
}

function decodeStreamText(
  record: PdfObjectRecord,
  fileName: string,
  warningSet: Set<string>,
  budget: PdfExtractionBudget
) {
  if (!record.stream) {
    return "";
  }

  let decoded = record.stream;

  if (!record.filters.length) {
    if (
      budget.decompressedBytes + decoded.byteLength >
      PDF_EXTRACTION_LIMITS.maxDecompressedBytes
    ) {
      warningSet.add(
        `${fileName} exceeded the PDF stream-processing budget, so extraction stopped before consuming more content.`
      );
      return "";
    }

    budget.decompressedBytes += decoded.byteLength;
  }

  for (const filter of record.filters) {
    if (filter === "FlateDecode") {
      const remainingBytes =
        PDF_EXTRACTION_LIMITS.maxDecompressedBytes - budget.decompressedBytes;

      if (remainingBytes <= 0) {
        warningSet.add(
          `${fileName} exceeded the PDF decompression budget, so extraction stopped before consuming more content.`
        );
        return "";
      }

      try {
        decoded = inflateSync(decoded, {
          maxOutputLength: remainingBytes
        });
      } catch {
        warningSet.add(
          `${fileName} contains a compressed PDF stream that could not be decoded within the deterministic decompression budget.`
        );
        return "";
      }

      budget.decompressedBytes += decoded.byteLength;

      continue;
    }

    warningSet.add(
      `${fileName} uses unsupported PDF filter "${filter}", so some pages could not be grounded deterministically.`
    );
    return "";
  }

  return extractTextFromContentStream(decoded.toString("latin1"));
}

export function extractPdfPagesDeterministically(
  buffer: Buffer,
  fileName: string
): DeterministicPdfExtractionResult {
  const warningSet = new Set<string>();

  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return {
      pages: [],
      warnings: [`${fileName} is not a valid PDF file.`]
    };
  }

  const parsedObjects = parsePdfObjects(buffer);
  const objects = parsedObjects.objects;

  if (parsedObjects.retentionLimitReached) {
    warningSet.add(
      `${fileName} exceeded the ${PDF_OBJECT_SCAN_LIMITS.maxRetainedObjects}-object retention limit; later PDF objects were not processed.`
    );
  }

  const pageObjects = Array.from(objects.values()).filter(isPageObject);

  if (!pageObjects.length) {
    warningSet.add(
      `${fileName} did not expose any PDF pages that ClaimGraph could extract deterministically.`
    );
    return {
      pages: [],
      warnings: Array.from(warningSet)
    };
  }

  const pages: ExtractedPdfPage[] = [];
  const budget: PdfExtractionBudget = {
    decompressedBytes: 0
  };
  let extractedTextChars = 0;

  if (pageObjects.length > PDF_EXTRACTION_LIMITS.maxPages) {
    warningSet.add(
      `${fileName} exceeds the ${PDF_EXTRACTION_LIMITS.maxPages}-page extraction limit; later pages were not processed.`
    );
  }

  pageObjects.slice(0, PDF_EXTRACTION_LIMITS.maxPages).forEach((pageObject, index) => {
    const contentRefs = extractContentRefs(pageObject);
    const contentObjects =
      contentRefs.length > 0
        ? contentRefs
            .map((reference) => objects.get(reference))
            .filter((record): record is PdfObjectRecord => Boolean(record))
        : pageObject.stream
          ? [pageObject]
          : [];
    const pageText = normalizeWhitespace(
      contentObjects
        .map((record) => decodeStreamText(record, fileName, warningSet, budget))
        .filter(Boolean)
        .join("\n\n")
    );

    if (!hasUsableReadableText(pageText)) {
      return;
    }

    const remainingTextChars =
      PDF_EXTRACTION_LIMITS.maxExtractedTextChars - extractedTextChars;

    if (remainingTextChars <= 0) {
      warningSet.add(
        `${fileName} reached the PDF extracted-text budget; remaining page text was not retained.`
      );
      return;
    }

    const boundedPageText = pageText.slice(0, remainingTextChars);

    if (boundedPageText.length < pageText.length) {
      warningSet.add(
        `${fileName} reached the PDF extracted-text budget; later text was truncated.`
      );
    }

    extractedTextChars += boundedPageText.length;

    pages.push({
      pageNumber: index + 1,
      text: boundedPageText
    });
  });

  if (!pages.length) {
    warningSet.add(
      `${fileName} did not contain enough readable text for grounded PDF extraction.`
    );
  }

  return {
    pages,
    warnings: Array.from(warningSet)
  };
}
