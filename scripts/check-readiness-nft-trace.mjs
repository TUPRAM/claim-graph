import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFESTS = [
  ".next/server/app/api/runtime/readiness/route.js.nft.json",
  ".next/server/app/api/dev/runtime/readiness/route.js.nft.json"
];

const ALLOWED_PROJECT_TRACE_ROOTS = new Set([".next", "node_modules"]);

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isInsideProject(projectRoot, absolutePath) {
  const relativePath = path.relative(projectRoot, absolutePath);
  return (
    relativePath !== "" &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".."
  );
}

function isForbiddenProjectPath(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  const segments = normalizedPath.split("/");
  const topLevel = segments[0]?.toLowerCase();

  if (!topLevel) {
    return false;
  }

  if (/\.(?:db|sqlite|sqlite3)(?:-(?:shm|wal))?$/iu.test(normalizedPath)) {
    return true;
  }

  return !ALLOWED_PROJECT_TRACE_ROOTS.has(topLevel);
}

function parseArgs(argv) {
  let projectRoot = process.cwd();
  const manifests = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--project-root" && value) {
      projectRoot = path.resolve(value);
      index += 1;
      continue;
    }

    if (argument === "--manifest" && value) {
      manifests.push(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete argument: ${argument}`);
  }

  return {
    projectRoot,
    manifests: manifests.length > 0 ? manifests : DEFAULT_MANIFESTS
  };
}

export function inspectReadinessNftManifests({ projectRoot, manifests }) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const violations = [];
  let tracedFileCount = 0;

  for (const manifestInput of manifests) {
    const manifestPath = path.resolve(resolvedProjectRoot, manifestInput);

    if (!existsSync(manifestPath)) {
      throw new Error(
        `Readiness NFT manifest is missing: ${toPosixPath(
          path.relative(resolvedProjectRoot, manifestPath)
        )}`
      );
    }

    let manifest;

    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new Error(
        `Readiness NFT manifest is not valid JSON: ${toPosixPath(
          path.relative(resolvedProjectRoot, manifestPath)
        )}`
      );
    }

    if (
      !manifest ||
      !Array.isArray(manifest.files) ||
      !manifest.files.every((item) => typeof item === "string")
    ) {
      throw new Error(
        `Readiness NFT manifest has an invalid files list: ${toPosixPath(
          path.relative(resolvedProjectRoot, manifestPath)
        )}`
      );
    }

    tracedFileCount += manifest.files.length;

    for (const tracedFile of manifest.files) {
      const absoluteTracedFile = path.resolve(path.dirname(manifestPath), tracedFile);

      if (!isInsideProject(resolvedProjectRoot, absoluteTracedFile)) {
        continue;
      }

      const projectRelativePath = path.relative(resolvedProjectRoot, absoluteTracedFile);

      if (isForbiddenProjectPath(projectRelativePath)) {
        violations.push({
          manifest: toPosixPath(path.relative(resolvedProjectRoot, manifestPath)),
          tracedFile: toPosixPath(projectRelativePath)
        });
      }
    }
  }

  return {
    manifestCount: manifests.length,
    tracedFileCount,
    violations
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = inspectReadinessNftManifests(options);

  if (result.violations.length > 0) {
    console.error(
      `Readiness NFT trace check failed: ${result.violations.length} forbidden project file(s) were bundled.`
    );

    for (const violation of result.violations) {
      console.error(`  ${violation.manifest}: ${violation.tracedFile}`);
    }

    process.exitCode = 1;
    return;
  }

  console.log(
    `Readiness NFT trace check passed for ${result.manifestCount} manifest(s) and ${result.tracedFileCount} traced file(s).`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Readiness NFT trace check failed."
    );
    process.exitCode = 1;
  }
}
