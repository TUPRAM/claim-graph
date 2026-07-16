const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MIN_PUBLIC_BETA_SECRET_BYTES = 32;

export function hasStrongPublicBetaSecret(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return Buffer.byteLength(normalized, "utf8") >= MIN_PUBLIC_BETA_SECRET_BYTES;
}

export function hasValidCanonicalPublicOrigin(value: string | undefined) {
  if (!value?.trim()) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value.trim().replace(/\/$/u, "");
  } catch {
    return false;
  }
}

export function hasValidOperationsWebhookUrl(value: string | undefined) {
  if (!value?.trim()) {
    return false;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const OPERATIONS_WEBHOOK_FORMATS = [
  "generic",
  "github-issue"
] as const;

export type OperationsWebhookFormat =
  (typeof OPERATIONS_WEBHOOK_FORMATS)[number];

export function parseOperationsWebhookFormat(
  value: string | undefined
): OperationsWebhookFormat | null {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return "generic";
  }

  return OPERATIONS_WEBHOOK_FORMATS.find((format) => format === normalized) ?? null;
}

export function hasValidGitHubIssueApiUrl(value: string | undefined) {
  if (!hasValidOperationsWebhookUrl(value)) {
    return false;
  }

  const url = new URL(value!.trim());
  const segments = url.pathname.split("/").filter(Boolean);

  return url.hostname === "api.github.com" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    segments.length === 4 &&
    segments[0] === "repos" &&
    Boolean(segments[1]) &&
    Boolean(segments[2]) &&
    segments[3] === "issues";
}

export function validateOperationsNotificationConfiguration(
  env: NodeJS.ProcessEnv = process.env
) {
  const format = parseOperationsWebhookFormat(
    env.CLAIMGRAPH_OPERATIONS_WEBHOOK_FORMAT
  );
  const url = env.CLAIMGRAPH_OPERATIONS_WEBHOOK_URL?.trim() ?? "";
  const bearerConfigured = Boolean(
    env.CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN?.trim()
  );
  const urlValid = format === "github-issue"
    ? hasValidGitHubIssueApiUrl(url)
    : hasValidOperationsWebhookUrl(url);
  const bearerRequired = format === "github-issue";

  return {
    format,
    formatValid: format !== null,
    urlValid,
    bearerRequired,
    bearerConfigured,
    configured:
      format !== null &&
      urlValid &&
      (!bearerRequired || bearerConfigured)
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number }
) {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(bounds.min, Math.min(bounds.max, parsed));
}

function enabled(value: string | undefined, fallback: boolean) {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  return !["0", "false", "off", "disabled", "no"].includes(
    value.trim().toLowerCase()
  );
}

export interface PublicBetaPolicy {
  workspaceCreation: {
    limit: number;
    windowMs: number;
    globalLimit: number;
    globalWindowMs: number;
  };
  workspaceAnalysis: {
    limit: number;
    windowMs: number;
  };
  export: {
    limit: number;
    windowMs: number;
    globalLimit: number;
    globalWindowMs: number;
    maxPayloadBytes: number;
  };
  workspaceFiles: {
    mutationLimit: number;
    mutationWindowMs: number;
    globalMutationLimit: number;
    globalMutationWindowMs: number;
    uploadedByteLimit: number;
    uploadedByteWindowMs: number;
  };
  developerLogin: {
    limit: number;
    windowMs: number;
    globalLimit: number;
    globalWindowMs: number;
  };
  paidAnalysis: {
    dailyLimit: number;
    windowMs: number;
  };
  provider: {
    concurrency: number;
    leaseMs: number;
  };
  retention: {
    abandonedWorkspaceMs: number;
    uploadedObjectMs: number;
    generatedExportMs: number;
    qaWorkspaceMs: number;
    cleanupBatchSize: number;
    cleanupDrainLimit: number;
    cleanupMaxDurationMs: number;
    maxCleanupAttempts: number;
  };
  analysisEnabledByDefault: boolean;
  idempotencyTtlMs: number;
}

export function isCostBearingAnalysisRuntime(input: {
  mode: "demo" | "open-model" | "full";
  openModelBackend?: string;
}) {
  return input.mode === "full" ||
    (input.mode === "open-model" && input.openModelBackend !== "ollama");
}

/**
 * Fail-safe public-beta defaults. Every cost-bearing limit is bounded even when
 * an operator has not supplied environment overrides.
 */
export function getPublicBetaPolicy(
  env: NodeJS.ProcessEnv = process.env
): PublicBetaPolicy {
  const testMode = env.NODE_ENV === "test";

  return {
    workspaceCreation: {
      limit: boundedInteger(env.CLAIMGRAPH_CREATE_LIMIT_PER_IP, testMode ? 10_000 : 6, {
        min: 1,
        max: 1_000
      }),
      windowMs:
        boundedInteger(env.CLAIMGRAPH_CREATE_WINDOW_MINUTES, 60, {
          min: 1,
          max: 24 * 60
        }) * 60_000,
      globalLimit: boundedInteger(
        env.CLAIMGRAPH_CREATE_GLOBAL_LIMIT,
        testMode ? 100_000 : 30,
        { min: 1, max: 10_000 }
      ),
      globalWindowMs: HOUR_MS
    },
    workspaceAnalysis: {
      limit: boundedInteger(env.CLAIMGRAPH_ANALYSIS_LIMIT_PER_WORKSPACE, testMode ? 10_000 : 5, {
        min: 1,
        max: 1_000
      }),
      windowMs:
        boundedInteger(env.CLAIMGRAPH_ANALYSIS_WINDOW_MINUTES, 24 * 60, {
          min: 1,
          max: 7 * 24 * 60
        }) * 60_000
    },
    export: {
      limit: boundedInteger(env.CLAIMGRAPH_EXPORT_LIMIT_PER_WORKSPACE, testMode ? 10_000 : 20, {
        min: 1,
        max: 10_000
      }),
      windowMs:
        boundedInteger(env.CLAIMGRAPH_EXPORT_WINDOW_MINUTES, 60, {
          min: 1,
          max: 24 * 60
        }) * 60_000,
      globalLimit: boundedInteger(
        env.CLAIMGRAPH_EXPORT_GLOBAL_LIMIT,
        testMode ? 100_000 : 60,
        { min: 1, max: 100_000 }
      ),
      globalWindowMs: HOUR_MS,
      maxPayloadBytes:
        boundedInteger(env.CLAIMGRAPH_EXPORT_MAX_MIB, 8, {
          min: 1,
          max: 32
        }) *
        1024 *
        1024
    },
    workspaceFiles: {
      mutationLimit: boundedInteger(
        env.CLAIMGRAPH_FILE_MUTATION_LIMIT_PER_WORKSPACE,
        testMode ? 10_000 : 30,
        { min: 1, max: 10_000 }
      ),
      mutationWindowMs: HOUR_MS,
      globalMutationLimit: boundedInteger(
        env.CLAIMGRAPH_FILE_MUTATION_GLOBAL_LIMIT,
        testMode ? 100_000 : 60,
        { min: 1, max: 100_000 }
      ),
      globalMutationWindowMs: HOUR_MS,
      uploadedByteLimit:
        boundedInteger(env.CLAIMGRAPH_UPLOAD_BYTE_LIMIT_MIB, testMode ? 1_000 : 50, {
          min: 1,
          max: 1_024
        }) * 1024 * 1024,
      uploadedByteWindowMs: DAY_MS
    },
    developerLogin: {
      limit: boundedInteger(env.CLAIMGRAPH_DEV_LOGIN_LIMIT_PER_IP, testMode ? 1_000 : 5, {
        min: 1,
        max: 1_000
      }),
      windowMs: 15 * 60_000,
      globalLimit: boundedInteger(
        env.CLAIMGRAPH_DEV_LOGIN_GLOBAL_LIMIT,
        testMode ? 10_000 : 30,
        { min: 1, max: 10_000 }
      ),
      globalWindowMs: 60_000
    },
    paidAnalysis: {
      dailyLimit: boundedInteger(env.CLAIMGRAPH_PAID_ANALYSIS_DAILY_LIMIT, testMode ? 10_000 : 20, {
        min: 1,
        max: 10_000
      }),
      windowMs: DAY_MS
    },
    provider: {
      concurrency: boundedInteger(env.CLAIMGRAPH_PROVIDER_CONCURRENCY, 2, {
        min: 1,
        max: 100
      }),
      leaseMs:
        boundedInteger(env.CLAIMGRAPH_PROVIDER_LEASE_MINUTES, 15, {
          min: 1,
          max: 120
        }) * 60_000
    },
    retention: {
      abandonedWorkspaceMs:
        boundedInteger(env.CLAIMGRAPH_ABANDONED_WORKSPACE_TTL_DAYS, 14, {
          min: 1,
          max: 365
        }) * DAY_MS,
      uploadedObjectMs:
        boundedInteger(env.CLAIMGRAPH_UPLOAD_TTL_DAYS, 30, {
          min: 1,
          max: 365
        }) * DAY_MS,
      generatedExportMs:
        boundedInteger(env.CLAIMGRAPH_EXPORT_TTL_HOURS, 24, {
          min: 1,
          max: 30 * 24
        }) * HOUR_MS,
      qaWorkspaceMs:
        boundedInteger(env.CLAIMGRAPH_QA_WORKSPACE_TTL_HOURS, 24, {
          min: 1,
          max: 7 * 24
        }) * HOUR_MS,
      cleanupBatchSize: boundedInteger(env.CLAIMGRAPH_CLEANUP_BATCH_SIZE, 25, {
        min: 1,
        max: 100
      }),
      cleanupDrainLimit: boundedInteger(
        env.CLAIMGRAPH_CLEANUP_DRAIN_LIMIT,
        500,
        { min: 25, max: 5_000 }
      ),
      cleanupMaxDurationMs:
        boundedInteger(env.CLAIMGRAPH_CLEANUP_MAX_SECONDS, 45, {
          min: 5,
          max: 240
        }) * 1_000,
      maxCleanupAttempts: boundedInteger(
        env.CLAIMGRAPH_CLEANUP_MAX_ATTEMPTS,
        10,
        { min: 1, max: 50 }
      )
    },
    analysisEnabledByDefault: enabled(
      env.CLAIMGRAPH_PUBLIC_ANALYSIS_ENABLED,
      true
    ),
    idempotencyTtlMs:
      boundedInteger(env.CLAIMGRAPH_IDEMPOTENCY_TTL_HOURS, 24, {
        min: 1,
        max: 7 * 24
      }) * HOUR_MS
  };
}

export function publicBetaPrivacyCopy(
  policy: PublicBetaPolicy = getPublicBetaPolicy()
) {
  const workspaceDays = Math.round(
    policy.retention.abandonedWorkspaceMs / DAY_MS
  );
  const uploadDays = Math.round(policy.retention.uploadedObjectMs / DAY_MS);
  const exportHours = Math.round(policy.retention.generatedExportMs / HOUR_MS);

  return `Submitted links and files are processed to build your graph. A shared workspace can show cited public source links, file names, and cited excerpts. Raw uploads and private storage URLs are not downloadable from a shared workspace, and links containing credentials or sensitive query tokens are omitted. Abandoned workspaces are removed after ${workspaceDays} days, uploads after ${uploadDays} days, and generated exports after ${exportHours} hours.`;
}

export function getPublicBetaSafetyConfiguration(
  env: NodeJS.ProcessEnv = process.env
) {
  const hosted = env.CLAIMGRAPH_STORAGE_DRIVER?.trim().toLowerCase() === "hosted";
  const production = env.NODE_ENV === "production";
  const abuseHashConfigured = hasStrongPublicBetaSecret(
    env.CLAIMGRAPH_ABUSE_HASH_SECRET
  );
  const cleanupCronConfigured = hasStrongPublicBetaSecret(env.CRON_SECRET);
  const monitorSecretConfigured = hasStrongPublicBetaSecret(
    env.CLAIMGRAPH_MONITOR_SECRET
  );
  const monitorSecretDistinct =
    monitorSecretConfigured &&
    cleanupCronConfigured &&
    env.CLAIMGRAPH_MONITOR_SECRET?.trim() !== env.CRON_SECRET?.trim();
  const operationsNotification = validateOperationsNotificationConfiguration(env);
  const operationsNotificationConfigured = operationsNotification.configured;
  const canonicalOriginConfigured = hasValidCanonicalPublicOrigin(
    env.CLAIMGRAPH_PUBLIC_ORIGIN ??
      env.NEXT_PUBLIC_APP_URL ??
      env.NEXT_PUBLIC_SITE_URL
  );

  return {
    hosted,
    production,
    abuseHashConfigured,
    cleanupCronConfigured,
    monitorSecretConfigured,
    monitorSecretDistinct,
    operationsNotificationConfigured,
    canonicalOriginConfigured,
    ready:
      (!hosted || (
        abuseHashConfigured &&
        cleanupCronConfigured &&
        monitorSecretConfigured &&
        monitorSecretDistinct &&
        operationsNotificationConfigured
      )) &&
      (!production || canonicalOriginConfigured),
    missingConfiguration: [
      ...(hosted && !abuseHashConfigured
        ? ["CLAIMGRAPH_ABUSE_HASH_SECRET"]
        : []),
      ...(hosted && !cleanupCronConfigured ? ["CRON_SECRET"] : []),
      ...(hosted && !monitorSecretConfigured
        ? ["CLAIMGRAPH_MONITOR_SECRET"]
        : []),
      ...(hosted && monitorSecretConfigured && cleanupCronConfigured &&
          !monitorSecretDistinct
        ? ["CLAIMGRAPH_MONITOR_SECRET must differ from CRON_SECRET"]
        : []),
      ...(hosted && !operationsNotificationConfigured
        ? [
            ...(!operationsNotification.formatValid
              ? ["CLAIMGRAPH_OPERATIONS_WEBHOOK_FORMAT"]
              : []),
            ...(!operationsNotification.urlValid
              ? ["CLAIMGRAPH_OPERATIONS_WEBHOOK_URL"]
              : []),
            ...(operationsNotification.bearerRequired &&
                !operationsNotification.bearerConfigured
              ? ["CLAIMGRAPH_OPERATIONS_WEBHOOK_BEARER_TOKEN"]
              : [])
          ]
        : []),
      ...(production && !canonicalOriginConfigured
        ? ["CLAIMGRAPH_PUBLIC_ORIGIN"]
        : [])
    ]
  };
}
