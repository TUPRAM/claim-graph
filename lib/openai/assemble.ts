import { zodTextFormat } from "openai/helpers/zod";
import {
  buildDeterministicAssemblyPlan,
  buildAssemblyInstructions,
  buildAssemblyPrompt,
  buildGraphFromAssemblyPlan,
  createAssemblyPlanSchema,
  FULL_ASSEMBLY_PLAN_LIMITS,
  type AssemblyPlan
} from "@/lib/pipeline/graph-assembly-plan";
import {
  createOpenAIRequestOptions,
  getOpenAIClient
} from "@/lib/openai/client";
import type { ClaimGraph, ClaimInventory, EvidencePack } from "@/types/claimgraph";

const assemblyPlanSchema = createAssemblyPlanSchema(FULL_ASSEMBLY_PLAN_LIMITS);
const DETERMINISTIC_ASSEMBLY_FALLBACK_MODEL = "deterministic-assembly-fallback";
const DETERMINISTIC_ASSEMBLY_FALLBACK_RESPONSE_ID = "deterministic-assembly-fallback";

export interface AssembledGraphResult {
  model: string;
  responseId: string;
  graph: ClaimGraph;
}

export async function assembleGraph(input: {
  question: string;
  claimInventory: ClaimInventory;
  evidencePack: EvidencePack;
  signal?: AbortSignal;
}): Promise<AssembledGraphResult> {
  const client = getOpenAIClient();
  const model = process.env.OPENAI_DEFAULT_MODEL ?? "gpt-5.4";
  const request = createOpenAIRequestOptions(input.signal);
  try {
    const requestBody = {
      model,
      instructions: buildAssemblyInstructions({
        maxClaims: FULL_ASSEMBLY_PLAN_LIMITS.maxPlanClaims,
        maxGaps: FULL_ASSEMBLY_PLAN_LIMITS.maxPlanGaps
      }),
      input: buildAssemblyPrompt(input),
      text: {
        format: zodTextFormat(
          assemblyPlanSchema,
          "claimgraph_graph_assembly_plan"
        )
      }
    } satisfies Parameters<typeof client.responses.parse>[0];

    const response = await client.responses.parse(requestBody, request.options);
    const plan = response.output_parsed as AssemblyPlan | null;

    if (!plan) {
      return assembleGraphDeterministically(input);
    }

    return {
      model,
      responseId: response.id,
      graph: buildGraphFromAssemblyPlan({
        question: input.question,
        claimInventory: input.claimInventory,
        evidencePack: input.evidencePack,
        plan
      })
    };
  } catch {
    return assembleGraphDeterministically(input);
  } finally {
    request.cleanup();
  }
}

function assembleGraphDeterministically(input: {
  question: string;
  claimInventory: ClaimInventory;
  evidencePack: EvidencePack;
}): AssembledGraphResult {
  const plan = buildDeterministicAssemblyPlan({
    question: input.question,
    claimInventory: input.claimInventory,
    evidencePack: input.evidencePack,
    limits: FULL_ASSEMBLY_PLAN_LIMITS
  });

  return {
    model: DETERMINISTIC_ASSEMBLY_FALLBACK_MODEL,
    responseId: DETERMINISTIC_ASSEMBLY_FALLBACK_RESPONSE_ID,
    graph: buildGraphFromAssemblyPlan({
      question: input.question,
      claimInventory: input.claimInventory,
      evidencePack: input.evidencePack,
      plan
    })
  };
}
