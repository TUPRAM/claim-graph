import { describe, expect, it } from "vitest";
import {
  DOCX_EXTRACTION_LIMITS,
  extractDocxTextDeterministically
} from "@/lib/open-model/retrieval/docx-extraction";
import { buildTestDocx } from "./helpers/docx";

describe("extractDocxTextDeterministically", () => {
  it("extracts readable DOCX body and footnote text into auditable blocks", () => {
    const docxBuffer = buildTestDocx({
      paragraphs: [
        "The downtown pilot increased foot traffic and preserved stronger transit throughput for the main corridor.",
        "Some pickup-oriented merchants still reported downside when curb pickup changed and loading access narrowed."
      ],
      footnotes: [
        "A city appendix notes that delivery exemptions varied block by block during the trial period."
      ]
    });

    const extracted = extractDocxTextDeterministically(docxBuffer, "corridor-brief.docx");

    expect(extracted.warnings).toEqual([]);
    expect(extracted.text).toContain("The downtown pilot increased foot traffic");
    expect(extracted.text).toContain("Some pickup-oriented merchants still reported downside");
    expect(extracted.text).toContain("delivery exemptions varied block by block");
    expect(extracted.blocks.map((block) => block.label)).toEqual([
      "document body",
      "document body",
      "footnotes"
    ]);
    expect(extracted.blocks[0]).toMatchObject({
      offsetStart: 0
    });
    expect(extracted.blocks[2]?.offsetStart).toBeGreaterThan(
      extracted.blocks[1]?.offsetEnd ?? 0
    );
  });

  it("keeps weak DOCX extraction honest when the document body has no usable text", () => {
    const docxBuffer = buildTestDocx({
      paragraphs: ["legend"]
    });

    const extracted = extractDocxTextDeterministically(docxBuffer, "scan-export.docx");

    expect(extracted.text).toBe("");
    expect(extracted.blocks).toEqual([]);
    expect(extracted.warnings).toContain(
      "scan-export.docx did not contain enough readable DOCX text for grounded extraction."
    );
  });

  it("rejects highly expanding DOCX entries before unbounded decompression", () => {
    const expandingText = "Evidence ".repeat(
      Math.ceil(DOCX_EXTRACTION_LIMITS.maxDecompressedBytes / 9) + 1
    );
    const extracted = extractDocxTextDeterministically(
      buildTestDocx({ paragraphs: [expandingText] }),
      "compressed-report.docx"
    );

    expect(extracted.text).toBe("");
    expect(extracted.warnings.join(" ")).toContain("decompression budget");
  });

  it("scans repeated unclosed paragraphs and markup suffixes in bounded time", () => {
    const unclosedParagraphs = Array.from({ length: 6_000 }, (_, index) => {
      const uniqueSuffix = Math.imul(index + 1, 2_654_435_761)
        .toString(36)
        .replace("-", "n");
      return `<w:p>evidence-${index.toString(36)}-${uniqueSuffix} `;
    }).join("");
    const malformedXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
      unclosedParagraphs,
      "<".repeat(30_000)
    ].join("");
    const startedAt = performance.now();
    const extracted = extractDocxTextDeterministically(
      buildTestDocx({ paragraphs: [], documentXml: malformedXml }),
      "unclosed-paragraphs.docx"
    );

    expect(performance.now() - startedAt).toBeLessThan(4_000);
    expect(extracted.text.length).toBeLessThanOrEqual(
      DOCX_EXTRACTION_LIMITS.maxExtractedTextChars
    );
    expect(extracted.blocks.length).toBeLessThanOrEqual(1);
    expect(extracted.text).toContain("evidence-0");
  }, 5_000);
});
