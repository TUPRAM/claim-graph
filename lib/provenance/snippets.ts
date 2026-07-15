import type {
  EvidenceGroundingStatus,
  EvidencePack,
  Snippet,
  SnippetOrigin,
  Source
} from "@/types/claimgraph";

export function resolveSnippetOrigin(
  snippet: Snippet,
  source?: Source | null
): SnippetOrigin {
  if (snippet.origin) {
    return snippet.origin;
  }

  if (!source) {
    return "unknown";
  }

  if (source.type === "file") {
    return "file_search_result";
  }

  if (
    typeof snippet.offsetStart === "number" ||
    typeof snippet.offsetEnd === "number"
  ) {
    return "web_citation_summary_span";
  }

  if (source.type === "web") {
    return "web_search_result_excerpt";
  }

  return "unknown";
}

export function getSnippetOriginLabel(origin: SnippetOrigin) {
  switch (origin) {
    case "starter_curated":
      return "demo snippet";
    case "file_search_result":
      return "file excerpt";
    case "file_ingest_excerpt":
      return "file excerpt";
    case "web_search_result_excerpt":
      return "source excerpt";
    case "web_search_result_summary":
      return "source summary";
    case "web_citation_summary_span":
      return "cited source summary";
    case "url_ingest_excerpt":
      return "source URL excerpt";
    default:
      return "origin unknown";
  }
}

export function getSnippetOriginDescription(origin: SnippetOrigin) {
  switch (origin) {
    case "starter_curated":
      return "Curated starter demo content. It is visible sample scaffolding, not a fetched external citation.";
    case "file_search_result":
      return "Extracted from an uploaded file used for this map.";
    case "file_ingest_excerpt":
      return "Extracted from an uploaded file used for this map.";
    case "web_search_result_excerpt":
      return "Saved evidence excerpt from the linked source.";
    case "web_search_result_summary":
      return "Saved source summary kept for inspection.";
    case "web_citation_summary_span":
      return "Saved cited-source summary kept with the source trail. Open the source to inspect the original page.";
    case "url_ingest_excerpt":
      return "Extracted from a source URL used for this map.";
    default:
      return "The stored snippet origin could not be verified from the persisted record.";
  }
}

export function getEvidenceGroundingStatus(
  evidencePack: EvidencePack
): EvidenceGroundingStatus {
  if (evidencePack.groundingStatus) {
    return evidencePack.groundingStatus;
  }

  return evidencePack.sources.length > 0 && evidencePack.snippets.length > 0
    ? "grounded"
    : "insufficient_grounding";
}
