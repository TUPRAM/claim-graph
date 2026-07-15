import path from "node:path";
import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getPublicGraph } from "@/app/api/workspaces/[workspaceId]/graph/route";
import { GET as getDevGraph } from "@/app/api/dev/workspaces/[workspaceId]/graph/route";
import { GET as getDevReadiness } from "@/app/api/dev/runtime/readiness/route";
import {
  DELETE as deleteSession,
  GET as getSession,
  POST as postSession
} from "@/app/api/session/dev/route";
import { GET as getLegacySession } from "@/app/api/dev/session/route";
import {
  createDevPasswordHash,
  DEV_SESSION_COOKIE_NAME
} from "@/lib/server/dev-auth";
import {
  createWorkspace,
  recordWorkspaceArtifactsInvalidated,
  resetStoreForTests
} from "@/lib/server/store";
import { getDevSessionCookieHeader, resetDevAuthForTest, withDevSession } from "./helpers/dev-auth";
import type { WorkspaceGraphPayload } from "@/types/claimgraph";

const originalDataDir = process.env.CLAIMGRAPH_DATA_DIR;
const originalPasswordHash = process.env.DEV_MODE_PASSWORD_HASH;
const originalSessionSecret = process.env.DEV_MODE_SESSION_SECRET;
const testDataDir = path.join(process.cwd(), "runtime_data", "test_state", "dev-auth");

function workspaceRouteContext(workspaceId: string) {
  return {
    params: Promise.resolve({ workspaceId })
  };
}

describe("developer auth and public payload separation", () => {
  beforeEach(() => {
    process.env.CLAIMGRAPH_DATA_DIR = testDataDir;
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
    resetDevAuthForTest({
      passwordHash: originalPasswordHash,
      sessionSecret: originalSessionSecret
    });
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    resetStoreForTests();
    resetDevAuthForTest({
      passwordHash: originalPasswordHash,
      sessionSecret: originalSessionSecret
    });

    if (originalDataDir === undefined) {
      delete process.env.CLAIMGRAPH_DATA_DIR;
    } else {
      process.env.CLAIMGRAPH_DATA_DIR = originalDataDir;
    }
  });

  it("sets and clears an HttpOnly SameSite=Lax developer session cookie", async () => {
    process.env.DEV_MODE_PASSWORD_HASH = createDevPasswordHash(
      "correct-password",
      Buffer.from("route-test-salt")
    );
    process.env.DEV_MODE_SESSION_SECRET = "route-test-session-secret-32-bytes";

    const crossOriginLogin = await postSession(
      new Request("http://localhost/api/session/dev", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example"
        },
        body: JSON.stringify({ password: "correct-password" })
      })
    );

    expect(crossOriginLogin.status).toBe(403);

    const failedLogin = await postSession(
      new Request("http://localhost/api/session/dev", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost"
        },
        body: JSON.stringify({ password: "wrong-password" })
      })
    );

    expect(failedLogin.status).toBe(401);

    const login = await postSession(
      new Request("http://localhost/api/session/dev", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost"
        },
        body: JSON.stringify({ password: "correct-password" })
      })
    );
    const setCookie = login.headers.get("set-cookie") ?? "";

    expect(login.status).toBe(200);
    expect(setCookie).toContain(`${DEV_SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).not.toContain("correct-password");

    const session = await getSession(
      new Request("http://localhost/api/session/dev", {
        headers: {
          cookie: setCookie
        }
      })
    );

    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      configured: true
    });

    const legacyProbe = await getLegacySession(
      new Request("http://localhost/api/dev/session", {
        headers: {
          cookie: setCookie
        }
      })
    );

    await expect(legacyProbe.json()).resolves.toMatchObject({
      authenticated: true,
      configured: true
    });

    const logout = await deleteSession(
      new Request("http://localhost/api/session/dev", {
        method: "DELETE",
        headers: { Origin: "http://localhost" }
      })
    );
    const clearedCookie = logout.headers.get("set-cookie") ?? "";

    expect(clearedCookie).toContain(`${DEV_SESSION_COOKIE_NAME}=`);
    expect(clearedCookie).toContain("Max-Age=0");
  });

  it("bounds developer login bodies and throttles repeated attempts", async () => {
    const originalLoginLimit = process.env.CLAIMGRAPH_DEV_LOGIN_LIMIT_PER_IP;
    const originalAbuseSecret = process.env.CLAIMGRAPH_ABUSE_HASH_SECRET;
    process.env.DEV_MODE_PASSWORD_HASH = createDevPasswordHash(
      "correct-password",
      Buffer.from("bounded-login-salt")
    );
    process.env.DEV_MODE_SESSION_SECRET =
      "bounded-login-session-secret-with-32-bytes";
    process.env.CLAIMGRAPH_ABUSE_HASH_SECRET =
      "bounded-login-abuse-secret-with-32-bytes";

    try {
      const oversized = await postSession(
        new Request("http://localhost/api/session/dev", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
            "X-Forwarded-For": "203.0.113.70"
          },
          body: JSON.stringify({ password: "x".repeat(5_000) })
        })
      );
      expect(oversized.status).toBe(413);

      process.env.CLAIMGRAPH_DEV_LOGIN_LIMIT_PER_IP = "1";
      resetStoreForTests();
      const attempt = () =>
        postSession(
          new Request("http://localhost/api/session/dev", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "X-Forwarded-For": "203.0.113.71"
            },
            body: JSON.stringify({ password: "wrong-password" })
          })
        );

      expect((await attempt()).status).toBe(401);
      const throttled = await attempt();
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBeTruthy();
    } finally {
      if (originalLoginLimit === undefined) {
        delete process.env.CLAIMGRAPH_DEV_LOGIN_LIMIT_PER_IP;
      } else {
        process.env.CLAIMGRAPH_DEV_LOGIN_LIMIT_PER_IP = originalLoginLimit;
      }
      if (originalAbuseSecret === undefined) {
        delete process.env.CLAIMGRAPH_ABUSE_HASH_SECRET;
      } else {
        process.env.CLAIMGRAPH_ABUSE_HASH_SECRET = originalAbuseSecret;
      }
    }
  });

  it("requires a valid session for protected developer APIs", async () => {
    const workspace = createWorkspace("Should cities ban cars downtown?");

    const unauthorizedGraph = await getDevGraph(
      new Request(`http://localhost/api/dev/workspaces/${workspace.id}/graph`),
      workspaceRouteContext(workspace.id)
    );
    const unauthorizedReadiness = await getDevReadiness(
      new Request("http://localhost/api/dev/runtime/readiness")
    );

    expect(unauthorizedGraph.status).toBe(401);
    expect(unauthorizedReadiness.status).toBe(401);

    const authorizedGraph = await getDevGraph(
      withDevSession(new Request(`http://localhost/api/dev/workspaces/${workspace.id}/graph`)),
      workspaceRouteContext(workspace.id)
    );

    expect(authorizedGraph.status).toBe(200);
  });

  it("keeps public workspace graph JSON free of raw run diagnostics", async () => {
    const workspace = createWorkspace("Should cities ban cars downtown?");
    recordWorkspaceArtifactsInvalidated(workspace.id, {
      statusMessage:
        "Workspace inputs changed. Previous live analysis artifacts were cleared with provider cleanup details.",
      cleanupEvents: [
        {
          id: "cleanup_1",
          kind: "vector_store",
          remoteId: "vs_secret",
          reason: "workspace_deleted",
          status: "deleted",
          createdAt: "2026-04-12T12:00:00.000Z"
        }
      ]
    });

    const publicResponse = await getPublicGraph(
      new Request(`http://localhost/api/workspaces/${workspace.id}/graph`),
      workspaceRouteContext(workspace.id)
    );
    const publicPayload = (await publicResponse.json()) as WorkspaceGraphPayload;

    expect(publicResponse.status).toBe(200);
    expect(publicPayload.run?.observability).toBeUndefined();
    expect(publicPayload.run?.statusMessage).toBe(
      "The map is ready to inspect."
    );
    expect(publicPayload.evidence).toBeNull();
    expect(publicPayload.claimInventory).toBeNull();
    expect(JSON.stringify(publicPayload)).not.toContain("vs_secret");
    expect(JSON.stringify(publicPayload)).not.toContain("provider cleanup details");

    const devResponse = await getDevGraph(
      withDevSession(new Request(`http://localhost/api/dev/workspaces/${workspace.id}/graph`)),
      workspaceRouteContext(workspace.id)
    );
    const devPayload = (await devResponse.json()) as WorkspaceGraphPayload;

    expect(devPayload.run?.observability?.retrievalCleanupEvents?.[0]?.remoteId).toBe(
      "vs_secret"
    );
    expect(getDevSessionCookieHeader()).toContain(`${DEV_SESSION_COOKIE_NAME}=`);
  });
});
