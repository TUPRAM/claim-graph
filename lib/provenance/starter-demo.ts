import type { GraphNode, Snippet, Source } from "@/types/claimgraph";

export const STARTER_DEMO_SOURCE_NOTICE =
  "Sample starter source: this is curated demo scaffolding, not a fetched external citation. Add sources and rebuild before treating the node as evidence-backed.";

export const STARTER_DEMO_SNIPPET_NOTICE =
  "This snippet is sample starter scaffolding. It shows what source-backed evidence should cover, but it is not live research.";

export function isStarterDemoSnippet(snippet: Snippet) {
  return snippet.origin === "starter_curated";
}

export function isStarterDemoSource(source: Source, snippets: Snippet[] = []) {
  return source.domain === "demo.local" || snippets.some(isStarterDemoSnippet);
}

export function getStarterDemoSourceNotice(source: Source, snippets: Snippet[] = []) {
  return isStarterDemoSource(source, snippets) ? STARTER_DEMO_SOURCE_NOTICE : null;
}

export function getStarterDemoSnippetNotice(snippet: Snippet) {
  return isStarterDemoSnippet(snippet) ? STARTER_DEMO_SNIPPET_NOTICE : null;
}

export function buildNodeProvenanceCallout(input: {
  node: GraphNode | null;
  sources: Source[];
  snippets: Snippet[];
}) {
  if (!input.node) {
    return "Select a node to see exactly which sources and snippets support it.";
  }

  if (input.node.kind === "question") {
    return "Question nodes anchor the map and do not carry direct citations. Inspect the claims, counterclaims, evidence, and gaps to see source trails.";
  }

  if (!input.sources.length && !input.snippets.length) {
    return "No provenance is attached to this node yet. It should not be treated as grounded until sources and snippets are linked.";
  }

  const sourceTitles = input.sources
    .slice(0, 2)
    .map((source) => source.title)
    .join("; ");
  const starterSnippetCount = input.snippets.filter(isStarterDemoSnippet).length;
  const suffix =
    input.sources.length > 2 ? ` plus ${input.sources.length - 2} more source${input.sources.length - 2 === 1 ? "" : "s"}` : "";

  if (starterSnippetCount === input.snippets.length && input.snippets.length > 0) {
    return `Sample starter provenance: this node traces to ${sourceTitles}${suffix}. These are curated demo snippets, not fetched external citations.`;
  }

  return `Source trail: this node traces to ${sourceTitles || "linked sources"}${suffix}. Open the Evidence and Sources sections below to inspect snippets, source details, and limitations.`;
}
