import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();

function loadEnvFile(fileName) {
  const filePath = path.join(projectRoot, fileName);

  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

async function readOllamaServiceCatalog(baseUrl, model) {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    });

    if (!response.ok) {
      return {
        reachable: false,
        modelInstalled: false
      };
    }

    const payload = await response.json();
    const modelNames = (payload.models ?? [])
      .flatMap((item) => [item.name, item.model])
      .filter(Boolean);

    return {
      reachable: true,
      modelInstalled: modelNames.some(
        (name) => String(name).toLowerCase() === model.toLowerCase()
      )
    };
  } catch {
    return {
      reachable: false,
      modelInstalled: false
    };
  }
}

async function checkOllama(baseUrl, model) {
  const result = spawnSync("ollama", ["list"], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    const serviceCatalog = await readOllamaServiceCatalog(baseUrl, model);

    return {
      cliAvailable: false,
      serviceReachable: serviceCatalog.reachable,
      installed: serviceCatalog.reachable,
      modelInstalled: serviceCatalog.modelInstalled
    };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  return {
    cliAvailable: true,
    serviceReachable: true,
    installed: true,
    modelInstalled: output.includes(model.toLowerCase())
  };
}

function checkInstallerCommands() {
  const candidates = ["winget", "choco", "scoop"];
  return candidates.filter((command) => {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true
    });

    return !result.error && result.status === 0;
  });
}

const mode = process.env.CLAIMGRAPH_MODE?.trim() || (process.env.OPENAI_API_KEY ? "full" : "demo");
const backend = process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND?.trim() || "ollama";
const openModelName = process.env.CLAIMGRAPH_OPEN_MODEL_NAME?.trim() || "qwen3:8b";
const localDevelopmentModel = "qwen3:8b";
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/+$/, "");
const hostedBaseUrl = process.env.OPEN_MODEL_BASE_URL?.trim() || "";
const hostedTokenPresent = Boolean(
  process.env.OPEN_MODEL_API_KEY?.trim() || process.env.HF_TOKEN?.trim()
);
const openAIKeyPresent = Boolean(process.env.OPENAI_API_KEY?.trim());
const ollama = await checkOllama(ollamaBaseUrl, localDevelopmentModel);
const installerCommands = ollama.installed ? [] : checkInstallerCommands();

console.log("ClaimGraph runtime readiness");
console.log("");
console.log(`Selected mode: ${mode}`);
console.log(`Selected open-model backend: ${backend}`);
console.log(`Selected open-model model: ${openModelName}`);
console.log("");
console.log("Environment contract");
console.log(`- OPENAI_API_KEY present: ${openAIKeyPresent ? "yes" : "no"}`);
console.log(`- OPEN_MODEL_BASE_URL present: ${hostedBaseUrl ? "yes" : "no"}`);
console.log(`- Hosted token present: ${hostedTokenPresent ? "yes" : "no"}`);
console.log(`- Ollama CLI available: ${ollama.cliAvailable ? "yes" : "no"}`);
console.log(`- Ollama service reachable: ${ollama.serviceReachable ? "yes" : "no"} (${ollamaBaseUrl})`);
console.log(`- Ollama ${localDevelopmentModel} present: ${ollama.modelInstalled ? "yes" : "no"}`);
if (!ollama.installed) {
  console.log(`- Installer command available: ${installerCommands.length ? installerCommands.join(", ") : "no"}`);
}
console.log("");
console.log("Next action");

if (mode === "demo") {
  console.log("- Starter mode is selected; provider-backed live analysis is disabled.");
  console.log("- Select and verify Ollama or a hosted provider before relying on live analysis.");
} else if (mode === "full") {
  if (openAIKeyPresent) {
    console.log("- Premium OpenAI configuration is present.");
    console.log("- Run a representative workspace and inspect its run diagnostics before relying on the lane.");
  } else {
    console.log("- OPENAI_API_KEY is required for the selected full-mode runtime.");
  }
} else if (backend === "vllm" && (!hostedBaseUrl || !hostedTokenPresent)) {
  console.log("- Hosted vllm is selected but not fully configured.");
  console.log("- Add OPEN_MODEL_BASE_URL and OPEN_MODEL_API_KEY or HF_TOKEN, or switch to local Ollama.");
} else if (backend === "vllm") {
  console.log("- Hosted vllm configuration is present, but reachability and model availability are not yet verified.");
  console.log("- Run a representative workspace or an explicit provider probe before treating the lane as operational.");
} else if (backend === "tgi") {
  console.log("- TGI is not a verified runtime lane in this repository.");
  console.log("- Verify the configured endpoint and model explicitly before enabling it.");
} else if (!ollama.installed || !ollama.modelInstalled) {
  if (!ollama.installed && installerCommands.length === 0) {
    console.log("- Install Ollama manually or add winget, choco, or scoop to PATH.");
  } else if (!ollama.installed) {
    console.log("- Install Ollama with an available installer command.");
  } else {
    console.log(`- Pull ${localDevelopmentModel} before using the selected local runtime.`);
  }
} else {
  console.log("- The selected local Ollama lane is runnable in this environment.");
  console.log("- Run a representative workspace and inspect its run diagnostics before relying on the lane.");
}
