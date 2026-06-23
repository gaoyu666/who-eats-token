"use strict";

const { boundsOverlap, getWindowArea, normalizeBounds } = require("./geometry-service.cjs");

/**
 * Tool detection and window classification — pure functions.
 * External dependencies are injected via createToolDetection().
 */

function createToolDetection({
  detectTool,
  getToolHudSize,
  isDesktopForegroundWindow,
  isDialogWindow,
  getDisplayBounds,
  getDesktopBarVisualBounds,
  isOwnDesktopBar
}) {
  // ── Window classification helpers ─────────────────────────────────

  function isDesktopOverlayForeground(activeWindow) {
    return isDesktopForeground(activeWindow) || isDesktopShellTransientForeground(activeWindow);
  }

  function isForegroundSamplingNoise(activeWindow) {
    return !activeWindow ||
      Boolean(activeWindow.foregroundFallbackMiss || activeWindow.samplingNoise) ||
      isZeroSizedExplorerForeground(activeWindow);
  }

  function isHudSuppressingForegroundPopup(activeWindow) {
    return isHudSuppressingShellPopup(activeWindow) ||
      isToolPopupMenuForeground(activeWindow) ||
      getHudSuppressingDesktopBlockers(activeWindow).length > 0;
  }

  function getHudSuppressingDesktopBlockers(activeWindow) {
    const blockers = Array.isArray(activeWindow?.desktop?.blockers)
      ? activeWindow.desktop.blockers
      : [];
    return blockers.filter((blocker) =>
      isHudSuppressingShellPopup(blocker) ||
      isToolPopupMenuForeground(blocker)
    );
  }

  function isHudSuppressingShellPopup(activeWindow) {
    const processName = String(activeWindow?.processName || "").toLowerCase();
    const path = String(activeWindow?.path || "").toLowerCase();
    const className = String(activeWindow?.className || "").trim().toLowerCase();
    const title = String(activeWindow?.title || "").trim().toLowerCase();
    const isExplorer = processName === "explorer" || path.endsWith("\\explorer.exe") || path.endsWith("/explorer.exe");
    if (!isExplorer) return false;
    if ([
      "shell_traywnd",
      "shell_secondarytraywnd",
      "dv2controlhost",
      "notifyiconoverflowwindow",
      "toplevelwindowforoverflowxamlisland",
      "xaml_hosting_windowedpopupclass",
      "xaml_hosting_windowed_popup_class",
      "tasklistthumbnailwnd",
      "taskswitcherwnd",
      "mstasklistwclass"
    ].includes(className)) {
      return true;
    }
    return /notifyicon|overflow|hidden icons|tray|taskbar/.test(title);
  }

  function isToolPopupMenuForeground(activeWindow) {
    const processName = String(activeWindow?.processName || "").toLowerCase();
    const path = String(activeWindow?.path || "").toLowerCase();
    const className = String(activeWindow?.className || "").trim().toLowerCase();
    const title = String(activeWindow?.title || "").trim();
    const bounds = normalizeBounds(activeWindow?.bounds);
    const isExplorer = processName === "explorer" || path.endsWith("\\explorer.exe") || path.endsWith("/explorer.exe");
    if (isExplorer) return false;
    if (!detectTool(activeWindow)) return false;
    if (className === "#32768") return true;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
    if (bounds.width > 720 || bounds.height > 520) return false;
    if (!title) return true;
    return /menu|popup|context|tooltip|dropdown|flyout/.test(className);
  }

  function isZeroSizedExplorerForeground(activeWindow) {
    const processName = String(activeWindow?.processName || "").toLowerCase();
    const pathText = String(activeWindow?.path || "").toLowerCase();
    const title = String(activeWindow?.title || "").trim();
    const bounds = normalizeBounds(activeWindow?.bounds);
    const isExplorer = processName === "explorer" ||
      processName === "windows 资源管理器" ||
      pathText.endsWith("\\explorer.exe") ||
      pathText.endsWith("/explorer.exe");
    return isExplorer &&
      !title &&
      Boolean(bounds) &&
      (bounds.width <= 0 || bounds.height <= 0);
  }

  function isDesktopShellTransientForeground(activeWindow) {
    const processName = String(activeWindow?.processName || "").toLowerCase();
    const path = String(activeWindow?.path || "").toLowerCase();
    const className = String(activeWindow?.className || "").trim().toLowerCase();
    const title = String(activeWindow?.title || "").trim().toLowerCase();
    const bounds = activeWindow?.bounds || {};
    const isExplorer = processName === "explorer" || path.endsWith("\\explorer.exe") || path.endsWith("/explorer.exe");
    if (!isExplorer) return false;
    if (className === "tasklistthumbnailwnd" || className === "notifyiconoverflowwindow") return false;
    if (/notifyicon|overflow|hidden icons|隐藏.*图标|通知区域|系统托盘|任务栏/.test(title)) return false;
    if (className === "#32768") return true;
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 720 && height <= 520;
  }

  function isShellForegroundWindow(activeWindow) {
    const processName = String(activeWindow?.processName || "").toLowerCase();
    const className = String(activeWindow?.className || "").toLowerCase();
    const title = String(activeWindow?.title || "").trim().toLowerCase();
    const path = String(activeWindow?.path || "").toLowerCase();
    const shellClasses = [
      "shell_traywnd",
      "shell_secondarytraywnd",
      "progman",
      "workerw",
      "#32768",
      "dv2controlhost",
      "notifyiconoverflowwindow",
      "toplevelwindowforoverflowxamlisland",
      "tasklistthumbnailwnd",
      "taskswitcherwnd",
      "mstasklistwclass",
      "windows.ui.core.corewindow",
      "xaml_hosting_windowedpopupclass",
      "xaml_hosting_windowed_popup_class"
    ];
    if (shellClasses.includes(className)) return true;
    const shellProcesses = [
      "shellexperiencehost",
      "shellexperiencehost.exe",
      "startmenuexperiencehost",
      "startmenuexperiencehost.exe",
      "searchhost",
      "searchhost.exe"
    ];
    if (shellProcesses.includes(processName)) return true;

    const isExplorer = processName === "explorer" || path.endsWith("\\explorer.exe") || path.endsWith("/explorer.exe");
    if (!isExplorer) return false;
    if (!title || title === "program manager" || title === "desktop" || title === "桌面") return true;
    return /notifyicon|overflow|hidden icons|隐藏.*图标|通知区域|系统托盘|任务栏/.test(title);
  }

  function hasDesktopForegroundBlocker(activeWindow) {
    const desktop = activeWindow?.desktop;
    if (!desktop || desktop.clear !== false) return false;
    const blockerCount = Number(desktop.blockerCount);
    return Number.isFinite(blockerCount) && blockerCount > 0;
  }

  function isForegroundFullscreen(activeWindow) {
    const bounds = normalizeBounds(activeWindow?.bounds);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
    const displayBounds = getDisplayBounds(activeWindow);
    if (!displayBounds || displayBounds.width <= 0 || displayBounds.height <= 0) return false;

    const horizontalCoverage = bounds.width / displayBounds.width;
    const verticalCoverage = bounds.height / displayBounds.height;
    const leftAligned = bounds.x <= displayBounds.x + 8;
    const topAligned = bounds.y <= displayBounds.y + 8;
    return horizontalCoverage >= 0.98 && verticalCoverage >= 0.98 && leftAligned && topAligned;
  }

  function isDesktopForeground(activeWindow) {
    if (!activeWindow) return false;
    return isDesktopForegroundWindow(activeWindow, process.platform);
  }

  function doesWindowOverlapDesktopBar(windowInfo) {
    if (!windowInfo || isOwnDesktopBar(windowInfo)) return false;
    const bounds = normalizeBounds(windowInfo.bounds);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
    return boundsOverlap(bounds, getDesktopBarVisualBounds());
  }

  function shouldShowDesktopBar(activeWindow) {
    if (!activeWindow) return false;
    if (isOwnDesktopBar(activeWindow)) return false;
    if (hasDesktopForegroundBlocker(activeWindow)) return false;
    return isDesktopOverlayForeground(activeWindow);
  }

  // ── Tool detection ────────────────────────────────────────────────

  function addWindowCandidate(candidates, windowInfo) {
    if (!windowInfo) return;
    const key = `${windowInfo.hwnd || ""}:${windowInfo.pid || ""}:${windowInfo.processName || ""}:${windowInfo.title || ""}`;
    if (candidates.some((candidate) =>
      `${candidate.hwnd || ""}:${candidate.pid || ""}:${candidate.processName || ""}:${candidate.title || ""}` === key
    )) {
      return;
    }
    candidates.push(windowInfo);
  }

  function isPotentialDialogParentWindow(activeWindow, blocker) {
    const activePid = Number(activeWindow?.pid) || null;
    const blockerPid = Number(blocker?.pid) || null;
    if (activePid && blockerPid && activePid === blockerPid) return true;
    return boundsOverlap(normalizeBounds(activeWindow?.bounds), normalizeBounds(blocker?.bounds));
  }

  function shouldInspectDesktopBlockersForToolDetection(activeWindow) {
    if (!activeWindow) return false;
    if (isHudSuppressingForegroundPopup(activeWindow)) return false;
    if (isDialogWindow(activeWindow)) return true;
    return hasDesktopForegroundBlocker(activeWindow);
  }

  function getToolDetectionBlockers(activeWindow) {
    if (!shouldInspectDesktopBlockersForToolDetection(activeWindow)) return [];
    const blockers = Array.isArray(activeWindow?.desktop?.blockers)
      ? activeWindow.desktop.blockers
      : [];
    if (!isDialogWindow(activeWindow)) return blockers;
    return blockers.filter((blocker) => isPotentialDialogParentWindow(activeWindow, blocker));
  }

  function getToolDetectionCandidates(activeWindow) {
    const candidates = [];
    addWindowCandidate(candidates, activeWindow);
    addWindowCandidate(candidates, getHudAnchorWindow(activeWindow));

    if (!shouldInspectDesktopBlockersForToolDetection(activeWindow)) {
      return candidates;
    }

    for (const blocker of getToolDetectionBlockers(activeWindow)) {
      addWindowCandidate(candidates, blocker);
      addWindowCandidate(candidates, getHudAnchorWindow(blocker));
    }

    return candidates;
  }

  function getDetectedToolContext(activeWindow) {
    if (isHudSuppressingForegroundPopup(activeWindow)) return null;
    for (const candidateWindow of getToolDetectionCandidates(activeWindow)) {
      const anchorWindow = getHudAnchorWindow(candidateWindow);
      const tool = detectTool(candidateWindow) || detectTool(anchorWindow);
      if (tool) {
        return {
          tool,
          window: anchorWindow || candidateWindow
        };
      }
    }
    return null;
  }

  function getForegroundToolContext(activeWindow) {
    if (isHudSuppressingForegroundPopup(activeWindow)) return null;
    const candidates = [];
    addWindowCandidate(candidates, activeWindow);
    addWindowCandidate(candidates, getHudAnchorWindow(activeWindow));

    for (const candidateWindow of candidates) {
      const anchorWindow = getHudAnchorWindow(candidateWindow);
      const tool = detectTool(candidateWindow) || detectTool(anchorWindow);
      if (tool) {
        return {
          tool,
          window: anchorWindow || candidateWindow
        };
      }
    }
    return null;
  }

  function getHudAnchorWindow(activeWindow) {
    if (!isDialogWindow(activeWindow)) return activeWindow;

    const activePid = Number(activeWindow?.pid) || null;
    const size = getToolHudSize();
    const blockers = Array.isArray(activeWindow?.desktop?.blockers)
      ? activeWindow.desktop.blockers
      : [];
    const candidates = blockers
      .filter((windowInfo) => !isDialogWindow(windowInfo))
      .filter((windowInfo) => {
        const pid = Number(windowInfo?.pid) || null;
        return activePid && pid === activePid;
      })
      .filter((windowInfo) => {
        const bounds = windowInfo?.bounds;
        return Number(bounds?.width) > size.width && Number(bounds?.height) > size.height;
      })
      .sort((a, b) => getWindowArea(b) - getWindowArea(a));

    return candidates[0] || activeWindow;
  }

  function normalizeToolDesktopWakeProbeWindow(payload) {
    return {
      hwnd: String(payload?.hwnd || ""),
      processName: payload?.processName || "",
      path: payload?.path || "",
      title: payload?.title || "",
      className: payload?.className || "",
      bounds: normalizeBounds(payload?.bounds),
      source: payload?.source || "tool-desktop-wake-probe",
      desktop: {
        clear: true,
        blockerCount: 0,
        blockers: []
      }
    };
  }

  // ── Return public API ─────────────────────────────────────────────

  return {
    addWindowCandidate,
    doesWindowOverlapDesktopBar,
    getDetectedToolContext,
    getForegroundToolContext,
    getHudAnchorWindow,
    getToolDetectionBlockers,
    getToolDetectionCandidates,
    hasDesktopForegroundBlocker,
    getHudSuppressingDesktopBlockers,
    isDesktopForeground,
    isDesktopOverlayForeground,
    isDesktopShellTransientForeground,
    isForegroundFullscreen,
    isForegroundSamplingNoise,
    isHudSuppressingForegroundPopup,
    isHudSuppressingShellPopup,
    isPotentialDialogParentWindow,
    isShellForegroundWindow,
    isToolPopupMenuForeground,
    isZeroSizedExplorerForeground,
    normalizeToolDesktopWakeProbeWindow,
    shouldInspectDesktopBlockersForToolDetection,
    shouldShowDesktopBar
  };
}

module.exports = { createToolDetection };
