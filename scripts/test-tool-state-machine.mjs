/**
 * Tool registry state machine tests — requires the REAL production module.
 *
 * All 8 acceptance scenarios verified against src/system/tool-registry.cjs
 * with mock clock and mock dependencies. No hand-rewritten copies.
 *
 * Run: node scripts/test-tool-state-machine.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(path.join(__dirname, "..", "src", "system", "tool-registry.cjs"));

// Require the REAL production module
const { createToolRegistryStateMachine } = require("./tool-registry.cjs");

// ── Mock clock ─────────────────────────────────────────────────────

let mockNow = 1000000;

function advanceClock(ms) {
  mockNow += ms;
}

function resetClock() {
  mockNow = 1000000;
}

// ── Test helpers ───────────────────────────────────────────────────

function createTestSM(opts = {}) {
  const tracked = opts.tracked || ["vscode", "cursor"];
  let overlayMode = opts.overlayMode || null;
  let refreshMs = opts.refreshMs || 15000;
  let workBuddyVisible = opts.workBuddyVisible || false;
  const broadcasts = [];

  const sm = createToolRegistryStateMachine({
    clock: () => mockNow,
    getTrackedIds: () => tracked,
    getOverlayMode: () => overlayMode,
    getRefreshMs: () => refreshMs,
    isWorkBuddyVisible: () => workBuddyVisible,
    broadcast: (data) => broadcasts.push(data)
  });

  return {
    sm,
    tracked,
    broadcasts,
    setOverlayMode: (m) => { overlayMode = m; },
    setRefreshMs: (ms) => { refreshMs = ms; },
    setWorkBuddyVisible: (v) => { workBuddyVisible = v; }
  };
}

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    resetClock();
    fn();
    console.log(`  ✅ ${name}`);
    passCount++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failCount++;
  }
}

// ── S1: Checkbox tracking (seed + cleanup) ─────────────────────────

console.log("\n─── S1: Checkbox tracking ───");

test("seedTrackedTools adds tracked available tools to registry", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.seedTrackedTools([
    { id: "vscode", name: "VS Code", available: true },
    { id: "cursor", name: "Cursor", available: true }
  ]);
  assert.equal(sm.registry.size, 1);
  assert.ok(sm.registry.has("vscode"));
  assert.equal(sm.registry.get("vscode").status, "online-background");
});

test("untracked tool ignored by updateToolRegistry", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.updateToolRegistry({
    toolContext: { tool: { id: "cursor", name: "Cursor" } }
  });
  assert.equal(sm.registry.size, 0);
});

test("cleanupUntrackedTools removes tools no longer tracked", () => {
  const tracked = ["vscode", "cursor"];
  const { sm } = createTestSM({ tracked });
  sm.seedTrackedTools([
    { id: "vscode", name: "VS Code", available: true },
    { id: "cursor", name: "Cursor", available: true }
  ]);
  assert.equal(sm.registry.size, 2);

  // Remove cursor from tracked list
  tracked.length = 0;
  tracked.push("vscode");
  sm.cleanupUntrackedTools();

  assert.equal(sm.registry.size, 1);
  assert.ok(sm.registry.has("vscode"));
  assert.ok(!sm.registry.has("cursor"));
});

// ── S2: Foreground switch demotion ─────────────────────────────────

console.log("\n─── S2: Foreground switch ───");

test("foreground switch demotes old tool to background", () => {
  const { sm } = createTestSM({ tracked: ["vscode", "cursor"] });
  sm.updateToolRegistry({
    toolContext: { tool: { id: "vscode", name: "VS Code" } }
  });
  assert.equal(sm.registry.get("vscode").status, "online-foreground");

  sm.updateToolRegistry({
    toolContext: { tool: { id: "cursor", name: "Cursor" } }
  });
  assert.equal(sm.registry.get("cursor").status, "online-foreground");
  assert.equal(sm.registry.get("vscode").status, "online-background");
});

test("multiple switches maintain correct states", () => {
  const { sm } = createTestSM({ tracked: ["vscode", "cursor", "claude"] });
  sm.updateToolRegistry({ toolContext: { tool: { id: "vscode" } } });
  sm.updateToolRegistry({ toolContext: { tool: { id: "cursor" } } });
  sm.updateToolRegistry({ toolContext: { tool: { id: "claude" } } });
  assert.equal(sm.registry.get("claude").status, "online-foreground");
  assert.equal(sm.registry.get("cursor").status, "online-background");
  assert.equal(sm.registry.get("vscode").status, "online-background");
});

// ── S3: 10min idle threshold ───────────────────────────────────────

console.log("\n─── S3: 10min idle threshold ───");

const IDLE = 10 * 60 * 1000;

test("online-background → idle after 10min", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.seedTrackedTools([{ id: "vscode", name: "VS Code", available: true }]);
  assert.equal(sm.registry.get("vscode").status, "online-background");

  advanceClock(IDLE + 1);
  sm.scanTrackedToolProcesses();
  assert.equal(sm.registry.get("vscode").status, "idle");
});

test("online-background stays background before 10min", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.seedTrackedTools([{ id: "vscode", name: "VS Code", available: true }]);

  advanceClock(IDLE - 1000);
  sm.scanTrackedToolProcesses();
  assert.equal(sm.registry.get("vscode").status, "online-background");
});

test("foreground tool is NOT affected by idle scan", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.updateToolRegistry({ toolContext: { tool: { id: "vscode" } } });

  advanceClock(IDLE + 1);
  sm.scanTrackedToolProcesses();
  assert.equal(sm.registry.get("vscode").status, "online-foreground");
});

// ── S4: 1h offline + 24h delete ────────────────────────────────────

console.log("\n─── S4: offline + delete thresholds ───");

const OFFLINE = 60 * 60 * 1000;
const DELETE = 24 * 60 * 60 * 1000;

test("idle → offline after 1h (from lastSeenAt)", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.seedTrackedTools([{ id: "vscode", name: "VS Code", available: true }]);

  // Go to idle
  advanceClock(IDLE + 1);
  sm.scanTrackedToolProcesses();
  assert.equal(sm.registry.get("vscode").status, "idle");

  // Go to offline (1h from lastSeenAt, not from idle transition)
  advanceClock(OFFLINE - IDLE + 1);
  sm.scanTrackedToolProcesses();
  assert.equal(sm.registry.get("vscode").status, "offline");
});

test("offline → deleted after 24h", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.seedTrackedTools([{ id: "vscode", name: "VS Code", available: true }]);

  // Need 3 scans: online-background → idle → offline → delete
  advanceClock(IDLE + 1);
  sm.scanTrackedToolProcesses(); // → idle
  assert.equal(sm.registry.get("vscode").status, "idle");

  advanceClock(OFFLINE - IDLE + 1);
  sm.scanTrackedToolProcesses(); // → offline
  assert.equal(sm.registry.get("vscode").status, "offline");

  advanceClock(DELETE - OFFLINE + 1);
  sm.scanTrackedToolProcesses(); // → delete
  assert.equal(sm.registry.size, 0);
});

test("offline has 23h visible window before delete", () => {
  const { sm } = createTestSM({ tracked: ["vscode"] });
  sm.seedTrackedTools([{ id: "vscode", name: "VS Code", available: true }]);

  // Reach offline state (need 2 scans: idle → offline)
  advanceClock(IDLE + 1);
  sm.scanTrackedToolProcesses(); // → idle
  advanceClock(OFFLINE - IDLE + 1);
  sm.scanTrackedToolProcesses(); // → offline
  assert.equal(sm.registry.get("vscode").status, "offline");

  // Still offline after 23h more (not yet at DELETE threshold from lastSeenAt)
  const entry = sm.registry.get("vscode");
  const timeToDelete = DELETE - (mockNow - entry.lastSeenAt);
  advanceClock(timeToDelete - 2000); // 2s before delete
  sm.scanTrackedToolProcesses();
  assert.equal(sm.registry.get("vscode").status, "offline");
  assert.equal(sm.registry.size, 1);
});

// ── S5: Desktop snapshot refresh = settings.refreshMs ──────────────

console.log("\n─── S5: Desktop refresh delay ───");

test("desktop-topbar mode returns settings.behavior.refreshMs", () => {
  const { sm, setRefreshMs } = createTestSM({ overlayMode: "desktop-topbar", refreshMs: 15000 });
  assert.equal(sm.getSnapshotRefreshDelayMs(), 15000);

  setRefreshMs(20000);
  assert.equal(sm.getSnapshotRefreshDelayMs(), 20000);
});

// ── S6: Tool HUD = 5min steady ─────────────────────────────────────

console.log("\n─── S6: Tool HUD refresh delay ───");

test("tool-hud mode returns TOOL_HUD_STEADY_REFRESH_MS (5min)", () => {
  const { sm } = createTestSM({ overlayMode: "tool-hud" });
  assert.equal(sm.getSnapshotRefreshDelayMs(), 5 * 60 * 1000);
});

// ── S7: WorkBuddy HUD = 2s ────────────────────────────────────────

console.log("\n─── S7: WorkBuddy HUD refresh delay ───");

test("tool-hud + WorkBuddy visible returns WORKBUDDY_HUD_SNAPSHOT_REFRESH_MS (2s)", () => {
  const { sm } = createTestSM({ overlayMode: "tool-hud", workBuddyVisible: true });
  assert.equal(sm.getSnapshotRefreshDelayMs(), 2000);
});

test("tool-hud + WorkBuddy not visible returns 5min", () => {
  const { sm } = createTestSM({ overlayMode: "tool-hud", workBuddyVisible: false });
  assert.equal(sm.getSnapshotRefreshDelayMs(), 5 * 60 * 1000);
});

// ── S8: Hidden mode sentinel -1 ────────────────────────────────────

console.log("\n─── S8: Hidden mode sentinel ───");

test("unknown/null mode returns -1 (no refresh)", () => {
  const { sm } = createTestSM({ overlayMode: null });
  assert.equal(sm.getSnapshotRefreshDelayMs(), -1);
});

test("random mode returns -1", () => {
  const { sm } = createTestSM({ overlayMode: "something-else" });
  assert.equal(sm.getSnapshotRefreshDelayMs(), -1);
});

// ── Additional: broadcast diff guard ───────────────────────────────

console.log("\n─── Extra: broadcast + timer guards ───");

test("broadcast: no-op if registry unchanged", () => {
  const { sm, broadcasts } = createTestSM({ tracked: ["vscode"] });
  sm.seedTrackedTools([{ id: "vscode", name: "VS Code", available: true }]);
  const countBefore = broadcasts.length;
  sm.broadcastState(); // same data
  assert.equal(broadcasts.length, countBefore); // no new broadcast
});

test("broadcast: fires when status actually changes", () => {
  const { sm, broadcasts } = createTestSM({ tracked: ["vscode", "cursor"] });
  // Set vscode to foreground
  sm.updateToolRegistry({ toolContext: { tool: { id: "vscode" } } });
  // Demote to background by switching to cursor
  sm.updateToolRegistry({ toolContext: { tool: { id: "cursor" } } });
  const countAfterSetup = broadcasts.length;

  // Now advance past idle threshold
  advanceClock(IDLE + 1);
  sm.scanTrackedToolProcesses(); // vscode should go idle
  assert.ok(broadcasts.length > countAfterSetup);
});

test("scheduleScan: returns early when registry is empty", () => {
  const { sm } = createTestSM();
  // Should not throw, should be a no-op
  sm.scheduleScan();
  sm.stopScan();
});

// ── Summary ────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════");
console.log(`Tool State Machine Tests: ${passCount} passed, ${failCount} failed`);
console.log("═══════════════════════════════════════════════");

if (failCount > 0) {
  console.log("\n❌ Some tests failed");
  process.exit(1);
} else {
  console.log("\n✅ All 8 acceptance scenarios verified against REAL tool-registry.cjs");
}
