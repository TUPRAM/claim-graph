import { isDevAuthConfigured } from "@/lib/server/dev-auth";
import { getClaimGraphRuntimeConfig } from "@/lib/claimgraph/config";
import { getDurableAnalysisSummary } from "@/lib/server/durable-analysis";
import { getObjectStorageSummary } from "@/lib/server/object-storage";
import { getPublicBetaSafetyConfiguration } from "@/lib/server/public-beta-policy";
import {
  getClaimGraphStorageDriver,
  getClaimGraphStorageSummary
} from "@/lib/server/storage/config";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown production health error.";
}

function getProductionAnalysisRuntimeSummary() {
  const config = getClaimGraphRuntimeConfig();
  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasHostedBaseUrl = Boolean(config.openModelBaseUrl);
  const hasHostedToken = Boolean(config.openModelApiKey);
  const missingConfiguration: string[] = [];
  let sourceBackedAnalysisConfigured = false;
  let message =
    "Starter mode is selected, so Build graph will use sample scaffolding rather than source-backed hosted analysis.";
  let nextAction =
    "Configure either the verified hosted vllm open-model lane or the premium full OpenAI lane before public source-backed launch.";

  if (config.mode === "full") {
    sourceBackedAnalysisConfigured = hasOpenAiKey;
    if (!hasOpenAiKey) {
      missingConfiguration.push("OPENAI_API_KEY");
      message =
        "Full mode is selected, but the OpenAI API key is missing.";
      nextAction =
        "Add OPENAI_API_KEY in Vercel or switch to the verified hosted vllm open-model lane.";
    } else {
      message =
        "Full mode is selected and the premium OpenAI lane has the required key.";
      nextAction =
        "Run a source-backed workspace smoke test and verify provenance, snippets, and run status survive redeploy.";
    }
  } else if (config.mode === "open-model") {
    if (config.openModelBackend === "vllm") {
      sourceBackedAnalysisConfigured = hasHostedBaseUrl && hasHostedToken;
      if (!hasHostedBaseUrl) {
        missingConfiguration.push("OPEN_MODEL_BASE_URL");
      }
      if (!hasHostedToken) {
        missingConfiguration.push("OPEN_MODEL_API_KEY or HF_TOKEN");
      }

      message = sourceBackedAnalysisConfigured
        ? "Open-model mode is selected and the verified hosted vllm lane has the required endpoint and token."
        : "Open-model mode is selected, but the verified hosted vllm lane is missing endpoint or token configuration.";
      nextAction = sourceBackedAnalysisConfigured
        ? "Run a source-backed workspace smoke test and verify hosted model reachability, provenance, and persisted run status."
        : "Add OPEN_MODEL_BASE_URL and OPEN_MODEL_API_KEY or HF_TOKEN in Vercel, then redeploy.";
    } else if (config.openModelBackend === "ollama") {
      missingConfiguration.push("CLAIMGRAPH_OPEN_MODEL_BACKEND=vllm for hosted Vercel");
      message =
        "Open-model mode is selected with local Ollama, which is not a hosted production model provider on Vercel.";
      nextAction =
        "Use local Ollama only for local development, or set the production backend to vllm with a hosted endpoint and token.";
    } else {
      missingConfiguration.push("verified hosted backend");
      message =
        "Open-model mode is selected with an unverified hosted backend.";
      nextAction =
        "Use the verified hosted vllm lane, or run a separate hosted-backend verification block before public launch.";
    }
  } else {
    missingConfiguration.push("CLAIMGRAPH_MODE");
  }

  return {
    mode: config.mode,
    provider: config.provider,
    liveAnalysisEnabled: config.liveAnalysisEnabled,
    supportsUrlIntake: config.supportsUrlIntake,
    supportsWebSearch: config.supportsWebSearch,
    openModelBackend:
      config.mode === "open-model" ? config.openModelBackend : undefined,
    openModelModel:
      config.mode === "open-model" ? config.openModelName : undefined,
    hasOpenAiKey,
    hasHostedBaseUrl,
    hasHostedToken,
    sourceBackedAnalysisConfigured,
    missingConfiguration,
    status: sourceBackedAnalysisConfigured ? "ready" as const : "blocked" as const,
    message,
    nextAction
  };
}

export async function getProductionHealthSummary() {
  const checkedAt = new Date().toISOString();
  const devAuth = {
    configured: isDevAuthConfigured()
  };
  const durableRunner = getDurableAnalysisSummary();
  const objectStorage = getObjectStorageSummary();
  const analysisRuntime = getProductionAnalysisRuntimeSummary();
  const safetyConfiguration = getPublicBetaSafetyConfiguration();
  const publicBetaSafety = {
    ...safetyConfiguration,
    operatorAuthConfigured: devAuth.configured,
    ready: safetyConfiguration.ready && devAuth.configured,
    missingConfiguration: [
      ...safetyConfiguration.missingConfiguration,
      ...(devAuth.configured
        ? []
        : ["DEV_MODE_PASSWORD_HASH", "DEV_MODE_SESSION_SECRET"])
    ]
  };

  try {
    const storageSummary = getClaimGraphStorageSummary();
    const storage = {
      ...storageSummary,
      databaseReachable: false,
      schemaInitialized: storageSummary.driver === "local",
      requiredTables: [] as string[],
      missingTables: [] as string[]
    };

    if (storageSummary.driver === "hosted") {
      try {
        const hostedHealth = await import("@/lib/server/storage/hosted-health")
          .then((module) => module.checkHostedStorageHealth());

        Object.assign(storage, hostedHealth);
      } catch (error) {
        storage.databaseReachable = false;
        storage.schemaInitialized = false;
        return {
          checkedAt,
          status: "unhealthy" as const,
          storage: {
            ...storage,
            error: errorMessage(error)
          },
          objectStorage,
          devAuth,
          durableRunner,
          analysisRuntime,
          publicBetaSafety
        };
      }
    }

    const readyForHostedPersistence =
      getClaimGraphStorageDriver() === "hosted" &&
      storage.databaseConfigured &&
      storage.databaseReachable &&
      storage.schemaInitialized &&
      objectStorage.ready;
    const readyForHostedSourceBackedAnalysis =
      readyForHostedPersistence &&
      durableRunner.configured &&
      analysisRuntime.sourceBackedAnalysisConfigured;
    const readyForPublicBeta =
      readyForHostedSourceBackedAnalysis && publicBetaSafety.ready;

    return {
      checkedAt,
      status: readyForPublicBeta
        ? "ready" as const
        : readyForHostedPersistence
          ? "degraded" as const
          : "degraded" as const,
      storage,
      objectStorage,
      devAuth,
      durableRunner,
      analysisRuntime,
      publicBetaSafety
    };
  } catch (error) {
    return {
      checkedAt,
      status: "unhealthy" as const,
      storage: {
        driver: process.env.CLAIMGRAPH_STORAGE_DRIVER ?? "local",
        databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
        localDefault: !process.env.CLAIMGRAPH_STORAGE_DRIVER,
        databaseReachable: false,
        schemaInitialized: false,
        requiredTables: [] as string[],
        missingTables: [] as string[],
        error: errorMessage(error)
      },
      objectStorage,
      devAuth,
      durableRunner,
      analysisRuntime,
      publicBetaSafety
    };
  }
}
