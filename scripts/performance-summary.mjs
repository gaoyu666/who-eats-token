import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const intervalNeedle = "set" + "Interval(";
const args = parseArgs(process.argv.slice(2));

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const catalog = readJson("adapters/catalog.json");
const releaseEvidence = readJson("docs/release-evidence.json");
const packagedSmoke = readText("scripts/lib/packaged-smoke.mjs");
const packagedSoak = readText("scripts/lib/packaged-soak.mjs");
const adapterReview = runAdapterReview();

const summary = buildSummary();

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}

if (args.requireClean && !summary.ok) {
  process.exitCode = 1;
}

function buildSummary() {
  const intervalAudit = auditIntervals();
  const adapterBoundaries = summarizeAdapterBoundaries(catalog.adapters || []);
  const packageWeight = summarizePackageWeight();
  const runtimeBudgets = summarizeRuntimeBudgets();
  const evidence = summarizeReleaseEvidence();
  const ok = (
    intervalAudit.unreviewedRuntimeIntervalCount === 0
    && intervalAudit.adapterDomIntervalCount === 0
    && adapterReview.ok === true
  );

  return {
    ok,
    checkedAt: new Date().toISOString(),
    packageWeight,
    runtimeBudgets,
    intervalAudit,
    adapterBoundaries,
    adapterReview,
    releaseEvidence: evidence,
    commands: [
      "npm run test:performance-budget",
      "npm run performance:summary -- -- --json",
      "npm run test:soak-script",
      "npm run soak:packaged-win",
      "npm run soak:packaged-mac",
      "npm run adapter:review",
      "npm run diagnostics -- -- --json",
      "npm run stability -- -- --json",
      "npm run release:summary"
    ]
  };
}

function summarizePackageWeight() {
  const lockPackages = Object.keys(packageLock.packages || {});
  const installedPackages = lockPackages.filter(Boolean);
  return {
    runtimeDependencyCount: Object.keys(packageJson.dependencies || {}).length,
    devDependencyCount: Object.keys(packageJson.devDependencies || {}).length,
    lockPackageCount: installedPackages.length,
    packageLockRootIncluded: lockPackages.length !== installedPackages.length,
    runtimeDependencies: Object.keys(packageJson.dependencies || {}).sort(),
    devDependencies: Object.keys(packageJson.devDependencies || {}).sort()
  };
}

function summarizeRuntimeBudgets() {
  return {
    smoke: {
      maxWorkingSetMb: readConstNumber(packagedSmoke, "DEFAULT_MAX_WORKING_SET_MB"),
      maxCpuPercent: readConstNumber(packagedSmoke, "DEFAULT_MAX_CPU_PERCENT"),
      timeoutMs: readConstNumber(packagedSmoke, "DEFAULT_TIMEOUT_MS"),
      env: [
        "WHO_EATS_TOKEN_SMOKE_MAX_RSS_MB",
        "WHO_EATS_TOKEN_SMOKE_MAX_CPU_PERCENT"
      ]
    },
    soak: {
      durationMs: readConstNumber(packagedSoak, "DEFAULT_DURATION_MS"),
      intervalMs: readConstNumber(packagedSoak, "DEFAULT_INTERVAL_MS"),
      maxWorkingSetMb: readConstNumber(packagedSoak, "DEFAULT_MAX_WORKING_SET_MB"),
      maxGrowthMb: readConstNumber(packagedSoak, "DEFAULT_MAX_GROWTH_MB"),
      maxCpuPercent: readConstNumber(packagedSoak, "DEFAULT_MAX_CPU_PERCENT"),
      env: [
        "WHO_EATS_TOKEN_SOAK_DURATION_MS",
        "WHO_EATS_TOKEN_SOAK_INTERVAL_MS",
        "WHO_EATS_TOKEN_SOAK_MAX_RSS_MB",
        "WHO_EATS_TOKEN_SOAK_MAX_GROWTH_MB",
        "WHO_EATS_TOKEN_SOAK_MAX_CPU_PERCENT"
      ]
    }
  };
}

function auditIntervals() {
  const occurrences = scanSourceFiles(["src", "adapters", "scripts"])
    .flatMap((relativePath) => findNeedleOccurrences(relativePath, intervalNeedle))
    .map(classifyInterval);
  const reviewedRuntime = occurrences.filter((item) => item.classification === "reviewed-runtime");
  const adapterDom = occurrences.filter((item) => item.classification === "adapter-dom-runtime");
  const testOrGuard = occurrences.filter((item) => item.classification === "test-or-guard");
  const unreviewedRuntime = occurrences.filter((item) => item.classification === "unreviewed-runtime");

  return {
    totalOccurrenceCount: occurrences.length,
    reviewedRuntimeIntervalCount: reviewedRuntime.length,
    adapterDomIntervalCount: adapterDom.length,
    testOrGuardOccurrenceCount: testOrGuard.length,
    unreviewedRuntimeIntervalCount: unreviewedRuntime.length,
    reviewedRuntime,
    adapterDom,
    unreviewedRuntime,
    testOrGuardSample: testOrGuard.slice(0, 5)
  };
}

function classifyInterval(occurrence) {
  const normalized = occurrence.file.replace(/\\/g, "/");
  const line = occurrence.lineText;
  if (
    normalized === "src/main.cjs"
    && (
      line.includes("snapshotTimer =")
      || line.includes("systemTimer =")
      || line.includes("desktopBarTimer =")
      || line.includes("toolProcessScanTimer =")
    )
  ) {
    return {
      ...occurrence,
      classification: "reviewed-runtime",
      reason: "Bounded desktop/runtime timer covered by docs/performance-budget.md"
    };
  }

  if (
    (normalized === "src/collectors/ingest-server.cjs" || normalized === "src/collectors/hermes-bridge.cjs")
    && line.includes("retryTimer = setInterval")
  ) {
    return {
      ...occurrence,
      classification: "reviewed-runtime",
      reason: "Port retry timer: .unref(), cleared on listen/close, only fires on EADDRINUSE."
    };
  }

  if (
    normalized.startsWith("adapters/")
    || normalized === "src/integrations/hermes-overlay-installer.cjs"
  ) {
    return {
      ...occurrence,
      classification: "adapter-dom-runtime",
      reason: "Adapters and injected overlays should remain event-driven."
    };
  }

  if (
    normalized.startsWith("scripts/test-")
    || normalized === "scripts/adapter-guard.mjs"
    || normalized === "scripts/performance-summary.mjs"
  ) {
    return {
      ...occurrence,
      classification: "test-or-guard",
      reason: "Test or static guard source."
    };
  }

  return {
    ...occurrence,
    classification: "unreviewed-runtime",
    reason: "Runtime timer is not part of the documented budget allowlist."
  };
}

function summarizeAdapterBoundaries(adapters) {
  const reviewed = adapters.map((adapter) => {
    const boundary = `${adapter.performanceBoundary || ""}`.toLowerCase();
    const noRuntime = adapter.type === "agent-workflow" && /(no background runtime|only executes|only runs|仅在)/i.test(boundary);
    return {
      id: adapter.id,
      type: adapter.type,
      status: adapter.status,
      hasShortTimeout: noRuntime || /(timeout|short|短)/i.test(boundary),
      hasPollingBound: /(poll|watchdog|loop|cache|queue|bounded|缓存|轮询|队列)/i.test(boundary),
      signalCount: Array.isArray(adapter.providedSignals) ? adapter.providedSignals.length : 0
    };
  });

  return {
    adapterCount: reviewed.length,
    withShortTimeouts: reviewed.filter((adapter) => adapter.hasShortTimeout).length,
    withPollingBounds: reviewed.filter((adapter) => adapter.hasPollingBound).length,
    supportedCount: reviewed.filter((adapter) => adapter.status === "supported").length,
    referenceCount: reviewed.filter((adapter) => adapter.status === "reference").length,
    plannedCount: reviewed.filter((adapter) => adapter.status === "planned").length,
    reviewed
  };
}

function summarizeReleaseEvidence() {
  const evidence = releaseEvidence.evidence || {};
  return {
    releaseCandidate: releaseEvidence.releaseCandidate || "",
    windowsPackagedSmoke: summarizeEvidenceItem(evidence.windowsPackagedRuntime?.smoke),
    windowsPackagedSoak: summarizeEvidenceItem(evidence.windowsPackagedRuntime?.soak),
    macosPackagedSmoke: summarizeEvidenceItem(evidence.macosPackagedRuntime?.smoke),
    macosPackagedSoak: summarizeEvidenceItem(evidence.macosPackagedRuntime?.soak),
    dependencyAudit: summarizeEvidenceItem(evidence.dependencyAudit)
  };
}

function summarizeEvidenceItem(item = {}) {
  return {
    status: item.status || "missing",
    recordedAt: item.recordedAt || "",
    command: item.command || "",
    notes: item.notes || ""
  };
}

function runAdapterReview() {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "adapter-review.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0 || result.error) {
    return {
      ok: false,
      adapterCount: 0,
      errorCount: 1,
      warningCount: 0,
      error: result.error?.message || result.stderr || `adapter-review exited ${result.status}`
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ok: parsed.ok === true,
      adapterCount: Number(parsed.adapterCount || 0),
      errorCount: Number(parsed.errorCount || 0),
      warningCount: Number(parsed.warningCount || 0)
    };
  } catch (error) {
    return {
      ok: false,
      adapterCount: 0,
      errorCount: 1,
      warningCount: 0,
      error: `Could not parse adapter-review JSON: ${error.message}`
    };
  }
}

function scanSourceFiles(roots) {
  const results = [];
  for (const directory of roots) {
    walk(path.join(root, directory), results);
  }
  return results.map((absolutePath) => path.relative(root, absolutePath));
}

function walk(directory, results) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "release", ".git"].includes(entry.name)) continue;
      walk(absolutePath, results);
      continue;
    }
    if (!/\.(cjs|mjs|js)$/.test(entry.name)) continue;
    results.push(absolutePath);
  }
}

function findNeedleOccurrences(relativePath, needle) {
  const lines = readText(relativePath).split(/\r?\n/);
  const occurrences = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) {
      occurrences.push({
        file: relativePath,
        line: index + 1,
        lineText: lines[index].trim()
      });
    }
  }
  return occurrences;
}

function readConstNumber(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`));
  if (!match) return null;
  return parseNumberExpression(match[1]);
}

function parseNumberExpression(expression) {
  const parts = expression.split("*").map((part) => part.trim().replace(/_/g, ""));
  if (parts.every((part) => /^\d+(\.\d+)?$/.test(part))) {
    return parts.reduce((product, part) => product * Number(part), 1);
  }
  const numeric = Number(expression.trim().replace(/_/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function printSummary(report) {
  console.log("# Performance Summary");
  console.log("");
  console.log(`Low-memory gates: ${report.ok ? "clean" : "needs attention"}`);
  console.log(`Package weight: ${report.packageWeight.runtimeDependencyCount} runtime deps, ${report.packageWeight.devDependencyCount} dev deps, ${report.packageWeight.lockPackageCount} locked packages`);
  console.log(`Runtime intervals: ${report.intervalAudit.reviewedRuntimeIntervalCount} reviewed, ${report.intervalAudit.adapterDomIntervalCount} adapter DOM intervals, ${report.intervalAudit.unreviewedRuntimeIntervalCount} unreviewed`);
  console.log(`Adapter boundaries: ${report.adapterBoundaries.adapterCount} adapters, ${report.adapterBoundaries.withShortTimeouts} short-timeout/no-runtime boundaries, ${report.adapterBoundaries.withPollingBounds} polling/cache/queue boundaries`);
  console.log(`Adapter review: ${report.adapterReview.adapterCount} adapters, ${report.adapterReview.errorCount} errors, ${report.adapterReview.warningCount} warnings`);
  console.log("");
  console.log("## Runtime Budgets");
  console.log(`Packaged smoke: RSS <= ${report.runtimeBudgets.smoke.maxWorkingSetMb}MB, CPU <= ${report.runtimeBudgets.smoke.maxCpuPercent}%`);
  console.log(`Packaged soak: RSS <= ${report.runtimeBudgets.soak.maxWorkingSetMb}MB, growth <= ${report.runtimeBudgets.soak.maxGrowthMb}MB, CPU <= ${report.runtimeBudgets.soak.maxCpuPercent}%`);
  console.log("");
  console.log("## Windows packaged soak");
  printEvidence(report.releaseEvidence.windowsPackagedSoak);
  console.log("");
  console.log("## macOS packaged soak");
  printEvidence(report.releaseEvidence.macosPackagedSoak);
  console.log("");
  console.log("## Commands");
  for (const command of report.commands) console.log(`- ${command}`);
}

function printEvidence(item) {
  console.log(`Status: ${item.status}`);
  if (item.command) console.log(`Command: ${item.command}`);
  if (item.notes) console.log(`Notes: ${item.notes}`);
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    requireClean: argv.includes("--require-clean")
  };
}
