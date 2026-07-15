import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const checkerPath = path.join(
  process.cwd(),
  "scripts",
  "check-readiness-nft-trace.mjs"
);
const temporaryRoots: string[] = [];

function createFixtureManifest(projectRoot: string, tracedFiles: string[]) {
  const manifestPath = path.join(
    projectRoot,
    ".next",
    "server",
    "app",
    "api",
    "runtime",
    "readiness",
    "route.js.nft.json"
  );
  const manifestDirectory = path.dirname(manifestPath);
  mkdirSync(manifestDirectory, { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      files: tracedFiles.map((filePath) =>
        path.relative(manifestDirectory, filePath)
      )
    })
  );

  return manifestPath;
}

function runChecker(projectRoot: string, manifestPath: string) {
  return spawnSync(
    process.execPath,
    [
      checkerPath,
      "--project-root",
      projectRoot,
      "--manifest",
      manifestPath
    ],
    { encoding: "utf8" }
  );
}

describe("readiness NFT trace check", () => {
  afterEach(() => {
    for (const temporaryRoot of temporaryRoots.splice(0)) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("accepts framework output and dependency files", () => {
    const projectRoot = mkdtempSync(
      path.join(os.tmpdir(), "claimgraph-nft-safe-")
    );
    temporaryRoots.push(projectRoot);
    const manifestPath = createFixtureManifest(projectRoot, [
      path.join(projectRoot, ".next", "server", "chunks", "route.js"),
      path.join(projectRoot, "node_modules", "next", "dist", "server.js")
    ]);

    const result = runChecker(projectRoot, manifestPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Readiness NFT trace check passed");
  });

  it("rejects unexpected project roots and persisted database files", () => {
    const projectRoot = mkdtempSync(
      path.join(os.tmpdir(), "claimgraph-nft-forbidden-")
    );
    temporaryRoots.push(projectRoot);
    const manifestPath = createFixtureManifest(projectRoot, [
      path.join(projectRoot, "runtime", "claimgraph-store.sqlite"),
      path.join(projectRoot, "notes", "internal.md"),
      path.join(projectRoot, "quality", "fixture.test.ts"),
      path.join(projectRoot, "tools", "task.mjs"),
      path.join(projectRoot, ".workspace", "configuration.env"),
      path.join(projectRoot, "MAINTAINERS.md"),
      path.join(projectRoot, "claimgraph-store.sqlite")
    ]);

    const result = runChecker(projectRoot, manifestPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("7 forbidden project file(s)");
    expect(result.stderr).toContain("runtime/claimgraph-store.sqlite");
    expect(result.stderr).toContain("notes/internal.md");
    expect(result.stderr).toContain("quality/fixture.test.ts");
    expect(result.stderr).toContain("tools/task.mjs");
    expect(result.stderr).toContain(".workspace/configuration.env");
    expect(result.stderr).toContain("MAINTAINERS.md");
    expect(result.stderr).toContain("claimgraph-store.sqlite");
  });
});
