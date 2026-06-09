"use strict";

/**
 * Tool registry state machine — pure logic with DI for testability.
 *
 * Usage in production (main.cjs):
 *   const { createToolRegistryStateMachine } = require("./system/tool-registry.cjs");
 *   const sm = createToolRegistryStateMachine({
 *     clock: () => Date.now(),
 *     getTrackedIds: () => settings.tools.tracked,
 *     getOverlayMode: () => latestOverlayDecision?.mode,
 *     getRefreshMs: () => settings.behavior.refreshMs,
 *     isWorkBuddyVisible: () => /* check hud payload *\/,
 *     broadcast: (data) => safeSend(win, "tool-registry:update", data)
 *   });
 *
 * Usage in tests:
 *   const sm = createToolRegistryStateMachine({ clock: () => mockNow, ... });
 */

const TOOL_REGISTRY_IDLE_THRESHOLD_MS = 10 * 60 * 1000;       // 10min
const TOOL_REGISTRY_OFFLINE_THRESHOLD_MS = 60 * 60 * 1000;    // 1h
const TOOL_REGISTRY_DELETE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const TOOL_HUD_STEADY_REFRESH_MS = 5 * 60 * 1000;             // 5min
const WORKBUDDY_HUD_SNAPSHOT_REFRESH_MS = 2000;                // 2s
const TOOL_PROCESS_SCAN_MS = 30_000;                           // 30s

function createToolRegistryStateMachine(deps) {
  const {
    clock = Date.now,
    getTrackedIds,
    getOverlayMode,
    getRefreshMs,
    isWorkBuddyVisible,
    broadcast
  } = deps;

  const registry = new Map();
  let lastBroadcast = null;
  let scanTimer = null;

  function isToolTracked(id) {
    const tracked = getTrackedIds();
    return Array.isArray(tracked) && tracked.includes(id);
  }

  function updateToolRegistry(decision) {
    const tool = decision?.toolContext?.tool;
    if (!tool || !isToolTracked(tool.id)) return;
    const now = clock();
    registry.set(tool.id, {
      id: tool.id,
      name: tool.name,
      providerIds: tool.providerIds,
      status: "online-foreground",
      lastSeenAt: now
    });
    for (const [id, entry] of registry) {
      if (id !== tool.id && entry.status === "online-foreground") {
        entry.status = "online-background";
      }
    }
    broadcastState();
  }

  function scanTrackedToolProcesses() {
    const now = clock();
    let changed = false;
    for (const [id, entry] of registry) {
      if (entry.status === "online-foreground") continue;
      const elapsed = now - entry.lastSeenAt;
      if (entry.status === "online-background") {
        if (elapsed > TOOL_REGISTRY_IDLE_THRESHOLD_MS) {
          entry.status = "idle";
          changed = true;
        }
      } else if (entry.status === "idle") {
        if (elapsed > TOOL_REGISTRY_OFFLINE_THRESHOLD_MS) {
          entry.status = "offline";
          changed = true;
        }
      } else if (entry.status === "offline") {
        if (elapsed > TOOL_REGISTRY_DELETE_THRESHOLD_MS) {
          registry.delete(id);
          changed = true;
        }
      }
    }
    if (changed) broadcastState();
  }

  function seedTrackedTools(available) {
    const now = clock();
    for (const tool of available) {
      if (!isToolTracked(tool.id)) continue;
      if (registry.has(tool.id)) continue;
      if (tool.available) {
        registry.set(tool.id, {
          id: tool.id,
          name: tool.name,
          providerIds: tool.providerIds,
          status: "online-background",
          lastSeenAt: now
        });
      }
    }
    broadcastState();
  }

  function cleanupUntrackedTools() {
    let changed = false;
    for (const [id] of registry) {
      if (!isToolTracked(id)) {
        registry.delete(id);
        changed = true;
      }
    }
    if (changed) {
      broadcastState();
      if (registry.size === 0) stopScan();
    }
  }

  function broadcastState() {
    if (!broadcast) return;
    const data = Array.from(registry.values());
    const json = JSON.stringify(data);
    if (json === lastBroadcast) return;
    lastBroadcast = json;
    broadcast(data);
  }

  function scheduleScan() {
    if (scanTimer) return;
    if (registry.size === 0) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanTrackedToolProcesses();
      scheduleScan();
    }, TOOL_PROCESS_SCAN_MS);
    scanTimer.unref?.();
  }

  function stopScan() {
    if (!scanTimer) return;
    clearTimeout(scanTimer);
    scanTimer = null;
  }

  /**
   * Returns snapshot refresh delay based on current overlay mode.
   *
   * Real semantics from main.cjs:1943-1952:
   *   - "desktop-topbar" → settings.behavior.refreshMs
   *   - "tool-hud" + isWorkBuddyVisible → WORKBUDDY_HUD_SNAPSHOT_REFRESH_MS (2s)
   *   - "tool-hud" (non-workbuddy) → TOOL_HUD_STEADY_REFRESH_MS (5min)
   *   - anything else / hidden → -1 (no refresh)
   */
  function getSnapshotRefreshDelayMs() {
    const mode = getOverlayMode ? getOverlayMode() : null;
    if (mode === "desktop-topbar") {
      return getRefreshMs ? getRefreshMs() : 15_000;
    }
    if (mode === "tool-hud") {
      if (isWorkBuddyVisible && isWorkBuddyVisible()) {
        return WORKBUDDY_HUD_SNAPSHOT_REFRESH_MS;
      }
      return TOOL_HUD_STEADY_REFRESH_MS;
    }
    return -1;
  }

  return {
    registry,
    updateToolRegistry,
    scanTrackedToolProcesses,
    seedTrackedTools,
    cleanupUntrackedTools,
    getSnapshotRefreshDelayMs,
    broadcastState,
    scheduleScan,
    stopScan,
    // Expose constants for test assertions
    TOOL_REGISTRY_IDLE_THRESHOLD_MS,
    TOOL_REGISTRY_OFFLINE_THRESHOLD_MS,
    TOOL_REGISTRY_DELETE_THRESHOLD_MS,
    TOOL_HUD_STEADY_REFRESH_MS,
    WORKBUDDY_HUD_SNAPSHOT_REFRESH_MS,
    TOOL_PROCESS_SCAN_MS
  };
}

module.exports = { createToolRegistryStateMachine };
