import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalMode = process.env.CLAIMGRAPH_MODE;
const originalBackend = process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
const originalModel = process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
const originalOpenModelBaseUrl = process.env.OPEN_MODEL_BASE_URL;
const originalOpenModelApiKey = process.env.OPEN_MODEL_API_KEY;
const originalFetch = global.fetch;

describe("requestStructuredOpenModelOutput", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "ollama";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "qwen3:8b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
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

  it("retries once when the first structured response fails schema validation", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: "qwen3:8b" }]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "qwen3:8b",
            message: {
              content: JSON.stringify({ ok: false })
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "qwen3:8b",
            message: {
              content: JSON.stringify({ ok: true })
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      ) as typeof fetch;

    const { requestStructuredOpenModelOutput } = await import("@/lib/open-model/client");

    const result = await requestStructuredOpenModelOutput({
      schema: z.object({
        ok: z.literal(true)
      }),
      schemaName: "test_retry_schema",
      systemPrompt: "Return valid JSON only.",
      userPrompt: "Produce the requested test payload."
    });

    expect(result.backend).toBe("ollama");
    expect(result.model).toBe("qwen3:8b");
    expect(result.output).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("surfaces backend availability errors separately from schema errors", async () => {
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "http://127.0.0.1:11434/api/tags") {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }

      throw new Error(`Unhandled fetch request in unavailable test: ${url}`);
    }) as typeof fetch;

    const { requestStructuredOpenModelOutput, OpenModelBackendUnavailableError } =
      await import("@/lib/open-model/client");

    await expect(
      requestStructuredOpenModelOutput({
        schema: z.object({
          ok: z.literal(true)
        }),
        schemaName: "test_unavailable_schema",
        systemPrompt: "Return valid JSON only.",
        userPrompt: "Produce the requested test payload."
      })
    ).rejects.toBeInstanceOf(OpenModelBackendUnavailableError);
  });

  it("fails honestly when the configured Ollama model is not installed", async () => {
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "http://127.0.0.1:11434/api/tags") {
        return new Response(
          JSON.stringify({
            models: [{ name: "llama3:8b" }]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }

      throw new Error(`Unhandled fetch request in missing-model test: ${url}`);
    }) as typeof fetch;

    const { requestStructuredOpenModelOutput, OpenModelModelUnavailableError } =
      await import("@/lib/open-model/client");

    await expect(
      requestStructuredOpenModelOutput({
        schema: z.object({
          ok: z.literal(true)
        }),
        schemaName: "test_missing_model_schema",
        systemPrompt: "Return valid JSON only.",
        userPrompt: "Produce the requested test payload."
      })
    ).rejects.toBeInstanceOf(OpenModelModelUnavailableError);
  });

  it("supports the verified hosted vllm path with strict JSON schema validation", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL =
      "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "Qwen/Qwen3-8B" }]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "Qwen/Qwen3-8B",
            choices: [
              {
                message: {
                  content: JSON.stringify({ ok: true })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      ) as typeof fetch;

    const { requestStructuredOpenModelOutput } = await import("@/lib/open-model/client");

    const result = await requestStructuredOpenModelOutput({
      schema: z.object({
        ok: z.literal(true)
      }),
      schemaName: "test_vllm_schema",
      systemPrompt: "Return valid JSON only.",
      userPrompt: "Produce the requested test payload."
    });

    expect(result.backend).toBe("vllm");
    expect(result.model).toBe("Qwen/Qwen3-8B");
    expect(result.output).toEqual({ ok: true });
    expect(result.hostedOpenModelHealth).toMatchObject({
      backend: "vllm",
      apiBaseUrl: "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1",
      model: "Qwen/Qwen3-8B",
      catalogRoute:
        "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/models",
      catalogStatus: "succeeded",
      catalogCache: "miss",
      advertisedModelCount: 1,
      completionRoute:
        "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/chat/completions",
      requestStatus: "succeeded",
      requestAttempt: 1,
      requestMaxAttempts: 2
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer hf_test_token"
        })
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/chat/completions",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("requires OPEN_MODEL_API_KEY for the hosted vllm path", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    delete process.env.OPEN_MODEL_API_KEY;

    const { requestStructuredOpenModelOutput, OpenModelConfigurationError } =
      await import("@/lib/open-model/client");

    await expect(
      requestStructuredOpenModelOutput({
        schema: z.object({
          ok: z.literal(true)
        }),
        schemaName: "test_vllm_missing_token_schema",
        systemPrompt: "Return valid JSON only.",
        userPrompt: "Produce the requested test payload."
      })
    ).rejects.toBeInstanceOf(OpenModelConfigurationError);
  });

  it("fails honestly when the hosted vllm endpoint rejects the configured token", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "forbidden"
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    ) as typeof fetch;

    const { requestStructuredOpenModelOutput, OpenModelConfigurationError } =
      await import("@/lib/open-model/client");

    await expect(
      requestStructuredOpenModelOutput({
        schema: z.object({
          ok: z.literal(true)
        }),
        schemaName: "test_vllm_auth_schema",
        systemPrompt: "Return valid JSON only.",
        userPrompt: "Produce the requested test payload."
      })
    ).rejects.toBeInstanceOf(OpenModelConfigurationError);
  });

  it("attaches hosted health diagnostics when the hosted vllm token is rejected during preflight", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "forbidden"
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    ) as typeof fetch;

    const { requestStructuredOpenModelOutput, OpenModelConfigurationError } =
      await import("@/lib/open-model/client");

    let thrownError: unknown;

    try {
      await requestStructuredOpenModelOutput({
        schema: z.object({
          ok: z.literal(true)
        }),
        schemaName: "test_vllm_auth_health_schema",
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
      backend: "vllm",
      catalogStatus: "auth_rejected",
      catalogCache: "miss",
      requestStatus: "not_started",
      catalogRoute:
        "https://example.us-east-1.aws.endpoints.huggingface.cloud/v1/models"
    });
  });

  it("records when hosted vllm succeeds only after a schema-validation retry", async () => {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL =
      "https://example.us-east-1.aws.endpoints.huggingface.cloud";
    process.env.OPEN_MODEL_API_KEY = "hf_test_token";

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "Qwen/Qwen3-8B" }]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "Qwen/Qwen3-8B",
            choices: [
              {
                message: {
                  content: JSON.stringify({ ok: false })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "Qwen/Qwen3-8B",
            choices: [
              {
                message: {
                  content: JSON.stringify({ ok: true })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      ) as typeof fetch;

    const { requestStructuredOpenModelOutput } = await import("@/lib/open-model/client");

    const result = await requestStructuredOpenModelOutput({
      schema: z.object({
        ok: z.literal(true)
      }),
      schemaName: "test_vllm_retry_health_schema",
      systemPrompt: "Return valid JSON only.",
      userPrompt: "Produce the requested test payload."
    });

    expect(result.output).toEqual({ ok: true });
    expect(result.hostedOpenModelHealth).toMatchObject({
      requestStatus: "succeeded_after_validation_retry",
      requestAttempt: 2,
      requestMaxAttempts: 2
    });
    expect(result.hostedOpenModelHealth?.lastErrorMessage).toContain(
      "failed schema validation"
    );
  });
});
