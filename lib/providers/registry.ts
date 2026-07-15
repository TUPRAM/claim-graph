import {
  getClaimGraphRuntimeConfig,
  getClaimGraphRuntimeInfo
} from "@/lib/claimgraph/config";
import { OpenModelConfigurationError } from "@/lib/open-model/client";
import { OpenAIProvider } from "@/lib/providers/openai-provider";
import { OpenModelProvider } from "@/lib/providers/open-model-provider";
import type { ClaimGraphProvider } from "@/lib/providers/types";
import type { ClaimGraphRuntimeInfo, RunFallbackReason } from "@/types/claimgraph";

export interface ProviderResolution {
  runtime: ClaimGraphRuntimeInfo;
  provider: ClaimGraphProvider | null;
  unavailableReason?: string;
  unavailableFallbackReason?: RunFallbackReason;
}

export function resolveClaimGraphProvider(): ProviderResolution {
  const config = getClaimGraphRuntimeConfig();
  const runtime = getClaimGraphRuntimeInfo();

  switch (config.mode) {
    case "demo":
      return {
        runtime,
        provider: null
      };
    case "full":
      return {
        runtime,
        provider: OpenAIProvider
      };
    case "open-model":
      if (config.openModelBackend === "vllm") {
        if (!config.openModelBaseUrl) {
          return {
            runtime,
            provider: null,
            unavailableReason:
              "Hosted open-model backend vllm requires OPEN_MODEL_BASE_URL.",
            unavailableFallbackReason: "open_model_misconfigured"
          };
        }

        if (!config.openModelApiKey) {
          return {
            runtime,
            provider: null,
            unavailableReason:
              "Hosted open-model backend vllm requires OPEN_MODEL_API_KEY (or HF_TOKEN) so ClaimGraph can call the private endpoint honestly.",
            unavailableFallbackReason: "open_model_misconfigured"
          };
        }

        return {
          runtime,
          provider: {
            ...OpenModelProvider,
            backend: "vllm"
          }
        };
      }

      if (config.openModelBackend !== "ollama") {
        const unavailableReason = config.openModelBaseUrl
          ? `Hosted open-model backend ${config.openModelBackend} is configured at ${config.openModelBaseUrl}, but only the verified hosted vllm path is enabled in this repo right now.`
          : `Hosted open-model backend ${config.openModelBackend} requires OPEN_MODEL_BASE_URL, but only the verified hosted vllm path is enabled in this repo right now.`;

        return {
          runtime,
          provider: null,
          unavailableReason,
          unavailableFallbackReason: "open_model_misconfigured"
        };
      }

      if (!config.openModelName) {
        throw new OpenModelConfigurationError(
          "CLAIMGRAPH_OPEN_MODEL_NAME is required for open-model mode."
        );
      }

      return {
        runtime,
        provider: {
          ...OpenModelProvider,
          backend: "ollama"
        }
      };
  }
}
