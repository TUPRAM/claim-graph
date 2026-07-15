import {
  buildTextBlocks,
  hasUsableReadableText,
  normalizeWhitespace,
  selectRelevantTextBlockPassages
} from "@/lib/open-model/retrieval/content-extraction";
import { extractDocxTextDeterministically } from "@/lib/open-model/retrieval/docx-extraction";
import { extractPdfPagesDeterministically } from "@/lib/open-model/retrieval/pdf-extraction";
import { readWorkspaceFileObject } from "@/lib/server/object-storage";
import type {
  DeterministicRetrievalResult,
  ExtractedTextBlock
} from "@/lib/open-model/retrieval/types";
import type { Snippet, Source, WorkspaceFile } from "@/types/claimgraph";

const SUPPORTED_OPEN_MODEL_FILE_EXTENSIONS = new Set(["txt", "md", "pdf", "docx"]);

interface ExtractedFilePassage {
  text: string;
  pageNumber?: number;
  offsetStart?: number;
  offsetEnd?: number;
  locationLabel?: string;
}

interface ExtractedFileTextResult {
  text: string;
  pageTexts: Array<{
    pageNumber: number;
    text: string;
  }>;
  textBlocks: ExtractedTextBlock[];
  warnings: string[];
  formatLabel: string;
}

function tokenizeQuestion(value: string) {
  return new Set(
    normalizeWhitespace(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
}

function selectRelevantPagePassages(input: {
  question: string;
  pages: Array<{
    pageNumber: number;
    text: string;
  }>;
  maxPassages?: number;
  maxCharsPerPassage?: number;
}) {
  const questionTokens = tokenizeQuestion(input.question);
  const maxPassages = Math.max(1, input.maxPassages ?? 3);
  const maxCharsPerPassage = Math.max(120, input.maxCharsPerPassage ?? 320);
  const candidates = input.pages.flatMap((page) => {
    const segments = page.text
      .split(/\n{2,}/)
      .map((segment) => normalizeWhitespace(segment))
      .filter((segment) => segment.length >= 60);
    const pageSegments = segments.length ? segments : [normalizeWhitespace(page.text)];

    return pageSegments
      .filter((segment) => segment.length >= 40)
      .map((segment) => {
        const trimmed = segment.slice(0, maxCharsPerPassage);
        const segmentTokens = new Set(
          trimmed
            .toLowerCase()
            .split(/[^a-z0-9]+/i)
            .filter((token) => token.length >= 4)
        );
        let overlap = 0;

        for (const token of questionTokens) {
          if (segmentTokens.has(token)) {
            overlap += 1;
          }
        }

        return {
          text: trimmed,
          pageNumber: page.pageNumber,
          overlap,
          lengthScore: Math.min(segment.length, maxCharsPerPassage)
        };
      });
  });
  const seen = new Set<string>();

  return candidates
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        right.lengthScore - left.lengthScore ||
        left.pageNumber - right.pageNumber
    )
    .filter((candidate) => {
      const key = `${candidate.pageNumber}:${candidate.text}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .slice(0, maxPassages)
    .map<ExtractedFilePassage>((candidate) => ({
      text: candidate.text,
      pageNumber: candidate.pageNumber
    }));
}

async function readSupportedFileText(file: WorkspaceFile) {
  if (!SUPPORTED_OPEN_MODEL_FILE_EXTENSIONS.has(file.extension)) {
    return {
      text: "",
      pageTexts: [],
      textBlocks: [],
      warnings: [
        `Open-model mode currently supports deterministic grounded extraction for PDF, TXT, MD, and DOCX uploads. ${file.originalName} was preserved as a workspace file but not used for grounded extraction.`
      ],
      formatLabel: file.extension.toUpperCase()
    };
  }

  const fileBuffer = await readWorkspaceFileObject(file);

  if (!fileBuffer) {
    return {
      text: "",
      pageTexts: [],
      textBlocks: [],
      warnings: [
        `${file.originalName} is missing from local storage, so it could not contribute grounded snippets.`
      ],
      formatLabel: file.extension.toUpperCase()
    };
  }

  if (file.extension === "pdf") {
    const extraction = extractPdfPagesDeterministically(fileBuffer, file.originalName);

    return {
      text: extraction.pages.map((page) => page.text).join("\n\n"),
      pageTexts: extraction.pages,
      textBlocks: [],
      warnings: extraction.warnings,
      formatLabel: "PDF"
    };
  }

  if (file.extension === "docx") {
    const extraction = extractDocxTextDeterministically(fileBuffer, file.originalName);

    return {
      text: extraction.text,
      pageTexts: [],
      textBlocks: extraction.blocks.map((block) => ({
        text: block.text,
        offsetStart: block.offsetStart,
        offsetEnd: block.offsetEnd,
        locationLabel: block.label
      })),
      warnings: extraction.warnings,
      formatLabel: "DOCX"
    };
  }

  const text = normalizeWhitespace(fileBuffer.toString("utf8"));

  if (!hasUsableReadableText(text)) {
    return {
      text: "",
      pageTexts: [],
      textBlocks: [],
      warnings: [
        text
          ? `${file.originalName} did not contain enough readable text for grounded deterministic extraction.`
          : `${file.originalName} did not contain usable text after deterministic extraction.`
      ],
      formatLabel: file.extension === "md" ? "Markdown" : "text"
    };
  }

  return {
    text,
    pageTexts: [],
    textBlocks: buildTextBlocks(text),
    warnings: [],
    formatLabel: file.extension === "md" ? "Markdown" : "text"
  };
}

function buildFilePassageRationale(input: {
  passage: ExtractedFilePassage;
  index: number;
  formatLabel: string;
}) {
  if (typeof input.passage.pageNumber === "number") {
    return input.index === 0
      ? `Deterministically extracted from page ${input.passage.pageNumber} of the uploaded PDF and ranked against the question.`
      : `Deterministically extracted supporting passage from page ${input.passage.pageNumber} of the uploaded PDF.`;
  }

  if (input.passage.locationLabel) {
    return input.index === 0
      ? `Deterministically extracted from the ${input.passage.locationLabel} of the uploaded ${input.formatLabel} file and ranked against the question.`
      : `Deterministically extracted supporting passage from the ${input.passage.locationLabel} of the uploaded ${input.formatLabel} file.`;
  }

  return input.index === 0
    ? `Deterministically extracted from the uploaded ${input.formatLabel} file and ranked against the question.`
    : `Deterministically extracted supporting passage from the uploaded ${input.formatLabel} file.`;
}

export async function ingestFilesDeterministically(input: {
  question: string;
  files: WorkspaceFile[];
  maxFiles: number;
}): Promise<DeterministicRetrievalResult> {
  const sources: Source[] = [];
  const snippets: Snippet[] = [];
  const warnings: string[] = [];

  for (const file of input.files.slice(0, input.maxFiles)) {
    const sourceId = `src_file_${sources.length + 1}`;
    const source: Source = {
      id: sourceId,
      type: "file",
      title: file.originalName,
      fileName: file.originalName,
      sourceKind: "memo"
    };
    const extracted = await readSupportedFileText(file);

    sources.push(source);

    if (extracted.warnings.length) {
      warnings.push(...extracted.warnings);
    }

    if (!extracted.text) {
      continue;
    }

    const passages =
      extracted.pageTexts.length > 0
        ? selectRelevantPagePassages({
            question: input.question,
            pages: extracted.pageTexts,
            maxPassages: 3
          })
        : selectRelevantTextBlockPassages({
            question: input.question,
            blocks: extracted.textBlocks,
            maxPassages: 3
          }).map<ExtractedFilePassage>((passage) => ({
            text: passage.text,
            offsetStart: passage.offsetStart,
            offsetEnd: passage.offsetEnd,
            ...(passage.locationLabel ? { locationLabel: passage.locationLabel } : {})
          }));

    if (!passages.length) {
      warnings.push(
        `${file.originalName} preserved some text after deterministic extraction, but not enough question-relevant passage material to ground a live open-model snippet honestly.`
      );
      continue;
    }

    passages.forEach((passage, index) => {
      snippets.push({
        id: `snp_file_ingest_${snippets.length + 1}`,
        sourceId,
        text: passage.text,
        rationale: buildFilePassageRationale({
          passage,
          index,
          formatLabel: extracted.formatLabel
        }),
        relevance: Number(Math.max(0.55, 0.88 - index * 0.1).toFixed(3)),
        origin: "file_ingest_excerpt" as const,
        ...(passage.locationLabel ? { locationLabel: passage.locationLabel } : {}),
        ...(typeof passage.pageNumber === "number" ? { pageNumber: passage.pageNumber } : {}),
        ...(typeof passage.offsetStart === "number" &&
        typeof passage.offsetEnd === "number"
          ? {
              offsetStart: passage.offsetStart,
              offsetEnd: passage.offsetEnd
            }
          : {})
      });
    });
  }

  return {
    sources,
    snippets,
    warnings
  };
}
