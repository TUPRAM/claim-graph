import { z } from "zod";
import { buildLiveClaimGraph } from "@/lib/graph/live-assembly";
import type {
  ClaimGraph,
  ClaimInventory,
  ClaimUnit,
  ContradictionPair,
  EvidencePack,
  GapUnit
} from "@/types/claimgraph";

export interface AssemblyPlanLimits {
  maxPlanClaims: number;
  maxPlanGaps: number;
  maxPlanRelations: number;
  maxPlanClusters: number;
}

export const FULL_ASSEMBLY_PLAN_LIMITS: AssemblyPlanLimits = {
  maxPlanClaims: 10,
  maxPlanGaps: 6,
  maxPlanRelations: 16,
  maxPlanClusters: 6
};

export const OPEN_MODEL_ASSEMBLY_PLAN_LIMITS: AssemblyPlanLimits = {
  maxPlanClaims: 8,
  maxPlanGaps: 4,
  maxPlanRelations: 12,
  maxPlanClusters: 4
};

export function createAssemblyPlanSchema(limits: AssemblyPlanLimits) {
  return z
    .object({
      graphSummary: z.string().trim().min(1).max(1200),
      claimSelections: z
        .array(
          z
            .object({
              claimId: z.string().trim().min(1).max(80),
              importance: z.number().min(0).max(1)
            })
            .strict()
        )
        .max(limits.maxPlanClaims)
        .default([]),
      gapSelections: z
        .array(
          z
            .object({
              gapId: z.string().trim().min(1).max(80),
              importance: z.number().min(0).max(1)
            })
            .strict()
        )
        .max(limits.maxPlanGaps)
        .default([]),
      claimRelations: z
        .array(
          z
            .object({
              fromClaimId: z.string().trim().min(1).max(80),
              toClaimId: z.string().trim().min(1).max(80),
              relation: z.enum(["refutes", "qualifies"]),
              strength: z.number().min(0).max(1)
            })
            .strict()
        )
        .max(limits.maxPlanRelations)
        .default([]),
      gapRelations: z
        .array(
          z
            .object({
              gapId: z.string().trim().min(1).max(80),
              claimId: z.string().trim().min(1).max(80),
              relation: z.enum(["depends_on", "qualifies"]),
              strength: z.number().min(0).max(1)
            })
            .strict()
        )
        .max(limits.maxPlanRelations)
        .default([]),
      disagreementClusters: z
        .array(
          z
            .object({
              contradictionPairId: z.string().trim().min(1).max(80),
              title: z.string().trim().min(1).max(180),
              explanation: z.string().trim().min(1).max(360),
              topicRelevance: z.number().min(0).max(1)
            })
            .strict()
        )
        .max(limits.maxPlanClusters)
        .default([])
    })
    .strict();
}

export type AssemblyPlan = z.infer<ReturnType<typeof createAssemblyPlanSchema>>;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number) {
  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function hasProvenance(unit: ClaimUnit | GapUnit) {
  return unit.sourceIds.length > 0 && unit.snippetIds.length > 0;
}

function scoreClaimForDeterministicPlan(
  claim: ClaimUnit,
  pairStrengthByClaimId: Map<string, number>
) {
  const qualityBonus =
    claim.evidenceQuality === "high"
      ? 0.14
      : claim.evidenceQuality === "medium"
        ? 0.08
        : 0.02;
  const stanceBonus =
    claim.kind === "counterclaim" || claim.stance === "con" ? 0.06 : 0.03;
  const sourceBonus = Math.min(0.1, uniqueStrings(claim.sourceIds).length * 0.035);
  const snippetBonus = Math.min(0.1, uniqueStrings(claim.snippetIds).length * 0.025);
  const gapBonus = Math.min(0.06, uniqueStrings(claim.dependsOnGapIds).length * 0.03);
  const pairBonus = (pairStrengthByClaimId.get(claim.id) ?? 0) * 0.22;

  return clamp01(
    claim.confidence * 0.42 +
      qualityBonus +
      stanceBonus +
      sourceBonus +
      snippetBonus +
      gapBonus +
      pairBonus
  );
}

function scoreGapForDeterministicPlan(gap: GapUnit) {
  const sourceBonus = Math.min(0.1, uniqueStrings(gap.sourceIds).length * 0.035);
  const snippetBonus = Math.min(0.1, uniqueStrings(gap.snippetIds).length * 0.025);

  return clamp01(gap.importance * 0.78 + sourceBonus + snippetBonus);
}

function buildPairTitle(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  return truncate(`${leftClaim.title} vs. ${rightClaim.title}`, 180);
}

function buildPairExplanation(pair: ContradictionPair, leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  const explanation = normalizeWhitespace(pair.explanation);

  if (explanation) {
    return truncate(explanation, 360);
  }

  return truncate(
    `${leftClaim.title} and ${rightClaim.title} are both grounded in the saved evidence but point users toward different decisions.`,
    360
  );
}

function orientRefuteRelation(leftClaim: ClaimUnit, rightClaim: ClaimUnit) {
  if (leftClaim.kind === "counterclaim" && rightClaim.kind !== "counterclaim") {
    return { fromClaimId: leftClaim.id, toClaimId: rightClaim.id };
  }

  if (rightClaim.kind === "counterclaim" && leftClaim.kind !== "counterclaim") {
    return { fromClaimId: rightClaim.id, toClaimId: leftClaim.id };
  }

  if (leftClaim.stance === "con" && rightClaim.stance !== "con") {
    return { fromClaimId: leftClaim.id, toClaimId: rightClaim.id };
  }

  if (rightClaim.stance === "con" && leftClaim.stance !== "con") {
    return { fromClaimId: rightClaim.id, toClaimId: leftClaim.id };
  }

  return { fromClaimId: rightClaim.id, toClaimId: leftClaim.id };
}

function buildDeterministicGraphSummary(input: {
  question: string;
  selectedPairs: Array<{
    pair: ContradictionPair;
    leftClaim: ClaimUnit;
    rightClaim: ClaimUnit;
  }>;
  selectedClaims: ClaimUnit[];
  selectedGaps: GapUnit[];
}) {
  const firstPair = input.selectedPairs[0];

  if (firstPair) {
    const gapText = input.selectedGaps[0]
      ? ` The main unresolved dependency is ${input.selectedGaps[0].title.toLowerCase()}.`
      : "";

    return truncate(
      `The saved web evidence for "${input.question}" shows a provisional disagreement between ${firstPair.leftClaim.title} and ${firstPair.rightClaim.title}.${gapText} Inspect the linked snippets before treating the map as settled.`,
      1200
    );
  }

  const leadClaims = input.selectedClaims.slice(0, 2).map((claim) => claim.title);
  const leadText = leadClaims.length
    ? `The saved web evidence for "${input.question}" supports ${leadClaims.join(" and ")}.`
    : `The saved web evidence for "${input.question}" produced limited grounded claims.`;
  const gapText = input.selectedGaps[0]
    ? ` The most important unresolved dependency is ${input.selectedGaps[0].title.toLowerCase()}.`
    : " The result should be treated as source-backed but still in need of stronger disagreement evidence.";

  return truncate(`${leadText}${gapText}`, 1200);
}

export function buildDeterministicAssemblyPlan(input: {
  question: string;
  claimInventory: ClaimInventory;
  evidencePack: EvidencePack;
  limits?: AssemblyPlanLimits;
}): AssemblyPlan {
  const limits = input.limits ?? FULL_ASSEMBLY_PLAN_LIMITS;
  const claimById = new Map(input.claimInventory.claims.map((claim) => [claim.id, claim]));
  const gapById = new Map(input.claimInventory.unresolvedGaps.map((gap) => [gap.id, gap]));
  const pairStrengthByClaimId = new Map<string, number>();
  const eligiblePairs = input.claimInventory.contradictionPairs
    .map((pair) => {
      const leftClaim = claimById.get(pair.leftClaimId);
      const rightClaim = claimById.get(pair.rightClaimId);

      if (!leftClaim || !rightClaim || !hasProvenance(leftClaim) || !hasProvenance(rightClaim)) {
        return null;
      }

      pairStrengthByClaimId.set(
        leftClaim.id,
        Math.max(pairStrengthByClaimId.get(leftClaim.id) ?? 0, pair.contradictionStrength)
      );
      pairStrengthByClaimId.set(
        rightClaim.id,
        Math.max(pairStrengthByClaimId.get(rightClaim.id) ?? 0, pair.contradictionStrength)
      );

      return { pair, leftClaim, rightClaim };
    })
    .filter(
      (
        item
      ): item is {
        pair: ContradictionPair;
        leftClaim: ClaimUnit;
        rightClaim: ClaimUnit;
      } => Boolean(item)
    )
    .sort(
      (left, right) =>
        right.pair.contradictionStrength - left.pair.contradictionStrength ||
        buildPairTitle(left.leftClaim, left.rightClaim).localeCompare(
          buildPairTitle(right.leftClaim, right.rightClaim)
        )
    )
    .slice(0, limits.maxPlanClusters);

  const selectedClaimIds = new Set<string>();
  const selectedClaims: ClaimUnit[] = [];

  function addClaim(claim: ClaimUnit) {
    if (
      selectedClaimIds.has(claim.id) ||
      selectedClaimIds.size >= limits.maxPlanClaims ||
      !hasProvenance(claim)
    ) {
      return;
    }

    selectedClaimIds.add(claim.id);
    selectedClaims.push(claim);
  }

  for (const candidate of eligiblePairs) {
    addClaim(candidate.leftClaim);
    addClaim(candidate.rightClaim);
  }

  for (const claim of input.claimInventory.claims
    .filter((claim) => !selectedClaimIds.has(claim.id) && hasProvenance(claim))
    .sort((left, right) => {
      const leftScore = scoreClaimForDeterministicPlan(left, pairStrengthByClaimId);
      const rightScore = scoreClaimForDeterministicPlan(right, pairStrengthByClaimId);

      return rightScore - leftScore || left.title.localeCompare(right.title);
    })) {
    addClaim(claim);
  }

  const selectedGapIds = new Set<string>();
  const selectedGaps: GapUnit[] = [];

  function addGap(gap: GapUnit | undefined) {
    if (
      !gap ||
      selectedGapIds.has(gap.id) ||
      selectedGapIds.size >= limits.maxPlanGaps ||
      !hasProvenance(gap)
    ) {
      return;
    }

    selectedGapIds.add(gap.id);
    selectedGaps.push(gap);
  }

  for (const claim of selectedClaims) {
    for (const gapId of claim.dependsOnGapIds) {
      addGap(gapById.get(gapId));
    }
  }

  for (const gap of input.claimInventory.unresolvedGaps
    .filter((gap) => !selectedGapIds.has(gap.id) && hasProvenance(gap))
    .sort((left, right) => {
      const leftScore = scoreGapForDeterministicPlan(left);
      const rightScore = scoreGapForDeterministicPlan(right);

      return rightScore - leftScore || left.title.localeCompare(right.title);
    })) {
    addGap(gap);
  }

  const selectedPairs = eligiblePairs.filter(
    ({ leftClaim, rightClaim }) =>
      selectedClaimIds.has(leftClaim.id) && selectedClaimIds.has(rightClaim.id)
  );
  const claimRelations = selectedPairs
    .slice(0, limits.maxPlanRelations)
    .map(({ pair, leftClaim, rightClaim }) => ({
      ...orientRefuteRelation(leftClaim, rightClaim),
      relation: "refutes" as const,
      strength: clamp01(pair.contradictionStrength)
    }));
  const gapRelations: AssemblyPlan["gapRelations"] = [];

  for (const gap of selectedGaps) {
    for (const claim of selectedClaims) {
      if (!claim.dependsOnGapIds.includes(gap.id)) {
        continue;
      }

      gapRelations.push({
        gapId: gap.id,
        claimId: claim.id,
        relation: "depends_on",
        strength: clamp01(Math.max(0.45, gap.importance))
      });

      if (gapRelations.length >= limits.maxPlanRelations) {
        break;
      }
    }

    if (gapRelations.length >= limits.maxPlanRelations) {
      break;
    }
  }

  const disagreementClusters = selectedPairs
    .slice(0, limits.maxPlanClusters)
    .map(({ pair, leftClaim, rightClaim }) => ({
      contradictionPairId: pair.id,
      title: buildPairTitle(leftClaim, rightClaim),
      explanation: buildPairExplanation(pair, leftClaim, rightClaim),
      topicRelevance: clamp01(
        Math.max(0.45, (leftClaim.confidence + rightClaim.confidence) / 2)
      )
    }));

  return {
    graphSummary: buildDeterministicGraphSummary({
      question: input.question,
      selectedPairs,
      selectedClaims,
      selectedGaps
    }),
    claimSelections: selectedClaims.map((claim) => ({
      claimId: claim.id,
      importance: scoreClaimForDeterministicPlan(claim, pairStrengthByClaimId)
    })),
    gapSelections: selectedGaps.map((gap) => ({
      gapId: gap.id,
      importance: scoreGapForDeterministicPlan(gap)
    })),
    claimRelations,
    gapRelations,
    disagreementClusters
  };
}

export function buildAssemblyInstructions(input?: {
  maxClaims?: number;
  maxGaps?: number;
}) {
  const maxClaims = input?.maxClaims ?? FULL_ASSEMBLY_PLAN_LIMITS.maxPlanClaims;
  const maxGaps = input?.maxGaps ?? FULL_ASSEMBLY_PLAN_LIMITS.maxPlanGaps;

  return [
    "You are the graph assembly planner for ClaimGraph, a visual argument engine.",
    "You will be given a persisted ClaimInventory and the saved EvidencePack it came from.",
    "Return a compact graph assembly plan only.",
    "Hard rules:",
    "1. Reuse only claim ids, gap ids, and contradiction pair ids that already exist in the input artifacts.",
    `2. Keep the visible graph readable. Prefer roughly 4 to ${maxClaims} main claim or counterclaim nodes and at most ${maxGaps} gap nodes when available.`,
    "3. Prioritize the most decision-relevant disagreement, not exhaustive coverage.",
    "4. Use refutes only for direct opposition. Use qualifies only when a claim or gap narrows another claim without fully opposing it.",
    "5. Do not add layout coordinates. Layout is computed in code.",
    "6. Do not add evidence nodes. Code will derive evidence nodes from persisted snippet ids.",
    "7. Every selected non-question node must remain grounded in the provided evidence.",
    "8. Preserve counterclaims and unresolved gaps explicitly.",
    "9. Prefer contradiction pairs where both sides stay grounded, answer the same decision axis, and unresolved dependencies still matter.",
    "10. Do not elevate merely adjacent tradeoffs or side-conditions over direct opposition. Use qualifiers and gaps to keep the main conflict honest.",
    "11. Downrank decorative branches that do not sharpen the main disagreement.",
    "12. If grounded counterclaim evidence exists, select at least one counterclaim-side node or contradiction pair that makes the opposition inspectable.",
    "13. If the evidence is one-sided, do not invent a counterclaim. Prefer a smaller graph with explicit gaps that say what opposing or missing evidence would be needed.",
    "14. Make gap nodes specific to the user's question, source mix, or unresolved decision condition. Avoid generic gaps such as 'more research is needed'.",
    "15. Keep selected claims atomic and question-specific; split broad multi-part claims by selecting a narrower claim when available.",
    "16. The graph summary should describe the strongest disagreement and the main unresolved dependency without claiming final truth or completeness.",
    "17. Return JSON only."
  ].join("\n");
}

export function buildAssemblyPrompt(input: {
  question: string;
  claimInventory: ClaimInventory;
  evidencePack: EvidencePack;
}) {
  return JSON.stringify(
    {
      question: input.question,
      claimInventory: input.claimInventory,
      evidencePack: {
        summary: input.evidencePack.summary,
        openQuestions: input.evidencePack.openQuestions,
        sources: input.evidencePack.sources,
        snippets: input.evidencePack.snippets
      }
    },
    null,
    2
  );
}

export function buildGraphFromAssemblyPlan(input: {
  question: string;
  claimInventory: ClaimInventory;
  evidencePack: EvidencePack;
  plan: AssemblyPlan;
}): ClaimGraph {
  return buildLiveClaimGraph({
    question: input.question,
    claimInventory: input.claimInventory,
    evidencePack: input.evidencePack,
    plan: input.plan
  });
}
