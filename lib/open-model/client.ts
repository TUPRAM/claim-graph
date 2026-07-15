import { z } from "zod";
import { getClaimGraphRuntimeConfig } from "@/lib/claimgraph/config";
import type { HostedOpenModelHealthCheck, OpenModelBackend } from "@/types/claimgraph";

type OpenModelMessage = {
  role: "system" | "user";
  content: string;
};

type OpenAiCompatibleMessageContentPart = {
  text?: string;
};

type OpenAiCompatibleChatPayload = {
  model?: string;
  error?: { message?: string } | string;
  choices?: Array<{
    message?: {
      content?: string | OpenAiCompatibleMessageContentPart[];
    };
  }>;
};

interface CachedModelCatalog {
  checkedAt: number;
  modelNames: Set<string>;
}

const MODEL_CATALOG_TTL_MS = 15_000;
const modelCatalogCache = new Map<string, CachedModelCatalog>();

export class OpenModelConfigurationError extends Error {
  readonly hostedOpenModelHealth?: HostedOpenModelHealthCheck;

  constructor(message: string, hostedOpenModelHealth?: HostedOpenModelHealthCheck) {
    super(message);
    this.name = "OpenModelConfigurationError";
    this.hostedOpenModelHealth = hostedOpenModelHealth;
  }
}

export class OpenModelBackendUnavailableError extends Error {
  readonly hostedOpenModelHealth?: HostedOpenModelHealthCheck;

  constructor(message: string, hostedOpenModelHealth?: HostedOpenModelHealthCheck) {
    super(message);
    this.name = "OpenModelBackendUnavailableError";
    this.hostedOpenModelHealth = hostedOpenModelHealth;
  }
}

export class OpenModelModelUnavailableError extends Error {
  readonly hostedOpenModelHealth?: HostedOpenModelHealthCheck;

  constructor(message: string, hostedOpenModelHealth?: HostedOpenModelHealthCheck) {
    super(message);
    this.name = "OpenModelModelUnavailableError";
    this.hostedOpenModelHealth = hostedOpenModelHealth;
  }
}

export class OpenModelRequestTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly hostedOpenModelHealth?: HostedOpenModelHealthCheck;

  constructor(
    message: string,
    timeoutMs: number,
    hostedOpenModelHealth?: HostedOpenModelHealthCheck
  ) {
    super(message);
    this.name = "OpenModelRequestTimeoutError";
    this.timeoutMs = timeoutMs;
    this.hostedOpenModelHealth = hostedOpenModelHealth;
  }
}

export class OpenModelResponseValidationError extends Error {
  readonly hostedOpenModelHealth?: HostedOpenModelHealthCheck;

  constructor(message: string, hostedOpenModelHealth?: HostedOpenModelHealthCheck) {
    super(message);
    this.name = "OpenModelResponseValidationError";
    this.hostedOpenModelHealth = hostedOpenModelHealth;
  }
}

function getOpenModelTimeoutMs() {
  const raw = process.env.CLAIMGRAPH_OPEN_MODEL_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;

  if (Number.isFinite(parsed) && parsed >= 1_000) {
    return parsed;
  }

  return 90_000;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function normalizeModelName(value: string) {
  return value.trim().toLowerCase();
}

function getCatalogCacheKey(backend: OpenModelBackend, baseUrl: string) {
  return `${backend}:${baseUrl}`;
}

function buildUnavailableMessage(
  backend: OpenModelBackend,
  baseUrl: string,
  error: unknown
) {
  const message = error instanceof Error ? error.message : "Unknown error.";

  return `Open-model backend ${backend} is unavailable at ${baseUrl}. ${message}`;
}

function buildOllamaModelUnavailableMessage(baseUrl: string, model: string) {
  return [
    `Open-model backend ollama is reachable at ${baseUrl}, but model ${model} is not installed there.`,
    `Run "ollama pull ${model}" or set CLAIMGRAPH_OPEN_MODEL_NAME to one of the installed models from "ollama list".`
  ].join(" ");
}

function buildHostedModelUnavailableMessage(
  backend: "vllm",
  apiBaseUrl: string,
  model: string,
  availableModels: string[]
) {
  const availableText = availableModels.length
    ? `Available models: ${availableModels.join(", ")}.`
    : "The backend did not advertise any available model identifiers.";

  return [
    `Hosted open-model backend ${backend} is reachable at ${apiBaseUrl}, but model ${model} was not listed by /models.`,
    availableText,
    "Set CLAIMGRAPH_OPEN_MODEL_NAME to one of the served model identifiers or redeploy the endpoint with the intended model."
  ].join(" ");
}

function getCachedModelCatalog(backend: OpenModelBackend, baseUrl: string) {
  const cacheKey = getCatalogCacheKey(backend, baseUrl);
  const cached = modelCatalogCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.checkedAt > MODEL_CATALOG_TTL_MS) {
    modelCatalogCache.delete(cacheKey);
    return null;
  }

  return cached.modelNames;
}

function cacheModelCatalog(
  backend: OpenModelBackend,
  baseUrl: string,
  modelNames: Set<string>
) {
  modelCatalogCache.set(getCatalogCacheKey(backend, baseUrl), {
    checkedAt: Date.now(),
    modelNames
  });
}

function isKnownModel(modelNames: Set<string>, model: string) {
  return modelNames.has(normalizeModelName(model));
}

function isMissingOllamaModelError(message: string, model: string) {
  const normalizedMessage = message.toLowerCase();
  const normalizedModel = normalizeModelName(model);

  return (
    (normalizedMessage.includes("model") &&
      normalizedMessage.includes("not found")) ||
    normalizedMessage.includes(`pull model "${normalizedModel}" first`) ||
    normalizedMessage.includes(`pull "${normalizedModel}" first`) ||
    normalizedMessage.includes(`pull '${normalizedModel}' first`)
  );
}

function isHostedModelMissingError(message: string, model: string) {
  const normalizedMessage = message.toLowerCase();
  const normalizedModel = normalizeModelName(model);

  return (
    normalizedMessage.includes("model") &&
    normalizedMessage.includes(normalizedModel) &&
    (normalizedMessage.includes("not found") ||
      normalizedMessage.includes("does not exist") ||
      normalizedMessage.includes("unknown"))
  );
}

function getHostedApiBaseUrl(baseUrl: string, exactBaseUrl: boolean) {
  const normalized = baseUrl.replace(/\/+$/, "");

  if (exactBaseUrl) {
    return normalized;
  }

  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function buildHostedHeaders(apiKey: string) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`
  };
}

function buildHostedAuthErrorMessage(
  backend: "vllm",
  apiBaseUrl: string,
  status: 401 | 403
) {
  const statusDetail =
    status === 401
      ? "The endpoint reported the token as missing, expired, or invalid."
      : "The endpoint accepted the token format but denied infer access for this endpoint.";

  return [
    `Hosted open-model backend ${backend} rejected the configured OPEN_MODEL_API_KEY at ${apiBaseUrl}.`,
    statusDetail,
    "Make sure the token can call the private endpoint and includes the required Inference Endpoint infer permission."
  ].join(" ");
}

function buildHostedInvalidPayloadMessage(
  apiBaseUrl: string,
  route: "/models" | "/chat/completions",
  detail: string
) {
  return [
    `Hosted open-model backend vllm at ${apiBaseUrl} did not return the verified OpenAI-compatible payload shape from ${route}.`,
    detail
  ].join(" ");
}

function createHostedOpenModelHealthCheck(input: {
  apiBaseUrl: string;
  model: string;
  timeoutMs: number;
  catalogCache: "hit" | "miss";
}): HostedOpenModelHealthCheck {
  return {
    backend: "vllm",
    apiBaseUrl: input.apiBaseUrl,
    model: input.model,
    checkedAt: new Date().toISOString(),
    timeoutMs: input.timeoutMs,
    catalogRoute: `${input.apiBaseUrl}/models`,
    catalogStatus: "succeeded",
    catalogCache: input.catalogCache,
    completionRoute: `${input.apiBaseUrl}/chat/completions`,
    requestStatus: "not_started"
  };
}

function updateHostedOpenModelHealthCheck(
  health: HostedOpenModelHealthCheck,
  patch: Partial<HostedOpenModelHealthCheck>
): HostedOpenModelHealthCheck {
  return {
    ...health,
    ...patch,
    checkedAt: new Date().toISOString()
  };
}

function hasSupportedOpenAiCompatibleMessageContent(
  content: string | OpenAiCompatibleMessageContentPart[] | undefined
) {
  if (typeof content === "string") {
    return true;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((part) => typeof part?.text === "string");
}

function parseJsonContent<T>(
  content: string,
  schema: z.ZodType<T>,
  schemaName: string
) {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${schemaName} response was not valid JSON: ${
        error instanceof Error ? error.message : "parse failed"
      }`
    );
  }

  const parsedResult = schema.safeParse(parsedJson);

  if (!parsedResult.success) {
    const firstIssue = parsedResult.error.issues[0];
    throw new Error(
      `${schemaName} response failed schema validation at ${
        firstIssue?.path.join(".") || "<root>"
      }: ${firstIssue?.message || "invalid response"}`
    );
  }

  return parsedResult.data;
}

function extractOpenAiCompatibleMessageContent(
  content: string | OpenAiCompatibleMessageContentPart[] | undefined
) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("")
      .trim();
  }

  return "";
}

export function createOpenModelRequestOptions(signal?: AbortSignal) {
  const timeoutMs = getOpenModelTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;

  const handleAbort = () => {
    controller.abort(
      signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")
    );
  };

  if (signal?.aborted) {
    handleAbort();
  } else if (signal) {
    signal.addEventListener("abort", handleAbort, { once: true });
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException(
        `Open-model request exceeded ${timeoutMs}ms and was aborted.`,
        "AbortError"
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  return {
    signal: controller.signal,
    timeoutMs,
    didTimeout() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", handleAbort);
    }
  };
}

async function fetchOllamaModelCatalog(input: {
  baseUrl: string;
  signal?: AbortSignal;
}) {
  const request = createOpenModelRequestOptions(input.signal);
  let response: Response;

  try {
    response = await fetch(`${input.baseUrl}/api/tags`, {
      headers: {
        Accept: "application/json"
      },
      signal: request.signal
    });
  } catch (error) {
    if (request.didTimeout()) {
      throw new OpenModelRequestTimeoutError(
        `Open-model backend ollama did not return its model catalog before the configured timeout at ${input.baseUrl}.`,
        request.timeoutMs
      );
    }

    if (!isAbortError(error)) {
      throw new OpenModelBackendUnavailableError(
        buildUnavailableMessage("ollama", input.baseUrl, error)
      );
    }

    throw error;
  }

  try {
    if (!response.ok) {
      const errorText = await response.text();
      throw new OpenModelBackendUnavailableError(
        `Open-model backend ollama did not return a healthy model catalog from ${input.baseUrl}/api/tags. Received ${response.status}. ${errorText || "No response body."}`
      );
    }

    const payload = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };

    if (!Array.isArray(payload.models)) {
      throw new OpenModelBackendUnavailableError(
        `Open-model backend ollama at ${input.baseUrl} did not return the expected model catalog from /api/tags.`
      );
    }

    return new Set(
      payload.models.flatMap((modelEntry) =>
        [modelEntry.name, modelEntry.model]
          .filter((value): value is string => Boolean(value?.trim()))
          .map(normalizeModelName)
      )
    );
  } finally {
    request.cleanup();
  }
}

async function fetchHostedModelCatalog(input: {
  backend: "vllm";
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}) {
  const request = createOpenModelRequestOptions(input.signal);
  const baseHealth = createHostedOpenModelHealthCheck({
    apiBaseUrl: input.apiBaseUrl,
    model: input.model,
    timeoutMs: request.timeoutMs,
    catalogCache: "miss"
  });
  let response: Response;

  try {
    response = await fetch(`${input.apiBaseUrl}/models`, {
      headers: buildHostedHeaders(input.apiKey),
      signal: request.signal
    });
  } catch (error) {
    if (request.didTimeout()) {
      const timeoutMessage = `Hosted open-model backend ${input.backend} did not return its model catalog before CLAIMGRAPH_OPEN_MODEL_TIMEOUT_MS=${request.timeoutMs} at ${input.apiBaseUrl}/models.`;
      throw new OpenModelRequestTimeoutError(
        timeoutMessage,
        request.timeoutMs,
        updateHostedOpenModelHealthCheck(baseHealth, {
          catalogStatus: "timed_out",
          lastErrorMessage: timeoutMessage
        })
      );
    }

    if (!isAbortError(error)) {
      const unavailableMessage = buildUnavailableMessage(input.backend, input.apiBaseUrl, error);
      throw new OpenModelBackendUnavailableError(
        unavailableMessage,
        updateHostedOpenModelHealthCheck(baseHealth, {
          catalogStatus: "unreachable",
          lastErrorMessage: unavailableMessage
        })
      );
    }

    throw error;
  }

  try {
    if (response.status === 401 || response.status === 403) {
      const authMessage = buildHostedAuthErrorMessage(
        input.backend,
        input.apiBaseUrl,
        response.status
      );
      throw new OpenModelConfigurationError(
        authMessage,
        updateHostedOpenModelHealthCheck(baseHealth, {
          catalogStatus: "auth_rejected",
          lastErrorMessage: authMessage
        })
      );
    }

    if (response.status === 404) {
      const routeMessage = `Hosted open-model backend ${input.backend} at ${input.apiBaseUrl} did not expose the OpenAI-compatible /models route. Check OPEN_MODEL_BASE_URL and the hosted engine configuration.`;
      throw new OpenModelConfigurationError(
        routeMessage,
        updateHostedOpenModelHealthCheck(baseHealth, {
          catalogStatus: "route_missing",
          lastErrorMessage: routeMessage
        })
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      const unavailableMessage =
        `Hosted open-model backend ${input.backend} did not return a healthy model catalog from ${input.apiBaseUrl}/models. Received ${response.status}. ${errorText || "No response body."}`;
      throw new OpenModelBackendUnavailableError(
        unavailableMessage,
        updateHostedOpenModelHealthCheck(baseHealth, {
          catalogStatus: "unreachable",
          lastErrorMessage: unavailableMessage
        })
      );
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch (error) {
      const payloadMessage = buildHostedInvalidPayloadMessage(
        input.apiBaseUrl,
        "/models",
        `The response body was not valid JSON. ${
          error instanceof Error ? error.message : "JSON parsing failed."
        }`
      );
      throw new OpenModelConfigurationError(
        payloadMessage,
        updateHostedOpenModelHealthCheck(baseHealth, {
          catalogStatus: "invalid_payload",
          lastErrorMessage: payloadMessage
        })
      );
    }

    const modelEntries: unknown[] | undefined = Array.isArray(payload)
      ? payload
      : payload &&
          typeof payload === "object" &&
          "data" in payload &&
          Array.isArray(payload.data)
        ? payload.data
        : undefined;

    if (!modelEntries) {
      const payloadMessage = buildHostedInvalidPayloadMessage(
        input.apiBaseUrl,
        "/models",
        "Expected either a top-level array or a JSON object with a data array of model identifiers."
      );
      throw new OpenModelConfigurationError(
        payloadMessage,
        updateHostedOpenModelHealthCheck(baseHealth, {
          catalogStatus: "invalid_payload",
          lastErrorMessage: payloadMessage
        })
      );
    }

    const modelNames = new Set(
      modelEntries.flatMap((modelEntry) => {
        if (!modelEntry || typeof modelEntry !== "object") {
          return [];
        }

        const entry = modelEntry as Record<string, unknown>;

        return [entry.id, entry.root, entry.name]
          .filter(
            (value): value is string =>
              typeof value === "string" && Boolean(value.trim())
          )
          .map(normalizeModelName);
      })
    );

    return {
      modelNames,
      health: updateHostedOpenModelHealthCheck(baseHealth, {
        catalogStatus: "succeeded",
        advertisedModelCount: modelNames.size
      })
    };
  } finally {
    request.cleanup();
  }
}

async function ensureOllamaModelAvailable(input: {
  baseUrl: string;
  model: string;
  signal?: AbortSignal;
}) {
  const cachedCatalog = getCachedModelCatalog("ollama", input.baseUrl);
  const modelNames =
    cachedCatalog ??
    (await fetchOllamaModelCatalog({
      baseUrl: input.baseUrl,
      signal: input.signal
    }));

  if (!cachedCatalog) {
    cacheModelCatalog("ollama", input.baseUrl, modelNames);
  }

  if (!isKnownModel(modelNames, input.model)) {
    throw new OpenModelModelUnavailableError(
      buildOllamaModelUnavailableMessage(input.baseUrl, input.model)
    );
  }
}

async function ensureHostedModelAvailable(input: {
  backend: "vllm";
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}) {
  const cachedCatalog = getCachedModelCatalog(input.backend, input.apiBaseUrl);
  const fetchedCatalog = cachedCatalog
    ? {
        modelNames: cachedCatalog,
        health: updateHostedOpenModelHealthCheck(
          createHostedOpenModelHealthCheck({
            apiBaseUrl: input.apiBaseUrl,
            model: input.model,
            timeoutMs: getOpenModelTimeoutMs(),
            catalogCache: "hit"
          }),
          {
            catalogStatus: "succeeded",
            advertisedModelCount: cachedCatalog.size
          }
        )
      }
    : await fetchHostedModelCatalog({
        backend: input.backend,
        apiBaseUrl: input.apiBaseUrl,
        apiKey: input.apiKey,
        model: input.model,
        signal: input.signal
      });
  const modelNames = fetchedCatalog.modelNames;

  if (!cachedCatalog) {
    cacheModelCatalog(input.backend, input.apiBaseUrl, modelNames);
  }

  if (!isKnownModel(modelNames, input.model)) {
    const unavailableMessage = buildHostedModelUnavailableMessage(
      input.backend,
      input.apiBaseUrl,
      input.model,
      [...modelNames].sort()
    );
    throw new OpenModelModelUnavailableError(
      unavailableMessage,
      updateHostedOpenModelHealthCheck(fetchedCatalog.health, {
        requestStatus: "model_missing",
        lastErrorMessage: unavailableMessage
      })
    );
  }

  return fetchedCatalog.health;
}

async function requestOllamaStructuredOutput<T>(input: {
  baseUrl: string;
  model: string;
  schema: z.ZodType<T>;
  schemaName: string;
  messages: OpenModelMessage[];
  signal?: AbortSignal;
}) {
  const request = createOpenModelRequestOptions(input.signal);
  let response: Response;

  try {
    response = await fetch(`${input.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: false,
        format: z.toJSONSchema(input.schema),
        options: {
          temperature: 0
        }
      }),
      signal: request.signal
    });
  } catch (error) {
    if (request.didTimeout()) {
      throw new OpenModelRequestTimeoutError(
        `Open-model request exceeded the configured timeout while using ${input.model}.`,
        request.timeoutMs
      );
    }

    if (!isAbortError(error)) {
      throw new OpenModelBackendUnavailableError(
        buildUnavailableMessage("ollama", input.baseUrl, error)
      );
    }

    throw error;
  }

  try {
    if (!response.ok) {
      const errorText = await response.text();

      if (isMissingOllamaModelError(errorText, input.model)) {
        throw new OpenModelModelUnavailableError(
          buildOllamaModelUnavailableMessage(input.baseUrl, input.model)
        );
      }

      throw new Error(
        `Ollama returned ${response.status}. ${errorText || "No response body."}`
      );
    }

    const payload = (await response.json()) as {
      message?: { content?: string };
      model?: string;
      error?: string;
    };

    if (payload.error) {
      if (isMissingOllamaModelError(payload.error, input.model)) {
        throw new OpenModelModelUnavailableError(
          buildOllamaModelUnavailableMessage(input.baseUrl, input.model)
        );
      }

      throw new Error(payload.error);
    }

    const content = payload.message?.content?.trim();

    if (!content) {
      throw new Error("Ollama returned an empty response body.");
    }

    return {
      model: payload.model?.trim() || input.model,
      rawText: content,
      output: parseJsonContent(content, input.schema, input.schemaName)
    };
  } finally {
    request.cleanup();
  }
}

async function requestVllmStructuredOutput<T>(input: {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  schema: z.ZodType<T>;
  schemaName: string;
  messages: OpenModelMessage[];
  hostedOpenModelHealth: HostedOpenModelHealthCheck;
  attempt: number;
  maxAttempts: number;
  previousValidationError?: string | null;
  signal?: AbortSignal;
}) {
  const request = createOpenModelRequestOptions(input.signal);
  const requestHealth = updateHostedOpenModelHealthCheck(input.hostedOpenModelHealth, {
    timeoutMs: request.timeoutMs,
    requestAttempt: input.attempt,
    requestMaxAttempts: input.maxAttempts
  });
  let response: Response;

  try {
    response = await fetch(`${input.apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...buildHostedHeaders(input.apiKey),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: false,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: input.schemaName,
            strict: true,
            schema: z.toJSONSchema(input.schema)
          }
        }
      }),
      signal: request.signal
    });
  } catch (error) {
    if (request.didTimeout()) {
      const timeoutMessage =
        `Hosted open-model request exceeded CLAIMGRAPH_OPEN_MODEL_TIMEOUT_MS=${request.timeoutMs} while using ${input.model} through ${input.apiBaseUrl}/chat/completions.`;
      throw new OpenModelRequestTimeoutError(
        timeoutMessage,
        request.timeoutMs,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "timed_out",
          lastErrorMessage: timeoutMessage
        })
      );
    }

    if (!isAbortError(error)) {
      const unavailableMessage = buildUnavailableMessage("vllm", input.apiBaseUrl, error);
      throw new OpenModelBackendUnavailableError(
        unavailableMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "unreachable",
          lastErrorMessage: unavailableMessage
        })
      );
    }

    throw error;
  }

  try {
    if (response.status === 401 || response.status === 403) {
      const authMessage = buildHostedAuthErrorMessage(
        "vllm",
        input.apiBaseUrl,
        response.status
      );
      throw new OpenModelConfigurationError(
        authMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "auth_rejected",
          lastErrorMessage: authMessage
        })
      );
    }

    if (response.status === 404) {
      const routeMessage =
        `Hosted open-model backend vllm at ${input.apiBaseUrl} did not expose the OpenAI-compatible /chat/completions route. Check OPEN_MODEL_BASE_URL and the hosted engine configuration.`;
      throw new OpenModelConfigurationError(
        routeMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "route_missing",
          lastErrorMessage: routeMessage
        })
      );
    }

    if (!response.ok) {
      const errorText = await response.text();

      if (isHostedModelMissingError(errorText, input.model)) {
        const unavailableMessage = buildHostedModelUnavailableMessage(
          "vllm",
          input.apiBaseUrl,
          input.model,
          []
        );
        throw new OpenModelModelUnavailableError(
          unavailableMessage,
          updateHostedOpenModelHealthCheck(requestHealth, {
            requestStatus: "model_missing",
            lastErrorMessage: unavailableMessage
          })
        );
      }

      const responseErrorMessage =
        `Hosted open-model backend vllm returned ${response.status}. ${errorText || "No response body."}`;
      throw new OpenModelBackendUnavailableError(
        responseErrorMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "response_error",
          lastErrorMessage: responseErrorMessage
        })
      );
    }

    let payload: OpenAiCompatibleChatPayload;

    try {
      payload = (await response.json()) as OpenAiCompatibleChatPayload;
    } catch (error) {
      const payloadMessage = buildHostedInvalidPayloadMessage(
        input.apiBaseUrl,
        "/chat/completions",
        `The response body was not valid JSON. ${
          error instanceof Error ? error.message : "JSON parsing failed."
        }`
      );
      throw new OpenModelConfigurationError(
        payloadMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "invalid_payload",
          lastErrorMessage: payloadMessage
        })
      );
    }

    const payloadError =
      typeof payload.error === "string" ? payload.error : payload.error?.message;

    if (payloadError) {
      if (isHostedModelMissingError(payloadError, input.model)) {
        const unavailableMessage = buildHostedModelUnavailableMessage(
          "vllm",
          input.apiBaseUrl,
          input.model,
          []
        );
        throw new OpenModelModelUnavailableError(
          unavailableMessage,
          updateHostedOpenModelHealthCheck(requestHealth, {
            requestStatus: "model_missing",
            lastErrorMessage: unavailableMessage
          })
        );
      }

      throw new OpenModelBackendUnavailableError(
        payloadError,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "response_error",
          lastErrorMessage: payloadError
        })
      );
    }

    if (!Array.isArray(payload.choices) || !payload.choices.length) {
      const payloadMessage = buildHostedInvalidPayloadMessage(
        input.apiBaseUrl,
        "/chat/completions",
        "Expected a choices array with at least one assistant message."
      );
      throw new OpenModelConfigurationError(
        payloadMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "invalid_payload",
          lastErrorMessage: payloadMessage
        })
      );
    }

    if (
      !hasSupportedOpenAiCompatibleMessageContent(payload.choices[0]?.message?.content)
    ) {
      const payloadMessage = buildHostedInvalidPayloadMessage(
        input.apiBaseUrl,
        "/chat/completions",
        "Expected the first choice to include message.content as either a string or an array of text parts."
      );
      throw new OpenModelConfigurationError(
        payloadMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "invalid_payload",
          lastErrorMessage: payloadMessage
        })
      );
    }

    const content = extractOpenAiCompatibleMessageContent(
      payload.choices?.[0]?.message?.content
    );

    if (!content) {
      const emptyBodyMessage =
        "Hosted open-model backend vllm returned an empty chat completion body.";
      throw new OpenModelBackendUnavailableError(
        emptyBodyMessage,
        updateHostedOpenModelHealthCheck(requestHealth, {
          requestStatus: "response_error",
          lastErrorMessage: emptyBodyMessage
        })
      );
    }

    return {
      model: payload.model?.trim() || input.model,
      rawText: content,
      output: parseJsonContent(content, input.schema, input.schemaName),
      hostedOpenModelHealth: updateHostedOpenModelHealthCheck(requestHealth, {
        requestStatus: input.previousValidationError
          ? "succeeded_after_validation_retry"
          : "succeeded",
        lastErrorMessage: input.previousValidationError ?? undefined
      })
    };
  } finally {
    request.cleanup();
  }
}

export async function requestStructuredOpenModelOutput<T>(input: {
  schema: z.ZodType<T>;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  maxAttempts?: number;
}): Promise<{
  backend: OpenModelBackend;
  model: string;
  output: T;
  hostedOpenModelHealth?: HostedOpenModelHealthCheck;
}> {
  const config = getClaimGraphRuntimeConfig();
  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);
  let hostedOpenModelHealth: HostedOpenModelHealthCheck | undefined;

  if (config.mode !== "open-model") {
    throw new OpenModelConfigurationError(
      "requestStructuredOpenModelOutput was called outside open-model mode."
    );
  }

  if (config.openModelBackend === "ollama") {
    await ensureOllamaModelAvailable({
      baseUrl: config.ollamaBaseUrl,
      model: config.openModelName,
      signal: input.signal
    });
  } else if (config.openModelBackend === "vllm") {
    if (!config.openModelBaseUrl) {
      throw new OpenModelConfigurationError(
        "Hosted open-model backend vllm requires OPEN_MODEL_BASE_URL."
      );
    }

    if (!config.openModelApiKey) {
      throw new OpenModelConfigurationError(
        "Hosted open-model backend vllm requires OPEN_MODEL_API_KEY (or HF_TOKEN) so ClaimGraph can call the private endpoint honestly."
      );
    }

    hostedOpenModelHealth = await ensureHostedModelAvailable({
      backend: "vllm",
      apiBaseUrl: getHostedApiBaseUrl(
        config.openModelBaseUrl,
        config.openModelExactBaseUrl
      ),
      apiKey: config.openModelApiKey,
      model: config.openModelName,
      signal: input.signal
    });
  } else {
    if (!config.openModelBaseUrl) {
      throw new OpenModelConfigurationError(
        "Hosted open-model backend tgi requires OPEN_MODEL_BASE_URL."
      );
    }

    throw new OpenModelConfigurationError(
      `Hosted open-model backend ${config.openModelBackend} is configured at ${config.openModelBaseUrl}, but only Ollama and the verified hosted vllm path are enabled in this repo right now.`
    );
  }

  let validationError: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages: OpenModelMessage[] = [
      {
        role: "system",
        content: [
          input.systemPrompt,
          "Return JSON only.",
          `Schema name: ${input.schemaName}.`
        ].join("\n")
      },
      {
        role: "user",
        content: validationError
          ? `${input.userPrompt}\n\nThe previous attempt failed validation: ${validationError}\nReturn only valid JSON that matches the required schema exactly.`
          : input.userPrompt
      }
    ];

    try {
      if (config.openModelBackend === "ollama") {
        const response = await requestOllamaStructuredOutput({
          baseUrl: config.ollamaBaseUrl,
          model: config.openModelName,
          schema: input.schema,
          schemaName: input.schemaName,
          messages,
          signal: input.signal
        });

        return {
          backend: config.openModelBackend,
          model: response.model,
          output: response.output
        };
      }

      const response = await requestVllmStructuredOutput({
        apiBaseUrl: getHostedApiBaseUrl(
          config.openModelBaseUrl!,
          config.openModelExactBaseUrl
        ),
        apiKey: config.openModelApiKey!,
        model: config.openModelName,
        schema: input.schema,
        schemaName: input.schemaName,
        messages,
        hostedOpenModelHealth: hostedOpenModelHealth!,
        attempt,
        maxAttempts,
        previousValidationError: validationError,
        signal: input.signal
      });

      return {
        backend: config.openModelBackend,
        model: response.model,
        output: response.output,
        hostedOpenModelHealth: response.hostedOpenModelHealth
      };
    } catch (error) {
      if (
        error instanceof OpenModelBackendUnavailableError ||
        error instanceof OpenModelConfigurationError ||
        error instanceof OpenModelModelUnavailableError ||
        error instanceof OpenModelRequestTimeoutError ||
        isAbortError(error)
      ) {
        throw error;
      }

      validationError =
        error instanceof Error ? error.message : "Open-model validation failed.";

      if (attempt === maxAttempts) {
        if (config.openModelBackend === "vllm" && hostedOpenModelHealth) {
          throw new OpenModelResponseValidationError(
            `Hosted open-model backend vllm failed schema validation after ${maxAttempts} attempts. ${validationError}`,
            updateHostedOpenModelHealthCheck(hostedOpenModelHealth, {
              requestStatus: "validation_failed",
              requestAttempt: attempt,
              requestMaxAttempts: maxAttempts,
              lastErrorMessage: validationError
            })
          );
        }

        throw new Error(
          `Open-model response failed schema validation after ${maxAttempts} attempts. ${validationError}`
        );
      }
    }
  }

  throw new Error("Open-model request failed before producing structured output.");
}
