import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestUrlsDeterministically } from "@/lib/open-model/retrieval/url-ingestion";
import { DefaultUrlFetchAdapter } from "@/lib/open-model/retrieval/url-fetch";
import type { UrlFetchAdapter } from "@/lib/open-model/retrieval/types";

const originalFetch = global.fetch;

function getTestUrlFetchAdapter(): UrlFetchAdapter {
  return {
    kind: "url-fetch",
    async fetch(url, signal) {
      const response = await fetch(url, { signal });

      return {
        url,
        resolvedUrl: response.url || url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        title: new URL(url).hostname,
        bodyText: await response.text()
      };
    }
  };
}

describe("ingestUrlsDeterministically", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("preserves source metadata and auditable offsets for readable article URLs", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        [
          "<html><head>",
          '<meta property="og:title" content="Downtown Freight Review" />',
          '<meta property="article:published_time" content="2026-03-02" />',
          "<title>Ignore this title</title>",
          "</head><body>",
          "<article>",
          "<p>City engineers found the freight corridor preserved loading access for morning deliveries while bus lanes reduced idle traffic across downtown.</p>",
          "<p>A retail survey recorded stronger midday foot traffic after the pilot and kept the business case contested.</p>",
          "</article>",
          "</body></html>"
        ].join(""),
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      )
    ) as typeof fetch;

    const result = await ingestUrlsDeterministically({
      question: "How did the freight corridor affect loading access downtown?",
      urls: ["https://city.gov/reports/freight-review"],
      maxUrls: 3,
      urlFetchAdapter: getTestUrlFetchAdapter()
    });

    expect(result.warnings).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      type: "web",
      title: "Downtown Freight Review",
      url: "https://city.gov/reports/freight-review",
      domain: "city.gov",
      sourceKind: "government",
      isPrimary: true,
      publishedAt: "2026-03-02"
    });
    expect(result.snippets[0]).toMatchObject({
      origin: "url_ingest_excerpt",
      offsetStart: 0
    });
    expect(typeof result.snippets[0]?.offsetEnd).toBe("number");
    expect(result.snippets[0]?.text).toContain("freight corridor preserved loading access");
  });

  it("decodes numeric HTML entities in deterministic URL snippets", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        [
          "<html><head>",
          '<meta property="og:title" content="Design governance review" />',
          "</head><body>",
          "<article>",
          "<p>Centralized teams can create &#8220;top-down&#8221; systems that don&#8217;t match product needs, while hybrid governance can keep shared standards and local feedback connected.</p>",
          "<p>Product teams still need clear contribution criteria so reusable components do not drift from accessibility and brand rules.</p>",
          "</article>",
          "</body></html>"
        ].join(""),
        {
          status: 200,
          headers: {
            "Content-Type": "text/html"
          }
        }
      )
    ) as typeof fetch;

    const result = await ingestUrlsDeterministically({
      question: "Should product teams centralize design systems?",
      urls: ["https://design.example.org/governance"],
      maxUrls: 3,
      urlFetchAdapter: getTestUrlFetchAdapter()
    });

    expect(result.warnings).toEqual([]);
    expect(result.snippets[0]?.text).toContain("Centralized teams can create");
    expect(result.snippets[0]?.text).toContain("top-down");
    expect(result.snippets[0]?.text).toContain("match product needs");
    expect(result.snippets[0]?.text).not.toContain("&#8220;");
    expect(result.snippets[0]?.text).not.toContain("&#8217;");
  });

  it("keeps weak URL extraction honest with source-specific warnings", async () => {
    global.fetch = vi.fn(async () =>
      new Response("<html><body><nav>Home</nav><p>legend</p></body></html>", {
        status: 200,
        headers: {
          "Content-Type": "text/html"
        }
      })
    ) as typeof fetch;

    const result = await ingestUrlsDeterministically({
      question: "Should cities ban cars downtown?",
      urls: ["https://example.com/noisy-note"],
      maxUrls: 3,
      urlFetchAdapter: getTestUrlFetchAdapter()
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      url: "https://example.com/noisy-note",
      sourceKind: "company",
      isPrimary: true
    });
    expect(result.snippets).toEqual([]);
    expect(result.warnings.join(" ")).toContain(
      "example.com (https://example.com/noisy-note): The fetched page did not yield enough readable text for deterministic open-model grounding."
    );
  });

  it("does not echo rejected URL credentials into retrieval warnings", async () => {
    const result = await ingestUrlsDeterministically({
      question: "Should cities ban cars downtown?",
      urls: ["https://sensitive-user:sensitive-pass@example.com/report"],
      maxUrls: 1,
      urlFetchAdapter: new DefaultUrlFetchAdapter({
        lookup: async () => [{ address: "93.184.216.34", family: 4 }]
      })
    });

    expect(result.sources).toEqual([]);
    expect(result.warnings.join(" ")).toContain("https://example.com/report");
    expect(result.warnings.join(" ")).not.toContain("sensitive-user");
    expect(result.warnings.join(" ")).not.toContain("sensitive-pass");
  });
});
