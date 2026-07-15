import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("fetch", fetchMock);

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalMode = process.env.CLAIMGRAPH_MODE;
const originalBackend = process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
const originalModel = process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
const originalBaseUrl = process.env.OPEN_MODEL_BASE_URL;
const originalToken = process.env.OPEN_MODEL_API_KEY;
const originalHfToken = process.env.HF_TOKEN;
const originalOpenAIKey = process.env.OPENAI_API_KEY;

const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "runtime-readiness");
const privateEvalCanary = "PRIVATE_EVAL_CANARY_MUST_NOT_LEAK";

function writePrivateEvalArtifacts() {
  const evalDir = path.join(testDataDir, "evals");
  mkdirSync(evalDir, { recursive: true });
  writeFileSync(
    path.join(evalDir, "latest-release.json"),
    JSON.stringify({
      privateEvalCanary,
      summary: {
        overallReleaseGateStatus: "pass",
        starterDemoReady: true,
        readyForReviewCount: 99,
        demoCandidateCount: 42
      }
    })
  );
  writeFileSync(
    path.join(evalDir, "latest-capture-plan.json"),
    JSON.stringify({
      privateEvalCanary,
      summary: {
        queuedCaptureCount: 0,
        prioritizedCaseIds: ["private_case_id"]
      }
    })
  );
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function useDefaultOllamaEndpoint() {
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
}

describe("getRuntimeReadinessSummary", () => {
  afterEach(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    fetchMock.mockReset();
    vi.resetModules();

    restoreEnv("CLAIMGRAPH_DATA_DIR", originalDataDir);
    restoreEnv("CLAIMGRAPH_MODE", originalMode);
    restoreEnv("CLAIMGRAPH_OPEN_MODEL_BACKEND", originalBackend);
    restoreEnv("CLAIMGRAPH_OPEN_MODEL_NAME", originalModel);
    restoreEnv("OLLAMA_BASE_URL", originalOllamaBaseUrl);
    restoreEnv("OPEN_MODEL_BASE_URL", originalBaseUrl);
    restoreEnv("OPEN_MODEL_API_KEY", originalToken);
    restoreEnv("HF_TOKEN", originalHfToken);
    restoreEnv("OPENAI_API_KEY", originalOpenAIKey);
  });

  it("reports runtime blockers without consuming or exposing private eval artifacts", async () => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL =
      "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    delete process.env.OPEN_MODEL_API_KEY;
    delete process.env.HF_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    useDefaultOllamaEndpoint();
    writePrivateEvalArtifacts();

    fetchMock.mockRejectedValue(new Error("not reachable"));

    const { getRuntimeReadinessSummary } = await import("@/lib/server/runtime-readiness");
    const summary = await getRuntimeReadinessSummary();
    const serialized = JSON.stringify(summary);

    expect(summary.overallStatus).toBe("blocked");
    expect(summary).not.toHaveProperty("evalCoverage");
    expect(serialized).not.toContain(privateEvalCanary);
    expect(serialized).not.toContain("releaseGateStatus");
    expect(serialized).not.toContain("demoCandidateCount");
    expect(serialized).not.toContain("prioritizedCaseIds");

    const selectedLane = summary.lanes.find((lane) => lane.id === "selected_runtime");
    const devLane = summary.lanes.find((lane) => lane.id === "development_ollama");
    const hostedLane = summary.lanes.find((lane) => lane.id === "launch_vllm");

    expect(selectedLane?.status).toBe("blocked");
    expect(selectedLane?.summary).toContain("not fully configured");
    expect(devLane?.status).toBe("blocked");
    expect(devLane?.details).toContain(
      "Ollama service did not respond at http://127.0.0.1:11434/api/tags."
    );
    expect(devLane?.nextAction).toContain("npm run runtime:check");
    expect(hostedLane?.status).toBe("blocked");
  });

  it("reports a ready local Ollama lane from runtime evidence only", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "ollama";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "qwen3:8b";
    delete process.env.OPENAI_API_KEY;
    useDefaultOllamaEndpoint();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: "qwen3:8b", model: "qwen3:8b" }]
      })
    });

    const { getRuntimeReadinessSummary } = await import("@/lib/server/runtime-readiness");
    const summary = await getRuntimeReadinessSummary();

    const selectedLane = summary.lanes.find((lane) => lane.id === "selected_runtime");
    const devLane = summary.lanes.find((lane) => lane.id === "development_ollama");

    expect(summary.overallStatus).toBe("ready");
    expect(selectedLane?.status).toBe("ready");
    expect(devLane?.status).toBe("ready");
    expect(summary.nextAction).toContain("representative workspace");
    expect(summary.nextAction).toContain("run diagnostics");
  });

  it("reports hosted vllm as configured until reachability is verified", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL =
      "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hosted-token";
    delete process.env.HF_TOKEN;
    delete process.env.OPENAI_API_KEY;
    useDefaultOllamaEndpoint();

    fetchMock.mockRejectedValue(new Error("not reachable"));

    const { getRuntimeReadinessSummary } = await import("@/lib/server/runtime-readiness");
    const summary = await getRuntimeReadinessSummary();
    const selectedLane = summary.lanes.find((lane) => lane.id === "selected_runtime");

    expect(summary.overallStatus).toBe("configured");
    expect(selectedLane?.status).toBe("configured");
    expect(summary.overallSummary).toContain("reachability and model availability");
    expect(summary.nextAction).toContain("provider probe");
  });

  it("keeps demo mode honest without implying that a live lane is runnable", async () => {
    process.env.CLAIMGRAPH_MODE = "demo";
    delete process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
    delete process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
    delete process.env.OPEN_MODEL_BASE_URL;
    delete process.env.OPEN_MODEL_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.OPENAI_API_KEY;
    useDefaultOllamaEndpoint();

    fetchMock.mockRejectedValue(new Error("not reachable"));

    const { getRuntimeReadinessSummary } = await import("@/lib/server/runtime-readiness");
    const summary = await getRuntimeReadinessSummary();
    const selectedLane = summary.lanes.find((lane) => lane.id === "selected_runtime");

    expect(selectedLane?.mode).toBe("demo");
    expect(selectedLane?.status).toBe("ready");
    expect(summary.overallStatus).toBe("configured");
    expect(summary.overallSummary).toContain("Starter mode is active");
    expect(summary.nextAction).toContain("live provider lane");
  });

  it("accepts a reachable Ollama service without bundling CLI probes", async () => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "ollama";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "qwen3:8b";
    delete process.env.OPENAI_API_KEY;
    useDefaultOllamaEndpoint();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: "qwen3:8b", model: "qwen3:8b" }]
      })
    });

    const { getRuntimeReadinessSummary } = await import("@/lib/server/runtime-readiness");
    const summary = await getRuntimeReadinessSummary();

    const selectedLane = summary.lanes.find((lane) => lane.id === "selected_runtime");
    const devLane = summary.lanes.find((lane) => lane.id === "development_ollama");

    expect(summary.overallStatus).toBe("ready");
    expect(selectedLane?.status).toBe("ready");
    expect(devLane?.details).toContain(
      "Ollama service responded at http://127.0.0.1:11434/api/tags."
    );
    expect(devLane?.details).toContain(
      "Model qwen3:8b is available from the service."
    );
  });
});
