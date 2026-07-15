import { zodResponsesFunction } from "openai/helpers/zod";
import type {
  ParsedResponse,
  ParsedResponseFunctionToolCall
} from "openai/resources/responses/responses";
import {
  buildClaimExtractionInstructions,
  buildClaimExtractionPrompt,
  buildClaimInventory,
  createRawClaimInventorySchema,
  FULL_CLAIM_INVENTORY_LIMITS,
  type RawClaimInventory
} from "@/lib/pipeline/claim-inventory";
import {
  createOpenAIRequestOptions,
  getOpenAIClient,
  OpenAIRequestTimeoutError
} from "@/lib/openai/client";
import type { ClaimInventory, EvidencePack } from "@/types/claimgraph";

const SUBMIT_CLAIM_INVENTORY_TOOL = "submit_claim_inventory";
const DEFAULT_TIMEOUT_MS = 120_000;
const rawClaimInventorySchema = createRawClaimInventorySchema(
  FULL_CLAIM_INVENTORY_LIMITS
);

const submitClaimInventoryTool = zodResponsesFunction({
  name: SUBMIT_CLAIM_INVENTORY_TOOL,
  description:
    "Submit a compact ClaimInventory grounded in EvidencePack snippet ids only.",
  parameters: rawClaimInventorySchema
});

export interface ExtractedClaimInventoryResult {
  model: string;
  responseId: string;
  claimInventory: ClaimInventory;
}

export { buildClaimInventory };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryParseRawInventoryCandidate(value: unknown): RawClaimInventory | null {
  const directResult = rawClaimInventorySchema.safeParse(value);

  if (directResult.success) {
    return directResult.data;
  }

  if (typeof value === "string") {
    try {
      const parsedJson = JSON.parse(value) as unknown;
      const parsedResult = rawClaimInventorySchema.safeParse(parsedJson);

      if (parsedResult.success) {
        return parsedResult.data;
      }
    } catch {
      return null;
    }
  }

  if (isRecord(value) && "parsed_arguments" in value) {
    const nestedResult = tryParseRawInventoryCandidate(
      (value as { parsed_arguments?: unknown }).parsed_arguments
    );

    if (nestedResult) {
      return nestedResult;
    }
  }

  if (isRecord(value) && "arguments" in value) {
    const nestedResult = tryParseRawInventoryCandidate(
      (value as { arguments?: unknown }).arguments
    );

    if (nestedResult) {
      return nestedResult;
    }
  }

  return null;
}

function getSubmittedClaimInventory(
  response: ParsedResponse<never>
): RawClaimInventory {
  const toolCall = response.output.find(
    (
      item
    ): item is ParsedResponseFunctionToolCall =>
      item.type === "function_call" &&
      item.name === SUBMIT_CLAIM_INVENTORY_TOOL
  );

  if (!toolCall) {
    throw new Error(
      "Claim extraction did not return submit_claim_inventory."
    );
  }

  const parsedInventory =
    tryParseRawInventoryCandidate(toolCall.parsed_arguments) ??
    tryParseRawInventoryCandidate(toolCall.arguments) ??
    tryParseRawInventoryCandidate(
      (response as { output_parsed?: unknown }).output_parsed
    );

  if (!parsedInventory) {
    throw new Error(
      "Claim extraction returned submit_claim_inventory, but the arguments could not be parsed into a valid ClaimInventory payload."
    );
  }

  return parsedInventory;
}

export async function extractClaimsWithPro(input: {
  question: string;
  evidencePack: EvidencePack;
  signal?: AbortSignal;
}): Promise<ExtractedClaimInventoryResult> {
  const client = getOpenAIClient();
  const primaryModel =
    process.env.OPENAI_REASONING_MODEL?.trim() ||
    process.env.OPENAI_DEFAULT_MODEL?.trim() ||
    "gpt-5.4";
  const fallbackModel = process.env.OPENAI_DEFAULT_MODEL?.trim() || "gpt-5.4";

  async function requestClaimInventory(model: string, effort: "medium" | "low") {
    const request = createOpenAIRequestOptions(input.signal);

    try {
      const requestBody = {
        model,
        reasoning: {
          effort
        },
        instructions: buildClaimExtractionInstructions({
          maxClaims: FULL_CLAIM_INVENTORY_LIMITS.maxClaims,
          maxGaps: FULL_CLAIM_INVENTORY_LIMITS.maxGaps
        }),
        input: buildClaimExtractionPrompt(input.question, input.evidencePack),
        tools: [submitClaimInventoryTool],
        tool_choice: {
          type: "function",
          name: SUBMIT_CLAIM_INVENTORY_TOOL
        }
      } satisfies Parameters<typeof client.responses.parse>[0];

      return await client.responses.parse(requestBody, request.options);
    } catch (error) {
      if (request.didTimeout()) {
        throw new OpenAIRequestTimeoutError(
          `Claim extraction exceeded the configured OpenAI timeout while using ${model}.`,
          Number(process.env.CLAIMGRAPH_OPENAI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
        );
      }

      throw error;
    } finally {
      request.cleanup();
    }
  }

  let model = primaryModel;
  let response: ParsedResponse<never>;

  try {
    response = await requestClaimInventory(primaryModel, "medium") as ParsedResponse<never>;
  } catch (error) {
    if (
      error instanceof OpenAIRequestTimeoutError &&
      fallbackModel &&
      fallbackModel !== primaryModel
    ) {
      model = fallbackModel;
      response = await requestClaimInventory(fallbackModel, "low") as ParsedResponse<never>;
    } else {
      throw error;
    }
  }

  const rawInventory = getSubmittedClaimInventory(response);
  const claimInventory = buildClaimInventory({
    question: input.question,
    evidencePack: input.evidencePack,
    rawInventory
  });

  if (!claimInventory.claims.length && !claimInventory.unresolvedGaps.length) {
    throw new Error(
      "Claim extraction did not produce any grounded claims or gaps."
    );
  }

  return {
    model,
    responseId: response.id,
    claimInventory
  };
}
