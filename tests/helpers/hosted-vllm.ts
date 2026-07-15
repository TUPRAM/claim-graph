import { vi } from "vitest";

interface MockHostedVllmResponse {
  status?: number;
  jsonBody?: unknown;
  rawBody?: string;
  headers?: HeadersInit;
}

export function createMockHostedVllmFetch(input: {
  hostBaseUrl: string;
  models: MockHostedVllmResponse;
  completions: MockHostedVllmResponse[];
  exactBaseUrl?: boolean;
  onCompletionRequest?: (body: unknown) => void;
}) {
  const hostBaseUrl = input.hostBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const apiBaseUrl = input.exactBaseUrl ? hostBaseUrl : `${hostBaseUrl}/v1`;
  let completionIndex = 0;

  function buildResponse(response: MockHostedVllmResponse) {
    const headers = new Headers(response.headers);

    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const body =
      response.rawBody ??
      (response.jsonBody === undefined ? "" : JSON.stringify(response.jsonBody));

    return new Response(body, {
      status: response.status ?? 200,
      headers
    });
  }

  return vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;

    if (url === `${apiBaseUrl}/models`) {
      return buildResponse(input.models);
    }

    if (url === `${apiBaseUrl}/chat/completions`) {
      const response = input.completions[completionIndex];

      if (!response) {
        throw new Error(`No mocked hosted vllm completion response remained for ${url}.`);
      }

      completionIndex += 1;

      if (typeof init?.body === "string") {
        input.onCompletionRequest?.(JSON.parse(init.body));
      } else {
        input.onCompletionRequest?.(undefined);
      }

      return buildResponse(response);
    }

    throw new Error(`Unhandled hosted vllm fetch request: ${url}`);
  }) as typeof fetch;
}
