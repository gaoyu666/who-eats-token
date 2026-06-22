const { app, BrowserWindow, ipcMain, screen, Notification, Tray, Menu, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { collectCodexUsage } = require("./collectors/codex.cjs");
const { collectHermesUsage } = require("./collectors/hermes-local.cjs");
const { getProviderRegistry } = require("./config/providers.cjs");
const { loadSettings, saveSettings, sanitizeSettings } = require("./config/settings.cjs");
const { scanAvailableTools } = require("./system/tool-scanner.cjs");
const { createToolRegistryStateMachine } = require("./system/tool-registry.cjs");
const { ensureHermesOverlayInstalled } = require("./integrations/hermes-overlay-installer.cjs");
const {
  boundsOverlap,
  clampNumber,
  getWindowArea,
  normalizeBounds
} = require("./main/geometry-service.cjs");
const {
  buildHudDebugEntry,
  buildHudPayload,
  findProvider,
  formatResetForNotification,
  getWindowRemaining,
  numberOrNull,
  numberOrZero,
  roundedNumberOrNull,
  summarizeHudPayload,
  summarizeHudTool,
  summarizeHudWindow,
  summarizeProviders
} = require("./main/hud-payload.cjs");
const {
  DEFAULT_BAR_HEIGHT,
  DEFAULT_HUD_WIDTH,
  DEFAULT_HUD_HEIGHT,
  TOOL_HUD_HITBOX_WIDTH,
  TOOL_HUD_HITBOX_HEIGHT,
  WINDOW_BOUNDS_JITTER_TOLERANCE_PX,
  boundsCloseEnough,
  getDesktopBarHeight,
  getDesktopBarStagePadding,
  getDesktopBarStageLayout,
  getDesktopBarWindowBounds,
  getDesktopBarVisualBounds,
  getDesktopBarRendererLayout,
  getHudBottomOffset,
  getHudBounds,
  getHudPosition,
  getHudTargetArea,
  getToolHudOffset,
  getToolHudSize,
  hudAnchorBoundsCloseEnough,
  scaleBounds,
  scaledHudAnchorBoundsCloseEnough
} = require("./main/overlay-layout.cjs");
const {
  guardBooleanPayload,
  guardHudTrustPopoverPayload,
  guardHudTrustPopoverSize,
  guardSettingsPayload
} = require("./main/ipc-guards.cjs");
const {
  closeServer,
  restartHermesBridge: restartHermesBridgeServer,
  restartIngestServer: restartIngestLocalServer
} = require("./main/server-manager.cjs");
const { createOverlayController, SURFACES } = require("./main/overlay-controller.cjs");
const { createSnapshotService } = require("./main/snapshot-service.cjs");
const { safeSend } = require("./main/window-safe-send.cjs");
const { getLocalApiAccess } = require("./security/local-token.cjs");
const { getActiveWindow, isDesktopForegroundWindow } = require("./system/active-window.cjs");
const { collectSystemMetrics } = require("./system/system-metrics.cjs");
const { detectTool, isDialogWindow } = require("./system/tool-detector.cjs");
const { createToolDetection } = require("./main/tool-detection.cjs");
const { createDisplayAdapter } = require("./main/display-adapter.cjs");

// ── display-adapter (sole screen.* boundary) ────────────────────────
const {
  getPrimaryDisplay,
  getMatchingDisplay,
  getDisplayBounds,
  isDisplayFillingBounds,
  getDisplayForActiveWindow
} = createDisplayAdapter({ screen });

const {
  addWindowCandidate,
  doesWindowOverlapDesktopBar,
  getDetectedToolContext,
  getForegroundToolContext,
  getHudAnchorWindow,
  getToolDetectionBlockers,
  getToolDetectionCandidates,
  hasDesktopForegroundBlocker,
  isDesktopForeground,
  isDesktopOverlayForeground,
  isDesktopShellTransientForeground,
  isForegroundFullscreen,
  isForegroundSamplingNoise,
  isPotentialDialogParentWindow,
  isShellForegroundWindow,
  isZeroSizedExplorerForeground,
  normalizeToolDesktopWakeProbeWindow,
  shouldInspectDesktopBlockersForToolDetection,
  shouldShowDesktopBar
} = createToolDetection({
  detectTool,
  getToolHudSize: () => getToolHudSize(settings),
  isDesktopForegroundWindow,
  isDialogWindow,
  getDisplayBounds,
  getDesktopBarVisualBounds: () => getDesktopBarVisualBounds(settings, getPrimaryDisplay()),
  isOwnDesktopBar
});

function registerDisplayChangeListeners() {
  screen.on('display-added', () => refreshOverlayCoordinator());
  screen.on('display-removed', () => refreshOverlayCoordinator());
  screen.on('display-metrics-changed', () => refreshOverlayCoordinator());
}

if (process.env.WHO_EATS_TOKEN_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

const HUD_TRUST_POPOVER_WIDTH = 440;
const HUD_TRUST_POPOVER_MIN_HEIGHT = 336;
const HUD_TRUST_POPOVER_MAX_HEIGHT = 480;
const SYSTEM_REFRESH_MS = 2000;
const OVERLAY_COORDINATOR_REFRESH_MS = 200;
const OVERLAY_COORDINATOR_ACTIVE_REFRESH_MS = 50;
const OVERLAY_DEFERRED_RETRY_MS = 75;
const OVERLAY_DEFERRED_RETRY_MAX_MS = 600;
const OVERLAY_ACTIVE_WINDOW_TIMEOUT_MS = 1000;
const TOOL_DESKTOP_WAKE_MS = 75;
const TOOL_DESKTOP_WAKE_TIMEOUT_MS = 300;
const TOOL_DESKTOP_WAKE_PROBE_INTERVAL_MS = 50;
const TOOL_TRANSITION_SNAPSHOT_DELAY_MS = OVERLAY_COORDINATOR_REFRESH_MS;
const HIDDEN_SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;
const ACTIVE_TOOL_TTL_MS = 10 * 60 * 1000;
const HUD_DEBUG_LOG_MAX_BYTES = 1 * 1024 * 1024;
const CODEX_SESSION_WATCH_DEBOUNCE_MS = 750;
const SETTINGS_WIDTH = 420;
const SETTINGS_HEIGHT = 560;
const TREND_WINDOW_MS = 15 * 60 * 1000;
const TREND_MIN_SAMPLE_MS = 2 * 60 * 1000;
const INGEST_PORT = readPortEnv("WHO_EATS_TOKEN_INGEST_PORT", 17667);
const HERMES_BRIDGE_PORT = readPortEnv("WHO_EATS_TOKEN_HERMES_BRIDGE_PORT", 17668);
const GUIDE_DOCUMENTS = {
  user: "docs/getting-started.md",
  agent: "docs/agent-getting-started.md"
};
const TOOL_DESKTOP_WAKE_PROBE_PS1 = path.join(__dirname, "main", "wake-probe.ps1");

let desktopBarWindow;
let toolHudWindow;
let toolHudHitboxWindow;
let hudTrustPopoverWindow;
let settingsWindow;
let settingsOverlayOwner = null;
let settingsPreservedOverlayDecision = null;
let tray;
let ingestServer;
let hermesBridgeServer;
let localApiAccess = null;
let latestSnapshot = null;
let latestSystemMetrics = null;
let latestHudPayload = { visible: false };
let latestHudTrustPopoverPayload = null;
let latestHudTrustPopoverOwner = null;
let latestHudTrustPopoverSourceWindow = null;
let latestHudTrustPopoverSize = {
  width: HUD_TRUST_POPOVER_WIDTH,
  height: HUD_TRUST_POPOVER_MIN_HEIGHT
};
let latestActiveTool = null;
let latestActiveToolAt = 0;
let latestActiveToolWindow = null;
let lastVisibleHudPayload = null;
let lastVisibleHudBounds = null;
let lastVisibleHudAt = 0;
let warmToolHudPayload = null;
let warmToolHudBounds = null;
let warmToolHudAt = 0;
let latestOverlayDecision = { mode: "hidden", reason: "startup" };
let latestOverlayDecisionVersion = 0;
let overlaySampleSequence = 0;
const overlayController = createOverlayController({
  noiseGraceMs: 500,
  confirmedLatencyMs: 400
});
let snapshotInFlight = false;
let hudRefreshInFlight = false;
let overlayCoordinatorInFlight = false;
let overlayCoordinatorPriorityInFlight = false;
let overlayCoordinatorPending = false;
let overlayCoordinatorGeneration = 0;
let hudDebugSequence = 0;
let capacityAlertKeys = new Set();
let capacityHistory = new Map();
let settings = sanitizeSettings();
let snapshotTimer = null;
let desktopBarTimer = null;
let toolDecisionSnapshotTimer = null;
let overlayDeferredRetryTimer = null;
let overlayDeferredRetryDelayMs = OVERLAY_DEFERRED_RETRY_MS;
let toolDesktopWakeTimer = null;
let toolDesktopWakeInFlight = false;
let toolDesktopWakeProbeProcess = null;
let toolDesktopWakeProbeBuffer = "";
let systemTimer = null;
let codexSessionWatcher = null;
let codexSessionWatchTimer = null;
let isQuitting = false;
let desktopBarMouseInteractive = null;
let toolHudHitboxMouseInteractive = null;

function isWorkBuddyToolHudVisible() {
  return latestHudPayload?.visible && latestHudPayload.tool?.id === "workbuddy";
}

const toolSM = createToolRegistryStateMachine({
  clock: () => Date.now(),
  getTrackedIds: () => settings.tools.tracked,
  getOverlayMode: () => latestOverlayDecision?.mode,
  getRefreshMs: () => settings.behavior.refreshMs,
  isWorkBuddyVisible: isWorkBuddyToolHudVisible,
  broadcast: (data) => safeSend(desktopBarWindow, "tool-registry:update", data)
});
const toolRegistry = toolSM.registry;

const snapshotService = createSnapshotService({
  collectCodexUsage,
  collectHermesUsage,
  getIngestServer: () => ingestServer,
  getHermesBridgeServer: () => hermesBridgeServer,
  getSystemMetrics: () => latestSystemMetrics || refreshSystemMetrics(),
  getPublicSettings,
  isProviderEnabled,
  annotateCapacityTrends,
  summarizeProviders
});

applyUserDataOverride();
const gotSingleInstanceLock = app.requestSingleInstanceLock();

app.setName("谁在吃 token");
if (process.platform === "win32") {
  app.setAppUserModelId("local.who-eats-token");
}

if (!gotSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return;
  refreshDesktopBarFromForeground();
});

function createDesktopBarWindow() {
  const bounds = getDesktopBarWindowBounds(settings, getPrimaryDisplay());

  desktopBarWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    show: false,
    focusable: false,
    transparent: true,
    title: "谁在吃 token",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  desktopBarWindow.setFocusable(false);
  desktopBarMouseInteractive = null;
  setDesktopBarMouseRegion(false);
  desktopBarWindow.on("focus", () => {
    desktopBarWindow?.blur();
  });
  desktopBarWindow.on("show", () => {
    desktopBarWindow?.setFocusable(false);
  });
  desktopBarWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  desktopBarWindow.once("ready-to-show", () => {
    safeSend(desktopBarWindow, "settings:update", getPublicSettings());
    sendSnapshot();
    sendSystemMetrics();
    refreshDesktopBarFromForeground();
  });
}

function resizeDesktopBar(sourceSettings = settings) {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return;
  setWindowBoundsIfChanged(desktopBarWindow, getDesktopBarWindowBounds(sourceSettings, getPrimaryDisplay()));
  setDesktopBarMouseRegion(false);
}

function setDesktopBarMouseRegion(interactive) {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return false;
  const nextInteractive = Boolean(interactive);
  if (desktopBarMouseInteractive === nextInteractive) return true;
  desktopBarMouseInteractive = nextInteractive;
  desktopBarWindow.setIgnoreMouseEvents(!nextInteractive, { forward: true });
  return true;
}

function setToolHudMouseRegion(interactive) {
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return false;
  toolHudWindow.setIgnoreMouseEvents(true, { forward: true });
  return true;
}

function setToolHudHitboxMouseRegion(interactive) {
  if (!toolHudHitboxWindow || toolHudHitboxWindow.isDestroyed()) return false;
  const nextInteractive = Boolean(interactive);
  if (toolHudHitboxMouseInteractive === nextInteractive) return true;
  toolHudHitboxMouseInteractive = nextInteractive;
  reinforceNonActivatingWindow(toolHudHitboxWindow); // Pre-reinforce before Electron may reset WS_EX flags
  toolHudHitboxWindow.setIgnoreMouseEvents(!nextInteractive, { forward: true });
  reinforceNonActivatingWindow(toolHudHitboxWindow); // Post-reinforce to restore non-activating state
  return true;
}

function resizeToolHud(sourceSettings = settings, previousSettings = settings) {
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return;
  const current = toolHudWindow.getBounds();
  if (latestHudPayload?.visible && latestHudPayload.activeWindow) {
    const display = getDisplayForActiveWindow(latestHudPayload.activeWindow);
    const bounds = getHudBounds(display, latestHudPayload.tool, latestHudPayload.activeWindow, sourceSettings);
    setWindowBoundsIfChanged(toolHudWindow, bounds);
    showToolHudHitbox(bounds);
    lastVisibleHudBounds = bounds;
    return;
  }
  const size = getToolHudSize(sourceSettings);
  const previousOffset = getToolHudOffset(previousSettings);
  const nextOffset = getToolHudOffset(sourceSettings);
  const deltaX = nextOffset.x - previousOffset.x;
  const deltaY = nextOffset.y - previousOffset.y;
  const display = getMatchingDisplay(current);
  const rightGap = 12;
  const bottomGap = 12;
  const bounds = {
    x: clampNumber(current.x + current.width - size.width - deltaX, display.workArea.x + 12, display.workArea.x + display.workArea.width - size.width - rightGap),
    y: clampNumber(current.y + current.height - size.height - deltaY, display.workArea.y + 12, display.workArea.y + display.workArea.height - size.height - bottomGap),
    width: size.width,
    height: size.height
  };
  setWindowBoundsIfChanged(toolHudWindow, bounds);
  if (latestHudPayload?.visible) showToolHudHitbox(bounds);
  if (lastVisibleHudBounds) {
    lastVisibleHudBounds = bounds;
  }
}



function setWindowBoundsIfChanged(window, bounds) {
  if (!window || window.isDestroyed()) return;
  const current = window.getBounds();
  if (boundsCloseEnough(current, bounds)) return;
  window.setBounds(bounds);
}

function createToolHudWindow() {
  const primary = getPrimaryDisplay();
  const { x, y } = getHudPosition(primary, null, null, settings);
  const size = getToolHudSize(settings);

  toolHudWindow = new BrowserWindow({
    x,
    y,
    width: size.width,
    height: size.height,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  toolHudWindow.setAlwaysOnTop(true, "floating");
  toolHudWindow.setFocusable(false);
  setToolHudMouseRegion(false);
  toolHudWindow.on("focus", () => {
    toolHudWindow?.blur();
  });
  toolHudWindow.on("show", () => {
    toolHudWindow?.setFocusable(false);
    setToolHudMouseRegion(false);
  });
  toolHudWindow.loadFile(path.join(__dirname, "renderer", "hud.html"));
  toolHudWindow.webContents.once("did-finish-load", () => {
    safeSend(toolHudWindow, "settings:update", getPublicSettings());
    safeSend(toolHudWindow, "hud:update", latestHudPayload);
  });
  createToolHudHitboxWindow();
}

function createToolHudHitboxWindow() {
  if (toolHudHitboxWindow && !toolHudHitboxWindow.isDestroyed()) return;

  toolHudHitboxWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: TOOL_HUD_HITBOX_WIDTH,
    height: TOOL_HUD_HITBOX_HEIGHT,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    title: "LLM HUD Controls",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  toolHudHitboxWindow.setAlwaysOnTop(true, "floating");
  toolHudHitboxWindow.setFocusable(false);
  toolHudHitboxMouseInteractive = null;
  setToolHudHitboxMouseRegion(false);
  toolHudHitboxWindow.on("focus", () => {
    toolHudHitboxWindow?.blur();
  });
  toolHudHitboxWindow.on("show", () => {
    toolHudHitboxWindow?.setFocusable(false);
    setToolHudHitboxMouseRegion(false);
  });
  toolHudHitboxWindow.on("closed", () => {
    toolHudHitboxMouseInteractive = null;
    toolHudHitboxWindow = null;
  });
  toolHudHitboxWindow.loadFile(path.join(__dirname, "renderer", "hud-hitbox.html"));
  toolHudHitboxWindow.webContents.once("did-finish-load", () => {
    safeSend(toolHudHitboxWindow, "settings:update", getPublicSettings());
    safeSend(toolHudHitboxWindow, "hud:update", latestHudPayload);
  });
}

function createHudTrustPopoverWindow() {
  if (hudTrustPopoverWindow && !hudTrustPopoverWindow.isDestroyed()) return;

  hudTrustPopoverWindow = new BrowserWindow({
    width: HUD_TRUST_POPOVER_WIDTH,
    height: HUD_TRUST_POPOVER_MIN_HEIGHT,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  hudTrustPopoverWindow.setAlwaysOnTop(true, "floating");
  hudTrustPopoverWindow.setFocusable(false);
  hudTrustPopoverWindow.setIgnoreMouseEvents(true, { forward: true });
  hudTrustPopoverWindow.on("focus", () => {
    hudTrustPopoverWindow?.blur();
  });
  hudTrustPopoverWindow.on("closed", () => {
    hudTrustPopoverWindow = null;
  });
  hudTrustPopoverWindow.loadFile(path.join(__dirname, "renderer", "hud-trust-popover.html"));
  hudTrustPopoverWindow.webContents.once("did-finish-load", () => {
    safeSend(hudTrustPopoverWindow, "settings:update", getPublicSettings());
    if (latestHudTrustPopoverPayload) {
      safeSend(hudTrustPopoverWindow, "hud-trust-popover:update", latestHudTrustPopoverPayload.details || null);
    }
  });
}

function showHudTrustPopover(payload = {}, sourceWindow = null) {
  const anchorWindow = sourceWindow && !sourceWindow.isDestroyed()
    ? sourceWindow
    : toolHudWindow;
  if (!anchorWindow || anchorWindow.isDestroyed() || !anchorWindow.isVisible()) return false;
  latestHudTrustPopoverPayload = payload;
  latestHudTrustPopoverOwner = getHudTrustPopoverOwner(anchorWindow);
  latestHudTrustPopoverSourceWindow = anchorWindow;
  createHudTrustPopoverWindow();
  if (!hudTrustPopoverWindow || hudTrustPopoverWindow.isDestroyed()) return false;

  const bounds = getHudTrustPopoverBounds(payload.anchor || {}, anchorWindow, latestHudTrustPopoverSize);
  reinforceNonActivatingWindow(hudTrustPopoverWindow); // Pre-reinforce before bounds/content update
  setWindowBoundsIfChanged(hudTrustPopoverWindow, bounds);
  if (!hudTrustPopoverWindow.webContents.isLoading()) {
    safeSend(hudTrustPopoverWindow, "hud-trust-popover:update", payload.details || null);
  }
  if (!hudTrustPopoverWindow.isVisible()) {
    hudTrustPopoverWindow.showInactive();
  }
  reinforceNonActivatingWindow(hudTrustPopoverWindow); // Post-reinforce after showInactive may reset flags
  return true;
}

function hideHudTrustPopover(owner = null) {
  if (owner && latestHudTrustPopoverOwner && latestHudTrustPopoverOwner !== owner) return false;
  if (hudTrustPopoverWindow && !hudTrustPopoverWindow.isDestroyed() && hudTrustPopoverWindow.isVisible()) {
    hudTrustPopoverWindow.hide();
  }
  latestHudTrustPopoverOwner = null;
  latestHudTrustPopoverSourceWindow = null;
  return true;
}

function getHudTrustPopoverOwner(sourceWindow) {
  if (sourceWindow === desktopBarWindow) return "desktop";
  if (sourceWindow === toolHudWindow || sourceWindow === toolHudHitboxWindow) return "hud";
  return "other";
}

function resizeHudTrustPopover(size = {}) {
  if (!hudTrustPopoverWindow || hudTrustPopoverWindow.isDestroyed()) return false;
  const height = clampNumber(
    Math.ceil(Number(size.height) || HUD_TRUST_POPOVER_MIN_HEIGHT),
    HUD_TRUST_POPOVER_MIN_HEIGHT,
    HUD_TRUST_POPOVER_MAX_HEIGHT
  );
  latestHudTrustPopoverSize = {
    width: HUD_TRUST_POPOVER_WIDTH,
    height
  };
  const sourceWindow = latestHudTrustPopoverSourceWindow && !latestHudTrustPopoverSourceWindow.isDestroyed()
    ? latestHudTrustPopoverSourceWindow
    : null;
  if (sourceWindow && latestHudTrustPopoverPayload) {
    setWindowBoundsIfChanged(
      hudTrustPopoverWindow,
      getHudTrustPopoverBounds(latestHudTrustPopoverPayload.anchor || {}, sourceWindow, latestHudTrustPopoverSize)
    );
  } else {
    const current = hudTrustPopoverWindow.getBounds();
    setWindowBoundsIfChanged(hudTrustPopoverWindow, {
      ...current,
      width: latestHudTrustPopoverSize.width,
      height: latestHudTrustPopoverSize.height
    });
  }
  return true;
}

function getHudTrustPopoverBounds(anchor = {}, anchorWindow = toolHudWindow, size = latestHudTrustPopoverSize) {
  const sourceBounds = anchorWindow.getBounds();
  const display = getMatchingDisplay(sourceBounds);
  const workArea = display.workArea;
  const width = Number(size?.width) || HUD_TRUST_POPOVER_WIDTH;
  const height = Number(size?.height) || HUD_TRUST_POPOVER_MIN_HEIGHT;
  const anchorX = Number(anchor.x) || 0;
  const anchorY = Number(anchor.y) || 0;
  const anchorWidth = Number(anchor.width) || 0;
  const anchorHeight = Number(anchor.height) || 0;
  const anchorCenterX = sourceBounds.x + anchorX + anchorWidth / 2;
  const gap = 10;
  let x = Math.round(anchorCenterX - width / 2);
  let y = Math.round(sourceBounds.y + anchorY + anchorHeight + gap);

  if (y + height > workArea.y + workArea.height - 8) {
    y = Math.round(sourceBounds.y + anchorY - height - gap);
  }

  return {
    x: clampNumber(x, workArea.x + 8, workArea.x + workArea.width - width - 8),
    y: clampNumber(y, workArea.y + 8, workArea.y + workArea.height - height - 8),
    width,
    height
  };
}

function normalizeSettingsOverlayOwner(owner) {
  return ["desktop", "hud", "tray"].includes(owner) ? owner : "unknown";
}

function getSettingsOverlayOwnerFromWindow(sourceWindow) {
  if (!sourceWindow || sourceWindow.isDestroyed()) return "unknown";
  if (sourceWindow === desktopBarWindow) return "desktop";
  if (sourceWindow === toolHudWindow || sourceWindow === toolHudHitboxWindow || sourceWindow === hudTrustPopoverWindow) return "hud";
  return "unknown";
}

function rememberSettingsOverlayOwner(owner = "unknown") {
  settingsOverlayOwner = normalizeSettingsOverlayOwner(owner);
  if (latestOverlayDecision?.mode !== "settings-overlay") {
    settingsPreservedOverlayDecision = latestOverlayDecision;
  }
}

function clearSettingsOverlayOwner() {
  settingsOverlayOwner = null;
  settingsPreservedOverlayDecision = null;
}

function isSettingsWindowVisible() {
  return Boolean(settingsWindow && !settingsWindow.isDestroyed() && (settingsWindow.isVisible() || settingsOverlayOwner));
}

function openSettingsWindow(owner = "unknown") {
  rememberSettingsOverlayOwner(owner);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const primary = getPrimaryDisplay();
  const x = primary.workArea.x + Math.round((primary.workArea.width - SETTINGS_WIDTH) / 2);
  const y = primary.workArea.y + Math.round((primary.workArea.height - SETTINGS_HEIGHT) / 2);

  settingsWindow = new BrowserWindow({
    x,
    y,
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    transparent: true,
    title: "谁在吃 token 设置",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
    safeSend(settingsWindow, "settings:update", getPublicSettings());
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
    clearSettingsOverlayOwner();
    setTimeout(refreshOverlayCoordinator, 0);
  });
}

function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", () => openSettingsWindow("tray"));
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(getTrayTooltip());
  tray.setContextMenu(Menu.buildFromTemplate(getTrayMenuTemplate()));
}

function getTrayMenuTemplate() {
  return [
    {
      label: "谁在吃 token",
      enabled: false
    },
    {
      label: getTrayStatusLabel(),
      enabled: false
    },
    { type: "separator" },
    {
      label: "打开设置",
      click: () => openSettingsWindow("tray")
    },
    {
      label: "桌面顶部条",
      type: "checkbox",
      checked: settings.windows.desktopBarEnabled,
      click: (item) => updateSettings({
        ...settings,
        windows: {
          ...settings.windows,
          desktopBarEnabled: item.checked
        }
      })
    },
    {
      label: "工具内 HUD",
      type: "checkbox",
      checked: settings.windows.toolHudEnabled,
      click: (item) => updateSettings({
        ...settings,
        windows: {
          ...settings.windows,
          toolHudEnabled: item.checked
        }
      })
    },
    {
      label: "系统提醒",
      type: "checkbox",
      checked: settings.behavior.alertsEnabled,
      click: (item) => updateSettings({
        ...settings,
        behavior: {
          ...settings.behavior,
          alertsEnabled: item.checked
        }
      })
    },
    {
      label: "开机自启",
      type: "checkbox",
      checked: settings.system.startAtLogin,
      click: (item) => updateSettings({
        ...settings,
        system: {
          ...settings.system,
          startAtLogin: item.checked
        }
      })
    },
    { type: "separator" },
    {
      label: "立即刷新",
      click: () => {
        sendSnapshot();
        refreshOverlayCoordinator();
      }
    },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ];
}

function getTrayTooltip() {
  return `谁在吃 token\n${getTrayStatusLabel()}`;
}

function getTrayStatusLabel() {
  const provider = latestSnapshot?.providers?.find((candidate) => candidate.latest?.rateLimits?.primary);
  if (!provider) return "等待数据";
  const fiveHour = getWindowRemaining(provider.latest.rateLimits.primary);
  const week = getWindowRemaining(provider.latest.rateLimits.secondary);
  const syncLabel = provider.latest.rateLimitsTrust?.label || "等待";
  return `${provider.name} ${syncLabel} · 5小时 ${formatPercentForTray(fiveHour)} · 一周 ${formatPercentForTray(week)}`;
}

function formatPercentForTray(value) {
  return value === null || value === undefined ? "--" : `${value}%`;
}

function createTrayIcon() {
  const png = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  if (!png.isEmpty()) return png.resize({ width: 16, height: 16 });
  return nativeImage.createFromPath(path.join(__dirname, "assets", "tray.ico"));
}

async function refreshDesktopBarFromForeground() {
  return refreshOverlayCoordinator();
}

function getOverlayCoordinatorRefreshMs() {
  const mode = latestOverlayDecision?.mode;
  return mode === SURFACES.DESKTOP || mode === SURFACES.TOOL
    ? OVERLAY_COORDINATOR_ACTIVE_REFRESH_MS
    : OVERLAY_COORDINATOR_REFRESH_MS;
}

function scheduleOverlayCoordinatorTick(delayMs = getOverlayCoordinatorRefreshMs()) {
  if (isQuitting || isHeadlessRuntime()) return;
  if (desktopBarTimer) {
    clearTimeout(desktopBarTimer);
    desktopBarTimer = null;
  }
  desktopBarTimer = setTimeout(async () => {
    desktopBarTimer = null;
    try {
      await refreshOverlayCoordinator();
    } catch (error) {
      writeHudDebugLog({
        event: "overlay-coordinator",
        outcome: "tick-failed",
        error: error?.message || String(error)
      });
    } finally {
      scheduleOverlayCoordinatorTick();
    }
  }, Math.max(0, delayMs));
  desktopBarTimer.unref?.();
}

async function refreshOverlayCoordinator() {
  return runOverlayCoordinatorPass(getOverlayActiveWindow);
}

async function runOverlayCoordinatorPass(getActiveWindowForPass, options = {}) {
  if (isQuitting) return;
  const priority = options.priority === true;
  if (!priority && (overlayCoordinatorInFlight || overlayCoordinatorPriorityInFlight)) {
    overlayCoordinatorPending = true;
    return;
  }
  const generation = priority ? ++overlayCoordinatorGeneration : overlayCoordinatorGeneration;
  if (priority) {
    overlayCoordinatorPriorityInFlight = true;
  } else {
    overlayCoordinatorInFlight = true;
  }
  try {
    const activeWindow = enrichActiveWindowWithOverlayReports(
      await getActiveWindowForPass()
    );
    if (!priority && generation !== overlayCoordinatorGeneration) return;
    const decision = await resolveOverlayDecision(activeWindow);
    if (!priority && generation !== overlayCoordinatorGeneration) return;
    await applyOverlayDecision(decision);
  } finally {
    if (priority) {
      overlayCoordinatorPriorityInFlight = false;
    } else {
      overlayCoordinatorInFlight = false;
    }
    if (!overlayCoordinatorInFlight && !overlayCoordinatorPriorityInFlight && overlayCoordinatorPending && !isQuitting) {
      overlayCoordinatorPending = false;
      setTimeout(refreshOverlayCoordinator, 0);
    }
  }
}

async function getOverlayActiveWindow() {
  return withOverlayActiveWindowTimeout(
    getActiveWindow(getFastWindowInspectionOptions())
  );
}

async function getToolDesktopWakeActiveWindow() {
  return withToolDesktopWakeTimeout(
    getActiveWindow(getToolDesktopWakeInspectionOptions())
  );
}

async function withOverlayActiveWindowTimeout(activeWindowPromise) {
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(createOverlayActiveWindowTimeoutSample());
    }, OVERLAY_ACTIVE_WINDOW_TIMEOUT_MS);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([activeWindowPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function createOverlayActiveWindowTimeoutSample() {
  return {
    source: "overlay-active-window-timeout",
    title: "",
    processName: "",
    path: "",
    className: "",
    bounds: null,
    foregroundFallbackMiss: true,
    foregroundFallbackReason: "active-window-timeout",
    samplingNoise: true,
    desktop: {
      clear: false,
      blockerCount: 0,
      blockers: []
    }
  };
}

async function withToolDesktopWakeTimeout(activeWindowPromise) {
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), TOOL_DESKTOP_WAKE_TIMEOUT_MS);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([activeWindowPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function resolveOverlayDecision(activeWindow) {
  const sampleId = ++overlaySampleSequence;
  const settingsDecision = resolveSettingsOverlayDecision(activeWindow);
  const toolContext = settingsDecision?.preserveMode === SURFACES.TOOL
    ? settingsDecision.preservedDecision?.toolContext || latestOverlayDecision?.toolContext || null
    : getForegroundToolContext(activeWindow);

  // ── Debug diagnostics (toggle via DEBUG_OVERLAY env var) ──
  const _dbgShow = shouldShowDesktopBar(activeWindow);
  const _dbgSampling = !settingsDecision && isForegroundSamplingNoise(activeWindow);
  const _dbgDesktop = !settingsDecision && _dbgShow;
  const _dbgFullscreen = !settingsDecision && !isDesktopForegroundWindow(activeWindow, process.platform) && isForegroundFullscreen(activeWindow);
  if (process.env.DEBUG_OVERLAY === "1") {
    console.log(`[OVERLAY-DIAG #${sampleId}] prev=${latestOverlayDecision?.mode}`, {
      activeWindow: activeWindow ? {
        processName: activeWindow.processName,
        title: (activeWindow.title || "").slice(0, 60),
        className: activeWindow.className,
        source: activeWindow.source,
        isDesktopForeground: isDesktopForegroundWindow(activeWindow, "win32"),
        samplingNoise: Boolean(activeWindow?.samplingNoise),
        desktopClear: activeWindow?.desktop?.clear,
        desktopBlockerCount: activeWindow?.desktop?.blockerCount
      } : null,
      inputs: {
        shouldShowDesktopBar: _dbgShow,
        samplingNoise: _dbgSampling,
        desktopVisible: _dbgDesktop,
        fullscreenForeground: _dbgFullscreen,
        toolContext: toolContext?.tool?.id || null,
        desktopBarEnabled: settings.windows?.desktopBarEnabled
      }
    });
  }
  const decision = overlayController.resolve({
    sampleId,
    activeWindow,
    toolContext,
    settingsSurface: settingsDecision?.preserveMode || null,
    samplingNoise: !settingsDecision && isForegroundSamplingNoise(activeWindow),
    noiseReason: activeWindow?.foregroundFallbackReason || "foreground-sampling-noise",
    desktopVisible: !settingsDecision && shouldShowDesktopBar(activeWindow),
    fullscreenForeground: !settingsDecision && !isDesktopForegroundWindow(activeWindow, process.platform) && isForegroundFullscreen(activeWindow),
    desktopBarEnabled: settings.windows.desktopBarEnabled,
    toolHudEnabled: settings.windows.toolHudEnabled
  });
  if (process.env.DEBUG_OVERLAY === "1") {
    console.log(`[OVERLAY-RESOLVED #${sampleId}] → ${decision.surface} (${decision.reason})${decision.noise ? " [NOISE]" : ""}`);
  }

  return {
    ...decision,
    activeWindow,
    suppressDesktopBar: decision.mode !== SURFACES.DESKTOP,
    suppressHud: decision.mode !== SURFACES.TOOL,
    settingsOverlay: Boolean(settingsDecision),
    preserveMode: settingsDecision?.preserveMode || null,
    preservedDecision: settingsDecision?.preservedDecision || null,
    owner: settingsDecision?.owner || null
  };
}

function resolveSettingsOverlayDecision(activeWindow) {
  if (!isSettingsWindowVisible()) return null;

  const preservedDecision = settingsPreservedOverlayDecision || latestOverlayDecision || { mode: "hidden" };
  const owner = normalizeSettingsOverlayOwner(settingsOverlayOwner);
  const preserveMode = owner === "desktop" || owner === "hud"
    ? (owner === "desktop" ? "desktop-topbar" : "tool-hud")
    : preservedDecision.mode;

  if (!preserveMode || preserveMode === "hidden" || preserveMode === "settings-overlay") return null;

  return {
    mode: "settings-overlay",
    reason: isOwnSettingsWindow(activeWindow) ? "settings-window" : "settings-window-visible",
    preserveOverlay: true,
    preserveMode,
    owner,
    preservedDecision,
    activeWindow
  };
}

async function applyOverlayDecision(decision) {
  const previousDecision = latestOverlayDecision || { mode: "hidden" };
  clearOverlayDeferredRetry();
  latestOverlayDecision = {
    ...decision,
    version: ++latestOverlayDecisionVersion
  };
  await applyOverlayTransition(latestOverlayDecision, previousDecision);
}

async function applyOverlayTransition(decision, previousDecision) {
  if (decision.noise && decision.preserveOverlay) {
    if (decision.mode === SURFACES.TOOL) {
      hideDesktopBarWindow("tool-hud-noise-preserve");
      scheduleToolDesktopWake();
    } else if (decision.mode === SURFACES.DESKTOP && settings.windows.desktopBarEnabled) {
      hideToolHudForDesktop(decision.activeWindow);
      showDesktopBarWindow({ forceShow: true, promoteVisible: true });
    }
    scheduleOverlayDeferredRetry();
    writeOverlayDecisionDebug(decision, previousDecision);
    return;
  }

  updateToolRegistry(decision);

  if (decision.mode === SURFACES.DESKTOP) {
    clearToolDesktopWake();
    clearToolDecisionSnapshotRefresh();
    hideToolHudForDesktop(decision.activeWindow);
    showDesktopBarForTransition(decision);
    if (!snapshotInFlight) sendSnapshot();
    scheduleNextSnapshotRefresh();
    writeOverlayDecisionDebug(decision, previousDecision);
    return;
  }

  if (decision.mode === SURFACES.TOOL) {
    if (shouldRefreshSnapshotForToolDecision(decision, previousDecision)) {
      scheduleToolDecisionSnapshotRefresh(decision);
    }
    if (decision.settingsOverlay && !decision.toolContext) {
      clearToolDesktopWake();
      preserveSettingsOverlaySurface(decision);
      hideDesktopBarWindow("tool-hud");
    } else {
      hideDesktopBarWindow("tool-hud");
      let warmShown = false;
      if (shouldWarmShowToolHudForDecision(decision, previousDecision)) {
        warmShown = warmShowToolHudForTransition(decision) || quickShowToolHudForTransition(decision);
      }
      const shouldRefreshHud = shouldRefreshToolHudForDecision(decision, previousDecision);
      const shown = shouldRefreshHud
        ? await refreshToolHud({
            activeWindow: decision.activeWindow,
            toolContext: decision.toolContext,
            decisionVersion: decision.version
          })
        : true;
      if (!isOverlayDecisionCurrent(decision, SURFACES.TOOL)) {
        writeHudDebugLog({
          event: "overlay-transition",
          outcome: "stale-tool-transition",
          sampleId: decision.sampleId || null,
          decisionVersion: decision.version || null,
          currentVersion: latestOverlayDecision?.version || null,
          currentMode: latestOverlayDecision?.mode || null
        });
        return;
      }
      if (decision.toolContext) {
        rememberActiveTool(decision.toolContext.tool, decision.toolContext.window);
      }
      if (!shown && !warmShown) {
        hideToolHudForUnsupportedForeground(decision.activeWindow, null);
      }
      scheduleToolDesktopWake();
    }
    scheduleNextSnapshotRefresh();
    writeOverlayDecisionDebug(decision, previousDecision);
    return;
  }

  clearToolDesktopWake();
  clearToolDecisionSnapshotRefresh();
  hideDesktopBarWindow(decision.reason);
  if (isDesktopOverlayForeground(decision.activeWindow)) {
    hideToolHudForDesktop(decision.activeWindow);
  } else {
    hideToolHudForUnsupportedForeground(decision.activeWindow, null);
  }
  scheduleNextSnapshotRefresh();
  writeOverlayDecisionDebug(decision, previousDecision);
}

function shouldWarmShowToolHudForDecision(decision, previousDecision) {
  if (!decision?.toolContext?.tool) return false;
  if (previousDecision?.mode !== SURFACES.TOOL) return true;
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return true;
  if (!toolHudWindow.isVisible()) return true;
  if (typeof toolHudWindow.isMinimized === "function" && toolHudWindow.isMinimized()) return true;
  return false;
}

function warmShowToolHudForTransition(decision) {
  if (!settings.windows.toolHudEnabled) return false;
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return false;
  if (!decision?.toolContext?.tool || !isOverlayDecisionCurrent(decision, SURFACES.TOOL)) return false;
  const payload = warmToolHudPayload;
  if (!payload?.visible || !payload.tool?.id) return false;
  if (payload.tool.id !== decision.toolContext.tool.id) return false;

  const anchorWindow = decision.toolContext.window || decision.activeWindow || payload.activeWindow;
  const display = getDisplayForActiveWindow(anchorWindow);
  const hudBounds = getHudBounds(display, decision.toolContext.tool, anchorWindow, settings) || warmToolHudBounds;
  if (!hudBounds) return false;

  latestHudPayload = {
    ...payload,
    activeWindow: anchorWindow,
    tool: decision.toolContext.tool,
    transient: true,
    transientReason: "overlay-transition-warm"
  };
  setWindowBoundsIfChanged(toolHudWindow, hudBounds);
  sendHudUpdate(latestHudPayload);
  lastVisibleHudPayload = latestHudPayload;
  lastVisibleHudBounds = hudBounds;
  lastVisibleHudAt = Date.now();
  cacheWarmToolHudPayload();
  showToolHudWindow(hudBounds);
  writeHudDebugLog({
    event: "overlay-transition",
    outcome: "warm-tool-hud",
    sampleId: decision.sampleId || null,
    decisionVersion: decision.version || null,
    tool: summarizeHudTool(decision.toolContext.tool),
    activeWindow: summarizeHudWindow(anchorWindow),
    payloadAgeMs: warmToolHudAt ? Date.now() - warmToolHudAt : null,
    hudWindowVisible: toolHudWindow.isVisible()
  });
  return true;
}

function quickShowToolHudForTransition(decision) {
  if (!settings.windows.toolHudEnabled) return false;
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return false;
  if (!latestSnapshot || !decision?.toolContext?.tool || !isOverlayDecisionCurrent(decision, SURFACES.TOOL)) return false;
  const anchorWindow = decision.toolContext.window || decision.activeWindow;
  if (!anchorWindow) return false;
  const payload = buildHudPayload(latestSnapshot, anchorWindow, decision.toolContext.tool);
  if (!payload?.visible) return false;

  const display = getDisplayForActiveWindow(anchorWindow);
  const hudBounds = getHudBounds(display, decision.toolContext.tool, anchorWindow, settings);
  if (!hudBounds) return false;

  latestHudPayload = {
    ...payload,
    transient: true,
    transientReason: "overlay-transition-quick"
  };
  setWindowBoundsIfChanged(toolHudWindow, hudBounds);
  sendHudUpdate(latestHudPayload);
  lastVisibleHudPayload = latestHudPayload;
  lastVisibleHudBounds = hudBounds;
  lastVisibleHudAt = Date.now();
  cacheWarmToolHudPayload();
  showToolHudWindow(hudBounds);
  writeHudDebugLog({
    event: "overlay-transition",
    outcome: "quick-tool-hud",
    sampleId: decision.sampleId || null,
    decisionVersion: decision.version || null,
    tool: summarizeHudTool(decision.toolContext.tool),
    activeWindow: summarizeHudWindow(anchorWindow),
    hudWindowVisible: toolHudWindow.isVisible()
  });
  return true;
}

function isOverlayDecisionCurrent(decision, expectedMode = null) {
  if (!decision || latestOverlayDecision?.version !== decision.version) return false;
  if (expectedMode && latestOverlayDecision?.mode !== expectedMode) return false;
  return true;
}

function preserveSettingsOverlaySurface(decision) {
  const preserveMode = decision.preserveMode || decision.preservedDecision?.mode;
  if (preserveMode === "desktop-topbar") {
    if (settings.windows.desktopBarEnabled) {
      showDesktopBarForTransition(decision);
    }
    return;
  }

  if (preserveMode === "tool-hud") {
    const payload = lastVisibleHudPayload?.visible
      ? lastVisibleHudPayload
      : (latestHudPayload?.visible ? latestHudPayload : null);
    if (!payload) return;
    latestHudPayload = payload;
    sendHudUpdate(latestHudPayload);
    if (!toolHudWindow || toolHudWindow.isDestroyed()) return;
    if (!toolHudWindow.isVisible() || (typeof toolHudWindow.isMinimized === "function" && toolHudWindow.isMinimized())) {
      showToolHudWindow(lastVisibleHudBounds);
    }
  }
}

function scheduleOverlayDeferredRetry() {
  if (isQuitting || overlayDeferredRetryTimer) return;
  const delayMs = overlayDeferredRetryDelayMs;
  overlayDeferredRetryDelayMs = Math.min(overlayDeferredRetryDelayMs * 2, OVERLAY_DEFERRED_RETRY_MAX_MS);
  overlayDeferredRetryTimer = setTimeout(() => {
    overlayDeferredRetryTimer = null;
    refreshOverlayCoordinator();
  }, delayMs);
}

function clearOverlayDeferredRetry() {
  overlayDeferredRetryDelayMs = OVERLAY_DEFERRED_RETRY_MS;
  if (!overlayDeferredRetryTimer) return;
  clearTimeout(overlayDeferredRetryTimer);
  overlayDeferredRetryTimer = null;
}

function scheduleToolDesktopWake() {
  if (isQuitting || toolDesktopWakeTimer || toolDesktopWakeInFlight) return;
  if (!shouldRunToolDesktopWake()) return;
  if (startToolDesktopWakeProbe()) return;
  toolDesktopWakeTimer = setTimeout(runToolDesktopWake, TOOL_DESKTOP_WAKE_MS);
  toolDesktopWakeTimer.unref?.();
}

function clearToolDesktopWake() {
  if (toolDesktopWakeTimer) {
    clearTimeout(toolDesktopWakeTimer);
    toolDesktopWakeTimer = null;
  }
  stopToolDesktopWakeProbe();
}

function shouldRunToolDesktopWake() {
  return latestOverlayDecision?.mode === SURFACES.TOOL &&
    !latestOverlayDecision.settingsOverlay &&
    settings.windows.toolHudEnabled &&
    toolHudWindow &&
    !toolHudWindow.isDestroyed() &&
    toolHudWindow.isVisible();
}

async function runToolDesktopWake() {
  toolDesktopWakeTimer = null;
  if (!shouldRunToolDesktopWake()) return;
  if (overlayCoordinatorInFlight) {
    scheduleToolDesktopWake();
    return;
  }

  toolDesktopWakeInFlight = true;
  try {
    const activeWindow = enrichActiveWindowWithOverlayReports(
      await getToolDesktopWakeActiveWindow()
    );
    if (!activeWindow || !shouldShowDesktopBar(activeWindow)) return;
    await runOverlayCoordinatorPass(() => activeWindow);
  } finally {
    toolDesktopWakeInFlight = false;
    if (shouldRunToolDesktopWake()) {
      scheduleToolDesktopWake();
    }
  }
}

function startToolDesktopWakeProbe() {
  if (process.platform !== "win32") return false;
  if (toolDesktopWakeProbeProcess && !toolDesktopWakeProbeProcess.killed) return true;
  toolDesktopWakeProbeBuffer = "";
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    TOOL_DESKTOP_WAKE_PROBE_PS1,
    "-IntervalMs",
    String(TOOL_DESKTOP_WAKE_PROBE_INTERVAL_MS)
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  toolDesktopWakeProbeProcess = child;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", handleToolDesktopWakeProbeData);
  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on("data", (chunk) => {
    writeHudDebugLog({
      event: "tool-desktop-wake",
      outcome: "probe-stderr",
      message: String(chunk || "").trim().slice(0, 500)
    });
  });
  child.on("error", (error) => {
    writeHudDebugLog({
      event: "tool-desktop-wake",
      outcome: "probe-error",
      error: error?.message || String(error)
    });
  });
  child.on("exit", () => {
    if (toolDesktopWakeProbeProcess === child) {
      toolDesktopWakeProbeProcess = null;
      toolDesktopWakeProbeBuffer = "";
    }
  });
  return true;
}

function stopToolDesktopWakeProbe() {
  const child = toolDesktopWakeProbeProcess;
  toolDesktopWakeProbeProcess = null;
  toolDesktopWakeProbeBuffer = "";
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    // The helper may already be gone when the overlay transitions away from tool-hud.
  }
}

function handleToolDesktopWakeProbeData(chunk) {
  toolDesktopWakeProbeBuffer += String(chunk || "");
  let newlineIndex = toolDesktopWakeProbeBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = toolDesktopWakeProbeBuffer.slice(0, newlineIndex).trim();
    toolDesktopWakeProbeBuffer = toolDesktopWakeProbeBuffer.slice(newlineIndex + 1);
    if (line) handleToolDesktopWakeProbeLine(line);
    newlineIndex = toolDesktopWakeProbeBuffer.indexOf("\n");
  }
}

function handleToolDesktopWakeProbeLine(line) {
  if (!shouldRunToolDesktopWake() || toolDesktopWakeInFlight) return;
  let activeWindow = null;
  try {
    activeWindow = normalizeToolDesktopWakeProbeWindow(JSON.parse(line));
  } catch {
    writeHudDebugLog({
      event: "tool-desktop-wake",
      outcome: "probe-parse-error"
    });
    return;
  }
  if (!shouldShowDesktopBar(activeWindow)) return;
  toolDesktopWakeInFlight = true;
  runOverlayCoordinatorPass(() => activeWindow, { priority: true })
    .catch((error) => {
      writeHudDebugLog({
        event: "tool-desktop-wake",
        outcome: "wake-failed",
        error: error?.message || String(error)
      });
    })
    .finally(() => {
      toolDesktopWakeInFlight = false;
    });
}

function showDesktopBarForTransition(decision) {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return;
  if (!settings.windows.desktopBarEnabled || !shouldShowDesktopBar(decision.activeWindow)) {
    hideDesktopBarWindow("desktop-not-active");
    return;
  }
  const state = getOverlayWindowState(desktopBarWindow);
  const needsRestore = !state?.visible || state.minimized;
  if (decision.transition?.changed || needsRestore) {
    showDesktopBarWindow({ promoteVisible: Boolean(decision.transition?.changed) });
  }
}

function hideDesktopBarWindow(reason = "hidden") {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return;
  if (desktopBarWindow.isVisible()) {
    desktopBarWindow.setAlwaysOnTop(false);
    desktopBarWindow.hide();
    hideHudTrustPopover("desktop");
    writeHudDebugLog({
      event: "desktop-bar",
      outcome: "hidden",
      reason
    });
  }
}

function restoreOverlayWindowIfMinimized(window) {
  if (!window || window.isDestroyed()) return;
  if (typeof window.isMinimized === "function" && window.isMinimized()) {
    window.restore();
  }
}

function shouldRefreshSnapshotForToolDecision(decision, previousDecision) {
  if (!latestSnapshot) return true;
  if (previousDecision?.mode !== "tool-hud") return true;
  const previousToolId = previousDecision?.toolContext?.tool?.id || null;
  const nextToolId = decision?.toolContext?.tool?.id || null;
  return previousToolId !== nextToolId;
}

function shouldRefreshToolHudForDecision(decision, previousDecision) {
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return false;
  if (previousDecision?.mode !== "tool-hud") return true;
  if (!latestHudPayload?.visible || latestHudPayload.transient) return true;
  if (!toolHudWindow.isVisible()) return true;

  const previousToolId = previousDecision?.toolContext?.tool?.id || latestHudPayload.tool?.id || null;
  const nextToolId = decision?.toolContext?.tool?.id || null;
  if (previousToolId !== nextToolId) return true;

  const previousWindow = latestHudPayload.activeWindow || {};
  const nextWindow = decision.toolContext?.window || decision.activeWindow || {};
  if (String(previousWindow.hwnd || "") !== String(nextWindow.hwnd || "")) return true;
  return !hudAnchorBoundsCloseEnough(previousWindow.bounds, nextWindow.bounds, isDisplayFillingBounds);
}

function getSnapshotAgeMs(snapshot, now = Date.now()) {
  const collectedAt = Date.parse(snapshot?.collectedAt || "");
  if (!Number.isFinite(collectedAt)) return null;
  return Math.max(0, now - collectedAt);
}

function writeOverlayDecisionDebug(decision, previousDecision) {
  if (!isHudDebugEnabled()) return;
  if (
    previousDecision?.mode === decision.mode &&
    previousDecision?.reason === decision.reason &&
    previousDecision?.toolContext?.tool?.id === decision.toolContext?.tool?.id &&
    !decision.transition?.changed
  ) {
    return;
  }
  writeHudDebugLog({
    event: "overlay-decision",
    sampleId: decision.sampleId || null,
    mode: decision.mode,
    reason: decision.reason,
    suppressHud: Boolean(decision.suppressHud),
    activeWindow: summarizeHudWindow(decision.activeWindow),
    tool: summarizeHudTool(decision.toolContext?.tool || null),
    transition: decision.transition || null,
    stalePreserveMs: decision.stalePreserveMs || 0
  });
}

function updateActiveToolFromWindow(activeWindow) {
  const toolContext = getDetectedToolContext(activeWindow);
  if (!toolContext) return null;
  rememberActiveTool(toolContext.tool, toolContext.window);
  return toolContext.tool;
}

function rememberActiveTool(tool, activeWindow) {
  if (!tool) return;
  const previousId = latestActiveTool?.id || null;
  latestActiveTool = tool;
  latestActiveToolAt = Date.now();
  latestActiveToolWindow = summarizeHudWindow(activeWindow);

  if (tool.id !== previousId) {
    sendActiveToolSnapshot();
  }
}

function getActiveToolContext() {
  if (!latestActiveTool) return null;
  const ageMs = Date.now() - latestActiveToolAt;
  if (ageMs > ACTIVE_TOOL_TTL_MS) return null;
  return {
    ...summarizeHudTool(latestActiveTool),
    updatedAt: new Date(latestActiveToolAt).toISOString(),
    ageMs,
    window: latestActiveToolWindow
  };
}

function getSnapshotForRenderer(snapshot) {
  const base = snapshot || latestSnapshot || collectSnapshot();
  return {
    ...base,
    activeTool: getActiveToolContext()
  };
}

function sendActiveToolSnapshot() {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return;
  safeSend(desktopBarWindow, "metrics:update", getSnapshotForRenderer(latestSnapshot));
}

function sendHudUpdate(payload) {
  if (toolHudWindow && !toolHudWindow.isDestroyed()) {
    safeSend(toolHudWindow, "hud:update", payload);
  }
  if (toolHudHitboxWindow && !toolHudHitboxWindow.isDestroyed()) {
    safeSend(toolHudHitboxWindow, "hud:update", payload);
  }
}

function showDesktopBarWindow(options = {}) {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return;
  const promoteVisible = options.promoteVisible !== false;
  const forceShow = options.forceShow === true;
  const before = getOverlayWindowState(desktopBarWindow);
  restoreOverlayWindowIfMinimized(desktopBarWindow);
  reinforceNonActivatingWindow(desktopBarWindow); // Pre-reinforce before alwaysOnTop + visibility changes
  desktopBarWindow.setAlwaysOnTop(true, "floating");
  let action = "already-visible";
  if (!desktopBarWindow.isVisible() || forceShow) {
    action = forceShow && desktopBarWindow.isVisible() ? "force-show-inactive" : "show-inactive";
    desktopBarWindow.showInactive();
  } else if (promoteVisible && typeof desktopBarWindow.moveTop === "function") {
    action = "move-top";
    desktopBarWindow.moveTop();
  }
  reinforceNonActivatingWindow(desktopBarWindow); // Post-reinforce after showInactive/moveTop may reset flags
  writeHudDebugLog({
    event: "desktop-bar",
    outcome: "shown",
    action,
    before,
    after: getOverlayWindowState(desktopBarWindow)
  });
}

function getOverlayWindowState(window) {
  if (!window || window.isDestroyed()) return null;
  const state = {};
  try {
    state.visible = window.isVisible();
  } catch {
    state.visible = null;
  }
  try {
    state.minimized = typeof window.isMinimized === "function" ? window.isMinimized() : null;
  } catch {
    state.minimized = null;
  }
  try {
    state.bounds = typeof window.getBounds === "function" ? window.getBounds() : null;
  } catch {
    state.bounds = null;
  }
  return state;
}

function getToolHudHitboxBounds(hudBounds = null) {
  const bounds = hudBounds || lastVisibleHudBounds || toolHudWindow?.getBounds?.();
  if (!bounds) return null;
  const width = Math.min(TOOL_HUD_HITBOX_WIDTH, Math.max(116, bounds.width - 20));
  const height = TOOL_HUD_HITBOX_HEIGHT;
  return {
    x: Math.round(bounds.x + bounds.width - width - 8),
    y: Math.round(bounds.y + 4),
    width,
    height
  };
}

function showToolHudHitbox(hudBounds = null, options = {}) {
  if (!latestHudPayload?.visible) return;
  const promoteVisible = options.promoteVisible !== false;
  createToolHudHitboxWindow();
  if (!toolHudHitboxWindow || toolHudHitboxWindow.isDestroyed()) return;
  const bounds = getToolHudHitboxBounds(hudBounds);
  if (!bounds) return;
  setWindowBoundsIfChanged(toolHudHitboxWindow, bounds);
  restoreOverlayWindowIfMinimized(toolHudHitboxWindow);
  reinforceNonActivatingWindow(toolHudHitboxWindow); // Pre-reinforce before alwaysOnTop + visibility changes
  toolHudHitboxWindow.setAlwaysOnTop(true, "floating");
  setToolHudHitboxMouseRegion(false);
  if (!toolHudHitboxWindow.isVisible()) {
    toolHudHitboxWindow.showInactive();
  } else if (promoteVisible && typeof toolHudHitboxWindow.moveTop === "function") {
    toolHudHitboxWindow.moveTop();
  }
  reinforceNonActivatingWindow(toolHudHitboxWindow); // Post-reinforce after showInactive/moveTop may reset flags
  sendHudUpdate(latestHudPayload);
}

function hideToolHudHitbox() {
  setToolHudHitboxMouseRegion(false);
  if (toolHudHitboxWindow && !toolHudHitboxWindow.isDestroyed() && toolHudHitboxWindow.isVisible()) {
    toolHudHitboxWindow.hide();
  }
}

function hideToolHudForDesktop(activeWindow) {
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return;
  hideHudTrustPopover("hud");
  setToolHudMouseRegion(false);
  hideToolHudHitbox();

  const shouldLog =
    Boolean(latestHudPayload?.visible) ||
    toolHudWindow.isVisible() ||
    Boolean(lastVisibleHudPayload);

  latestHudPayload = {
    visible: false,
    hiddenReason: "desktop",
    activeWindow
  };
  cacheWarmToolHudPayload();
  lastVisibleHudPayload = null;
  lastVisibleHudBounds = null;
  lastVisibleHudAt = 0;

  if (toolHudWindow.isVisible()) {
    toolHudWindow.hide();
  }
  sendHudUpdate(latestHudPayload);

  if (shouldLog) {
    writeHudDebugLog({
      event: "hud-refresh",
      outcome: "hidden-desktop",
      activeWindow: summarizeHudWindow(activeWindow),
      payload: summarizeHudPayload(latestHudPayload),
      hudWindowVisible: false
    });
  }
}

function hideToolHudForUnsupportedForeground(activeWindow, foregroundTool) {
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return;
  if (foregroundTool) return;
  if (shouldHideToolHudForDesktopForeground(activeWindow)) {
    hideToolHudForDesktop(activeWindow);
    return;
  }
  hideHudTrustPopover("hud");
  setToolHudMouseRegion(false);
  hideToolHudHitbox();

  const shouldLog =
    Boolean(latestHudPayload?.visible) ||
    toolHudWindow.isVisible() ||
    Boolean(lastVisibleHudPayload);

  latestHudPayload = {
    visible: false,
    hiddenReason: "unsupported-foreground",
    activeWindow
  };
  clearWarmToolHudPayload();
  lastVisibleHudPayload = null;
  lastVisibleHudBounds = null;
  lastVisibleHudAt = 0;

  if (toolHudWindow.isVisible()) {
    toolHudWindow.hide();
  }
  sendHudUpdate(latestHudPayload);

  if (shouldLog) {
    writeHudDebugLog({
      event: "hud-refresh",
      outcome: "hidden-unsupported-foreground",
      activeWindow: summarizeHudWindow(activeWindow),
      payload: summarizeHudPayload(latestHudPayload),
      hudWindowVisible: false
    });
  }
}

function shouldHideToolHudForDesktopForeground(activeWindow) {
  return shouldShowDesktopBar(activeWindow);
}

function reinforceNonActivatingWindow(window) {
  if (!window || window.isDestroyed()) return;
  window.setFocusable(false);
  if (window.isFocused()) {
    window.blur();
  }
}

function getWindowInspectionOptions() {
  const primary = getPrimaryDisplay();
  return {
    ignoredHwnds: getOwnedWindowHwnds(),
    desktopArea: primary.workArea
  };
}

function getFastWindowInspectionOptions() {
  return {
    ...getWindowInspectionOptions(),
    fast: "desktop",
    probeDesktopForeground: latestOverlayDecision?.mode === SURFACES.TOOL
  };
}

function getToolDesktopWakeInspectionOptions() {
  return {
    ...getFastWindowInspectionOptions(),
    nativeDesktopFallbackOnly: true,
    probeDesktopForeground: false
  };
}

function getHudWindowInspectionOptions() {
  return {
    ...getWindowInspectionOptions(),
    inspectExplorer: false,
    inspectUnreliableShell: false,
    inspectSmallWindows: Boolean(lastVisibleHudPayload?.visible)
  };
}

function getOwnedWindowHwnds() {
  return [desktopBarWindow, toolHudWindow, toolHudHitboxWindow, hudTrustPopoverWindow, settingsWindow]
    .filter((window) => window && !window.isDestroyed())
    .map(getWindowHwnd)
    .filter(Boolean);
}

function getWindowHwnd(window) {
  const handle = window.getNativeWindowHandle();
  return process.arch === "x64" ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
}

function isOwnDesktopBar(activeWindow) {
  if (!desktopBarWindow || desktopBarWindow.isDestroyed()) return false;
  const activeHwnd = String(activeWindow?.hwnd || "");
  if (!activeHwnd) return false;
  return activeHwnd === getWindowHwnd(desktopBarWindow);
}

function isOwnSettingsWindow(activeWindow) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return false;
  const activeHwnd = String(activeWindow?.hwnd || "");
  if (!activeHwnd) return false;
  return activeHwnd === getWindowHwnd(settingsWindow);
}

function collectSnapshot() {
  return snapshotService.collectSnapshot();
}

function isProviderEnabled(providerId) {
  return settings.providers?.[providerId]?.enabled !== false;
}

function annotateCapacityTrends(providers, collectedAt) {
  return providers.map((provider) => annotateProviderTrend(provider, collectedAt));
}

function annotateProviderTrend(provider, collectedAt) {
  const primaryWindow = provider.latest?.rateLimits?.primary || null;
  const remaining = getWindowRemaining(primaryWindow);
  const trend = calculateCapacityTrend({
    key: `${provider.id}:primary:${primaryWindow?.resetsAt || "unknown"}`,
    remaining,
    collectedAt,
    resetsAt: primaryWindow?.resetsAt || null
  });

  if (!provider.latest) return provider;
  return {
    ...provider,
    latest: {
      ...provider.latest,
      capacityTrend: trend
    }
  };
}

function calculateCapacityTrend({ key, remaining, collectedAt, resetsAt }) {
  if (remaining === null || remaining === undefined) {
    return withCapacityForecast({
      status: "unknown",
      label: "等待",
      delta: null,
      burnPerHour: null,
      sampleMinutes: 0
    }, remaining, resetsAt, collectedAt);
  }

  const timestamp = collectedAt.getTime();
  const currentPoints = capacityHistory.get(key) || [];
  const points = [...currentPoints, { timestamp, remaining }].filter(
    (point) => timestamp - point.timestamp <= TREND_WINDOW_MS
  );
  capacityHistory.set(key, points);

  const baseline = points[0];
  const elapsedMs = timestamp - baseline.timestamp;
  const sampleMinutes = elapsedMs / 60000;
  const delta = remaining - baseline.remaining;

  if (points.length < 2 || elapsedMs < TREND_MIN_SAMPLE_MS) {
    return withCapacityForecast({
      status: "new",
      label: "观察",
      delta,
      burnPerHour: null,
      sampleMinutes
    }, remaining, resetsAt, collectedAt);
  }

  if (delta >= 4) {
    return withCapacityForecast({
      status: "recovering",
      label: "回升",
      delta,
      burnPerHour: 0,
      sampleMinutes
    }, remaining, resetsAt, collectedAt);
  }

  const burnPerHour = delta < 0 ? (-delta / sampleMinutes) * 60 : 0;
  if (burnPerHour >= 12 || delta <= -8) {
    return withCapacityForecast({
      status: "fast",
      label: "消耗快",
      delta,
      burnPerHour,
      sampleMinutes
    }, remaining, resetsAt, collectedAt);
  }

  if (burnPerHour >= 4 || delta <= -3) {
    return withCapacityForecast({
      status: "using",
      label: "消耗中",
      delta,
      burnPerHour,
      sampleMinutes
    }, remaining, resetsAt, collectedAt);
  }

  return withCapacityForecast({
    status: "steady",
    label: "稳定",
    delta,
    burnPerHour,
    sampleMinutes
  }, remaining, resetsAt, collectedAt);
}

function withCapacityForecast(trend, remaining, resetsAt, collectedAt) {
  const forecast =
    trend.status === "new" || trend.status === "unknown"
      ? buildWaitingForecast()
      : buildCapacityForecast({
          remaining,
          burnPerHour: trend.burnPerHour,
          resetsAt,
          collectedAt
        });
  return {
    ...trend,
    forecast,
    forecastLabel: forecast.label,
    forecastShortLabel: forecast.shortLabel
  };
}

function buildWaitingForecast() {
  return {
    status: "unknown",
    label: "等待估算",
    shortLabel: "估算中",
    targetThreshold: null,
    minutesToTarget: null
  };
}

function buildCapacityForecast({ remaining, burnPerHour, resetsAt, collectedAt }) {
  if (remaining === null || remaining === undefined) {
    return buildWaitingForecast();
  }

  if (remaining < 10) {
    return {
      status: "critical",
      label: "已低于10%",
      shortLabel: "<10%",
      targetThreshold: 10,
      minutesToTarget: 0
    };
  }

  if (remaining < 20) {
    return {
      status: "danger",
      label: "已低于20%",
      shortLabel: "<20%",
      targetThreshold: 20,
      minutesToTarget: 0
    };
  }

  const targetThreshold = getNextCapacityThreshold(remaining);
  if (!targetThreshold || !burnPerHour || burnPerHour <= 0) {
    return {
      status: "safe",
      label: "当前速度安全",
      shortLabel: "安全",
      targetThreshold,
      minutesToTarget: null
    };
  }

  const minutesToTarget = ((remaining - targetThreshold) / burnPerHour) * 60;
  const resetMs = resetsAt ? new Date(resetsAt).getTime() - collectedAt.getTime() : null;
  if (
    Number.isFinite(resetMs) &&
    resetMs > 0 &&
    Number.isFinite(minutesToTarget) &&
    minutesToTarget * 60000 > resetMs
  ) {
    return {
      status: "safe",
      label: "重置前安全",
      shortLabel: "安全",
      targetThreshold,
      minutesToTarget
    };
  }

  const timeLabel = formatForecastMinutes(minutesToTarget);
  return {
    status: minutesToTarget <= 60 ? "soon" : "watch",
    label: `约${timeLabel}到${targetThreshold}%`,
    shortLabel: `${timeLabel}到${targetThreshold}`,
    targetThreshold,
    minutesToTarget
  };
}

function getNextCapacityThreshold(remaining) {
  if (remaining > 40) return 40;
  if (remaining > 20) return 20;
  if (remaining > 10) return 10;
  return null;
}

function formatForecastMinutes(value) {
  if (!Number.isFinite(value) || value < 0) return "--";
  const minutes = Math.max(1, Math.ceil(value));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 10 && mins > 0) return `${hours}h${String(mins).padStart(2, "0")}m`;
  return `${hours}h`;
}



function refreshSystemMetrics() {
  latestSystemMetrics = collectSystemMetrics();
  return latestSystemMetrics;
}

function sendSystemMetrics() {
  const system = refreshSystemMetrics();
  if (desktopBarWindow && !desktopBarWindow.isDestroyed()) {
    safeSend(desktopBarWindow, "system:update", system);
  }
}

function sendSnapshot() {
  if (snapshotInFlight) return;
  snapshotInFlight = true;
  try {
    latestSnapshot = collectSnapshot();
    refreshVisibleHudPayloadFromSnapshot(latestSnapshot);
    maybeSendLowCapacityAlerts(latestSnapshot);
    updateTray();
    if (desktopBarWindow && !desktopBarWindow.isDestroyed()) {
      safeSend(desktopBarWindow, "metrics:update", getSnapshotForRenderer(latestSnapshot));
    }
    if (toolHudWindow && !toolHudWindow.isDestroyed()) {
      sendHudUpdate(latestHudPayload);
    }
  } finally {
    snapshotInFlight = false;
    scheduleNextSnapshotRefresh();
  }
}

function scheduleToolDecisionSnapshotRefresh(decision) {
  clearToolDecisionSnapshotRefresh();
  if (isQuitting || !decision?.version) return;
  const decisionVersion = decision.version;
  toolDecisionSnapshotTimer = setTimeout(() => {
    toolDecisionSnapshotTimer = null;
    if (latestOverlayDecision?.version !== decisionVersion || latestOverlayDecision?.mode !== SURFACES.TOOL) {
      return;
    }
    sendSnapshot();
  }, TOOL_TRANSITION_SNAPSHOT_DELAY_MS);
  toolDecisionSnapshotTimer.unref?.();
}

function clearToolDecisionSnapshotRefresh() {
  if (!toolDecisionSnapshotTimer) return;
  clearTimeout(toolDecisionSnapshotTimer);
  toolDecisionSnapshotTimer = null;
}

function scheduleNextSnapshotRefresh(delayMs = getSnapshotRefreshDelayMs()) {
  if (isQuitting) return;
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  if (delayMs < 0) return;
  const refreshBounds = getSnapshotRefreshBounds();
  const delay = clampNumber(delayMs, refreshBounds.min, refreshBounds.max);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    sendSnapshot();
  }, delay);
  snapshotTimer.unref?.();
}

function getSnapshotRefreshBounds() {
  return {
    min: toolSM.WORKBUDDY_HUD_SNAPSHOT_REFRESH_MS || 1000,
    max: Math.max(toolSM.TOOL_HUD_STEADY_REFRESH_MS || 0, HIDDEN_SNAPSHOT_REFRESH_MS)
  };
}

function getSnapshotRefreshDelayMs() {
  return toolSM.getSnapshotRefreshDelayMs();
}

function isToolTracked(toolId) {
  return settings.tools.tracked.includes(toolId);
}

function updateToolRegistry(decision) {
  toolSM.updateToolRegistry(decision);
}

function broadcastToolRegistry() {
  toolSM.broadcastState();
}

function seedTrackedTools() {
  const available = scanAvailableTools();
  toolSM.seedTrackedTools(available);
}

function scheduleToolProcessScan() {
  toolSM.scheduleScan();
}

function stopToolProcessScan() {
  toolSM.stopScan();
}

function scanTrackedToolProcesses() {
  toolSM.scanTrackedToolProcesses();
}

function cleanupUntrackedTools() {
  toolSM.cleanupUntrackedTools();
}

function refreshVisibleHudPayloadFromSnapshot(snapshot) {
  if (!snapshot) return;
  if (!latestHudPayload?.visible || !latestHudPayload.tool || latestHudPayload.transient) return;
  const nextPayload = buildHudPayload(snapshot, latestHudPayload.activeWindow, latestHudPayload.tool);
  latestHudPayload = {
    ...nextPayload,
    repositioned: latestHudPayload.repositioned,
    repositionReason: latestHudPayload.repositionReason
  };
  lastVisibleHudPayload = latestHudPayload;
  cacheWarmToolHudPayload();
}

async function refreshToolHud(options = {}) {
  if (hudRefreshInFlight) return false;
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return false;
  if (!settings.windows.toolHudEnabled) {
    setToolHudMouseRegion(false);
    hideToolHudHitbox();
    if (toolHudWindow.isVisible()) toolHudWindow.hide();
    hideHudTrustPopover("hud");
    latestHudPayload = { visible: false };
    clearWarmToolHudPayload();
    lastVisibleHudPayload = null;
    lastVisibleHudBounds = null;
    lastVisibleHudAt = 0;
    writeHudDebugLog({
      event: "hud-refresh",
      outcome: "disabled"
    });
    return false;
  }
  if (!options.toolContext?.tool) {
    writeHudDebugLog({
      event: "hud-refresh",
      outcome: "skipped-no-tool-context",
      activeWindow: summarizeHudWindow(options.activeWindow),
      hudWindowVisible: toolHudWindow.isVisible()
    });
    return false;
  }
  hudRefreshInFlight = true;
  const debugId = ++hudDebugSequence;
  try {
    const activeWindow = enrichActiveWindowWithOverlayReports(options.activeWindow || {});
    const toolContext = options.toolContext;
    if (isStaleToolHudRefresh(options, toolContext)) {
      retireStaleToolHudRefresh(activeWindow);
      writeHudDebugLog({
        event: "hud-refresh",
        id: debugId,
        outcome: "stale-decision",
        decisionVersion: options.decisionVersion || null,
        currentVersion: latestOverlayDecision?.version || null,
        currentMode: latestOverlayDecision?.mode || null,
        activeWindow: summarizeHudWindow(activeWindow),
        detectedTool: summarizeHudTool(toolContext?.tool || null)
      });
      return false;
    }
    const snapshot = latestSnapshot || collectSnapshot();
    const anchorWindow = toolContext?.window || getHudAnchorWindow(activeWindow);
    const tool = toolContext?.tool || null;
    const payloadWindow = tool ? anchorWindow || activeWindow : activeWindow;
    latestHudPayload = buildHudPayload(snapshot, payloadWindow, tool);
    const debugBase = isHudDebugEnabled()
      ? buildHudDebugEntry({
          id: debugId,
          snapshot,
          activeWindow,
          anchorWindow,
          tool,
          payload: latestHudPayload
        })
      : null;

    if (!latestHudPayload.visible) {
      setToolHudMouseRegion(false);
      hideToolHudHitbox();
      toolHudWindow.hide();
      hideHudTrustPopover("hud");
      clearWarmToolHudPayload();
      writeHudDebugLog({
        ...(debugBase || {}),
        outcome: "hidden-no-tool",
        hudWindowVisible: false
      });
      return false;
    }

    const display = getDisplayForActiveWindow(anchorWindow || activeWindow);
    const hudBounds = getHudBounds(display, tool, anchorWindow || activeWindow, settings);
    setWindowBoundsIfChanged(toolHudWindow, hudBounds);
    sendHudUpdate(latestHudPayload);
    lastVisibleHudPayload = latestHudPayload;
    lastVisibleHudBounds = hudBounds;
    lastVisibleHudAt = Date.now();
    cacheWarmToolHudPayload();
    if (isStaleToolHudRefresh(options, toolContext)) {
      retireStaleToolHudRefresh(activeWindow);
      writeHudDebugLog({
        ...(debugBase || {}),
        outcome: "stale-before-show",
        decisionVersion: options.decisionVersion || null,
        currentVersion: latestOverlayDecision?.version || null,
        currentMode: latestOverlayDecision?.mode || null
      });
      return false;
    }
    showToolHudWindow(hudBounds);
    writeHudDebugLog({
      ...(debugBase || {}),
      outcome: "shown",
      hudBounds,
      hudWindowVisible: toolHudWindow.isVisible()
    });
    return true;
  } finally {
    hudRefreshInFlight = false;
  }
}

function cacheWarmToolHudPayload() {
  if (!lastVisibleHudPayload?.visible || !lastVisibleHudPayload.tool?.id) return;
  if (!lastVisibleHudPayload.activeWindow?.hwnd || !lastVisibleHudBounds) return;
  warmToolHudPayload = lastVisibleHudPayload;
  warmToolHudBounds = lastVisibleHudBounds;
  warmToolHudAt = lastVisibleHudAt || Date.now();
}

function clearWarmToolHudPayload() {
  warmToolHudPayload = null;
  warmToolHudBounds = null;
  warmToolHudAt = 0;
}

function showToolHudWindow(hudBounds = null, options = {}) {
  if (!toolHudWindow || toolHudWindow.isDestroyed()) return;
  const promoteVisible = options.promoteVisible !== false;
  restoreOverlayWindowIfMinimized(toolHudWindow);
  reinforceNonActivatingWindow(toolHudWindow); // Pre-reinforce before alwaysOnTop + visibility changes
  toolHudWindow.setAlwaysOnTop(true, "floating");
  setToolHudMouseRegion(false);
  if (!toolHudWindow.isVisible()) {
    toolHudWindow.showInactive();
  } else if (promoteVisible && typeof toolHudWindow.moveTop === "function") {
    toolHudWindow.moveTop();
  }
  reinforceNonActivatingWindow(toolHudWindow); // Post-reinforce after showInactive/moveTop may reset flags
  showToolHudHitbox(hudBounds || toolHudWindow.getBounds(), { promoteVisible });
}

function isStaleToolHudRefresh(options, toolContext) {
  if (options.decisionVersion && latestOverlayDecision?.version !== options.decisionVersion) return true;
  if (latestOverlayDecision?.mode !== "tool-hud") return true;

  const expectedToolId = latestOverlayDecision.toolContext?.tool?.id || null;
  const nextToolId = toolContext?.tool?.id || null;
  if (expectedToolId && nextToolId && expectedToolId !== nextToolId) return true;

  const expectedHwnd = String(latestOverlayDecision.toolContext?.window?.hwnd || latestOverlayDecision.activeWindow?.hwnd || "");
  const nextHwnd = String(toolContext?.window?.hwnd || "");
  return Boolean(expectedHwnd && nextHwnd && expectedHwnd !== nextHwnd);
}

function retireStaleToolHudRefresh(activeWindow) {
  if (latestOverlayDecision?.mode === "desktop-topbar" || isDesktopOverlayForeground(latestOverlayDecision?.activeWindow)) {
    hideToolHudForDesktop(latestOverlayDecision.activeWindow || activeWindow);
    return;
  }
  if (latestOverlayDecision?.suppressHud) {
    hideToolHudForUnsupportedForeground(latestOverlayDecision.activeWindow || activeWindow, null);
  }
}



function writeHudDebugLog(entry) {
  if (!isHudDebugEnabled()) return;
  try {
    const filePath = getHudDebugLogPath();
    trimHudDebugLog(filePath);
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    })}\n`;
    fs.appendFileSync(filePath, line, "utf8");
  } catch {
    // Debug logging must never affect HUD behavior.
  }
}

function isHudDebugEnabled() {
  return Boolean(settings.behavior?.debugHud || process.env.WHO_EATS_TOKEN_DEBUG_HUD === "1");
}

function getHudDebugLogPath() {
  return path.join(app.getPath("userData"), "hud-debug.ndjson");
}

function cleanupHudDebugLog() {
  const filePath = getHudDebugLogPath();
  try {
    if (!fs.existsSync(filePath)) return;
    if (!isHudDebugEnabled()) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    trimHudDebugLog(filePath);
  } catch {
    // Debug cleanup must never affect app startup.
  }
}

function trimHudDebugLog(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= HUD_DEBUG_LOG_MAX_BYTES) return;
    const fd = fs.openSync(filePath, "r");
    try {
      const keepBytes = Math.floor(HUD_DEBUG_LOG_MAX_BYTES / 2);
      const buffer = Buffer.alloc(keepBytes);
      fs.readSync(fd, buffer, 0, keepBytes, Math.max(0, stat.size - keepBytes));
      const text = buffer.toString("utf8");
      const firstNewline = text.indexOf("\n");
      fs.writeFileSync(filePath, firstNewline >= 0 ? text.slice(firstNewline + 1) : text, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Debug trimming must stay best-effort.
  }
}

function enrichActiveWindowWithOverlayReports(activeWindow) {
  if (!activeWindow || !ingestServer?.getOverlayReports) return activeWindow;

  const reports = ingestServer.getOverlayReports();
  if (reports.length === 0) return activeWindow;

  const activeBounds = normalizeBounds(activeWindow.bounds);
  const relevantReports = reports.filter((report) => {
    if (!isOverlayReportForActiveWindow(activeWindow, report)) return false;
    if (!activeBounds) return true;
    if (!Array.isArray(report.overlays) || report.overlays.length === 0) return true;
    return report.overlays.some((overlay) => boundsOverlap(activeBounds, normalizeBounds(overlay.bounds)));
  });
  if (relevantReports.length === 0) return activeWindow;

  const overlayHints = relevantReports.flatMap((report) =>
    (report.overlays || []).map((overlay) => ({
      ...overlay,
      source: report.source,
      url: report.url,
      title: report.title,
      timestamp: report.timestamp
    }))
  );

  return {
    ...activeWindow,
    contentOverlays: [
      ...(Array.isArray(activeWindow.contentOverlays) ? activeWindow.contentOverlays : []),
      ...overlayHints
    ]
  };
}

function isOverlayReportForActiveWindow(activeWindow, report) {
  const processName = String(activeWindow?.processName || "").toLowerCase();
  const title = String(activeWindow?.title || "");
  const url = String(activeWindow?.url || "");
  const reportTitle = String(report?.title || "");
  const reportUrl = String(report?.url || "");

  if (processName === "hermes-web-ui") return true;
  if (!["arc", "brave browser", "chrome", "firefox", "google chrome", "microsoft edge", "msedge", "browser", "safari"].includes(processName)) return false;

  const titleLooksHermes =
    /^hermes(?:\s+(?:web\s*ui|agent|chat))?(?:\s*-\s*(google chrome|microsoft edge|mozilla firefox|firefox|safari))?$/i.test(title.trim()) ||
    /(127\.0\.0\.1:8648|localhost:8648|\/hermes\/chat)/i.test(url);
  const reportLooksHermes = /(127\.0\.0\.1:8648|localhost:8648|\/hermes\/chat|title=Hermes)/i.test(reportUrl) ||
    /^hermes(?:\s+(?:web\s*ui|agent|chat))?$/i.test(reportTitle.trim());

  return titleLooksHermes && reportLooksHermes;
}



function maybeSendLowCapacityAlerts(snapshot) {
  if (!Notification.isSupported()) return;
  if (!settings.behavior.alertsEnabled) return;

  for (const provider of snapshot.providers || []) {
    const windows = [
      ["primary", "5小时", provider.latest?.rateLimits?.primary],
      ["secondary", "一周", provider.latest?.rateLimits?.secondary]
    ];

    for (const [windowId, label, window] of windows) {
      const remaining = getWindowRemaining(window);
      const tier = getAlertTier(remaining);
      if (!tier) continue;

      const key = `${provider.id}:${windowId}:${tier.id}:${window.resetsAt || "unknown"}`;
      if (capacityAlertKeys.has(key)) continue;
      capacityAlertKeys.add(key);

      new Notification({
        title: tier.title,
        body: `${provider.name} ${label}余量 ${remaining}%${formatResetForNotification(window.resetsAt)}`
      }).show();
    }

    const tokenPlan = provider.latest?.tokenPlan;
    const tokenPlanRemaining = roundedNumberOrNull(tokenPlan?.remainingPercent);
    const tokenPlanTier = getAlertTier(tokenPlanRemaining);
    if (tokenPlanTier) {
      const key = `${provider.id}:token-plan:${tokenPlanTier.id}:${tokenPlan.planName || "unknown"}`;
      if (!capacityAlertKeys.has(key)) {
        capacityAlertKeys.add(key);
        new Notification({
          title: tokenPlanTier.title,
          body: `${provider.name} Token Plan 余量 ${tokenPlanRemaining}%`
        }).show();
      }
    }

    const context = provider.latest?.context;
    const contextRemaining = roundedNumberOrNull(context?.remainingPercent);
    const contextTier = getAlertTier(contextRemaining);
    if (contextTier) {
      const key = `${provider.id}:context:${contextTier.id}:${context.sessionId || "unknown"}`;
      if (!capacityAlertKeys.has(key)) {
        capacityAlertKeys.add(key);
        new Notification({
          title: contextTier.title,
          body: `${provider.name} 上下文余量 ${contextRemaining}%`
        }).show();
      }
    }
  }
}

function getAlertTier(remaining) {
  if (remaining === null || remaining === undefined) return null;
  return getAlertTiers().find((tier) => remaining < tier.threshold) || null;
}

function getAlertTiers() {
  return [
    { id: "critical", threshold: settings.alertThresholds.critical, title: "LLM 余量紧急" },
    { id: "danger", threshold: settings.alertThresholds.danger, title: "LLM 余量告警" },
    { id: "caution", threshold: settings.alertThresholds.caution, title: "LLM 余量偏紧" }
  ];
}







function getPublicSettings(sourceSettings = settings) {
  return {
    ...sourceSettings,
    providerRegistry: getProviderRegistry(sourceSettings),
    desktopBarStage: getDesktopBarRendererLayout(sourceSettings, getPrimaryDisplay())
  };
}

function getLocalSetupInfo() {
  return {
    endpoint: `http://127.0.0.1:${INGEST_PORT}`,
    tokenFile: localApiAccess?.tokenFile || null,
    tokenSource: localApiAccess?.source === "env" ? "WHO_EATS_TOKEN_API_TOKEN" : "api-token.txt",
    statusCommand: "npm run status"
  };
}

async function openGuideDocument(guide) {
  const relativePath = GUIDE_DOCUMENTS[String(guide || "")];
  if (!relativePath) return { ok: false, error: "Unknown guide." };
  const documentPath = path.resolve(__dirname, "..", relativePath);
  if (!fs.existsSync(documentPath)) return { ok: false, error: "Guide document was not found." };
  const error = await shell.openPath(documentPath);
  return { ok: !error, error: error || null };
}

function updateSettings(nextSettings) {
  const previous = settings;
  settings = saveSettings(app.getPath("userData"), guardSettingsPayload(nextSettings));
  applySettings(previous, settings);
  return getPublicSettings();
}

function previewSettings(nextSettings) {
  const guardedSettings = guardSettingsPayload(nextSettings);
  try {
    const preview = sanitizeSettings({
      ...settings,
      appearance: {
        ...settings.appearance,
        ...(guardedSettings?.appearance || {})
      },
      windows: {
        ...settings.windows,
        desktopWidthRatio: guardedSettings?.windows?.desktopWidthRatio ?? settings.windows.desktopWidthRatio,
        desktopBarHeight: guardedSettings?.windows?.desktopBarHeight ?? settings.windows.desktopBarHeight,
        toolHudWidth: guardedSettings?.windows?.toolHudWidth ?? settings.windows.toolHudWidth,
        toolHudHeight: guardedSettings?.windows?.toolHudHeight ?? settings.windows.toolHudHeight,
        toolHudOffsetX: guardedSettings?.windows?.toolHudOffsetX ?? settings.windows.toolHudOffsetX,
        toolHudOffsetY: guardedSettings?.windows?.toolHudOffsetY ?? settings.windows.toolHudOffsetY
      }
    });
    resizeDesktopBar(preview);
    resizeToolHud(preview, settings);
    broadcastSettings(preview, [desktopBarWindow, toolHudWindow, toolHudHitboxWindow, hudTrustPopoverWindow]);
    return {
      ok: true,
      settings: getPublicSettings(preview)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "preview failed",
      settings: getPublicSettings()
    };
  }
}

function applySettings(previous, current) {
  resizeDesktopBar();
  resizeToolHud(current, previous);
  restartIngestServerIfNeeded(previous, current);
  restartHermesBridgeIfNeeded(previous, current);
  restartCodexSessionWatcher();
  maybeInstallHermesOverlay(previous, current);
  applyLoginItemSettings();
  scheduleTimers();
  broadcastSettings();
  updateTray();
  cleanupUntrackedTools();
  seedTrackedTools();
  scheduleToolProcessScan();
  refreshOverlayCoordinator();
  sendSnapshot();
}

function maybeInstallHermesOverlay(previous = null, current = settings) {
  const enabled = Boolean(current.integrations?.hermesOverlayAutoInstall);
  if (!enabled) return [];

  const wasEnabled = Boolean(previous?.integrations?.hermesOverlayAutoInstall);
  if (previous && wasEnabled) return [];

  try {
    return ensureHermesOverlayInstalled({ accessToken: localApiAccess?.token || "" });
  } catch {
    // Optional third-party UI injection must never break the monitor itself.
    return [];
  }
}

function broadcastSettings(sourceSettings = settings, targetWindows = [desktopBarWindow, toolHudWindow, toolHudHitboxWindow, hudTrustPopoverWindow, settingsWindow]) {
  const publicSettings = getPublicSettings(sourceSettings);
  for (const window of targetWindows) {
    if (window && !window.isDestroyed()) {
      try {
        safeSend(window, "settings:update", publicSettings);
      } catch {
        // A renderer can disappear while a live preview is in flight; the next settings broadcast will catch up.
      }
    }
  }
}

function restartIngestServerIfNeeded(previous, current) {
  const previousEnabled = previous?.providers?.ingest?.enabled !== false;
  const currentEnabled = current.providers?.ingest?.enabled !== false;
  const securityChanged = hasLocalApiSecurityChanged(previous, current);
  if (previousEnabled === currentEnabled && ingestServer && !securityChanged) return;
  restartIngestServer();
}

function restartIngestServer() {
  ingestServer = restartIngestLocalServer(ingestServer, {
    enabled: isProviderEnabled("ingest"),
    port: INGEST_PORT,
    accessToken: localApiAccess?.token || null,
    security: {
      allowUnauthenticatedNoOrigin: settings.security?.allowUnauthenticatedNoOrigin === true
    },
    getSnapshot: () => collectSnapshot()
  });
}

function restartHermesBridgeIfNeeded(previous, current) {
  const previousEnabled = previous?.providers?.hermes?.enabled !== false;
  const currentEnabled = current.providers?.hermes?.enabled !== false;
  const securityChanged = hasLocalApiSecurityChanged(previous, current);
  if (previousEnabled === currentEnabled && hermesBridgeServer && !securityChanged) return;
  restartHermesBridge();
}

function hasLocalApiSecurityChanged(previous, current) {
  if (!previous || !current) return false;
  return (previous.security?.allowUnauthenticatedNoOrigin === true) !==
    (current.security?.allowUnauthenticatedNoOrigin === true);
}

function restartHermesBridge() {
  hermesBridgeServer = restartHermesBridgeServer(hermesBridgeServer, {
    enabled: isProviderEnabled("hermes"),
    port: HERMES_BRIDGE_PORT,
    targetBaseUrl: "http://127.0.0.1:8642",
    ingestUrl: `http://127.0.0.1:${INGEST_PORT}/events`,
    accessToken: localApiAccess?.token || null,
    ingestToken: localApiAccess?.token || null,
    security: {
      allowUnauthenticatedNoOrigin: settings.security?.allowUnauthenticatedNoOrigin === true
    }
  });
}

function restartCodexSessionWatcher() {
  stopCodexSessionWatcher();
  if (!isProviderEnabled("codex")) return;

  const codexSessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(codexSessionsRoot)) return;

  try {
    codexSessionWatcher = fs.watch(
      codexSessionsRoot,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (filename && !String(filename).endsWith(".jsonl")) return;
        scheduleCodexSessionRefresh();
      }
    );
    codexSessionWatcher.on("error", stopCodexSessionWatcher);
  } catch {
    codexSessionWatcher = null;
  }
}

function stopCodexSessionWatcher() {
  if (codexSessionWatchTimer) {
    clearTimeout(codexSessionWatchTimer);
    codexSessionWatchTimer = null;
  }
  if (!codexSessionWatcher) return;
  try {
    codexSessionWatcher.close();
  } catch {
    // File watchers can already be closed during app shutdown.
  }
  codexSessionWatcher = null;
}

function scheduleCodexSessionRefresh() {
  if (isQuitting) return;
  if (codexSessionWatchTimer) clearTimeout(codexSessionWatchTimer);
  codexSessionWatchTimer = setTimeout(() => {
    codexSessionWatchTimer = null;
    sendSnapshot();
    refreshOverlayCoordinator();
  }, CODEX_SESSION_WATCH_DEBOUNCE_MS);
  codexSessionWatchTimer.unref?.();
}

function applyUserDataOverride() {
  const override = String(process.env.WHO_EATS_TOKEN_USER_DATA_DIR || "").trim();
  if (!override) return;
  try {
    const resolved = path.resolve(override);
    fs.mkdirSync(resolved, { recursive: true });
    app.setPath("userData", resolved);
  } catch {
    // Smoke tests can use an isolated userData directory; production falls back to Electron defaults.
  }
}

function readPortEnv(name, fallback) {
  const port = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback;
}

function scheduleTimers() {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (desktopBarTimer) clearTimeout(desktopBarTimer);
  if (systemTimer) clearInterval(systemTimer);
  snapshotTimer = null;
  scheduleNextSnapshotRefresh();
  systemTimer = setInterval(sendSystemMetrics, SYSTEM_REFRESH_MS);
  if (isHeadlessRuntime()) return;
  scheduleOverlayCoordinatorTick(0);
}

function applyLoginItemSettings() {
  try {
    const options = {
      openAtLogin: settings.system.startAtLogin
    };
    if (!app.isPackaged) {
      options.path = process.execPath;
      options.args = [app.getAppPath()];
    }
    app.setLoginItemSettings(options);
  } catch {
    // Windows may reject this under unusual packaged/dev contexts; the UI still keeps the saved preference.
  }
}

ipcMain.handle("metrics:snapshot", () => getSnapshotForRenderer(latestSnapshot || collectSnapshot()));
ipcMain.handle("hud:snapshot", () => latestHudPayload);
ipcMain.handle("settings:get", () => getPublicSettings());
ipcMain.handle("setup:info", () => getLocalSetupInfo());
ipcMain.handle("guide:open", (_event, guide) => openGuideDocument(guide));
ipcMain.handle("tools:scan", () => scanAvailableTools());
ipcMain.handle("tools:registry", () => Array.from(toolRegistry.values()));
ipcMain.handle("settings:save", (_event, nextSettings) => updateSettings(nextSettings));
ipcMain.handle("settings:preview", (_event, nextSettings) => previewSettings(nextSettings));
ipcMain.handle("settings:reset", () => updateSettings(sanitizeSettings()));
ipcMain.handle("desktop-bar:mouse-region", (_event, interactive) => setDesktopBarMouseRegion(guardBooleanPayload(interactive)));
ipcMain.handle("hud:mouse-region", (_event, interactive) => setToolHudMouseRegion(guardBooleanPayload(interactive)));
ipcMain.handle("hud-hitbox:mouse-region", (_event, interactive) => setToolHudHitboxMouseRegion(guardBooleanPayload(interactive)));
ipcMain.handle("settings:open", (event, owner) => {
  openSettingsWindow(String(owner || "") || getSettingsOverlayOwnerFromWindow(BrowserWindow.fromWebContents(event.sender)));
  return true;
});
ipcMain.handle("settings:close", () => {
  closeSettingsWindow();
  return true;
});
ipcMain.handle("hud-trust-popover:show", (event, payload) =>
  showHudTrustPopover(guardHudTrustPopoverPayload(payload), BrowserWindow.fromWebContents(event.sender))
);
ipcMain.handle("hud-trust-popover:hide", (event) => {
  hideHudTrustPopover(getHudTrustPopoverOwner(BrowserWindow.fromWebContents(event.sender)));
  return true;
});
ipcMain.handle("hud-trust-popover:resize", (_event, size) => resizeHudTrustPopover(guardHudTrustPopoverSize(size)));

ipcMain.handle("window:toggle-expanded", () => {
  openSettingsWindow("desktop");
  return true;
});

ipcMain.handle("window:close", () => {
  isQuitting = true;
  app.quit();
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  const headless = isHeadlessRuntime();
  registerDisplayChangeListeners();
  settings = loadSettings(app.getPath("userData"));
  localApiAccess = getLocalApiAccess(app.getPath("userData"));
  cleanupHudDebugLog();
  maybeInstallHermesOverlay(null, settings);
  applyLoginItemSettings();
  restartIngestServer();
  restartHermesBridge();
  restartCodexSessionWatcher();
  seedTrackedTools();
  scheduleToolProcessScan();
  if (!headless) {
    createDesktopBarWindow();
    createToolHudWindow();
    createTray();
  }
  scheduleTimers();
  if (headless) {
    sendSystemMetrics();
    sendSnapshot();
  } else {
    setTimeout(refreshOverlayCoordinator, 500);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDesktopBarWindow();
      createToolHudWindow();
    }
  });
});

function isHeadlessRuntime() {
  return process.env.WHO_EATS_TOKEN_HEADLESS_SMOKE === "1";
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (desktopBarTimer) clearTimeout(desktopBarTimer);
  if (toolDecisionSnapshotTimer) clearTimeout(toolDecisionSnapshotTimer);
  if (overlayDeferredRetryTimer) clearTimeout(overlayDeferredRetryTimer);
  clearToolDesktopWake();
  if (systemTimer) clearInterval(systemTimer);
  stopCodexSessionWatcher();
  stopToolProcessScan();
  closeServer(ingestServer);
  closeServer(hermesBridgeServer);
});

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") app.quit();
});
