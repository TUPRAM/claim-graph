import type { ClaimGraph, RunMetrics } from "@/types/claimgraph";

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function computeDisagreementScore(input: {
  contradictionStrength: number;
  evidenceBalance: number;
  sourceDiversity: number;
  topicRelevance: number;
  claimConfidenceBalance?: number;
  gapPressure?: number;
  oppositionClarity?: number;
}) {
  const baseScore =
    0.3 * input.contradictionStrength +
    0.2 * input.evidenceBalance +
    0.15 * input.sourceDiversity +
    0.15 * input.topicRelevance +
    0.1 * (input.claimConfidenceBalance ?? 0) +
    0.1 * (input.gapPressure ?? 0);
  const clarityMultiplier = 0.45 + 0.55 * clamp(input.oppositionClarity ?? 1);
  const score = baseScore * clarityMultiplier;

  return clamp(Number(score.toFixed(3)));
}

export function computeRunMetrics(graph: ClaimGraph, sourceCount: number, snippetCount: number): RunMetrics {
  const claimCount = graph.nodes.filter((node) => node.kind === "claim").length;
  const counterclaimCount = graph.nodes.filter((node) => node.kind === "counterclaim").length;
  const evidenceCount = graph.nodes.filter((node) => node.kind === "evidence").length;
  const gapCount = graph.nodes.filter((node) => node.kind === "gap").length;
  const strongestDisagreementScore =
    graph.disagreementClusters.reduce((max, cluster) => Math.max(max, cluster.score), 0) || undefined;

  return {
    sourceCount,
    snippetCount,
    claimCount,
    counterclaimCount,
    evidenceCount,
    gapCount,
    totalNodeCount: graph.nodes.length,
    strongestDisagreementScore
  };
}

export function getPrimaryCluster(graph: ClaimGraph) {
  if (!graph.disagreementClusters.length) {
    return null;
  }

  if (graph.primaryClusterId) {
    return graph.disagreementClusters.find((cluster) => cluster.id === graph.primaryClusterId) ?? graph.disagreementClusters[0];
  }

  return [...graph.disagreementClusters].sort((left, right) => right.score - left.score)[0];
}
