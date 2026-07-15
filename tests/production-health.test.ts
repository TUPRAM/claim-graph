import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getProductionHealth } from "@/app/api/health/production/route";
import { GET as getInternalProductionHealth } from "@/app/api/internal/health/production/route";
import {
  createDevPasswordHash,
  createDevSessionCookieValue,
  DEV_SESSION_COOKIE_NAME
} from "@/lib/server/dev-auth";
import { getProductionHealthSummary } from "@/lib/server/production-health";
import { sanitizeProductionHealthForPublic } from "@/lib/validation/public-production-health";

const originalStorageDriver = process.env.CLAIMGRAPH_STORAGE_DRIVER;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPasswordHash = process.env.DEV_MODE_PASSWORD_HASH;
const originalSessionSecret = process.env.DEV_MODE_SESSION_SECRET;
const originalBlobReadWriteToken = process.env.BLOB_READ_WRITE_TOKEN;
const originalDurableRunner = process.env.CLAIMGRAPH_DURABLE_RUNNER;
const originalClaimGraphMode = process.env.CLAIMGRAPH_MODE;
const originalOpenModelBackend = process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
const originalOpenModelName = process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
const originalOpenModelBaseUrl = process.env.OPEN_MODEL_BASE_URL;
const originalOpenModelApiKey = process.env.OPEN_MODEL_API_KEY;
const originalHfToken = process.env.HF_TOKEN;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalCronSecret = process.env.CRON_SECRET;

function restoreEnv() {
  if (originalStorageDriver === undefined) {
    delete process.env.CLAIMGRAPH_STORAGE_DRIVER;
  } else {
    process.env.CLAIMGRAPH_STORAGE_DRIVER = originalStorageDriver;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalPasswordHash === undefined) {
    delete process.env.DEV_MODE_PASSWORD_HASH;
  } else {
    process.env.DEV_MODE_PASSWORD_HASH = originalPasswordHash;
  }

  if (originalSessionSecret === undefined) {
    delete process.env.DEV_MODE_SESSION_SECRET;
  } else {
    process.env.DEV_MODE_SESSION_SECRET = originalSessionSecret;
  }

  if (originalBlobReadWriteToken === undefined) {
    delete process.env.BLOB_READ_WRITE_TOKEN;
  } else {
    process.env.BLOB_READ_WRITE_TOKEN = originalBlobReadWriteToken;
  }

  if (originalDurableRunner === undefined) {
    delete process.env.CLAIMGRAPH_DURABLE_RUNNER;
  } else {
    process.env.CLAIMGRAPH_DURABLE_RUNNER = originalDurableRunner;
  }

  if (originalClaimGraphMode === undefined) {
    delete process.env.CLAIMGRAPH_MODE;
  } else {
    process.env.CLAIMGRAPH_MODE = originalClaimGraphMode;
  }

  if (originalOpenModelBackend === undefined) {
    delete process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
  } else {
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = originalOpenModelBackend;
  }

  if (originalOpenModelName === undefined) {
    delete process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
  } else {
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = originalOpenModelName;
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

  if (originalHfToken === undefined) {
    delete process.env.HF_TOKEN;
  } else {
    process.env.HF_TOKEN = originalHfToken;
  }

  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }

  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
}

describe("production health endpoint", () => {
  beforeEach(() => {
    vi.resetModules();
    restoreEnv();
    delete process.env.CLAIMGRAPH_STORAGE_DRIVER;
    delete process.env.DATABASE_URL;
    delete process.env.DEV_MODE_PASSWORD_HASH;
    delete process.env.DEV_MODE_SESSION_SECRET;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.CLAIMGRAPH_DURABLE_RUNNER;
    delete process.env.CLAIMGRAPH_MODE;
    delete process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND;
    delete process.env.CLAIMGRAPH_OPEN_MODEL_NAME;
    delete process.env.OPEN_MODEL_BASE_URL;
    delete process.env.OPEN_MODEL_API_KEY;
    delete process.env.HF_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CRON_SECRET;
  });

  afterAll(() => {
    restoreEnv();
  });

  it("returns only coarse status and timestamp from the anonymous endpoint", async () => {
    const response = await getProductionHealth();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      status: "degraded",
      checkedAt: expect.any(String)
    });
    expect(Object.keys(payload).sort()).toEqual(["checkedAt", "status"]);
    expect(payload).not.toHaveProperty("storage");
    expect(payload).not.toHaveProperty("analysisRuntime");
  });

  it("allowlists public health fields so nested and future secrets fail closed", () => {
    const canary = "SECRET_HEALTH_CANARY_MUST_NOT_LEAK";
    const internal = {
      status: "unhealthy" as const,
      checkedAt: "2026-07-15T00:00:00.000Z",
      storage: { error: canary },
      futureInternalSecret: canary
    };

    const payload = sanitizeProductionHealthForPublic(internal);

    expect(payload).toEqual({
      status: "unhealthy",
      checkedAt: "2026-07-15T00:00:00.000Z"
    });
    expect(JSON.stringify(payload)).not.toContain(canary);
  });

  it("protects detailed health and permits the established cron bearer", async () => {
    process.env.CRON_SECRET = "cron-test-secret-with-at-least-32-bytes";

    const unauthorized = await getInternalProductionHealth(
      new Request("http://localhost/api/internal/health/production")
    );
    const authorized = await getInternalProductionHealth(
      new Request("http://localhost/api/internal/health/production", {
        headers: {
          Authorization: "Bearer cron-test-secret-with-at-least-32-bytes"
        }
      })
    );

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: "Production health authorization required."
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      status: "degraded",
      storage: { driver: "local" },
      analysisRuntime: { status: "blocked" }
    });
  });

  it("permits detailed health with an existing developer session", async () => {
    process.env.DEV_MODE_PASSWORD_HASH = createDevPasswordHash("dev-password");
    process.env.DEV_MODE_SESSION_SECRET =
      "developer-session-secret-with-at-least-32-bytes";
    const session = createDevSessionCookieValue();

    const response = await getInternalProductionHealth(
      new Request("http://localhost/api/internal/health/production", {
        headers: {
          cookie: `${DEV_SESSION_COOKIE_NAME}=${session}`
        }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("devAuth.configured", true);
  });

  it("reports hosted storage as unhealthy when DATABASE_URL is missing", async () => {
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "hosted";

    const health = await getProductionHealthSummary();

    expect(health).toMatchObject({
      status: "unhealthy",
      storage: {
        driver: "hosted",
        databaseConfigured: false,
        schemaInitialized: false
      },
      objectStorage: {
        provider: "vercel_blob",
        blobConfigured: false,
        ready: false
      },
      analysisRuntime: {
        sourceBackedAnalysisConfigured: false,
        status: "blocked"
      },
      publicBetaSafety: {
        ready: false,
        abuseHashConfigured: false,
        cleanupCronConfigured: false,
        missingConfiguration: [
          "CLAIMGRAPH_ABUSE_HASH_SECRET",
          "CRON_SECRET",
          "DEV_MODE_PASSWORD_HASH",
          "DEV_MODE_SESSION_SECRET"
        ]
      }
    });
    expect("error" in health.storage).toBe(true);
  });

  it("reports the hosted vllm lane as analysis-ready when endpoint and token are configured", async () => {
    process.env.CLAIMGRAPH_STORAGE_DRIVER = "local";
    process.env.CLAIMGRAPH_MODE = "open-model";
    process.env.CLAIMGRAPH_OPEN_MODEL_BACKEND = "vllm";
    process.env.CLAIMGRAPH_OPEN_MODEL_NAME = "Qwen/Qwen3-8B";
    process.env.OPEN_MODEL_BASE_URL = "https://example.invalid/v1";
    process.env.OPEN_MODEL_API_KEY = "test-token";

    const health = await getProductionHealthSummary();

    expect(health).toMatchObject({
      analysisRuntime: {
        mode: "open-model",
        provider: "open-model",
        openModelBackend: "vllm",
        openModelModel: "Qwen/Qwen3-8B",
        hasHostedBaseUrl: true,
        hasHostedToken: true,
        sourceBackedAnalysisConfigured: true,
        status: "ready",
        missingConfiguration: []
      }
    });
  });
});
