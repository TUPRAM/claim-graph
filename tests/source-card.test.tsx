// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceCard } from "@/components/sidebar/SourceCard";
import type { Snippet, Source } from "@/types/claimgraph";

describe("SourceCard", () => {
  it("labels uploaded source-note material and its crawling limitation", () => {
    const source: Source = {
      id: "src_file_1",
      type: "file",
      title: "fcc-disclosure-scope.md",
      fileName: "fcc-disclosure-scope.md",
      sourceKind: "memo"
    };
    const snippets: Snippet[] = [
      {
        id: "snp_file_ingest_1",
        sourceId: source.id,
        text:
          "Evidence note 1: The FCC disclosure proposal is scoped to broadcast political ads.",
        rationale: "Deterministically extracted from the uploaded Markdown file.",
        relevance: 0.86,
        origin: "file_ingest_excerpt"
      }
    ];

    render(<SourceCard source={source} snippets={snippets} snippetCount={1} />);

    expect(screen.getByText("source note")).toBeTruthy();
    expect(
      screen.getByText(/app did not automatically crawl and verify the original pages/i)
    ).toBeTruthy();
  });
});
