import {
  buildEvidencePackFromOutline,
  evidenceOutlineSchema
} from "@/lib/pipeline/evidence-pack";
import {
  buildClaimExtractionInstructions,
  buildClaimExtractionPrompt,
  buildClaimInventory,
  createRawClaimInventorySchema,
  OPEN_MODEL_CLAIM_INVENTORY_LIMITS,
  type RawClaimInventory
} from "@/lib/pipeline/claim-inventory";
import {
  buildAssemblyInstructions,
  buildAssemblyPrompt,
  buildGraphFromAssemblyPlan,
  createAssemblyPlanSchema,
  OPEN_MODEL_ASSEMBLY_PLAN_LIMITS,
  type AssemblyPlan
} from "@/lib/pipeline/graph-assembly-plan";
import { requestStructuredOpenModelOutput } from "@/lib/open-model/client";
import { ingestFilesDeterministically } from "@/lib/open-model/retrieval/file-ingestion";
import { ingestUrlsDeterministically } from "@/lib/open-model/retrieval/url-ingestion";
import type { ClaimGraphProvider } from "@/lib/providers/types";
import type { ClaimInventory, ClaimUnit, GapUnit } from "@/types/claimgraph";

const openModelClaimInventorySchema = createRawClaimInventorySchema(
  OPEN_MODEL_CLAIM_INVENTORY_LIMITS
);
const openModelAssemblyPlanSchema = createAssemblyPlanSchema(
  OPEN_MODEL_ASSEMBLY_PLAN_LIMITS
);

function buildOpenModelEvidenceInstructions() {
  return [
    "You are the evidence-outline stage for ClaimGraph open-model mode.",
    "Retrieval is already complete. You are given deterministically collected sources and snippets from user-provided URLs and uploaded files.",
    "Do not invent sources, snippets, citations, or claims.",
    "Return only a compact evidence outline with summary, subquestions, evidence axes, and open questions.",
    "If the retrieved evidence is thin or mixed, say so in the summary and open questions."
  ].join("\n");
}

function buildOpenModelEvidencePrompt(input: {
  question: string;
  sources: Array<{ id: string; title: string; url?: string; fileName?: string }>;
  snippets: Array<{ id: string; sourceId: string; text: string; rationale: string }>;
}) {
  return JSON.stringify(
    {
      question: input.question,
      retrievedSources: input.sources,
      retrievedSnippets: input.snippets
    },
    null,
    2
  );
}

function limitClaimsForOpenModel(claims: ClaimUnit[]) {
  const supporters = claims.filter((claim) => claim.kind === "claim");
  const counters = claims.filter((claim) => claim.kind === "counterclaim");
  const selected: ClaimUnit[] = [
    ...supporters.slice(0, 4),
    ...counters.slice(0, 4)
  ];
  const selectedIds = new Set(selected.map((claim) => claim.id));

  for (const claim of claims) {
    if (selected.length >= OPEN_MODEL_CLAIM_INVENTORY_LIMITS.maxClaims) {
      break;
    }

    if (selectedIds.has(claim.id)) {
      continue;
    }

    selected.push(claim);
    selectedIds.add(claim.id);
  }

  return selected;
}

function limitGapsForOpenModel(gaps: GapUnit[]) {
  return gaps.slice(0, OPEN_MODEL_CLAIM_INVENTORY_LIMITS.maxGaps);
}

function compactClaimInventoryForOpenModel(claimInventory: ClaimInventory): ClaimInventory {
  const claims = limitClaimsForOpenModel(claimInventory.claims);
  const claimIds = new Set(claims.map((claim) => claim.id));
  const unresolvedGaps = limitGapsForOpenModel(claimInventory.unresolvedGaps);
  const gapIds = new Set(unresolvedGaps.map((gap) => gap.id));

  return {
    question: claimInventory.question,
    claims: claims.map((claim) => ({
      ...claim,
      dependsOnGapIds: claim.dependsOnGapIds.filter((gapId) => gapIds.has(gapId))
    })),
    contradictionPairs: claimInventory.contradictionPairs
      .filter(
        (pair) => claimIds.has(pair.leftClaimId) && claimIds.has(pair.rightClaimId)
      )
      .slice(0, OPEN_MODEL_CLAIM_INVENTORY_LIMITS.maxContradictionPairs),
    unresolvedGaps
  };
}

export const OpenModelProvider: ClaimGraphProvider = {
  id: "open-model",
  mode: "open-model",

  async gatherEvidence(input) {
    const [urlRetrieval, fileRetrieval] = await Promise.all([
      ingestUrlsDeterministically({
        question: input.workspace.question,
        urls: input.workspace.sourceUrls,
        maxUrls: 3,
        signal: input.signal
      }),
      ingestFilesDeterministically({
        question: input.workspace.question,
        files: input.files,
        maxFiles: input.workspace.settings.maxFiles
      })
    ]);
    const sources = [...urlRetrieval.sources, ...fileRetrieval.sources];
    const snippets = [...urlRetrieval.snippets, ...fileRetrieval.snippets];
    const warnings = [...urlRetrieval.warnings, ...fileRetrieval.warnings];

    if (!input.workspace.sourceUrls.length && !input.files.length) {
      warnings.push(
        "Open-model mode currently builds from user-provided URLs and/or uploaded files. Add at least one URL or a supported deterministic file to produce grounded live evidence."
      );
    }

    if (!snippets.length) {
      const { evidencePack, groundingStatus } = buildEvidencePackFromOutline({
        question: input.workspace.question,
        outline: {
          summary:
            "ClaimGraph did not preserve any grounded text snippets from the provided URLs or files, so open-model mode could not continue to claim extraction honestly.",
          subquestions: [],
          evidenceAxes: [],
          openQuestions: [
            "Which direct source URLs or supported deterministic files can ground the main disagreement?"
          ]
        },
        sources,
        snippets,
        warnings
      });

      return {
        model: "deterministic-retrieval",
        responseId: `open_model_retrieval_${input.runId}`,
        evidencePack,
        groundingStatus
      };
    }

    const outlineResult = await requestStructuredOpenModelOutput({
      schema: evidenceOutlineSchema,
      schemaName: "claimgraph_open_model_evidence_outline",
      systemPrompt: buildOpenModelEvidenceInstructions(),
      userPrompt: buildOpenModelEvidencePrompt({
        question: input.workspace.question,
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          url: source.url,
          fileName: source.fileName
        })),
        snippets: snippets.map((snippet) => ({
          id: snippet.id,
          sourceId: snippet.sourceId,
          text: snippet.text,
          rationale: snippet.rationale
        }))
      }),
      signal: input.signal
    });
    const { evidencePack, groundingStatus } = buildEvidencePackFromOutline({
      question: input.workspace.question,
      outline: outlineResult.output,
      sources,
      snippets,
      warnings
    });

    return {
      model: outlineResult.model,
      responseId: `${outlineResult.backend}:${input.runId}:evidence`,
      evidencePack,
      groundingStatus,
      hostedOpenModelHealth: outlineResult.hostedOpenModelHealth
    };
  },

  async extractClaims(input) {
    const result = await requestStructuredOpenModelOutput({
      schema: openModelClaimInventorySchema,
      schemaName: "claimgraph_open_model_claim_inventory",
      systemPrompt: buildClaimExtractionInstructions({
        maxClaims: OPEN_MODEL_CLAIM_INVENTORY_LIMITS.maxClaims,
        maxGaps: OPEN_MODEL_CLAIM_INVENTORY_LIMITS.maxGaps
      }),
      userPrompt: buildClaimExtractionPrompt(
        input.workspace.question,
        input.evidencePack
      ),
      signal: input.signal
    });
    const claimInventory = compactClaimInventoryForOpenModel(
      buildClaimInventory({
        question: input.workspace.question,
        evidencePack: input.evidencePack,
        rawInventory: {
          ...result.output,
          // The workspace owns the canonical question. Do not depend on a
          // hosted model echoing it, and never let an echo change identity.
          question: input.workspace.question
        } as RawClaimInventory
      })
    );

    if (!claimInventory.claims.length && !claimInventory.unresolvedGaps.length) {
      throw new Error(
        "Open-model claim extraction did not produce any grounded claims or gaps."
      );
    }

    return {
      model: result.model,
      responseId: `${result.backend}:${input.workspace.id}:claims`,
      claimInventory,
      hostedOpenModelHealth: result.hostedOpenModelHealth
    };
  },

  async assembleGraph(input) {
    const result = await requestStructuredOpenModelOutput({
      schema: openModelAssemblyPlanSchema,
      schemaName: "claimgraph_open_model_graph_plan",
      systemPrompt: buildAssemblyInstructions({
        maxClaims: OPEN_MODEL_ASSEMBLY_PLAN_LIMITS.maxPlanClaims,
        maxGaps: OPEN_MODEL_ASSEMBLY_PLAN_LIMITS.maxPlanGaps
      }),
      userPrompt: buildAssemblyPrompt({
        question: input.workspace.question,
        claimInventory: input.claimInventory,
        evidencePack: input.evidencePack
      }),
      signal: input.signal
    });

    return {
      model: result.model,
      responseId: `${result.backend}:${input.workspace.id}:graph`,
      graph: buildGraphFromAssemblyPlan({
        question: input.workspace.question,
        claimInventory: input.claimInventory,
        evidencePack: input.evidencePack,
        plan: result.output as AssemblyPlan
      }),
      hostedOpenModelHealth: result.hostedOpenModelHealth
    };
  }
};
