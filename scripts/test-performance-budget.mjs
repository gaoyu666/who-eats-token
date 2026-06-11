import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { DEFAULT_SETTINGS, sanitizeSettings } = require("../src/config/settings.cjs");
const {
  guardBooleanPayload,
  guardHudTrustPopoverPayload,
  guardHudTrustPopoverSize,
  guardSettingsPayload
} = require("../src/main/ipc-guards.cjs");

const mainSource = read("src/main.cjs");
const toolRegistrySource = read("src/system/tool-registry.cjs");
const wakeProbeSource = read("src/main/wake-probe.ps1");
const activeWindowSource = read("src/system/active-window.cjs");
const settingsSource = read("src/config/settings.cjs");
const stylesSource = read("src/renderer/styles.css");
const quotaDelightSource = read("src/protocol/quota-delight.cjs");
const statusSource = read("scripts/status.mjs");
const stabilitySource = read("scripts/stability.mjs");
const diagnosticsSource = read("scripts/diagnostics.mjs");
const lagTriageSource = read("scripts/lag-triage.mjs");
const supportBundleSource = read("scripts/support-bundle.mjs");
const delightContractSource = read("scripts/delight-contract.mjs");
const adapterFixtureSource = read("scripts/adapter-fixture.mjs");
const diagnosticsBundleSource = read("src/diagnostics/diagnostics-bundle.cjs");
const stabilityReportSource = read("src/diagnostics/stability-report.cjs");
const importUsageReportSource = read("scripts/import-usage-report.mjs");
const hermesOverlayInstaller = read("src/integrations/hermes-overlay-installer.cjs");
const xiaomiTokenPlanSource = read("src/collectors/xiaomi-token-plan.cjs");
const browserContentScript = read("adapters/browser-extension/content-script.js");
const browserServiceWorker = read("adapters/browser-extension/service-worker.js");
const overlayCoordinatorSource = extractFunction(mainSource, "async function refreshOverlayCoordinator");
const overlayDecisionSource = extractFunction(mainSource, "function resolveOverlayDecision");
const toolDesktopWakeSource = extractFunction(mainSource, "async function runToolDesktopWake");
const toolDesktopWakeProbeSource = extractFunction(mainSource, "function handleToolDesktopWakeProbeLine");
const restartIngestSource = extractFunction(mainSource, "function restartIngestServerIfNeeded");
const restartHermesBridgeSource = extractFunction(mainSource, "function restartHermesBridgeIfNeeded");

assert.equal(DEFAULT_SETTINGS.behavior.debugHud, false, "Debug HUD must stay disabled by default.");
assert.equal(DEFAULT_SETTINGS.integrations.hermesOverlayAutoInstall, false, "Hermes Web UI injection must stay opt-in.");
assert.equal(DEFAULT_SETTINGS.security.allowUnauthenticatedNoOrigin, false, "No-Origin local API bypass must stay disabled by default.");
assert.ok(DEFAULT_SETTINGS.behavior.refreshMs >= 15000, "Default provider refresh must be at least 15s.");
assert.ok(DEFAULT_SETTINGS.behavior.activeWindowMs >= 15000, "Default active-window refresh must be at least 15s.");

const aggressive = sanitizeSettings({
  behavior: {
    refreshMs: 1,
    activeWindowMs: 1
  },
  windows: {
    desktopWidthRatio: 0.95,
    desktopBarHeight: 120,
    toolHudWidth: 900,
    toolHudHeight: 400,
    toolHudOffsetX: 900,
    toolHudOffsetY: -900
  },
  desktopBarStage: { stageWidth: 9999 },
  unknown: true
});
assert.ok(aggressive.behavior.refreshMs >= 15000, "Provider refresh lower clamp must be at least 15s.");
assert.ok(aggressive.behavior.activeWindowMs >= 3000, "Active-window lower clamp must be at least 3s.");
assert.ok(aggressive.windows.desktopWidthRatio <= 0.9, "Desktop bar width must stay capped below full screen.");
assert.ok(aggressive.windows.desktopBarHeight <= 96, "Desktop bar height must stay capped for overlay safety.");
assert.ok(aggressive.windows.toolHudWidth <= 560, "Tool HUD width must stay capped for overlay safety.");
assert.ok(aggressive.windows.toolHudHeight <= 220, "Tool HUD height must stay capped for overlay safety.");
assert.ok(aggressive.windows.toolHudOffsetX <= 240, "Tool HUD horizontal offset must stay capped for overlay safety.");
assert.ok(aggressive.windows.toolHudOffsetY >= -240, "Tool HUD vertical offset must stay capped for overlay safety.");
assert.equal(Object.hasOwn(aggressive, "desktopBarStage"), false, "Settings sanitizer must drop renderer-only fields.");
assert.equal(Object.hasOwn(aggressive, "unknown"), false, "Settings sanitizer must drop unknown top-level fields.");

const guardedSettings = guardSettingsPayload({
  appearance: { glassOpacity: 0.4, injected: true },
  providers: {
    codex: { enabled: true, source: "forged" },
    "../bad": { enabled: true }
  },
  providerRegistry: [{ id: "forged" }]
});
assert.deepEqual(guardedSettings.appearance, { glassOpacity: 0.4 });
assert.deepEqual(guardedSettings.providers.codex, { enabled: true });
assert.equal(Object.hasOwn(guardedSettings, "providerRegistry"), false);
assert.equal(Object.hasOwn(guardedSettings.providers, "../bad"), false);
assert.equal(guardBooleanPayload("true"), false);
assert.equal(guardBooleanPayload(true), true);

const guardedPopover = guardHudTrustPopoverPayload({
  anchor: { x: 10, y: 12, width: 80, height: 24 },
  details: {
    status: "精确",
    rows: [{ label: "来源", value: "local".repeat(200) }]
  }
});
assert.equal(guardedPopover.anchor.width, 80);
assert.ok(guardedPopover.details.rows[0].value.length <= 500);
assert.equal(guardHudTrustPopoverSize({ height: 99999 }).height, 720);

assertNumericConstant(mainSource, "SYSTEM_REFRESH_MS", 2000, Infinity);
assertNumericConstant(mainSource, "OVERLAY_COORDINATOR_REFRESH_MS", 200, 500);
assertNumericConstant(mainSource, "TOOL_DESKTOP_WAKE_MS", 50, 150);
assertNumericConstant(mainSource, "TOOL_DESKTOP_WAKE_TIMEOUT_MS", 50, 300);
assertNumericConstant(mainSource, "TOOL_DESKTOP_WAKE_PROBE_INTERVAL_MS", 40, 150);
assert.ok(
  /const\s+TOOL_HUD_STEADY_REFRESH_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(toolRegistrySource),
  "Tool HUD steady-state provider refresh should stay at 5 minutes (in tool-registry.cjs)."
);
assert.ok(
  /const\s+HIDDEN_SNAPSHOT_REFRESH_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(mainSource),
  "Hidden/unsupported states should not keep the provider on the foreground cadence."
);
assertNumericConstant(mainSource, "CODEX_SESSION_WATCH_DEBOUNCE_MS", 250, 2000);
assert.ok(mainSource.includes("fs.watch("), "Codex session updates should be event-driven, not a tighter polling loop.");
assert.ok(mainSource.includes("scheduleCodexSessionRefresh"), "Codex session watcher must debounce snapshot refreshes.");
assert.ok(mainSource.includes("refreshOverlayCoordinator"), "Foreground re-entry should be handled by the unified overlay coordinator.");
assert.ok(mainSource.includes("scheduleNextSnapshotRefresh"), "Provider snapshots should be adaptively scheduled by overlay state.");
assert.ok(mainSource.includes("scheduleToolDecisionSnapshotRefresh"), "Entering a supported tool should refresh quota through a deferred overlay-safe task.");
assert.ok(!overlayCoordinatorSource.includes("collectSnapshot("), "The sub-second overlay coordinator must not read providers directly.");
assert.ok(!overlayDecisionSource.includes("collectSnapshot("), "Overlay decisions must be window-state only.");
assert.ok(!toolDesktopWakeSource.includes("collectSnapshot("), "The tool-desktop wake guard must not read providers directly.");
assert.ok(
  toolDesktopWakeSource.includes("runOverlayCoordinatorPass(() => activeWindow)") &&
    toolDesktopWakeProbeSource.includes("runOverlayCoordinatorPass(() => activeWindow, { priority: true })") &&
    !/hideToolHudForDesktop|showDesktopBarForTransition|hideDesktopBarWindow|showToolHudWindow/.test(`${toolDesktopWakeSource}\n${toolDesktopWakeProbeSource}`),
  "The tool-desktop wake guard must only wake the unified coordinator, not mutate overlay windows directly."
);
assert.ok(
  mainSource.includes("overlayCoordinatorGeneration") &&
    mainSource.includes("overlayCoordinatorPriorityInFlight") &&
    mainSource.includes("generation !== overlayCoordinatorGeneration"),
  "Priority tool-desktop wake samples must invalidate stale in-flight foreground samples and block new ordinary passes instead of increasing the coordinator cadence."
);
assert.ok(
  mainSource.includes("nativeDesktopFallbackOnly: true") &&
    activeWindowSource.includes("function shouldUseNativeDesktopFallbackOnly"),
  "The tool-desktop wake guard should use native desktop fallback instead of a slow PowerShell fallback."
);
assert.ok(
  mainSource.includes("TOOL_DESKTOP_WAKE_PROBE_PS1") &&
    wakeProbeSource.includes("GetShellWindow") &&
    wakeProbeSource.includes("IsIconic") &&
    wakeProbeSource.includes("tool-desktop-wake-offscreen-probe"),
  "The tool-desktop wake helper should reuse its warm Win32 process to classify minimized/offscreen foreground tools without extra polling."
);
assert.ok(mainSource.includes("function hasLocalApiSecurityChanged"), "Local API security changes must have an explicit restart predicate.");
assert.ok(
  restartIngestSource.includes("hasLocalApiSecurityChanged(previous, current)") &&
    restartIngestSource.includes("!securityChanged"),
  "Ingest server must restart when local API security settings change."
);
assert.ok(
  restartHermesBridgeSource.includes("hasLocalApiSecurityChanged(previous, current)") &&
    restartHermesBridgeSource.includes("!securityChanged"),
  "Hermes Bridge must restart when local API security settings change."
);
assert.ok(mainSource.includes("HUD_DEBUG_LOG_MAX_BYTES = 1 * 1024 * 1024"), "Debug log cap must stay <= 1MB.");
assert.ok(xiaomiTokenPlanSource.includes("TOKEN_PLAN_CACHE_MS = 15 * 1000"), "Xiaomi platform quota should refresh on the normal HUD cadence.");
assert.ok(xiaomiTokenPlanSource.includes("TOKEN_PLAN_STALE_MS = 45 * 1000"), "Xiaomi platform quota should not look live for minutes after it goes stale.");
assert.ok(xiaomiTokenPlanSource.includes("fingerprintCookie"), "Xiaomi cookie changes must bypass the refresh interval.");

assert.ok(!hermesOverlayInstaller.includes("setInterval("), "Hermes overlay installer must not inject setInterval.");
assert.ok(!browserContentScript.includes("setInterval("), "Browser content script must not use setInterval.");
assert.ok(!browserServiceWorker.includes("setInterval("), "Browser service worker must not use setInterval.");
assert.ok(!quotaDelightSource.includes("setInterval("), "Quota delight state must be pure and event-driven.");
assert.ok(!statusSource.includes("setInterval("), "Status command must be one-shot and not poll.");
assert.ok(!stabilitySource.includes("setInterval("), "Stability command must be one-shot and not poll.");
assert.ok(!diagnosticsSource.includes("setInterval("), "Diagnostics command must be one-shot and not poll.");
assert.ok(!lagTriageSource.includes("setInterval("), "Lag triage command must be one-shot and not poll.");
assert.ok(!supportBundleSource.includes("setInterval("), "Support bundle command must be one-shot and not poll.");
assert.ok(!delightContractSource.includes("setInterval("), "Delight contract command must be one-shot and not poll.");
assert.ok(!adapterFixtureSource.includes("setInterval("), "Adapter fixture command must be one-shot and not poll.");
assert.ok(!diagnosticsBundleSource.includes("setInterval("), "Diagnostics bundle builder must be one-shot and not poll.");
assert.ok(!stabilityReportSource.includes("setInterval("), "Stability report builder must be pure and not poll.");
assert.ok(!importUsageReportSource.includes("setInterval("), "External summary importer must be one-shot and not poll.");
assert.ok(stylesSource.includes("prefers-reduced-motion"), "Renderer styles must respect reduced-motion preferences.");
assert.ok(!settingsSource.includes("hermesOverlayAutoInstall: true"), "Hermes overlay auto-install must not default to true.");
assert.ok(fs.existsSync(path.join(root, "docs", "performance-budget.md")), "Performance budget doc is required.");

console.log("Performance budget checks passed.");

function assertNumericConstant(source, name, min, max) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  assert.ok(match, `Missing numeric constant: ${name}`);
  const value = Number(match[1]);
  assert.ok(value >= min, `${name} must be >= ${min}.`);
  assert.ok(value <= max, `${name} must be <= ${max}.`);
}

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing function: ${signature}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `Missing function body: ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`Unterminated function body: ${signature}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
