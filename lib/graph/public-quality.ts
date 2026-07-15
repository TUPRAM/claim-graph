import { getPrimaryCluster } from "@/lib/graph/score";
import {
  getGraphSourceMode,
  type GraphSourceMode
} from "@/lib/provenance/graph-source-mode";
import {
  classifySourceTrustTier,
  getSourceHostname,
  normalizeSourceDomain
} from "@/lib/provenance/source-quality";
import type { WorkspaceGraphPayload } from "@/types/claimgraph";

export type PublicGraphQualityLabel =
  | "Web-sourced graph"
  | "Needs disagreement"
  | "Thin web grounding"
  | "Sources found, conflict weak"
  | "Graph complete";

export interface PublicGraphQuality {
  label: PublicGraphQualityLabel;
  tone: "complete" | "warning";
  message: string;
  exportNote: string;
  sourceMode: GraphSourceMode;
  strongestDisagreementScore: number | null;
  hasCounterclaims: boolean;
  hasMeaningfulConflict: boolean;
  isThinGrounding: boolean;
  isConflictWeak: boolean;
}

const MIN_MEANINGFUL_CONFLICT_SCORE = 0.6;

function countNodes(payload: WorkspaceGraphPayload, kind: "claim" | "counterclaim" | "gap" | "evidence") {
  return payload.graph.nodes.filter((node) => node.kind === kind).length;
}

function isWebDerivedMode(mode: GraphSourceMode) {
  return mode === "web_sourced" || mode === "mixed";
}

function getUniqueWebDomainCount(payload: WorkspaceGraphPayload) {
  const domains = payload.sources
    .filter((source) => source.type === "web")
    .map((source) => getSourceHostname(source) || normalizeSourceDomain(source.domain))
    .filter(Boolean);

  return new Set(domains).size;
}

function getAuthoritativeWebSourceCount(payload: WorkspaceGraphPayload) {
  return payload.sources.filter((source) => {
    if (source.type !== "web") {
      return false;
    }

    const tier = classifySourceTrustTier(source);
    return tier === "official_policy" || tier === "report_research";
  }).length;
}

function hasThinWebGrounding(payload: WorkspaceGraphPayload, sourceMode: GraphSourceMode) {
  if (!isWebDerivedMode(sourceMode)) {
    return false;
  }

  const webSourceCount = payload.sources.filter((source) => source.type === "web").length;
  const webSnippetCount = payload.snippets.filter((snippet) =>
    payload.sources.some((source) => source.type === "web" && source.id === snippet.sourceId)
  ).length;
  const uniqueDomainCount = getUniqueWebDomainCount(payload);
  const authoritativeSourceCount = getAuthoritativeWebSourceCount(payload);

  return (
    webSourceCount < 2 ||
    webSnippetCount < 2 ||
    uniqueDomainCount < 2 ||
    authoritativeSourceCount < 1
  );
}

export function assessPublicGraphQuality(payload: WorkspaceGraphPayload): PublicGraphQuality {
  const sourceMode = getGraphSourceMode(payload);
  const primaryCluster = getPrimaryCluster(payload.graph);
  const strongestDisagreementScore = primaryCluster?.score ?? null;
  const hasCounterclaims = countNodes(payload, "counterclaim") > 0;
  const hasClaim = countNodes(payload, "claim") > 0;
  const hasMeaningfulConflict =
    hasClaim &&
    hasCounterclaims &&
    strongestDisagreementScore !== null &&
    strongestDisagreementScore >= MIN_MEANINGFUL_CONFLICT_SCORE;
  const isConflictWeak =
    hasClaim &&
    hasCounterclaims &&
    strongestDisagreementScore !== null &&
    strongestDisagreementScore < MIN_MEANINGFUL_CONFLICT_SCORE;
  const isThinGrounding = hasThinWebGrounding(payload, sourceMode);

  if (!hasMeaningfulConflict) {
    if (isConflictWeak) {
      return {
        label: "Sources found, conflict weak",
        tone: "warning",
        message:
          "The map has sourced branches, but the main disagreement is not strong enough to treat as settled.",
        exportNote:
          "Sources were preserved, but the main disagreement score is weak. Treat this export as a starting map, not a complete conflict readout.",
        sourceMode,
        strongestDisagreementScore,
        hasCounterclaims,
        hasMeaningfulConflict,
        isThinGrounding,
        isConflictWeak
      };
    }

    return {
      label: "Needs disagreement",
      tone: "warning",
      message:
        "The map is inspectable, but it has not found a meaningful main conflict yet.",
      exportNote:
        "The graph does not yet contain a grounded, meaningful claim-versus-counterclaim conflict. Use the sources and gaps as leads before relying on the map.",
      sourceMode,
      strongestDisagreementScore,
      hasCounterclaims,
      hasMeaningfulConflict,
      isThinGrounding,
      isConflictWeak
    };
  }

  if (isThinGrounding) {
    return {
      label: "Thin web grounding",
      tone: "warning",
      message:
        "The conflict is visible, but the preserved web source mix is narrow or light.",
      exportNote:
        "The graph has a visible disagreement, but the preserved web sources are thin, repetitive, or missing an authoritative source class.",
      sourceMode,
      strongestDisagreementScore,
      hasCounterclaims,
      hasMeaningfulConflict,
      isThinGrounding,
      isConflictWeak
    };
  }

  if (isWebDerivedMode(sourceMode)) {
    return {
      label: "Web-sourced graph",
      tone: "complete",
      message: "The map is ready to inspect with web source trails.",
      exportNote:
        "The graph preserves web source titles, snippets, and citation trails for inspection.",
      sourceMode,
      strongestDisagreementScore,
      hasCounterclaims,
      hasMeaningfulConflict,
      isThinGrounding,
      isConflictWeak
    };
  }

  return {
    label: "Graph complete",
    tone: "complete",
    message: "The map is ready to inspect.",
    exportNote: "The map was ready to inspect when this export was created.",
    sourceMode,
    strongestDisagreementScore,
    hasCounterclaims,
    hasMeaningfulConflict,
    isThinGrounding,
    isConflictWeak
  };
}
