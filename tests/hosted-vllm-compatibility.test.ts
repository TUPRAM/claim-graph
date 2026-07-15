import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockHostedVllmFetch } from "./helpers/hosted-vllm";

const originalMode = process.env.CLAIMGRAPH_MODE;
const originalBackend = process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
const originalModel = process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
const originalOpenModelBaseUrl = process.env.OPEN_MODEL_BASE_URL;
const originalExactBaseUrl = process.env.CLAIMGRAPH_OPEN_MODEL_EXACT_BASE_URL;
const originalOpenModelApiKey = process.env.OPEN_MODEL_API_KEY;
const originalFetch = global.fetch;

describe("hosted vllm compatibility coverage", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL =
      "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";
    delete process.env.CLAIMGRAPH_OPEN_MODEL_EXACT_BASE_URL;
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    global.fetch = originalFetch;

    if (originalMode === undefined) {
      delete process.env.CLAIMGRAPH_MODE;
    } else {
      process.env.CLAIMGRAPH_MODE = originalMode;
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

    if (originalExactBaseUrl === undefined) {
      delete process.env.CLAIMGRAPH_OPEN_MODEL_EXACT_BASE_URL;
    } else {
      process.env.CLAIMGRAPH_OPEN_MODEL_EXACT_BASE_URL = originalExactBaseUrl;
    }
  });

  it("supports an exact hosted base URL with a top-level model catalog", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "gpt-4o-mini";
    process.env.OPEN_MODEL_BASE_URL = "https://models.inference.ai.azure.com";
    process.env.CLAIMGRAPH_OPEN_MODEL_EXACT_BASE_URL = "1";
    global.fetch = createMockHostedVllmFetch({
      hostBaseUrl: "https://models.inference.ai.azure.com",
      exactBaseUrl: true,
      models: {
        jsonBody: [
          {
            id: "azureml://registries/azure-openai/models/gpt-4o-mini/versions/1",
            name: "gpt-4o-mini"
          }
        ]
      },
      completions: [
        {
          jsonBody: {
            model: "gpt-4o-mini",
            choices: [
              {
                message: {
                  content: JSON.stringify({ ok: true })
                }
              }
            ]
          }
        }
      ]
    });

    const { requestStructuredOpenModelOutput } = await import("@/lib/open-model/client");

    const result = await requestStructuredOpenModelOutput({
      schema: z.object({ ok: z.literal(true) }),
      schemaName: "test_exact_base_catalog_schema",
      systemPrompt: "Return valid JSON only.",
      userPrompt: "Produce the requested test payload."
    });

    expect(result.output).toEqual({ ok: true });
    expect(result.hostedOpenModelHealth).toMatchObject({
      apiBaseUrl: "https://models.inference.ai.azure.com",
      catalogRoute: "https://models.inference.ai.azure.com/models",
      completionRoute: "https://models.inference.ai.azure.com/chat/completions",
      catalogStatus: "succeeded",
      requestStatus: "succeeded"
    });
  });

  it("accepts the verified hosted route shape when the endpoint base omits /v1 and the model catalog advertises the model as root", async () => {
    const capturedBodies: unknown[] = [];
    global.fetch = createMockHostedVllmFetch({
      hostBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud",
      models: {
        jsonBody: {
          data: [{ root: "Qwen/Qwen3-8B" }]
        }
      },
      completions: [
        {
          jsonBody: {
            model: "Qwen/Qwen3-8B",
            choices: [
              {
                message: {
                  content: [{ text: JSON.stringify({ ok: true }) }]
                }
              }
            ]
          }
        }
      ],
      onCompletionRequest(body) {
        capturedBodies.push(body);
      }
    });

    const { requestStructuredOpenModelOutput } = await import("@/lib/open-model/client");

    const result = await requestStructuredOpenModelOutput({
      schema: z.object({
        ok: z.literal(true)
      }),
      schemaName: "test_vllm_root_catalog_schema",
      systemPrompt: "Return valid JSON only.",
      userPrompt: "Produce the requested test payload."
    });

    expect(result.output).toEqual({ ok: true });
    expect(result.hostedOpenModelHealth).toMatchObject({
      apiBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1",
      catalogStatus: "succeeded",
      requestStatus: "succeeded"
    });
    expect(capturedBodies[0]).toMatchObject({
      model: "Qwen/Qwen3-8B",
      stream: false,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "test_vllm_root_catalog_schema",
          strict: true
        }
      }
    });
  });

  it("accepts the verified hosted route shape when the model catalog advertises the model as name", async () => {
    global.fetch = createMockHostedVllmFetch({
      hostBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud",
      models: {
        jsonBody: {
          data: [{ name: "Qwen/Qwen3-8B" }]
        }
      },
      completions: [
        {
          jsonBody: {
            model: "Qwen/Qwen3-8B",
            choices: [
              {
                message: {
                  content: JSON.stringify({ ok: true })
                }
              }
            ]
          }
        }
      ]
    });

    const { requestStructuredOpenModelOutput } = await import("@/lib/open-model/client");

    const result = await requestStructuredOpenModelOutput({
      schema: z.object({
        ok: z.literal(true)
      }),
      schemaName: "test_vllm_name_catalog_schema",
      systemPrompt: "Return valid JSON only.",
      userPrompt: "Produce the requested test payload."
    });

    expect(result.output).toEqual({ ok: true });
    expect(result.hostedOpenModelHealth?.advertisedModelCount).toBe(1);
  });

  it("classifies invalid hosted chat JSON as an invalid-payload configuration failure", async () => {
    global.fetch = createMockHostedVllmFetch({
      hostBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud",
      models: {
        jsonBody: {
          data: [{ id: "Qwen/Qwen3-8B" }]
        }
      },
      completions: [
        {
          rawBody: "{not-json"
        }
      ]
    });

    const { requestStructuredOpenModelOutput, OpenModelConfigurationError } =
      await import("@/lib/open-model/client");

    let thrownError: unknown;

    try {
      await requestStructuredOpenModelOutput({
        schema: z.object({
          ok: z.literal(true)
        }),
        schemaName: "test_vllm_invalid_json_schema",
        systemPrompt: "Return valid JSON only.",
        userPrompt: "Produce the requested test payload."
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(OpenModelConfigurationError);
    expect(
      (thrownError as { hostedOpenModelHealth?: unknown }).hostedOpenModelHealth
    ).toMatchObject({
      requestStatus: "invalid_payload",
      catalogStatus: "succeeded"
    });
    expect((thrownError as Error).message).toContain("/chat/completions");
    expect((thrownError as Error).message).toContain("not valid JSON");
  });

  it("classifies a hosted chat payload without choices as an invalid-payload configuration failure", async () => {
    global.fetch = createMockHostedVllmFetch({
      hostBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud",
      models: {
        jsonBody: {
          data: [{ id: "Qwen/Qwen3-8B" }]
        }
      },
      completions: [
        {
          jsonBody: {
            model: "Qwen/Qwen3-8B"
          }
        }
      ]
    });

    const { requestStructuredOpenModelOutput, OpenModelConfigurationError } =
      await import("@/lib/open-model/client");

    let thrownError: unknown;

    try {
      await requestStructuredOpenModelOutput({
        schema: z.object({
          ok: z.literal(true)
        }),
        schemaName: "test_vllm_missing_choices_schema",
        systemPrompt: "Return valid JSON only.",
        userPrompt: "Produce the requested test payload."
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(OpenModelConfigurationError);
    expect(
      (thrownError as { hostedOpenModelHealth?: unknown }).hostedOpenModelHealth
    ).toMatchObject({
      requestStatus: "invalid_payload",
      catalogStatus: "succeeded"
    });
    expect((thrownError as Error).message).toContain("choices array");
  });
});
