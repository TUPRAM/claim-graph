import OpenAI from "openai";

let client: OpenAI | null = null;
let clientConfigKey: string | null = null;

export class OpenAIRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "OpenAIRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function getOpenAIRequestTimeoutMs() {
  const raw = process.env.CLAIMGRAPH_OPENAI_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;

  if (Number.isFinite(parsed) && parsed >= 1_000) {
    return parsed;
  }

  return 120_000;
}

export function createOpenAIRequestOptions(signal?: AbortSignal) {
  const timeoutMs = getOpenAIRequestTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;

  const handleAbort = () => {
    controller.abort(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
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
        `OpenAI request exceeded ${timeoutMs}ms and was aborted.`,
        "AbortError"
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  return {
    options: {
      signal: controller.signal
    },
    didTimeout() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", handleAbort);
    }
  };
}

export function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is missing. Starter mode still works without it, but live evidence gathering, claim extraction, and graph assembly are disabled."
    );
  }

  const timeout = getOpenAIRequestTimeoutMs();
  const nextConfigKey = `${apiKey.length}:${apiKey.slice(-6)}:${timeout}`;

  if (client && clientConfigKey === nextConfigKey) {
    return client;
  }

  client = new OpenAI({
    apiKey,
    timeout
  });
  clientConfigKey = nextConfigKey;

  return client;
}
