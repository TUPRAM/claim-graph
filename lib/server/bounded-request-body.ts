export class BoundedRequestBodyError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BoundedRequestBodyError";
    this.status = status;
  }
}

export async function readBoundedRequestText(input: {
  request: Request;
  maxBytes: number;
  label: string;
}) {
  const contentLengthHeader = input.request.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : NaN;

  if (Number.isFinite(contentLength) && contentLength > input.maxBytes) {
    throw new BoundedRequestBodyError(
      `${input.label} exceeds the ${input.maxBytes} byte payload limit.`,
      413
    );
  }

  if (!input.request.body) {
    return "";
  }

  const reader = input.request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let byteCount = 0;
  let text = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      byteCount += value.byteLength;

      if (byteCount > input.maxBytes) {
        await reader.cancel();
        throw new BoundedRequestBodyError(
          `${input.label} exceeds the ${input.maxBytes} byte payload limit.`,
          413
        );
      }

      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJsonBody(input: {
  request: Request;
  maxBytes: number;
  label: string;
}) {
  const text = await readBoundedRequestText(input);
  return JSON.parse(text) as unknown;
}
