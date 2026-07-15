import type { SnippetOrigin, WorkspaceGraphPayload } from "@/types/claimgraph";

export type GraphSourceMode =
  | "starter"
  | "web_sourced"
  | "source_backed"
  | "mixed"
  | "live_without_sources";

const WEB_SEARCH_ORIGINS = new Set<SnippetOrigin>([
  "web_search_result_excerpt",
  "web_search_result_summary",
  "web_citation_summary_span"
]);

function hasWebSearchSnippet(payload: WorkspaceGraphPayload) {
  return payload.snippets.some((snippet) =>
    snippet.origin ? WEB_SEARCH_ORIGINS.has(snippet.origin) : false
  );
}

function hasUserProvidedSource(payload: WorkspaceGraphPayload) {
  return (
    payload.workspace.sourceUrls.length > 0 ||
    payload.files.length > 0 ||
    payload.sources.some((source) => source.type === "file")
  );
}

export function getGraphSourceMode(payload: WorkspaceGraphPayload): GraphSourceMode {
  if (payload.starterMode) {
    return "starter";
  }

  const hasWebSources = payload.sources.some((source) => source.type === "web");
  const hasWebSearchEvidence =
    hasWebSources &&
    (hasWebSearchSnippet(payload) ||
      payload.runtime.supportsWebSearch ||
      payload.graphBuild.mode === "full");
  const hasUserSources = hasUserProvidedSource(payload);

  if (hasWebSearchEvidence && hasUserSources) {
    return "mixed";
  }

  if (hasWebSearchEvidence && !hasUserSources) {
    return "web_sourced";
  }

  if (hasUserSources || payload.sources.length > 0) {
    return "source_backed";
  }

  return "live_without_sources";
}

export function getGraphSourceModeLabel(mode: GraphSourceMode) {
  switch (mode) {
    case "starter":
      return "Demo scaffold";
    case "web_sourced":
      return "Web-sourced graph";
    case "source_backed":
      return "Source-backed graph";
    case "mixed":
      return "Source-backed graph with web context";
    case "live_without_sources":
      return "Live graph";
  }
}

export function getGraphSourceCountLabel(
  mode: GraphSourceMode,
  sourceCount: number
) {
  const sourceWord = sourceCount === 1 ? "source" : "sources";

  switch (mode) {
    case "starter":
      return `${sourceCount} sample ${sourceWord}`;
    case "web_sourced":
      return `${sourceCount} web ${sourceWord}`;
    default:
      return `${sourceCount} ${sourceWord}`;
  }
}

export function getGraphSourceModeExportDescription(
  mode: GraphSourceMode
) {
  switch (mode) {
    case "starter":
      return "Sample starter scaffold. This graph is curated demo data, not live research; use it to inspect the product shell, then add sources and rebuild for an evidence-backed map.";
    case "web_sourced":
      return "Web-sourced graph. ClaimGraph generated this map from web search results and preserved source titles, snippets, and citation trails for inspection.";
    case "source_backed":
      return "Source-backed graph. ClaimGraph assembled this map from provided source links or uploaded files and preserved source titles, snippets, and citation trails for inspection.";
    case "mixed":
      return "Source-backed graph with web context. ClaimGraph combined provided sources with web search results and preserved source titles, snippets, and citation trails for inspection.";
    case "live_without_sources":
      return "Live graph without reusable source records. The map can be inspected, but this export cannot attach reusable source titles or snippets.";
  }
}
