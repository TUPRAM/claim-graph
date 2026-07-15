import type {
  ClaimGraphMode,
  ClaimGraphProviderId,
  ClaimGraphRuntimeInfo,
  OpenModelBackend,
  WorkspaceSettings
} from "@/types/claimgraph";

const FULL_MODE_DEFAULT_SETTINGS: WorkspaceSettings = {
  maxWebSources: 8,
  maxFiles: 5,
  freshnessBias: "high",
  preferPrimarySources: true,
  includeOpposingEvidence: true
};

const OPEN_MODEL_DEFAULT_SETTINGS: WorkspaceSettings = {
  maxWebSources: 0,
  maxFiles: 3,
  freshnessBias: "medium",
  preferPrimarySources: true,
  includeOpposingEvidence: true
};

function parseMode(rawValue: string | undefined): ClaimGraphMode {
  const normalized = rawValue?.trim().toLowerCase();

  switch (normalized) {
    case "demo":
    case "open-model":
    case "full":
      return normalized;
    default:
      return process.env.OPENAI_API_KEY ? "full" : "demo";
  }
}

function parseOpenModelBackend(rawValue: string | undefined): OpenModelBackend {
  const normalized = rawValue?.trim().toLowerCase();

  switch (normalized) {
    case "ollama":
    case "vllm":
    case "tgi":
      return normalized;
    default:
      return "ollama";
  }
}

function parseBoolean(rawValue: string | undefined, fallback: boolean) {
  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  return fallback;
}

function normalizeBaseUrl(rawValue: string | undefined, fallback: string) {
  const value = rawValue?.trim() || fallback;

  return value.replace(/\/+$/, "");
}

export interface ClaimGraphRuntimeConfig {
  mode: ClaimGraphMode;
  provider: ClaimGraphProviderId;
  liveAnalysisEnabled: boolean;
  supportsUrlIntake: boolean;
  supportsWebSearch: boolean;
  defaultWorkspaceSettings: WorkspaceSettings;
  openModelBackend: OpenModelBackend;
  openModelName: string;
  ollamaBaseUrl: string;
  openModelBaseUrl?: string;
  openModelExactBaseUrl: boolean;
  openModelApiKey?: string;
  searxngBaseUrl?: string;
  playwrightRetrievalEnabled: boolean;
}

export function getDefaultWorkspaceSettingsForMode(
  mode: ClaimGraphMode
): WorkspaceSettings {
  return mode === "open-model"
    ? { ...OPEN_MODEL_DEFAULT_SETTINGS }
    : { ...FULL_MODE_DEFAULT_SETTINGS };
}

export function getClaimGraphRuntimeConfig(): ClaimGraphRuntimeConfig {
  const mode = parseMode(process.env.CLAIMGRAPH_MODE);
  const openModelBackend = parseOpenModelBackend(
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND
  );
  const provider: ClaimGraphProviderId =
    mode === "full"
      ? "openai"
      : mode === "open-model"
        ? "open-model"
        : "starter";

  return {
    mode,
    provider,
    liveAnalysisEnabled: mode !== "demo",
    supportsUrlIntake: mode === "open-model",
    supportsWebSearch: mode === "full",
    defaultWorkspaceSettings: getDefaultWorkspaceSettingsForMode(mode),
    openModelBackend,
    openModelName:
      process.env.CLAIMGRAPH_OPEN_MODEL_NAME?.trim() || "qwen3:8b",
    ollamaBaseUrl: normalizeBaseUrl(
      process.env.OLLAMA_BASE_URL,
      "http://127.0.0.1:11434"
    ),
    openModelBaseUrl: process.env.OPEN_MODEL_BASE_URL?.trim() || undefined,
    openModelExactBaseUrl: parseBoolean(
      process.env.CLAIMGRAPH_OPEN_MODEL_EXACT_BASE_URL,
      false
    ),
    openModelApiKey:
      process.env.OPEN_MODEL_API_KEY?.trim() ||
      process.env.HF_TOKEN?.trim() ||
      undefined,
    searxngBaseUrl: process.env.SEARXNG_BASE_URL?.trim() || undefined,
    playwrightRetrievalEnabled: parseBoolean(
      process.env.PLAYWRIGHT_RETRIEVAL_ENABLED,
      false
    )
  };
}

export function getClaimGraphRuntimeInfo(): ClaimGraphRuntimeInfo {
  const config = getClaimGraphRuntimeConfig();

  return {
    mode: config.mode,
    provider: config.provider,
    liveAnalysisEnabled: config.liveAnalysisEnabled,
    supportsUrlIntake: config.supportsUrlIntake,
    supportsWebSearch: config.supportsWebSearch,
    openModelBackend:
      config.mode === "open-model" ? config.openModelBackend : undefined,
    openModelModel:
      config.mode === "open-model" ? config.openModelName : undefined
  };
}
