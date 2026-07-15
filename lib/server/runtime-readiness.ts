import { getClaimGraphRuntimeConfig } from "@/lib/claimgraph/config";
import type {
  RuntimeLaneReadiness,
  RuntimeLaneStatus,
  RuntimeReadinessSummary
} from "@/types/claimgraph";

const PRODUCT_PROMISE =
  "ClaimGraph is a graph-first argument workspace for tradeoff and policy-style questions. It produces claims, counterclaims, evidence, gaps, and explicit provenance instead of a chat answer.";

function nowIso() {
  return new Date().toISOString();
}

async function readOllamaServiceCatalog(baseUrl: string, model: string) {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3_000)
    });

    if (!response.ok) {
      return {
        reachable: false,
        modelInstalled: false,
        detail: `Ollama service responded at ${baseUrl}/api/tags with HTTP ${response.status}.`
      };
    }

    const payload = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const modelNames = (payload.models ?? [])
      .flatMap((item) => [item.name, item.model])
      .filter((value): value is string => Boolean(value));

    return {
      reachable: true,
      modelInstalled: modelNames.some(
        (name) => name.toLowerCase() === model.toLowerCase()
      ),
      detail: `Ollama service responded at ${baseUrl}/api/tags.`
    };
  } catch {
    return {
      reachable: false,
      modelInstalled: false,
      detail: `Ollama service did not respond at ${baseUrl}/api/tags.`
    };
  }
}

async function buildDevelopmentLane(
  baseUrl: string,
  model: string
): Promise<RuntimeLaneReadiness> {
  // Keep the bundled readiness route network-only. CLI and package-manager
  // probes belong in scripts/check-runtime-readiness.mjs; child-process calls
  // here cause Node file tracing to conservatively package the whole checkout.
  const ollama = await readOllamaServiceCatalog(baseUrl, model);

  if (!ollama.reachable) {
    return {
      id: "development_ollama",
      label: "Local development lane",
      mode: "advisory",
      backend: "ollama",
      model,
      status: "blocked",
      summary: "Local Ollama analysis is blocked because the Ollama service is not reachable.",
      details: [ollama.detail, `Expected local development model: ${model}.`],
      nextAction: `Start or install Ollama, then run \`ollama pull ${model}\` to restore the local development lane. Run \`npm run runtime:check\` for CLI-specific diagnostics.`
    };
  }

  if (!ollama.modelInstalled) {
    return {
      id: "development_ollama",
      label: "Local development lane",
      mode: "advisory",
      backend: "ollama",
      model,
      status: "blocked",
      summary: "The local Ollama service is reachable, but the expected development model is missing.",
      details: [ollama.detail, `Model ${model} is not available from the service.`],
      nextAction: `Run \`ollama pull ${model}\` before using Ollama for local analysis.`
    };
  }

  return {
    id: "development_ollama",
    label: "Local development lane",
    mode: "advisory",
    backend: "ollama",
    model,
    status: "ready",
    summary: "The local Ollama development lane is runnable on this machine.",
    details: [
      ollama.detail,
      `Model ${model} is available from the service.`,
      "Use this lane for low-cost local verification before using a hosted provider."
    ],
    nextAction: "Run a representative local workspace, then validate any hosted lane separately."
  };
}

function buildLaunchLane(config: ReturnType<typeof getClaimGraphRuntimeConfig>): RuntimeLaneReadiness {
  const hasBaseUrl = Boolean(config.openModelBaseUrl);
  const hasToken = Boolean(config.openModelApiKey);
  const details = [
    hasBaseUrl
      ? `Hosted base URL configured: ${config.openModelBaseUrl}`
      : "Hosted base URL is missing.",
    hasToken
      ? "Hosted token is configured."
      : "Hosted token is missing. Set OPEN_MODEL_API_KEY or HF_TOKEN."
  ];

  if (!hasBaseUrl || !hasToken) {
    return {
      id: "launch_vllm",
      label: "Hosted vllm lane",
      mode: "advisory",
      backend: "vllm",
      model: config.openModelName,
      status: "blocked",
      summary: "The hosted vllm lane is not fully configured for this environment.",
      details,
      nextAction: "Add the hosted vllm token and keep the endpoint on the verified OpenAI-compatible route shape."
    };
  }

  return {
    id: "launch_vllm",
    label: "Hosted vllm lane",
    mode: "advisory",
    backend: "vllm",
    model: config.openModelName,
    status: "configured",
    summary: "The hosted vllm lane has the required config, but network reachability still needs a real run or manual probe.",
    details: [
      ...details,
      "This status confirms configuration only; it does not prove provider reachability or model availability."
    ],
    nextAction: "Run a real hosted analysis or use the workspace run diagnostics to verify endpoint reachability and model availability."
  };
}

function buildPremiumLane(): RuntimeLaneReadiness {
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());

  return hasKey
    ? {
        id: "premium_openai",
        label: "Premium OpenAI lane",
        mode: "advisory",
        backend: "openai",
        status: "configured",
        summary: "OPENAI_API_KEY is present, so the premium full-mode lane can be selected when you intentionally want it.",
        details: [
          "This repo still treats full mode as a separate premium lane, not the no-cost development default.",
          "Use full mode deliberately because it changes both cost and evidence-gathering behavior."
        ],
        nextAction: "Keep this lane for intentional premium verification, not as a substitute for the selected runtime."
      }
    : {
        id: "premium_openai",
        label: "Premium OpenAI lane",
        mode: "advisory",
        backend: "openai",
        status: "blocked",
        summary: "OPENAI_API_KEY is not configured, so full mode cannot run.",
        details: [
          "Starter mode remains usable without this key.",
          "The selected runtime does not require this lane to be configured."
        ],
        nextAction: "Only add OPENAI_API_KEY if you intentionally want the premium full-mode path."
      };
}

function buildSelectedLane(
  config: ReturnType<typeof getClaimGraphRuntimeConfig>,
  developmentLane: RuntimeLaneReadiness,
  launchLane: RuntimeLaneReadiness,
  premiumLane: RuntimeLaneReadiness
): RuntimeLaneReadiness {
  if (config.mode === "demo") {
    return {
      id: "selected_runtime",
      label: "Selected runtime",
      mode: "demo",
      backend: "starter",
      status: "ready",
      summary: "The repo is currently on the curated starter lane only.",
      details: [
        "This supports the curated demo and UI verification.",
        "It does not provide provider-backed live analysis."
      ],
      nextAction: "Select and verify Ollama or a hosted provider before relying on live analysis."
    };
  }

  if (config.mode === "full") {
    return {
      ...premiumLane,
      id: "selected_runtime",
      label: "Selected runtime",
      mode: "full"
    };
  }

  if (config.openModelBackend === "ollama") {
    return {
      ...developmentLane,
      id: "selected_runtime",
      label: "Selected runtime",
      mode: "open-model"
    };
  }

  if (config.openModelBackend === "vllm") {
    return {
      ...launchLane,
      id: "selected_runtime",
      label: "Selected runtime",
      mode: "open-model"
    };
  }

  return {
    id: "selected_runtime",
    label: "Selected runtime",
    mode: "open-model",
    backend: "tgi",
    model: config.openModelName,
    status: "blocked",
    summary: "TGI remains an unverified hosted path in this repo and is intentionally gated.",
    details: [
      "The repo only verifies local Ollama and one hosted vllm route shape today.",
      "Do not enable TGI without verifying the configured endpoint and model."
    ],
    nextAction: "Use Ollama or hosted vllm instead. Verify any TGI target explicitly before enabling it."
  };
}

function buildOverallSummary(input: {
  selectedMode: RuntimeReadinessSummary["selectedMode"];
  selectedLane: RuntimeLaneReadiness;
}) {
  if (input.selectedMode === "demo") {
    return {
      status: "configured" as RuntimeLaneStatus,
      summary:
        "Starter mode is active. Provider-backed live analysis is not selected.",
      nextAction:
        "Select and verify a live provider lane before relying on provider-backed analysis."
    };
  }

  if (input.selectedLane.status === "ready") {
    return {
      status: "ready" as RuntimeLaneStatus,
      summary: "The selected live-analysis lane is runnable in this environment.",
      nextAction:
        "Run a representative workspace and inspect its run diagnostics before relying on the lane."
    };
  }

  if (input.selectedLane.status === "configured") {
    return {
      status: "configured" as RuntimeLaneStatus,
      summary:
        "The selected lane has the required configuration, but reachability and model availability are not yet verified.",
      nextAction:
        "Run a representative workspace or an explicit provider probe before treating the lane as operational."
    };
  }

  return {
    status: "blocked" as RuntimeLaneStatus,
    summary:
      "The selected live-analysis lane is blocked at the environment or provider configuration boundary.",
    nextAction:
      input.selectedLane.nextAction ??
      "Configure and verify a live-analysis lane before relying on provider-backed analysis."
  };
}

export async function getRuntimeReadinessSummary(): Promise<RuntimeReadinessSummary> {
  const config = getClaimGraphRuntimeConfig();
  const developmentLane = await buildDevelopmentLane(
    config.ollamaBaseUrl,
    "qwen3:8b"
  );
  const launchLane = buildLaunchLane(config);
  const premiumLane = buildPremiumLane();
  const selectedLane = buildSelectedLane(
    config,
    developmentLane,
    launchLane,
    premiumLane
  );
  const overall = buildOverallSummary({
    selectedMode: config.mode,
    selectedLane
  });

  return {
    checkedAt: nowIso(),
    productPromise: PRODUCT_PROMISE,
    selectedMode: config.mode,
    overallStatus: overall.status,
    overallSummary: overall.summary,
    nextAction: overall.nextAction,
    lanes: [selectedLane, developmentLane, launchLane, premiumLane]
  };
}
