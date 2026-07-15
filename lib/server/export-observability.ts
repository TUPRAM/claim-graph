import { z } from "zod";

export const MAX_PNG_EXPORT_BYTES = 5 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
export const MAX_PNG_DATA_URL_CHARS =
  PNG_DATA_URL_PREFIX.length + Math.ceil(MAX_PNG_EXPORT_BYTES / 3) * 4;
export const MAX_EXPORT_REQUEST_BYTES = MAX_PNG_DATA_URL_CHARS + 32 * 1024;

export class ExportObservabilityRequestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ExportObservabilityRequestError";
    this.status = status;
  }
}

const nodeKindSchema = z.enum([
  "question",
  "claim",
  "counterclaim",
  "evidence",
  "gap"
]);
const reviewBranchFilterSchema = z.enum(["all", "left", "right", "unresolved"]);
const boundedNullableId = z.string().max(200).nullable().optional();
const boundedNullableLabel = z.string().min(1).max(500).nullable().optional();

export const exportObservabilityRequestSchema = z.object({
  strongestOnly: z.boolean().optional(),
  unresolvedOnly: z.boolean().optional(),
  hiddenKinds: z.array(nodeKindSchema).max(5).optional(),
  focusClusterId: boundedNullableId,
  selectedNodeId: boundedNullableId,
  savedReviewStateId: boundedNullableId,
  savedReviewStateLabel: boundedNullableLabel,
  reviewBranchFilter: reviewBranchFilterSchema.optional(),
  reviewSourceFilterId: boundedNullableId,
  reviewSourceFilterLabel: boundedNullableLabel,
  viewport: z.object({
    width: z.number().positive().max(20_000),
    height: z.number().positive().max(20_000)
  }).strict().optional(),
  success: z.boolean().optional(),
  errorMessage: z.string().min(1).max(2_000).optional(),
  pngDataUrl: z
    .string()
    .startsWith(PNG_DATA_URL_PREFIX)
    .max(MAX_PNG_DATA_URL_CHARS)
    .optional()
}).strict();

export type ExportObservabilityRequest = z.infer<typeof exportObservabilityRequestSchema>;

async function readBoundedRequestText(request: Request, maxBytes: number) {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : NaN;

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ExportObservabilityRequestError(
      `Export request exceeds the ${maxBytes} byte payload limit.`,
      413
    );
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
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

      if (byteCount > maxBytes) {
        await reader.cancel();
        throw new ExportObservabilityRequestError(
          `Export request exceeds the ${maxBytes} byte payload limit.`,
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

export async function readExportObservabilityRequest(request: Request) {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.includes("application/json")) {
    return null;
  }

  const raw = await readBoundedRequestText(request, MAX_EXPORT_REQUEST_BYTES);

  if (!raw.trim()) {
    return null;
  }

  try {
    return exportObservabilityRequestSchema.parse(JSON.parse(raw));
  } catch {
    throw new ExportObservabilityRequestError("Invalid export request payload.");
  }
}
