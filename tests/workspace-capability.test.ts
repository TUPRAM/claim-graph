import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as createWorkspaceRoute } from "@/app/api/workspaces/route";
import { GET as getWorkspaceGraphRoute } from "@/app/api/workspaces/[workspaceId]/graph/route";
import { POST as analyzeWorkspaceRoute } from "@/app/api/workspaces/[workspaceId]/analyze/route";
import { POST as uploadWorkspaceFilesRoute } from "@/app/api/workspaces/[workspaceId]/files/route";
import { POST as exportMarkdownRoute } from "@/app/api/workspaces/[workspaceId]/export/markdown/route";
import { DELETE as deleteWorkspaceRoute } from "@/app/api/workspaces/[workspaceId]/route";
import { DELETE as cancelRunRoute } from "@/app/api/runs/[runId]/route";
import { getStoreDatabasePath } from "@/lib/server/runtime-data";
import {
  DEV_SESSION_COOKIE_NAME,
  createDevPasswordHash,
  createDevSessionCookieValue
} from "@/lib/server/dev-auth";
import { localClaimGraphStore } from "@/lib/server/storage/local-store";
import { resetStoreForTests } from "@/lib/server/store";
import {
  WORKSPACE_WRITE_CAPABILITY_HEADER,
  generateWorkspaceWriteCapability,
  hashWorkspaceWriteCapability
} from "@/lib/server/workspace-capability";
import type { PublicWorkspaceGraphPayload } from "@/types/claimgraph";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const testDataDir = path.join(
  process.cwd(),
  "runtime_data",
  "test_state",
  "workspace-capability"
);
const sameOrigin = "http://localhost";

function workspaceContext(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function runContext(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

function ownerHeaders(capability: string) {
  return {
    Origin: sameOrigin,
    [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability
  };
}

async function createOwnedWorkspace(
  capability = generateWorkspaceWriteCapability()
) {
  const response = await createWorkspaceRoute(
    new Request(`${sameOrigin}/api/workspaces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ownerHeaders(capability)
      },
      body: JSON.stringify({
        question: "Should cities ban cars downtown?"
      })
    })
  );
  const body = (await response.json()) as { workspaceId: string };

  return { response, workspaceId: body.workspaceId, capability };
}

describe("anonymous workspace write capabilities", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }
  });

  it("persists only the capability hash and exposes public reads without mutation authority", async () => {
    const { response, workspaceId, capability } = await createOwnedWorkspace();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      `claimgraph_write_${workspaceId}=`
    );

    const db = new Database(getStoreDatabasePath(), { readonly: true });
    const row = db.prepare(`
      SELECT write_capability_hash
      FROM workspace_capabilities
      WHERE workspace_id = ?
    `).get(workspaceId) as { write_capability_hash: string };
    db.close();

    expect(row.write_capability_hash).toBe(
      hashWorkspaceWriteCapability(capability)
    );
    expect(row.write_capability_hash).not.toBe(capability);
    expect(readFileSync(getStoreDatabasePath()).includes(Buffer.from(capability))).toBe(
      false
    );

    const sharedResponse = await getWorkspaceGraphRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}/graph`),
      workspaceContext(workspaceId)
    );
    const sharedPayload =
      (await sharedResponse.json()) as PublicWorkspaceGraphPayload;

    expect(sharedResponse.status).toBe(200);
    expect(sharedPayload.workspace.id).toBe(workspaceId);
    expect(sharedPayload.canWrite).toBe(false);

    const ownerResponse = await getWorkspaceGraphRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}/graph`, {
        headers: {
          [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability
        }
      }),
      workspaceContext(workspaceId)
    );
    const ownerPayload =
      (await ownerResponse.json()) as PublicWorkspaceGraphPayload;

    expect(ownerPayload.canWrite).toBe(true);
  });

  it("rejects rebuild, upload, export persistence, and cancellation without the owner capability", async () => {
    const { workspaceId, capability } = await createOwnedWorkspace();
    const context = workspaceContext(workspaceId);
    const run = await localClaimGraphStore.createRun(workspaceId);

    const analyzeResponse = await analyzeWorkspaceRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}/analyze`, {
        method: "POST",
        headers: { Origin: sameOrigin }
      }),
      context
    );
    expect(analyzeResponse.status).toBe(403);

    const uploadForm = new FormData();
    uploadForm.append(
      "files",
      new File(["Grounded source note"], "source.txt", { type: "text/plain" })
    );
    const uploadResponse = await uploadWorkspaceFilesRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}/files`, {
        method: "POST",
        headers: { Origin: sameOrigin },
        body: uploadForm
      }),
      context
    );
    expect(uploadResponse.status).toBe(403);

    const exportResponse = await exportMarkdownRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}/export/markdown`, {
        method: "POST",
        headers: {
          Origin: sameOrigin,
          "Content-Type": "application/json"
        },
        body: "{}"
      }),
      context
    );
    expect(exportResponse.status).toBe(403);

    const cancelResponse = await cancelRunRoute(
      new Request(`${sameOrigin}/api/runs/${run.id}`, {
        method: "DELETE",
        headers: { Origin: sameOrigin }
      }),
      runContext(run.id)
    );
    expect(cancelResponse.status).toBe(403);
    expect((await localClaimGraphStore.getRun(run.id))?.status).toBe("queued");

    const ownerCancelResponse = await cancelRunRoute(
      new Request(`${sameOrigin}/api/runs/${run.id}`, {
        method: "DELETE",
        headers: ownerHeaders(capability)
      }),
      runContext(run.id)
    );
    expect(ownerCancelResponse.status).toBe(200);
    expect((await localClaimGraphStore.getRun(run.id))?.status).toBe("canceled");
  });

  it("lets a protected developer session operate a legacy workspace with no capability row", async () => {
    const originalPasswordHash = process.env.DEV_MODE_PASSWORD_HASH;
    const originalSessionSecret = process.env.DEV_MODE_SESSION_SECRET;

    try {
      process.env.DEV_MODE_PASSWORD_HASH = createDevPasswordHash(
        "legacy-qa-password",
        Buffer.from("legacy-qa-salt")
      );
      process.env.DEV_MODE_SESSION_SECRET =
        "legacy-qa-session-secret-with-at-least-32-bytes";
      const workspace = await localClaimGraphStore.createWorkspace(
        "Should the historical QA case stay reviewable?"
      );
      const cookie = `${DEV_SESSION_COOKIE_NAME}=${createDevSessionCookieValue()}`;
      const graphResponse = await getWorkspaceGraphRoute(
        new Request(`${sameOrigin}/api/workspaces/${workspace.id}/graph`, {
          headers: { cookie }
        }),
        workspaceContext(workspace.id)
      );

      expect(graphResponse.status).toBe(200);
      await expect(graphResponse.json()).resolves.toMatchObject({
        canWrite: true
      });

      const exportResponse = await exportMarkdownRoute(
        new Request(
          `${sameOrigin}/api/workspaces/${workspace.id}/export/markdown`,
          {
            method: "POST",
            headers: {
              Origin: sameOrigin,
              "Content-Type": "application/json",
              cookie
            },
            body: "{}"
          }
        ),
        workspaceContext(workspace.id)
      );

      expect(exportResponse.status).toBe(200);
      expect(await exportResponse.text()).toContain(
        "Should the historical QA case stay reviewable?"
      );
    } finally {
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
    }
  });

  it("rejects spoofed and cross-origin mutations even when the capability is valid", async () => {
    const { workspaceId, capability } = await createOwnedWorkspace();
    const response = await analyzeWorkspaceRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}/analyze`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "X-Forwarded-Host": "attacker.example",
          [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability
        }
      }),
      workspaceContext(workspaceId)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Cross-origin")
    });
  });

  it("requires the configured canonical origin in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousOrigin = process.env.CLAIMGRAPH_PUBLIC_ORIGIN;
    const { workspaceId, capability } = await createOwnedWorkspace();

    try {
      Object.assign(process.env, {
        NODE_ENV: "production",
        CLAIMGRAPH_PUBLIC_ORIGIN: "https://claimgraph.example"
      });
      const spoofedHost = await analyzeWorkspaceRoute(
        new Request(`https://attacker.example/api/workspaces/${workspaceId}/analyze`, {
          method: "POST",
          headers: {
            Origin: "https://attacker.example",
            [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability
          }
        }),
        workspaceContext(workspaceId)
      );
      const canonical = await analyzeWorkspaceRoute(
        new Request(
          `https://claimgraph.example/api/workspaces/${workspaceId}/analyze`,
          {
            method: "POST",
            headers: {
              Origin: "https://claimgraph.example",
              [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability
            }
          }
        ),
        workspaceContext(workspaceId)
      );
      const sameOriginSpoof = await analyzeWorkspaceRoute(
        new Request(`https://attacker.example/api/workspaces/${workspaceId}/analyze`, {
          method: "POST",
          headers: {
            "Sec-Fetch-Site": "same-origin",
            [WORKSPACE_WRITE_CAPABILITY_HEADER]: capability
          }
        }),
        workspaceContext(workspaceId)
      );

      expect(spoofedHost.status).toBe(403);
      expect(sameOriginSpoof.status).toBe(403);
      expect(canonical.status).not.toBe(403);
    } finally {
      const mutableEnv = process.env as Record<string, string | undefined>;
      if (previousNodeEnv === undefined) {
        delete mutableEnv.NODE_ENV;
      } else {
        mutableEnv.NODE_ENV = previousNodeEnv;
      }
      if (previousOrigin === undefined) {
        delete process.env.CLAIMGRAPH_PUBLIC_ORIGIN;
      } else {
        process.env.CLAIMGRAPH_PUBLIC_ORIGIN = previousOrigin;
      }
    }
  });

  it("keeps a shared workspace read-only and deletes only for the owner", async () => {
    const { workspaceId, capability } = await createOwnedWorkspace();
    const context = workspaceContext(workspaceId);
    const sharedDelete = await deleteWorkspaceRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { Origin: sameOrigin }
      }),
      context
    );

    expect(sharedDelete.status).toBe(403);
    expect(await localClaimGraphStore.getWorkspace(workspaceId)).not.toBeNull();

    const ownerDelete = await deleteWorkspaceRoute(
      new Request(`${sameOrigin}/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: ownerHeaders(capability)
      }),
      context
    );

    expect(ownerDelete.status).toBe(200);
    expect(ownerDelete.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await localClaimGraphStore.getWorkspace(workspaceId)).toBeNull();
  });
});
