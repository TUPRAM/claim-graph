import { describe, expect, it } from "vitest";
import {
  DefaultContentExtractionAdapter,
  MAX_EXTRACTED_URL_TEXT_CHARS,
  buildTextBlocks,
  selectRelevantTextBlockPassages
} from "@/lib/open-model/retrieval/content-extraction";

describe("selectRelevantTextBlockPassages", () => {
  it("extracts ordinary title and publication metadata", () => {
    const extracted = new DefaultContentExtractionAdapter().extract({
      url: "https://example.com/policy-review",
      contentType: "text/html; charset=utf-8",
      bodyText: [
        "<html><head>",
        '<meta property="og:title" content="Policy &amp; evidence review">',
        '<meta itemprop="datePublished" content="2026-07-15">',
        "</head><body><p>The policy review contains enough grounded evidence and implementation context for deterministic extraction.</p></body></html>"
      ].join("")
    });

    expect(extracted.title).toBe("Policy & evidence review");
    expect(extracted.publishedAt).toBe("2026-07-15");
  });

  it("prefers substantive evidence blocks over short markdown headings", () => {
    const blocks = buildTextBlocks(
      [
        "# Eval source pack: Should cities ban cars downtown?",
        "Question: Should cities ban cars downtown?",
        "Evidence note 1: Cities that ban cars downtown can reduce traffic volumes and improve street conditions in the restricted core, but measured air-quality changes may remain hard to attribute cleanly when wider background factors are moving at the same time.",
        "Evidence note 2: Cities that ban cars downtown can expose convenience-dependent retailers to access losses even when walkable districts help other shops, restaurants, and public-space users.",
        "Evidence note 3: Cities that ban cars downtown still need transit capacity, freight windows, disability access, boundary-street management, and enforcement support before a local outcome can be judged."
      ].join("\n\n")
    );

    const passages = selectRelevantTextBlockPassages({
      question: "Should cities ban cars downtown?",
      blocks,
      maxPassages: 3
    });

    expect(passages).toHaveLength(3);
    expect(passages.every((passage) => passage.text.startsWith("Evidence note"))).toBe(true);
  });

  it("downranks source-pack metadata when evidence notes are available", () => {
    const blocks = buildTextBlocks(
      [
        "Source basis:\n- CDC, School Start Times for Middle School and High School Students: https://www.cdc.gov/mmwr/preview/mmwrhtml/mm6430a1.htm\n- AAP/Pediatrics meta-analysis, School Start Times, Sleep, and Youth Outcomes: https://publications.aap.org/pediatrics/article/149/6/e2021054068/188062/School-Start-Times-Sleep-and-Youth-Outcomes-A-Meta",
        "Evidence note 1: Later school start times can improve adolescent sleep opportunity because school start time is a major weekday wake-time constraint and adolescent biological sleep timing often shifts later during puberty.",
        "Evidence note 2: Later school start times can create transportation, athletics, childcare, and family-schedule tradeoffs that matter before a district can treat the policy as practical.",
        "Evidence note 3: Later school start times leave a local implementation gap because bus capacity, funding, communication, and after-school coordination differ by district."
      ].join("\n\n")
    );

    const passages = selectRelevantTextBlockPassages({
      question: "Should schools start later?",
      blocks,
      maxPassages: 3
    });

    expect(passages).toHaveLength(3);
    expect(passages.every((passage) => passage.text.startsWith("Evidence note"))).toBe(true);
  });

  it("keeps source-basis blocks out of sparse school-start-time evidence selection", () => {
    const blocks = buildTextBlocks(
      [
        "Purpose: deterministic reviewer-provided source material for ClaimGraph live capture.",
        "Question: Should schools start later?",
        "Source basis:\n- CDC, School Start Times for Middle School and High School Students, United States, 2011-12 School Year: https://www.cdc.gov/mmwr/preview/mmwrhtml/mm6430a1.htm\n- CDC archived release, Most US middle and high schools start the school day too early: https://archive.cdc.gov/www_cdc_gov/media/releases/2015/p0806-school-sleep.html\n- American Academy of Sleep Medicine position statement, Delaying Middle School and High School Start Times Promotes Student Health and Performance: https://jcsm.aasm.org/doi/10.5664/jcsm.6558",
        "Evidence note 1: Later school start times can improve adolescent sleep opportunity. CDC summarizes the public-health rationale: adolescent sleep deprivation is common, biological sleep timing shifts later during puberty, and school start time is a major weekday wake-time constraint.",
        "Evidence note 2: Later school start times can plausibly support health, safety, attendance, and learning outcomes, but the strength of the evidence differs by outcome and should not be treated as equally strong for every downstream measure.",
        "Evidence note 3: Later school start times can create transportation, athletics, childcare, and family-schedule tradeoffs that matter before a district can treat the policy as practical."
      ].join("\n\n")
    );

    const passages = selectRelevantTextBlockPassages({
      question: "Should schools start later?",
      blocks,
      maxPassages: 3
    });

    expect(passages.map((passage) => passage.text.slice(0, 12))).toEqual([
      "Evidence not",
      "Evidence not",
      "Evidence not"
    ]);
    expect(passages.some((passage) => passage.text.startsWith("Source basis"))).toBe(false);
  });

  it("preserves explicit source-pack gap notes when overlap would crowd them out", () => {
    const blocks = buildTextBlocks(
      [
        "Evidence note 1: Remote and hybrid work can improve retention and employee satisfaction for some knowledge-work teams. The Trip.com randomized experiment found that a two-day-per-week hybrid schedule improved job satisfaction and reduced quit rates without damaging measured performance.",
        "Evidence note 2: Earlier experimental evidence from Ctrip found that selected call-center employees working from home improved measured performance and retention relative to office peers under controlled conditions.",
        "Evidence note 3: Survey-based work argues that working from home will persist because workers value commute savings and employers learned that some tasks can be done remotely.",
        "Evidence note 4: Fully remote defaults can weaken collaboration networks when coordination depends on cross-team ties and can make collaboration more static and siloed.",
        "Evidence note 5: The strongest disagreement is whether a company should make remote the default operating mode, or use hybrid office defaults to protect coordination and trust-building.",
        "Evidence note 6: The key unresolved gap is organizational fit. The evidence pack does not settle whether a specific company has remote-ready roles, reliable performance metrics, manager training, onboarding rituals, or enough in-person collaboration moments."
      ].join("\n\n")
    );

    const passages = selectRelevantTextBlockPassages({
      question: "Should companies default to remote work?",
      blocks,
      maxPassages: 3
    });

    expect(passages).toHaveLength(3);
    expect(
      passages.some((passage) =>
        passage.text.startsWith("Evidence note 6: The key unresolved gap")
      )
    ).toBe(true);
    expect(
      passages.some((passage) =>
        passage.text.startsWith("Evidence note 5: The strongest disagreement")
      )
    ).toBe(true);
  });

  it("suppresses repeated unclosed script-like HTML in bounded time", () => {
    const malformedSuppressedMarkup = Array.from(
      { length: 4_000 },
      (_, index) =>
        `<script data-index="${index}">ignored-${index}<style data-index="${index}">hidden-${index}`
    ).join("");
    const startedAt = performance.now();
    const extracted = new DefaultContentExtractionAdapter().extract({
      url: "https://example.com/adversarial",
      contentType: "text/html; charset=utf-8",
      bodyText: [
        "<html><body><p>Public transit evidence shows a measurable ridership benefit while preserving a clear implementation caveat for local review.</p>",
        malformedSuppressedMarkup
      ].join("")
    });

    expect(performance.now() - startedAt).toBeLessThan(4_000);
    expect(extracted.text.length).toBeLessThanOrEqual(
      MAX_EXTRACTED_URL_TEXT_CHARS
    );
    expect(extracted.text).toContain("Public transit evidence");
    expect(extracted.text).not.toContain("ignored-");
    expect(extracted.text).not.toContain("hidden-");
  }, 5_000);

  it("consumes repeated unterminated title metadata prefixes once", () => {
    const malformedMetadata = '<meta property="og:title" content="'.repeat(
      30_000
    );
    const startedAt = performance.now();
    const extracted = new DefaultContentExtractionAdapter().extract({
      url: "https://example.com/adversarial-title",
      contentType: "text/html; charset=utf-8",
      title: "Fallback title",
      bodyText: [
        "<html><body><p>Transit evidence remains readable and includes a substantive implementation caveat for independent review.</p>",
        malformedMetadata
      ].join("")
    });

    expect(performance.now() - startedAt).toBeLessThan(6_000);
    expect(extracted.title).toBe("Fallback title");
    expect(extracted.text).toContain("Transit evidence remains readable");
  }, 8_000);

  it("consumes repeated unterminated publication-date prefixes once", () => {
    const malformedDates = '<time datetime="'.repeat(50_000);
    const startedAt = performance.now();
    const extracted = new DefaultContentExtractionAdapter().extract({
      url: "https://example.com/adversarial-date",
      contentType: "text/html; charset=utf-8",
      bodyText: [
        "<html><head><title>Bounded metadata scan</title></head><body><p>Policy evidence stays available even when a malformed date suffix follows the article.</p>",
        malformedDates
      ].join("")
    });

    expect(performance.now() - startedAt).toBeLessThan(6_000);
    expect(extracted.title).toBe("Bounded metadata scan");
    expect(extracted.publishedAt).toBeUndefined();
    expect(extracted.text).toContain("Policy evidence stays available");
  }, 8_000);
});
