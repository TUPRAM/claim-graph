import { assembleGraph } from "@/lib/openai/assemble";
import { gatherEvidence } from "@/lib/openai/evidence";
import { extractClaimsWithPro } from "@/lib/openai/extraction";
import { ensureWorkspaceVectorStore } from "@/lib/openai/vector-store";
import type { ClaimGraphProvider } from "@/lib/providers/types";
import { assertHostedProviderFileRetentionSafe } from "@/lib/server/provider-file-retention";

export const OpenAIProvider: ClaimGraphProvider = {
  id: "openai",
  mode: "full",

  async gatherEvidence(input) {
    let vectorStoreId: string | undefined;

    assertHostedProviderFileRetentionSafe(input.files.length);

    if (input.files.length) {
      const retrievalState = await ensureWorkspaceVectorStore({
        workspaceId: input.workspace.id,
        runId: input.runId,
        files: input.files,
        signal: input.signal
      });

      vectorStoreId = retrievalState?.vectorStoreId;
    }

    return gatherEvidence({
      question: input.workspace.question,
      settings: input.workspace.settings,
      vectorStoreId,
      signal: input.signal
    });
  },

  async extractClaims(input) {
    return extractClaimsWithPro({
      question: input.workspace.question,
      evidencePack: input.evidencePack,
      signal: input.signal
    });
  },

  async assembleGraph(input) {
    return assembleGraph({
      question: input.workspace.question,
      claimInventory: input.claimInventory,
      evidencePack: input.evidencePack,
      signal: input.signal
    });
  }
};
