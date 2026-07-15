import { computeDisagreementScore } from "@/lib/graph/score";
import { buildEvidenceNodeTitle } from "@/lib/provenance/source-notes";
import {
  claimGraphSchema,
  validateClaimGraphArtifacts
} from "@/lib/validation/claim-graph";
import type {
  ClaimGraph,
  ClaimInventory,
  ClaimUnit,
  DisagreementCluster,
  EvidencePack,
  GapUnit,
  GraphEdge,
  GraphNode,
  Snippet,
  Source
} from "@/types/claimgraph";

export interface GraphAssemblyPlan {
  graphSummary: string;
  claimSelections: Array<{
    claimId: string;
    importance: number;
  }>;
  gapSelections: Array<{
    gapId: string;
    importance: number;
  }>;
  claimRelations: Array<{
    fromClaimId: string;
    toClaimId: string;
    relation: "refutes" | "qualifies";
    strength: number;
  }>;
  gapRelations: Array<{
    gapId: string;
    claimId: string;
    relation: "depends_on" | "qualifies";
    strength: number;
  }>;
  disagreementClusters: Array<{
    contradictionPairId: string;
    title: string;
    explanation: string;
    topicRelevance: number;
  }>;
}

interface ClusterCandidate {
  id: string;
  pairId: string;
  leftClaimId: string;
  rightClaimId: string;
  title: string;
  explanation: string;
  topicRelevance: number;
  score: number;
  sourceIds: string[];
  snippetIds: string[];
}

const QUESTION_NODE_ID = "question_root";
const MAX_ARGUMENT_NODES = 6;
const MAX_GAP_NODES = 4;
const MAX_EVIDENCE_PER_CLAIM = 2;
const MAX_EVIDENCE_PER_GAP = 1;
const MAX_CLUSTER_COUNT = 4;
const MAX_TOTAL_NODES = 25;
const EMPTY_ASSEMBLY_PLAN: GraphAssemblyPlan = {
  graphSummary: "",
  claimSelections: [],
  gapSelections: [],
  claimRelations: [],
  gapRelations: [],
  disagreementClusters: []
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function tokenize(value: string) {
  return uniqueStrings(
    normalizeWhitespace(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
}

function overlapRatio(left: string[], right: string[]) {
  if (!left.length || !right.length) {
    return 0;
  }

  const rightSet = new Set(right);
  const sharedCount = left.filter((value) => rightSet.has(value)).length;

  return sharedCount / Math.min(left.length, right.length);
}

function titleCaseTopic(value: string) {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    return "General";
  }

  return normalized
    .split(" ")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function truncate(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function claimPriorityScore(claim: ClaimUnit, modelImportance: number) {
  const contradictionBonus = claim.kind === "counterclaim" ? 0.03 : 0;
  const evidenceQualityBonus =
    claim.evidenceQuality === "high"
      ? 0.08
      : claim.evidenceQuality === "medium"
        ? 0.04
        : 0;
  const snippetBonus = Math.min(0.08, claim.snippetIds.length * 0.02);
  const dependencyBonus = Math.min(0.06, claim.dependsOnGapIds.length * 0.03);
  const lowEvidencePenalty = claim.evidenceQuality === "low" ? 0.05 : 0;

  return clamp01(
    modelImportance +
      claim.confidence * 0.35 +
      evidenceQualityBonus +
      snippetBonus +
      contradictionBonus +
      dependencyBonus -
      lowEvidencePenalty
  );
}

function computeEvidenceBalance(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  const leftCount = leftClaim.snippetIds.length;
  const rightCount = rightClaim.snippetIds.length;

  if (!leftCount || !rightCount) {
    return 0;
  }

  return clamp01(Math.min(leftCount, rightCount) / Math.max(leftCount, rightCount));
}

function computeConfidenceBalance(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  const leftConfidence = clamp01(leftClaim.confidence);
  const rightConfidence = clamp01(rightClaim.confidence);

  if (!leftConfidence || !rightConfidence) {
    return 0;
  }

  return clamp01(
    Math.min(leftConfidence, rightConfidence) /
      Math.max(leftConfidence, rightConfidence)
  );
}

function computeSourceDiversity(sourceIds: string[]) {
  return clamp01(sourceIds.length / 4);
}

function computeGapPressure(
  gapIds: string[],
  gapById: Map<string, GapUnit>
) {
  const importances = uniqueStrings(gapIds)
    .map((gapId) => gapById.get(gapId)?.importance ?? 0)
    .filter((importance) => importance > 0)
    .sort((left, right) => right - left)
    .slice(0, 2);

  if (!importances.length) {
    return 0;
  }

  if (importances.length === 1) {
    return clamp01(importances[0] * 0.65);
  }

  return clamp01(importances[0] * 0.65 + importances[1] * 0.35);
}

function computeTopicAlignment(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  const leftTopic = normalizeWhitespace(leftClaim.topic).toLowerCase();
  const rightTopic = normalizeWhitespace(rightClaim.topic).toLowerCase();

  if (!leftTopic || !rightTopic) {
    return 0.35;
  }

  if (leftTopic === rightTopic) {
    return 1;
  }

  const overlap = overlapRatio(tokenize(leftTopic), tokenize(rightTopic));

  if (overlap >= 0.75) {
    return 0.9;
  }

  if (overlap >= 0.5) {
    return 0.78;
  }

  if (overlap > 0) {
    return 0.58;
  }

  return 0.22;
}

function computeDependencyAlignment(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  const leftGapIds = uniqueStrings(leftClaim.dependsOnGapIds);
  const rightGapIds = uniqueStrings(rightClaim.dependsOnGapIds);

  if (!leftGapIds.length && !rightGapIds.length) {
    return 0.5;
  }

  if (!leftGapIds.length || !rightGapIds.length) {
    return 0.28;
  }

  const overlap = overlapRatio(leftGapIds, rightGapIds);

  if (overlap >= 0.75) {
    return 1;
  }

  if (overlap >= 0.5) {
    return 0.82;
  }

  if (overlap > 0) {
    return 0.64;
  }

  return 0.24;
}

function computeOppositionClarity(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  let explicitOpposition = 0.2;

  if (leftClaim.kind !== rightClaim.kind) {
    explicitOpposition = 1;
  } else if (
    (leftClaim.stance === "pro" && rightClaim.stance === "con") ||
    (leftClaim.stance === "con" && rightClaim.stance === "pro")
  ) {
    explicitOpposition = 0.88;
  } else if (
    leftClaim.stance === rightClaim.stance &&
    leftClaim.stance !== "mixed" &&
    leftClaim.stance !== "unknown"
  ) {
    explicitOpposition = 0.08;
  } else if (
    leftClaim.stance === "mixed" ||
    rightClaim.stance === "mixed" ||
    leftClaim.stance === "unknown" ||
    rightClaim.stance === "unknown"
  ) {
    explicitOpposition = 0.35;
  }

  return clamp01(
    explicitOpposition * 0.55 +
      computeTopicAlignment(leftClaim, rightClaim) * 0.3 +
      computeDependencyAlignment(leftClaim, rightClaim) * 0.15
  );
}

function inferTopicRelevance(leftClaim: ClaimUnit, rightClaim: ClaimUnit, question: string) {
  const questionTokens = new Set(
    normalizeWhitespace(question)
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
  const topicTokens = new Set(
    `${leftClaim.topic} ${rightClaim.topic}`
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4)
  );
  let overlap = 0;

  for (const token of topicTokens) {
    if (questionTokens.has(token)) {
      overlap += 1;
    }
  }

  if (normalizeWhitespace(leftClaim.topic).toLowerCase() === normalizeWhitespace(rightClaim.topic).toLowerCase()) {
    return clamp01(Math.max(0.6, overlap ? 0.65 + overlap * 0.1 : 0.65));
  }

  return clamp01(Math.max(0.45, overlap ? 0.55 + overlap * 0.08 : 0.5));
}

function buildDefaultClusterTitle(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  return `Disagreement on ${titleCaseTopic(leftClaim.topic || rightClaim.topic)}`;
}

function buildDefaultClusterExplanation(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  return `${leftClaim.title} conflicts with ${rightClaim.title}, and both sides retain grounded support in the saved sources.`;
}

function includesInternalArtifactId(value: string) {
  return /\b(?:claim|counterclaim|gap|pair|cluster|snp|src|cl|ct|ev|gp)[_-][a-z0-9_]+\b/i.test(
    value
  );
}

function chooseClusterExplanation(input: {
  plannedExplanation?: string;
  pairExplanation?: string;
  leftClaim: ClaimUnit;
  rightClaim: ClaimUnit;
}) {
  const plannedExplanation = normalizeWhitespace(input.plannedExplanation ?? "");
  const pairExplanation = normalizeWhitespace(input.pairExplanation ?? "");

  if (plannedExplanation && !includesInternalArtifactId(plannedExplanation)) {
    return plannedExplanation;
  }

  if (pairExplanation && !includesInternalArtifactId(pairExplanation)) {
    return pairExplanation;
  }

  return buildDefaultClusterExplanation(input.leftClaim, input.rightClaim);
}

function getReadableClaimTitle(input: {
  claimId: string;
  claimById: Map<string, ClaimUnit>;
  nodeById: Map<string, GraphNode>;
}) {
  return (
    input.claimById.get(input.claimId)?.title ||
    input.nodeById.get(input.claimId)?.title ||
    input.claimId
  );
}

function buildFallbackClusterExplanationFromTitles(
  leftTitle: string,
  rightTitle: string
) {
  return `${leftTitle} conflicts with ${rightTitle}, and both sides retain grounded support in the saved sources.`;
}

function sanitizeExistingDisagreementClusters(input: {
  graph: ClaimGraph;
  claimInventory: ClaimInventory | null;
}) {
  if (!input.graph.disagreementClusters.length) {
    return input.graph;
  }

  const claimById = new Map(
    (input.claimInventory?.claims ?? []).map((claim) => [claim.id, claim])
  );
  const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  let changed = false;
  const disagreementClusters = input.graph.disagreementClusters.map((cluster) => {
    const [leftClaimId, rightClaimId] = cluster.claimIds;
    const leftClaim = claimById.get(leftClaimId);
    const rightClaim = claimById.get(rightClaimId);
    const leftTitle = getReadableClaimTitle({
      claimId: leftClaimId,
      claimById,
      nodeById
    });
    const rightTitle = getReadableClaimTitle({
      claimId: rightClaimId,
      claimById,
      nodeById
    });
    const title = normalizeWhitespace(cluster.title);
    const explanation = normalizeWhitespace(cluster.explanation);

    if (
      !includesInternalArtifactId(title) &&
      !includesInternalArtifactId(explanation)
    ) {
      return cluster;
    }

    changed = true;

    return {
      ...cluster,
      title: includesInternalArtifactId(title)
        ? leftClaim && rightClaim
          ? buildDefaultClusterTitle(leftClaim, rightClaim)
          : truncate(`${leftTitle} vs. ${rightTitle}`, 96)
        : cluster.title,
      explanation:
        !includesInternalArtifactId(explanation)
          ? cluster.explanation
          : leftClaim && rightClaim
          ? buildDefaultClusterExplanation(leftClaim, rightClaim)
          : buildFallbackClusterExplanationFromTitles(leftTitle, rightTitle)
    };
  });

  if (!changed) {
    return input.graph;
  }

  return claimGraphSchema.parse({
    ...input.graph,
    disagreementClusters
  }) as ClaimGraph;
}

function buildDefaultGraphSummary(input: {
  question: string;
  claims: ClaimUnit[];
  gaps: GapUnit[];
  claimById: Map<string, ClaimUnit>;
  primaryCluster: DisagreementCluster | null;
}) {
  const leadClaims = input.claims.slice(0, 2).map((claim) => claim.title);
  const gap = input.gaps[0];

  if (input.primaryCluster) {
    const [leftClaimId, rightClaimId] = input.primaryCluster.claimIds;
    const leftClaim = input.claimById.get(leftClaimId)?.title ?? leftClaimId;
    const rightClaim = input.claimById.get(rightClaimId)?.title ?? rightClaimId;

    return [
      `The live graph centers the strongest disagreement between ${leftClaim} and ${rightClaim}.`,
      gap ? `The main unresolved dependency is ${gap.title.toLowerCase()}.` : null,
      leadClaims.length
        ? `The visible graph keeps the most decision-relevant claims grounded in the saved sources.`
        : null
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (leadClaims.length) {
    return [
      `The live graph highlights ${leadClaims.join(" and ")} as the strongest grounded branches for this question.`,
      gap ? `The main unresolved dependency is ${gap.title.toLowerCase()}.` : null
    ]
      .filter(Boolean)
      .join(" ");
  }

  return `The live graph stays conservative because the available source trail for "${input.question}" contains limited grounded disagreement.`;
}

function chooseGraphSummary(input: {
  plannedSummary?: string;
  question: string;
  claims: ClaimUnit[];
  gaps: GapUnit[];
  claimById: Map<string, ClaimUnit>;
  primaryCluster: DisagreementCluster | null;
}) {
  const plannedSummary = normalizeWhitespace(input.plannedSummary ?? "");

  if (plannedSummary && !includesInternalArtifactId(plannedSummary)) {
    return plannedSummary;
  }

  return buildDefaultGraphSummary({
    question: input.question,
    claims: input.claims,
    gaps: input.gaps,
    claimById: input.claimById,
    primaryCluster: input.primaryCluster
  });
}

function buildQuestionNode(question: string): GraphNode {
  return {
    id: QUESTION_NODE_ID,
    kind: "question",
    title: question,
    summary:
      "The root question anchors the source-backed argument map and keeps every branch tied to the question.",
    sourceIds: [],
    snippetIds: []
  };
}

function buildClaimNode(claim: ClaimUnit): GraphNode {
  return {
    id: claim.id,
    kind: claim.kind,
    title: claim.title,
    summary: claim.summary,
    topic: claim.topic,
    stance: claim.stance,
    confidence: claim.confidence,
    sourceIds: uniqueStrings(claim.sourceIds),
    snippetIds: uniqueStrings(claim.snippetIds),
    metadata: claim.qualifiers.length
      ? {
          qualifiers: claim.qualifiers
        }
      : undefined
  };
}

function buildGapNode(gap: GapUnit): GraphNode {
  return {
    id: gap.id,
    kind: "gap",
    title: gap.title,
    summary: gap.summary,
    topic: titleCaseTopic(gap.gapType.replaceAll("_", " ")),
    confidence: gap.importance,
    sourceIds: uniqueStrings(gap.sourceIds),
    snippetIds: uniqueStrings(gap.snippetIds),
    metadata: {
      gapType: gap.gapType,
      importance: gap.importance
    }
  };
}

function buildEvidenceNode(input: {
  snippet: Snippet;
  source: Source;
  targetNodeId: string;
}): GraphNode {
  return {
    id: `evidence_${input.snippet.id}`,
    kind: "evidence",
    title: buildEvidenceNodeTitle({
      snippet: input.snippet,
      source: input.source
    }),
    summary: truncate(input.snippet.text, 240),
    sourceIds: [input.source.id],
    snippetIds: [input.snippet.id],
    metadata: {
      targetNodeId: input.targetNodeId,
      sourceType: input.source.type,
      rationale: input.snippet.rationale
    }
  };
}

function buildQuestionEdge(claim: ClaimUnit): GraphEdge {
  return {
    id: `edge_question_${claim.id}`,
    from: claim.id,
    to: QUESTION_NODE_ID,
    relation: claim.kind === "counterclaim" ? "refutes" : "supports",
    strength: clamp01(Math.max(0.55, claim.confidence))
  };
}

function pickRefuteOrientation(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  if (leftClaim.kind === "counterclaim" && rightClaim.kind !== "counterclaim") {
    return { from: leftClaim.id, to: rightClaim.id };
  }

  if (rightClaim.kind === "counterclaim" && leftClaim.kind !== "counterclaim") {
    return { from: rightClaim.id, to: leftClaim.id };
  }

  return { from: rightClaim.id, to: leftClaim.id };
}

function buildClusterCandidates(input: {
  question: string;
  claimInventory: ClaimInventory;
  plan: GraphAssemblyPlan;
}) {
  const claimById = new Map(input.claimInventory.claims.map((claim) => [claim.id, claim]));
  const gapById = new Map(
    input.claimInventory.unresolvedGaps.map((gap) => [gap.id, gap])
  );
  const planClusterByPairId = new Map(
    input.plan.disagreementClusters.map((cluster) => [cluster.contradictionPairId, cluster])
  );
  const candidates: ClusterCandidate[] = [];

  for (const pair of input.claimInventory.contradictionPairs) {
    const leftClaim = claimById.get(pair.leftClaimId);
    const rightClaim = claimById.get(pair.rightClaimId);

    if (!leftClaim || !rightClaim) {
      continue;
    }

    const plannedCluster = planClusterByPairId.get(pair.id);
    const sourceIds = uniqueStrings([...leftClaim.sourceIds, ...rightClaim.sourceIds]);
    const snippetIds = uniqueStrings([...leftClaim.snippetIds, ...rightClaim.snippetIds]);
    const gapPressure = computeGapPressure(
      [...leftClaim.dependsOnGapIds, ...rightClaim.dependsOnGapIds],
      gapById
    );
    const oppositionClarity = computeOppositionClarity(leftClaim, rightClaim);
    const topicRelevance =
      plannedCluster?.topicRelevance ?? inferTopicRelevance(leftClaim, rightClaim, input.question);
    const score = computeDisagreementScore({
      contradictionStrength: pair.contradictionStrength,
      evidenceBalance: computeEvidenceBalance(leftClaim, rightClaim),
      sourceDiversity: computeSourceDiversity(sourceIds),
      topicRelevance,
      claimConfidenceBalance: computeConfidenceBalance(leftClaim, rightClaim),
      gapPressure,
      oppositionClarity
    });

    candidates.push({
      id: `cluster_${pair.id}`,
      pairId: pair.id,
      leftClaimId: pair.leftClaimId,
      rightClaimId: pair.rightClaimId,
      title:
        normalizeWhitespace(plannedCluster?.title ?? "") ||
        buildDefaultClusterTitle(leftClaim, rightClaim),
      explanation: chooseClusterExplanation({
        plannedExplanation: plannedCluster?.explanation,
        pairExplanation: pair.explanation,
        leftClaim,
        rightClaim
      }),
      topicRelevance,
      score,
      sourceIds,
      snippetIds
    });
  }

  return candidates.sort(
    (left, right) => right.score - left.score || left.title.localeCompare(right.title)
  );
}

function selectClaims(input: {
  claimInventory: ClaimInventory;
  plan: GraphAssemblyPlan;
  clusterCandidates: ClusterCandidate[];
}) {
  const claimById = new Map(input.claimInventory.claims.map((claim) => [claim.id, claim]));
  const claimImportance = new Map(
    input.plan.claimSelections.map((selection) => [
      selection.claimId,
      clamp01(selection.importance)
    ])
  );
  const orderedIds: string[] = [];
  const selectedIds = new Set<string>();

  for (const cluster of input.clusterCandidates) {
    for (const claimId of [cluster.leftClaimId, cluster.rightClaimId]) {
      if (selectedIds.has(claimId) || !claimById.has(claimId)) {
        continue;
      }

      orderedIds.push(claimId);
      selectedIds.add(claimId);

      if (selectedIds.size >= MAX_ARGUMENT_NODES) {
        break;
      }
    }

    if (selectedIds.size >= MAX_ARGUMENT_NODES) {
      break;
    }
  }

  const remainingClaims = input.claimInventory.claims
    .filter((claim) => !selectedIds.has(claim.id))
    .sort((left, right) => {
      const leftScore = claimPriorityScore(left, claimImportance.get(left.id) ?? 0);
      const rightScore = claimPriorityScore(right, claimImportance.get(right.id) ?? 0);

      return (
        rightScore - leftScore ||
        right.confidence - left.confidence ||
        left.title.localeCompare(right.title)
      );
    });

  for (const claim of remainingClaims) {
    if (orderedIds.length >= MAX_ARGUMENT_NODES) {
      break;
    }

    orderedIds.push(claim.id);
  }

  return orderedIds
    .map((claimId) => claimById.get(claimId))
    .filter((claim): claim is ClaimUnit => Boolean(claim));
}

function selectGaps(input: {
  claimInventory: ClaimInventory;
  plan: GraphAssemblyPlan;
  selectedClaims: ClaimUnit[];
}) {
  const gapById = new Map(
    input.claimInventory.unresolvedGaps.map((gap) => [gap.id, gap])
  );
  const gapImportance = new Map(
    input.plan.gapSelections.map((selection) => [selection.gapId, clamp01(selection.importance)])
  );
  const orderedGapIds = uniqueStrings(
    input.selectedClaims.flatMap((claim) => claim.dependsOnGapIds)
  ).filter((gapId) => gapById.has(gapId));

  for (const gap of input.claimInventory.unresolvedGaps
    .filter((item) => !orderedGapIds.includes(item.id))
    .sort((left, right) => {
      const leftScore = Math.max(left.importance, gapImportance.get(left.id) ?? 0);
      const rightScore = Math.max(right.importance, gapImportance.get(right.id) ?? 0);

      return rightScore - leftScore || left.title.localeCompare(right.title);
    })) {
    orderedGapIds.push(gap.id);

    if (orderedGapIds.length >= MAX_GAP_NODES) {
      break;
    }
  }

  return orderedGapIds
    .slice(0, MAX_GAP_NODES)
    .map((gapId) => gapById.get(gapId))
    .filter((gap): gap is GapUnit => Boolean(gap));
}

function buildClusters(input: {
  selectedClaimIds: Set<string>;
  clusterCandidates: ClusterCandidate[];
}) {
  const clusters = input.clusterCandidates
    .filter(
      (cluster) =>
        input.selectedClaimIds.has(cluster.leftClaimId) &&
        input.selectedClaimIds.has(cluster.rightClaimId)
    )
    .slice(0, MAX_CLUSTER_COUNT)
    .map(
      (cluster): DisagreementCluster => ({
        id: cluster.id,
        claimIds: [cluster.leftClaimId, cluster.rightClaimId],
        score: cluster.score,
        title: cluster.title,
        explanation: cluster.explanation,
        sourceIds: cluster.sourceIds,
        snippetIds: cluster.snippetIds
      })
    );

  return clusters.sort(
    (left, right) => right.score - left.score || left.title.localeCompare(right.title)
  );
}

function buildClaimRelationEdges(input: {
  selectedClaimIds: Set<string>;
  claimInventory: ClaimInventory;
  plan: GraphAssemblyPlan;
  clusters: DisagreementCluster[];
}) {
  const claimById = new Map(input.claimInventory.claims.map((claim) => [claim.id, claim]));
  const edgeMap = new Map<string, GraphEdge>();

  for (const relation of input.plan.claimRelations) {
    if (
      !input.selectedClaimIds.has(relation.fromClaimId) ||
      !input.selectedClaimIds.has(relation.toClaimId) ||
      relation.fromClaimId === relation.toClaimId
    ) {
      continue;
    }

    const edge: GraphEdge = {
      id: `edge_claim_${relation.fromClaimId}_${relation.toClaimId}_${relation.relation}`,
      from: relation.fromClaimId,
      to: relation.toClaimId,
      relation: relation.relation,
      strength: clamp01(relation.strength)
    };

    edgeMap.set(`${edge.from}|${edge.to}|${edge.relation}`, edge);
  }

  for (const cluster of input.clusters) {
    const leftClaim = claimById.get(cluster.claimIds[0]);
    const rightClaim = claimById.get(cluster.claimIds[1]);

    if (!leftClaim || !rightClaim) {
      continue;
    }

    const { from, to } = pickRefuteOrientation(leftClaim, rightClaim);
    const key = `${from}|${to}|refutes`;

    if (edgeMap.has(key)) {
      continue;
    }

    edgeMap.set(key, {
      id: `edge_cluster_${cluster.id}`,
      from,
      to,
      relation: "refutes",
      strength: cluster.score
    });
  }

  return Array.from(edgeMap.values());
}

function buildGapEdges(input: {
  selectedClaims: ClaimUnit[];
  selectedGaps: GapUnit[];
  plan: GraphAssemblyPlan;
}) {
  const selectedClaimIds = new Set(input.selectedClaims.map((claim) => claim.id));
  const selectedGapIds = new Set(input.selectedGaps.map((gap) => gap.id));
  const edgeMap = new Map<string, GraphEdge>();

  for (const claim of input.selectedClaims) {
    for (const gapId of claim.dependsOnGapIds) {
      if (!selectedGapIds.has(gapId)) {
        continue;
      }

      const key = `${gapId}|${claim.id}|depends_on`;
      edgeMap.set(key, {
        id: `edge_gap_${gapId}_${claim.id}`,
        from: gapId,
        to: claim.id,
        relation: "depends_on",
        strength: 0.82
      });
    }
  }

  for (const relation of input.plan.gapRelations) {
    if (!selectedGapIds.has(relation.gapId) || !selectedClaimIds.has(relation.claimId)) {
      continue;
    }

    const key = `${relation.gapId}|${relation.claimId}|${relation.relation}`;
    edgeMap.set(key, {
      id: `edge_gap_${relation.gapId}_${relation.claimId}_${relation.relation}`,
      from: relation.gapId,
      to: relation.claimId,
      relation: relation.relation,
      strength: clamp01(relation.strength)
    });
  }

  return Array.from(edgeMap.values());
}

function buildEvidenceArtifacts(input: {
  selectedClaims: ClaimUnit[];
  selectedGaps: GapUnit[];
  primaryClusterId?: string;
  clusters: DisagreementCluster[];
  evidencePack: EvidencePack;
}) {
  const snippetById = new Map(
    input.evidencePack.snippets.map((snippet) => [snippet.id, snippet])
  );
  const sourceById = new Map(
    input.evidencePack.sources.map((source) => [source.id, source])
  );
  const primaryCluster = input.clusters.find((cluster) => cluster.id === input.primaryClusterId);
  const prioritizedClaimIds = uniqueStrings([
    ...(primaryCluster?.claimIds ?? []),
    ...input.selectedClaims.map((claim) => claim.id)
  ]);
  const claimById = new Map(input.selectedClaims.map((claim) => [claim.id, claim]));
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  const baseNodeCount = 1 + input.selectedClaims.length + input.selectedGaps.length;
  let remainingSlots = Math.max(0, MAX_TOTAL_NODES - baseNodeCount);

  const evidenceTargets = [
    ...prioritizedClaimIds.map((claimId) => ({
      id: claimId,
      snippetIds: claimById.get(claimId)?.snippetIds ?? [],
      maxCount: MAX_EVIDENCE_PER_CLAIM
    })),
    ...input.selectedGaps.map((gap) => ({
      id: gap.id,
      snippetIds: gap.snippetIds,
      maxCount: MAX_EVIDENCE_PER_GAP
    }))
  ];

  for (const target of evidenceTargets) {
    let attachedCount = 0;

    for (const snippetId of target.snippetIds
      .map((value) => value.trim())
      .filter(Boolean)
      .sort((leftId, rightId) => {
        const leftSnippet = snippetById.get(leftId);
        const rightSnippet = snippetById.get(rightId);

        return (rightSnippet?.relevance ?? 0) - (leftSnippet?.relevance ?? 0);
      })) {
      if (attachedCount >= target.maxCount) {
        break;
      }

      const snippet = snippetById.get(snippetId);

      if (!snippet) {
        continue;
      }

      const source = sourceById.get(snippet.sourceId);

      if (!source) {
        continue;
      }

      const nodeId = `evidence_${snippet.id}`;

      if (!nodeMap.has(nodeId)) {
        if (remainingSlots <= 0) {
          break;
        }

        nodeMap.set(
          nodeId,
          buildEvidenceNode({
            snippet,
            source,
            targetNodeId: target.id
          })
        );
        remainingSlots -= 1;
      }

      const edgeKey = `${nodeId}|${target.id}|supports`;

      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, {
          id: `edge_evidence_${snippet.id}_${target.id}`,
          from: nodeId,
          to: target.id,
          relation: "supports",
          strength: clamp01(snippet.relevance)
        });
      }

      attachedCount += 1;
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values())
  };
}

function pruneDisconnectedGraph(input: {
  question: string;
  graphSummary: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: DisagreementCluster[];
  sources: Source[];
  snippets: Snippet[];
}) {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const filteredEdges = input.edges.filter(
    (edge) =>
      edge.from !== edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to)
  );
  const connectedNodeIds = new Set<string>([QUESTION_NODE_ID]);

  for (const edge of filteredEdges) {
    connectedNodeIds.add(edge.from);
    connectedNodeIds.add(edge.to);
  }

  const nodes = input.nodes.filter(
    (node) => node.id === QUESTION_NODE_ID || connectedNodeIds.has(node.id)
  );
  const survivingNodeIds = new Set(nodes.map((node) => node.id));
  const edges = filteredEdges.filter(
    (edge) => survivingNodeIds.has(edge.from) && survivingNodeIds.has(edge.to)
  );
  const clusters = input.clusters.filter(
    (cluster) =>
      survivingNodeIds.has(cluster.claimIds[0]) &&
      survivingNodeIds.has(cluster.claimIds[1])
  );

  const graph = claimGraphSchema.parse({
    question: input.question,
    nodes,
    edges,
    disagreementClusters: clusters,
    primaryClusterId: clusters[0]?.id,
    graphSummary: normalizeWhitespace(input.graphSummary)
  }) as ClaimGraph;

  return validateClaimGraphArtifacts({
    graph,
    sources: input.sources,
    snippets: input.snippets
  });
}

export function buildLiveClaimGraph(input: {
  question: string;
  claimInventory: ClaimInventory;
  evidencePack: EvidencePack;
  plan: GraphAssemblyPlan;
}): ClaimGraph {
  const clusterCandidates = buildClusterCandidates({
    question: input.question,
    claimInventory: input.claimInventory,
    plan: input.plan
  });
  const selectedClaims = selectClaims({
    claimInventory: input.claimInventory,
    plan: input.plan,
    clusterCandidates
  });
  const selectedClaimIds = new Set(selectedClaims.map((claim) => claim.id));
  const selectedGaps = selectGaps({
    claimInventory: input.claimInventory,
    plan: input.plan,
    selectedClaims
  });
  const selectedClaimById = new Map(selectedClaims.map((claim) => [claim.id, claim]));
  const clusters = buildClusters({
    selectedClaimIds,
    clusterCandidates
  });
  const primaryCluster = clusters[0] ?? null;
  const questionNode = buildQuestionNode(input.question);
  const claimNodes = selectedClaims.map(buildClaimNode);
  const gapNodes = selectedGaps.map(buildGapNode);
  const questionEdges = selectedClaims.map(buildQuestionEdge);
  const claimRelationEdges = buildClaimRelationEdges({
    selectedClaimIds,
    claimInventory: input.claimInventory,
    plan: input.plan,
    clusters
  });
  const gapEdges = buildGapEdges({
    selectedClaims,
    selectedGaps,
    plan: input.plan
  });
  const evidenceArtifacts = buildEvidenceArtifacts({
    selectedClaims,
    selectedGaps,
    primaryClusterId: primaryCluster?.id,
    clusters,
    evidencePack: input.evidencePack
  });
  const graphSummary = chooseGraphSummary({
    plannedSummary: input.plan.graphSummary,
    question: input.question,
    claims: selectedClaims,
    gaps: selectedGaps,
    claimById: selectedClaimById,
    primaryCluster
  });

  return pruneDisconnectedGraph({
    question: input.question,
    graphSummary,
    nodes: [
      questionNode,
      ...claimNodes,
      ...gapNodes,
      ...evidenceArtifacts.nodes
    ],
    edges: [
      ...questionEdges,
      ...claimRelationEdges,
      ...gapEdges,
      ...evidenceArtifacts.edges
    ],
    clusters,
    sources: input.evidencePack.sources,
    snippets: input.evidencePack.snippets
  });
}

export function repairLiveGraphDisagreementClusters(input: {
  graph: ClaimGraph;
  claimInventory: ClaimInventory | null;
}): ClaimGraph {
  const graph = claimGraphSchema.parse(input.graph) as ClaimGraph;
  const sanitizedGraph = sanitizeExistingDisagreementClusters({
    graph,
    claimInventory: input.claimInventory
  });

  if (
    sanitizedGraph.disagreementClusters.length > 0 ||
    !input.claimInventory ||
    input.claimInventory.contradictionPairs.length === 0
  ) {
    return sanitizedGraph;
  }

  const selectedClaimIds = new Set(
    sanitizedGraph.nodes
      .filter((node) => node.kind === "claim" || node.kind === "counterclaim")
      .map((node) => node.id)
  );

  if (selectedClaimIds.size < 2) {
    return graph;
  }

  const clusterCandidates = buildClusterCandidates({
    question: sanitizedGraph.question,
    claimInventory: input.claimInventory,
    plan: EMPTY_ASSEMBLY_PLAN
  });
  const disagreementClusters = buildClusters({
    selectedClaimIds,
    clusterCandidates
  });

  if (!disagreementClusters.length) {
    return graph;
  }

  return claimGraphSchema.parse({
    ...sanitizedGraph,
    disagreementClusters,
    primaryClusterId: disagreementClusters[0]?.id
  }) as ClaimGraph;
}
