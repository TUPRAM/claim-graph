import { getClaimGraphRuntimeConfig } from "@/lib/claimgraph/config";
import { getClaimGraphStorageDriver } from "@/lib/server/storage/config";

export const HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE =
  "File analysis is temporarily unavailable in hosted full mode because provider-side file and vector-store deletion is not yet durably tracked in Neon. Use public links, or use the hosted open-model lane, until durable provider cleanup is enabled.";

export function isHostedFullModeFileIntakeBlocked(input?: {
  storageDriver?: "local" | "hosted";
  mode?: "demo" | "open-model" | "full";
}) {
  const storageDriver = input?.storageDriver ?? getClaimGraphStorageDriver();
  const mode = input?.mode ?? getClaimGraphRuntimeConfig().mode;
  return storageDriver === "hosted" && mode === "full";
}

export function assertHostedProviderFileRetentionSafe(fileCount: number) {
  if (fileCount > 0 && isHostedFullModeFileIntakeBlocked()) {
    throw new HostedProviderFileRetentionError();
  }
}

export class HostedProviderFileRetentionError extends Error {
  readonly status = 503;

  constructor() {
    super(HOSTED_FULL_FILE_RETENTION_BLOCK_MESSAGE);
    this.name = "HostedProviderFileRetentionError";
  }
}
