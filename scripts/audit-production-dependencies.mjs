import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("npm_execpath is unavailable; run this gate through npm run audit:security.");
  process.exit(1);
}

const audit = spawnSync(
  process.execPath,
  [npmCli, "audit", "--omit=dev", "--json"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false
  }
);

if (audit.error) {
  console.error(`Unable to start npm audit: ${audit.error.message}`);
  process.exit(1);
}

if (typeof audit.status !== "number" || audit.signal) {
  console.error(`npm audit terminated unexpectedly${audit.signal ? ` (${audit.signal})` : ""}.`);
  process.exit(1);
}

if (audit.status > 1) {
  console.error(
    audit.stderr || `npm audit exited with unexpected status ${audit.status}.`
  );
  process.exit(1);
}

if (!audit.stdout?.trim()) {
  console.error(audit.stderr || "npm audit did not return a JSON report.");
  process.exit(1);
}

let report;

try {
  report = JSON.parse(audit.stdout);
} catch (error) {
  console.error("Unable to parse npm audit output.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (report?.error) {
  console.error(`npm audit failed: ${report.error.summary ?? report.error.code ?? "unknown error"}`);
  process.exit(1);
}

const counts = report?.metadata?.vulnerabilities ?? {};

if (!report?.metadata?.vulnerabilities) {
  console.error("npm audit returned no vulnerability metadata; failing closed.");
  process.exit(1);
}
const high = Number(counts.high ?? 0);
const critical = Number(counts.critical ?? 0);
const moderate = Number(counts.moderate ?? 0);
const low = Number(counts.low ?? 0);

if (![high, critical, moderate, low].every(Number.isFinite)) {
  console.error("npm audit returned invalid vulnerability counts; failing closed.");
  process.exit(1);
}

console.log(
  `Production dependency audit: critical=${critical}, high=${high}, moderate=${moderate}, low=${low}`
);

if (critical > 0 || high > 0) {
  const blocking = Object.values(report.vulnerabilities ?? {})
    .filter((entry) => entry.severity === "critical" || entry.severity === "high")
    .map((entry) => `${entry.name} (${entry.severity})`);

  console.error(`Blocking production findings: ${blocking.join(", ")}`);
  process.exit(1);
}

console.log("Security gate passed: no high or critical production dependency findings.");
