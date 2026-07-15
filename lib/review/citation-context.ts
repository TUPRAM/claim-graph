import type { GraphNode, Source } from "@/types/claimgraph";
import {
  buildPublicSourceLimitations,
  formatPublicSourceReference
} from "@/lib/provenance/public-provenance";

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function readMetadataRecord(node: GraphNode | null | undefined) {
  if (!node?.metadata || typeof node.metadata !== "object") {
    return null;
  }

  return node.metadata as Record<string, unknown>;
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? normalizeWhitespace(item) : ""))
    .filter(Boolean);
}

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getLinkedSources(node: GraphNode | null | undefined, sources: Source[]) {
  if (!node) {
    return [] as Source[];
  }

  const sourceIds = new Set(node.sourceIds);
  return sources.filter((source) => sourceIds.has(source.id));
}

export function formatGapTypeLabel(value: string) {
  return normalizeWhitespace(value).replaceAll("_", " ");
}

export function formatSourceReference(source: Source) {
  return formatPublicSourceReference(source);
}

export function buildSourceReviewFlags(source: Source) {
  return buildPublicSourceLimitations(source);
}

export function getNodeQualifiers(node: GraphNode | null | undefined) {
  const metadata = readMetadataRecord(node);
  return toStringArray(metadata?.qualifiers);
}

export function getNodeGapType(node: GraphNode | null | undefined) {
  const metadata = readMetadataRecord(node);
  const gapType = metadata?.gapType;

  return typeof gapType === "string" && normalizeWhitespace(gapType)
    ? normalizeWhitespace(gapType)
    : null;
}

export function getNodeGapImportance(node: GraphNode | null | undefined) {
  const metadata = readMetadataRecord(node);
  return toFiniteNumber(metadata?.importance);
}

export function buildNodeReviewFlags(
  node: GraphNode | null | undefined,
  sources: Source[] = []
) {
  if (!node) {
    return [] as string[];
  }

  const flags: string[] = [];
  const qualifiers = getNodeQualifiers(node);
  const gapType = getNodeGapType(node);
  const linkedSources = getLinkedSources(node, sources);
  const linkedWebSources = linkedSources.filter((source) => source.type === "web");

  if (node.kind !== "question" && node.sourceIds.length === 1 && node.snippetIds.length === 1) {
    flags.push("thin grounding");
  }

  if (qualifiers.length) {
    flags.push(`${qualifiers.length} caveat${qualifiers.length === 1 ? "" : "s"}`);
  }

  if (gapType) {
    flags.push(formatGapTypeLabel(gapType));
  }

  if (
    linkedWebSources.some(
      (source) => !source.sourceKind || !source.publishedAt
    )
  ) {
    flags.push("source limits");
  }

  if (node.kind === "gap") {
    const importance = getNodeGapImportance(node);

    if (typeof importance === "number") {
      flags.push(`importance ${Math.round(importance * 100)}%`);
    }
  }

  return flags;
}

export function buildNodeReviewNotes(
  node: GraphNode | null | undefined,
  sources: Source[] = []
) {
  if (!node) {
    return [] as string[];
  }

  const notes: string[] = [];
  const gapType = getNodeGapType(node);
  const linkedSources = getLinkedSources(node, sources);
  const linkedWebSources = linkedSources.filter((source) => source.type === "web");

  if (node.kind !== "question" && node.sourceIds.length === 1 && node.snippetIds.length === 1) {
    notes.push("Thin grounding: this node currently depends on one snippet from one source.");
  }

  if (
    linkedWebSources.some(
      (source) => !source.sourceKind || !source.publishedAt
    )
  ) {
    notes.push(
      "Some source metadata is limited: source type or publication date could not be verified for every linked web source."
    );
  }

  switch (gapType) {
    case "insufficient_evidence":
      notes.push(
        "This blocker is explicit insufficient evidence, not hidden disagreement."
      );
      break;
    case "mixed_evidence":
      notes.push(
        "This blocker preserves mixed grounded evidence instead of collapsing the conflict."
      );
      break;
    case "missing_context":
      notes.push("This blocker remains unresolved because required context is still missing.");
      break;
    case "stale_evidence":
      notes.push("This blocker reflects evidence that may be stale for the current decision.");
      break;
    case "assumption_dependency":
      notes.push("This blocker remains an explicit assumption dependency.");
      break;
    default:
      break;
  }

  return notes;
}
