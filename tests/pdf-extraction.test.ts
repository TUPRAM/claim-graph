import { describe, expect, it } from "vitest";
import {
  PDF_EXTRACTION_LIMITS,
  extractPdfPagesDeterministically
} from "@/lib/open-model/retrieval/pdf-extraction";
import { buildTestPdf } from "./helpers/pdf";

function buildRawContentPdf(content: string) {
  const contentLength = Buffer.byteLength(content, "latin1");

  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj",
      `4 0 obj\n<< /Length ${contentLength} >>\nstream\n${content}\nendstream\nendobj`,
      "%%EOF"
    ].join("\n"),
    "latin1"
  );
}

function buildDictionaryStressPdf(input: {
  pageDictionary: string;
  contentDictionary: string;
}) {
  const content =
    "BT\n(A readable evidence sentence remains available for deterministic PDF extraction and review.) Tj\nET";
  const contentLength = Buffer.byteLength(content, "latin1");

  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
      `3 0 obj\n<< /Type /Page /Parent 2 0 R ${input.pageDictionary} >>\nendobj`,
      `4 0 obj\n<< ${input.contentDictionary} /Length ${contentLength} >>\nstream\n${content}\nendstream\nendobj`,
      "%%EOF"
    ].join("\n"),
    "latin1"
  );
}

describe("extractPdfPagesDeterministically", () => {
  it("extracts readable page text from a compressed PDF text layer", () => {
    const pdfBuffer = buildTestPdf(
      [
        "Page one explains that a downtown bus corridor increased rider throughput and preserved freight windows.",
        "Page two says merchants still reported access friction when curb pickup was removed."
      ],
      { flate: true }
    );

    const extracted = extractPdfPagesDeterministically(pdfBuffer, "corridor-audit.pdf");

    expect(extracted.warnings).toEqual([]);
    expect(extracted.pages).toEqual([
      {
        pageNumber: 1,
        text: "Page one explains that a downtown bus corridor increased rider throughput and preserved freight windows."
      },
      {
        pageNumber: 2,
        text: "Page two says merchants still reported access friction when curb pickup was removed."
      }
    ]);
  });

  it("keeps weak PDF extraction honest when no readable text layer is available", () => {
    const pdfBuffer = buildTestPdf(["legend"], { flate: false });

    const extracted = extractPdfPagesDeterministically(pdfBuffer, "scanned-handout.pdf");

    expect(extracted.pages).toEqual([]);
    expect(extracted.warnings).toContain(
      "scanned-handout.pdf did not contain enough readable text for grounded PDF extraction."
    );
  });

  it("caps page processing and reports the omitted tail", () => {
    const pages = Array.from(
      { length: PDF_EXTRACTION_LIMITS.maxPages + 1 },
      (_, index) =>
        `Page ${index + 1} contains a complete readable policy evidence sentence for deterministic extraction.`
    );
    const extracted = extractPdfPagesDeterministically(
      buildTestPdf(pages),
      "oversized-report.pdf"
    );

    expect(extracted.pages).toHaveLength(PDF_EXTRACTION_LIMITS.maxPages);
    expect(extracted.warnings.join(" ")).toContain("page extraction limit");
  });

  it("stops compressed streams at the decompression budget", () => {
    const decompressionBombText = "Evidence ".repeat(
      Math.ceil(PDF_EXTRACTION_LIMITS.maxDecompressedBytes / 9) + 1
    );
    const extracted = extractPdfPagesDeterministically(
      buildTestPdf([decompressionBombText], { flate: true }),
      "compressed-report.pdf"
    );

    expect(extracted.pages).toEqual([]);
    expect(extracted.warnings.join(" ")).toContain("decompression budget");
  });

  it("consumes a repeated unmatched literal-string suffix once", () => {
    const startedAt = performance.now();
    const extracted = extractPdfPagesDeterministically(
      buildRawContentPdf(`BT\n${"(".repeat(50_000)}\nET`),
      "unclosed-literals.pdf"
    );

    expect(performance.now() - startedAt).toBeLessThan(4_000);
    expect(extracted.pages).toEqual([]);
    expect(extracted.warnings.join(" ")).toContain("readable text");
  }, 5_000);

  it("consumes a repeated unmatched hex-string suffix once", () => {
    const startedAt = performance.now();
    const extracted = extractPdfPagesDeterministically(
      buildRawContentPdf(`BT\n${"<a".repeat(50_000)}\nET`),
      "unclosed-hex.pdf"
    );

    expect(performance.now() - startedAt).toBeLessThan(4_000);
    expect(extracted.pages).toEqual([]);
    expect(extracted.warnings.join(" ")).toContain("readable text");
  }, 5_000);

  it("consumes repeated object headers without an end marker once", () => {
    const malformedPdf = Buffer.from(
      `%PDF-1.4\n${"1 0 obj\n".repeat(50_000)}%%EOF`,
      "latin1"
    );
    const startedAt = performance.now();
    const extracted = extractPdfPagesDeterministically(
      malformedPdf,
      "unclosed-objects.pdf"
    );

    expect(performance.now() - startedAt).toBeLessThan(6_000);
    expect(extracted.pages).toEqual([]);
    expect(extracted.warnings.join(" ")).toContain("PDF pages");
  }, 8_000);

  it("fails closed on repeated unterminated Filter arrays in a complete object", () => {
    const startedAt = performance.now();
    const extracted = extractPdfPagesDeterministically(
      buildDictionaryStressPdf({
        pageDictionary: "/Contents 4 0 R",
        contentDictionary: "/Filter [ ".repeat(30_000)
      }),
      "unclosed-filter-arrays.pdf"
    );

    expect(performance.now() - startedAt).toBeLessThan(6_000);
    expect(extracted.pages).toEqual([
      {
        pageNumber: 1,
        text:
          "A readable evidence sentence remains available for deterministic PDF extraction and review."
      }
    ]);
  }, 8_000);

  it("fails closed on repeated unterminated Contents arrays in a complete object", () => {
    const startedAt = performance.now();
    const extracted = extractPdfPagesDeterministically(
      buildDictionaryStressPdf({
        pageDictionary: "/Contents [ ".repeat(30_000),
        contentDictionary: ""
      }),
      "unclosed-content-arrays.pdf"
    );

    expect(performance.now() - startedAt).toBeLessThan(6_000);
    expect(extracted.pages).toEqual([]);
    expect(extracted.warnings.join(" ")).toContain("readable text");
  }, 8_000);

  it("caps retained PDF objects before a tiny-object flood can amplify the map", () => {
    const tinyObjects = Array.from(
      { length: 10_001 },
      (_, index) => `${index + 1} 0 obj\n<<>>\nendobj`
    ).join("\n");
    const startedAt = performance.now();
    const extracted = extractPdfPagesDeterministically(
      Buffer.from(`%PDF-1.4\n${tinyObjects}\n%%EOF`, "latin1"),
      "tiny-object-flood.pdf"
    );

    expect(performance.now() - startedAt).toBeLessThan(6_000);
    expect(extracted.pages).toEqual([]);
    expect(extracted.warnings.join(" ")).toContain(
      "10000-object retention limit"
    );
  }, 8_000);
});
