import type { Snippet, SnippetOrigin, Source } from "@/types/claimgraph";
import {
  classifySourceTrustTier,
  getSourceTrustLabel
} from "@/lib/provenance/source-quality";

export type CleanedSnippetText = {
  text: string;
  publishedAt?: string;
  crawledAt?: string;
};

const PRIVATE_USE_CITATION_PATTERN = /\ue200cite\ue202[^\ue201]{1,160}\ue201/giu;
const MOJIBAKE_CITATION_PATTERN =
  /\u00ee\u02c6[\u0080-\u20ff]cite.{1,160}?\u00ee\u02c6[\u0080-\u20ff]/giu;
const WORD_LIMIT_PATTERN = /\[\s*wordlim\s*:\s*\d+\s*\]\s*/giu;
const PUBLISHED_PATTERN = /\bPublished:\s*([^;|]+)[;|]?\s*/iu;
const CRAWLED_PATTERN = /\bCrawled:\s*([^;|]+)[;|]?\s*/iu;
const WEB_SEARCH_BOILERPLATE_PATTERN =
  /(\ue200cite\ue202[^\ue201]{1,160}\ue201|\u00ee\u02c6[\u0080-\u20ff]cite.{1,160}?\u00ee\u02c6[\u0080-\u20ff]|\[\s*wordlim\s*:\s*\d+\s*\]|\bPublished:|\bCrawled:|\bContent type:|\bSource:\s*open\(|\bTotal lines:|\bRedirected to URL:)/iu;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function decodeCommonMojibake(value: string) {
  return value
    .replace(/\u00e2\u20ac[\u0153\u009d]/g, "\"")
    .replace(/\u00e2\u20ac[\u02dc\u2122]/g, "'")
    .replace(/\u00e2\u20ac[\u201c\u201d]/g, "-")
    .replace(/\u00e2\u20ac\u00a6/g, "...")
    .replace(/\u00c2\u00a0/g, " ")
    .replace(/\ufffd/g, "");
}

function extractLabel(pattern: RegExp, value: string) {
  const match = value.match(pattern);
  return match?.[1] ? normalizeWhitespace(match[1]) : undefined;
}

function stripWebSearchBoilerplate(value: string) {
  return value
    .replace(PRIVATE_USE_CITATION_PATTERN, " ")
    .replace(MOJIBAKE_CITATION_PATTERN, " ")
    .replace(WORD_LIMIT_PATTERN, " ")
    .replace(/\bContent type:\s*[^;|]+[;|]?\s*/giu, " ")
    .replace(/\bNumber of pages:\s*\d+[;|]?\s*/giu, " ")
    .replace(/\bSource:\s*open\(\{.*?\}\);?\s*/giu, " ")
    .replace(/\bRedirected to URL:\s*https?:\/\/\S+[;|]?\s*/giu, " ")
    .replace(/\bTotal lines:\s*\d+\s*/giu, " ")
    .replace(/\bL\d+(?:@P\d+(?:-\d+)?)?:\s*/giu, " ")
    .replace(/\bPublished:\s*[^;|]+[;|]?\s*/giu, " ")
    .replace(/\bCrawled:\s*[^;|]+[;|]?\s*/giu, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/^\s*[-:;|,]+/, " ")
    .replace(/\s+([.,;:])/g, "$1");
}

export function cleanPublicSnippetText(value: string | null | undefined): CleanedSnippetText {
  const original = normalizeWhitespace(value ?? "");

  if (!original) {
    return { text: "" };
  }

  const decoded = decodeCommonMojibake(original);
  const publishedAt = extractLabel(PUBLISHED_PATTERN, decoded);
  const crawledAt = extractLabel(CRAWLED_PATTERN, decoded);
  const cleaned = normalizeWhitespace(stripWebSearchBoilerplate(decoded));

  return {
    text: cleaned || (WEB_SEARCH_BOILERPLATE_PATTERN.test(decoded) ? "" : original),
    ...(publishedAt ? { publishedAt } : {}),
    ...(crawledAt ? { crawledAt } : {})
  };
}

export function formatPublicSnippetText(
  value: string | null | undefined,
  options?: {
    maxLength?: number;
  }
) {
  const cleaned = cleanPublicSnippetText(value).text;
  const maxLength = options?.maxLength;

  if (!maxLength || cleaned.length <= maxLength) {
    return cleaned;
  }

  const trimmed = cleaned.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
  return `${trimmed || cleaned.slice(0, maxLength).trim()}...`;
}

export function formatPublicProseText(
  value: string | null | undefined,
  options?: {
    maxLength?: number;
  }
) {
  return formatPublicSnippetText(value, options);
}

export function formatPublicSnippetRationale(
  rationale: string | null | undefined,
  origin?: SnippetOrigin
) {
  const cleaned = normalizeWhitespace(decodeCommonMojibake(rationale ?? ""));

  if (!cleaned) {
    return "Saved as supporting evidence for this map.";
  }

  if (
    /\bResponses API\b/i.test(cleaned) ||
    /\bevidence pass\b/i.test(cleaned) ||
    /web-search result/i.test(cleaned) ||
    /source-side web/i.test(cleaned) ||
    /model-cited web/i.test(cleaned) ||
    /model-authored cited web/i.test(cleaned) ||
    /model-authored cited web-summary/i.test(cleaned) ||
    /uploaded file search during/i.test(cleaned)
  ) {
    switch (origin) {
      case "web_search_result_excerpt":
        return "Saved evidence excerpt from the linked source.";
      case "web_search_result_summary":
        return "Saved source summary kept for inspection.";
      case "web_citation_summary_span":
        return "Saved cited-source summary kept with the source trail.";
      case "file_search_result":
      case "file_ingest_excerpt":
        return "Retrieved from an uploaded file used for this map.";
      case "url_ingest_excerpt":
        return "Extracted from a source URL used for this map.";
      default:
        return "Saved as supporting evidence for this map.";
    }
  }

  return cleaned
    .replace(/\bResponses API\b/gi, "source workflow")
    .replace(/\bevidence pass\b/gi, "source review")
    .replace(/\bweb-search result text returned by\b/gi, "source excerpt from")
    .replace(/\bweb-search result summary returned by\b/gi, "source summary from")
    .replace(/\blinked web result\b/gi, "linked source")
    .replace(/\bweb result\b/gi, "source result");
}

function getUrlPath(source: Source) {
  if (!source.url) {
    return "";
  }

  try {
    return new URL(source.url).pathname.toLowerCase();
  } catch {
    return source.url.toLowerCase();
  }
}

function looksLikePdf(source: Source) {
  const path = getUrlPath(source);
  return (
    path.endsWith(".pdf") ||
    source.fileName?.toLowerCase().endsWith(".pdf") ||
    /\bpdf\b/i.test(source.title)
  );
}

export function getPublicSourceKindLabel(source: Source) {
  if (looksLikePdf(source)) {
    return "PDF";
  }

  if (source.type === "file") {
    return source.sourceKind === "memo" ? "report" : "unknown";
  }

  const trustTier = classifySourceTrustTier(source);

  if (trustTier === "official_policy") {
    return "policy page";
  }

  if (trustTier === "report_research") {
    return "report";
  }

  if (source.type === "web") {
    return "web page";
  }

  return "unknown";
}

export function formatPublicSourceReference(source: Source) {
  const items = [getPublicSourceKindLabel(source)];

  if (source.fileName) {
    items.push(source.fileName);
  } else if (source.domain) {
    items.push(source.domain);
  }

  if (source.publishedAt) {
    items.push(`published ${source.publishedAt}`);
  }

  if (source.isPrimary) {
    items.push("primary");
  }

  return items.join(" / ");
}

export function buildPublicSourceLimitations(source: Source) {
  const flags: string[] = [];

  if (source.type === "web" && classifySourceTrustTier(source) === "unknown_thin") {
    flags.push(`${getSourceTrustLabel(source)} source`);
  }

  if (source.type === "web" && !source.publishedAt) {
    flags.push("publication date unavailable");
  }

  return flags;
}

export function buildPublicGraphSourceLimitations(sources: Source[]) {
  const webSources = sources.filter((source) => source.type === "web");

  if (!webSources.length) {
    return [] as string[];
  }

  const unknownThinCount = webSources.filter(
    (source) => classifySourceTrustTier(source) === "unknown_thin"
  ).length;
  const missingDateCount = webSources.filter((source) => !source.publishedAt).length;
  const trustSummary = webSources.reduce(
    (counts, source) => {
      const label = getSourceTrustLabel(source);
      counts.set(label, (counts.get(label) ?? 0) + 1);
      return counts;
    },
    new Map<string, number>()
  );
  const limitations: string[] = [];

  if (unknownThinCount) {
    limitations.push(
      `${unknownThinCount} web ${unknownThinCount === 1 ? "source" : "sources"} had thin metadata, so ClaimGraph could not classify source authority confidently.`
    );
  }

  if (missingDateCount) {
    limitations.push(
      `${missingDateCount} web ${missingDateCount === 1 ? "source" : "sources"} did not expose a publication date in the saved search metadata.`
    );
  }

  if (trustSummary.size) {
    limitations.push(
      `Source mix: ${Array.from(trustSummary.entries())
        .map(([label, count]) => `${count} ${label}`)
        .join(", ")}.`
    );
  }

  return limitations;
}

export function getSnippetPublicText(snippet: Snippet, options?: { maxLength?: number }) {
  return formatPublicSnippetText(snippet.text, options);
}
