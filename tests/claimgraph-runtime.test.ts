import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalMode = process.env.CLAIMGRAPH_MODE;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBackend = process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
const originalModel = process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
const originalOpenModelBaseUrl = process.env.OPEN_MODEL_BASE_URL;
const originalOpenModelApiKey = process.env.OPEN_MODEL_API_KEY;

async function importRuntimeModules() {
  const configModule = await import("@/lib/claimgraph/config");
  const registryModule = await import("@/lib/providers/registry");

  return {
    ...configModule,
    ...registryModule
  };
}

describe("ClaimGraph runtime config", () => {
  beforeEach(() => {
    delete process.env.CLAIMGRAPH_MODE;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
    delete process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OPEN_MODEL_BASE_URL;
    delete process.env.OPEN_MODEL_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();

    if (originalMode === undefined) {
      delete process.env.CLAIMGRAPH_MODE;
    } else {
      process.env.CLAIMGRAPH_MODE = originalMode;
    }

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    if (originalBackend === undefined) {
      delete process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
    } else {
      process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = originalBackend;
    }

    if (originalModel === undefined) {
      delete process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
    } else {
      process.env.CLAIMGRAPH_OPEN_MODEL_NAME = originalModel;
    }

    if (originalOllamaBaseUrl === undefined) {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    }

    if (originalOpenModelBaseUrl === undefined) {
      delete process.env.OPEN_MODEL_BASE_URL;
    } else {
      process.env.OPEN_MODEL_BASE_URL = originalOpenModelBaseUrl;
    }

    if (originalOpenModelApiKey === undefined) {
      delete process.env.OPEN_MODEL_API_KEY;
    } else {
      process.env.OPEN_MODEL_API_KEY = originalOpenModelApiKey;
    }
  });

  it("defaults to demo mode when no live provider is configured", async () => {
    const { getClaimGraphRuntimeConfig, getClaimGraphRuntimeInfo, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const runtime = getClaimGraphRuntimeInfo();
    const providerResolution = resolveClaimGraphProvider();

    expect(config.mode).toBe("demo");
    expect(runtime).toMatchObject({
      mode: "demo",
      provider: "starter",
      liveAnalysisEnabled: false,
      supportsUrlIntake: false,
      supportsWebSearch: false
    });
    expect(providerResolution.provider).toBeNull();
  });

  it("defaults to full mode when OPENAI_API_KEY is present", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const { getClaimGraphRuntimeConfig, getClaimGraphRuntimeInfo, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const runtime = getClaimGraphRuntimeInfo();
    const providerResolution = resolveClaimGraphProvider();

    expect(config.mode).toBe("full");
    expect(runtime).toMatchObject({
      mode: "full",
      provider: "openai",
      liveAnalysisEnabled: true,
      supportsUrlIntake: false,
      supportsWebSearch: true
    });
    expect(providerResolution.provider?.id).toBe("openai");
  });

  it("parses open-model mode with Ollama defaults and resolves the open-model provider", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "ollama";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "qwen3:8b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/";

    const { getClaimGraphRuntimeConfig, getClaimGraphRuntimeInfo, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const runtime = getClaimGraphRuntimeInfo();
    const providerResolution = resolveClaimGraphProvider();

    expect(config).toMatchObject({
      mode: "open-model",
      provider: "open-model",
      liveAnalysisEnabled: true,
      supportsUrlIntake: true,
      supportsWebSearch: false,
      openModelBackend: "ollama",
      openModelName: "qwen3:8b",
      ollamaBaseUrl: "http://127.0.0.1:11434"
    });
    expect(runtime).toMatchObject({
      mode: "open-model",
      provider: "open-model",
      liveAnalysisEnabled: true,
      supportsUrlIntake: true,
      supportsWebSearch: false,
      openModelBackend: "ollama",
      openModelModel: "qwen3:8b"
    });
    expect(providerResolution.provider?.id).toBe("open-model");
    expect(providerResolution.provider?.backend).toBe("ollama");
  });

  it("resolves the verified hosted vllm path when base URL and API key are configured", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "http://localhost:8000/v1";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    const { getClaimGraphRuntimeConfig, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const providerResolution = resolveClaimGraphProvider();

    expect(config.openModelBackend).toBe("vllm");
    expect(config.openModelApiKey).toBe("hf_test_token");
    expect(providerResolution.provider?.id).toBe("open-model");
    expect(providerResolution.provider?.backend).toBe("vllm");
  });

  it("resolves the verified hosted vllm path when the configured base URL omits /v1", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "http://localhost:8000";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    const { getClaimGraphRuntimeConfig, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const providerResolution = resolveClaimGraphProvider();

    expect(config.openModelBackend).toBe("vllm");
    expect(config.openModelBaseUrl).toBe("http://localhost:8000");
    expect(providerResolution.provider?.id).toBe("open-model");
    expect(providerResolution.provider?.backend).toBe("vllm");
  });

  it("requires OPEN_MODEL_BASE_URL before hosted vllm can be considered", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    const { getClaimGraphRuntimeConfig, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const providerResolution = resolveClaimGraphProvider();

    expect(config.openModelBackend).toBe("vllm");
    expect(providerResolution.provider).toBeNull();
    expect(providerResolution.unavailableFallbackReason).toBe("open_model_misconfigured");
    expect(providerResolution.unavailableReason).toContain("requires OPEN_MODEL_BASE_URL");
  });

  it("requires OPEN_MODEL_API_KEY before hosted vllm can be considered", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "http://localhost:8000/v1";

    const { getClaimGraphRuntimeConfig, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const providerResolution = resolveClaimGraphProvider();

    expect(config.openModelBackend).toBe("vllm");
    expect(providerResolution.provider).toBeNull();
    expect(providerResolution.unavailableFallbackReason).toBe("open_model_misconfigured");
    expect(providerResolution.unavailableReason).toContain("requires OPEN_MODEL_API_KEY");
  });

  it("keeps tgi explicitly gated until it is verified separately", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "tgi";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "http://localhost:8000/v1";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    const { getClaimGraphRuntimeConfig, resolveClaimGraphProvider } =
      await importRuntimeModules();

    const config = getClaimGraphRuntimeConfig();
    const providerResolution = resolveClaimGraphProvider();

    expect(config.openModelBackend).toBe("tgi");
    expect(providerResolution.provider).toBeNull();
    expect(providerResolution.unavailableFallbackReason).toBe("open_model_misconfigured");
    expect(providerResolution.unavailableReason).toContain("only the verified hosted vllm path is enabled");
  });
});
