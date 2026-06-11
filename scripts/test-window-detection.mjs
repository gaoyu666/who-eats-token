import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { _test } = require("../src/system/active-window.cjs");
const activeWindowSource = fs.readFileSync(new URL("../src/system/active-window.cjs", import.meta.url), "utf8");

testMacPermissionOptions();
testMacDesktopDetection();
testWindowsDesktopForegroundGating();
testWindowsDesktopAssistantForeground();
testDesktopBlockerFiltering();
testOwnedOverlayForegroundFallback();
testOwnedOverlayInspectionFallback();
testFastDesktopMetadata();
testWindowStatusByHwnd();
testWindowsFallbackDecisions();

console.log("Window detection checks passed.");

function testMacPermissionOptions() {
  assert.deepEqual(
    _test.getNativeWindowOptions({ fast: "desktop" }, "darwin"),
    {
      accessibilityPermission: false,
      screenRecordingPermission: false
    },
    "macOS desktop checks should avoid permission prompts."
  );

  assert.deepEqual(
    _test.getNativeWindowOptions({}, "darwin"),
    {
      accessibilityPermission: true,
      screenRecordingPermission: true
    },
    "macOS HUD checks should request full active-window metadata."
  );

  assert.deepEqual(
    _test.getNativeWindowOptions({
      macAccessibilityPermission: false,
      macScreenRecordingPermission: false
    }, "darwin"),
    {
      accessibilityPermission: false,
      screenRecordingPermission: false
    },
    "macOS permission flags should be individually disableable for degraded checks."
  );

  assert.deepEqual(
    _test.getNativeWindowOptions({ fast: "desktop" }, "win32"),
    {},
    "Non-macOS platforms should not receive macOS permission flags."
  );
}

function testMacDesktopDetection() {
  assert.equal(
    _test.isMacDesktopForeground({
      processName: "Finder",
      bundleId: "com.apple.finder",
      title: ""
    }),
    true,
    "Finder with an empty title should count as desktop."
  );
  assert.equal(
    _test.isMacDesktopForeground({
      processName: "Finder",
      bundleId: "com.apple.finder",
      title: "Desktop"
    }),
    true,
    "Finder Desktop should count as desktop."
  );
  assert.equal(
    _test.isMacDesktopForeground({
      processName: "Finder",
      bundleId: "com.apple.finder",
      title: "Documents"
    }),
    false,
    "Finder file windows should not count as desktop."
  );
  assert.equal(
    _test.isMacDesktopForeground({
      processName: "Google Chrome",
      bundleId: "com.google.Chrome",
      title: "Hermes"
    }),
    false,
    "Browser foreground should not show the desktop top bar."
  );
}

function testWindowsDesktopForegroundGating() {
  const desktopArea = { x: 0, y: 0, width: 1920, height: 1080 };

  assert.equal(
    _test.isDesktopForegroundWindow(
      _test.normalizeNativeWindow(
        nativeWindow("explorer", "Program Manager", desktopArea, "", "C:\\Windows\\explorer.exe"),
        "win32"
      ),
      "win32"
    ),
    true,
    "Explorer Program Manager should count as the Windows desktop."
  );

  const zeroSizeExplorerShell = _test.normalizeNativeWindow(
    nativeWindow("Windows 资源管理器", "", { x: 0, y: 0, width: 0, height: 0 }, "", "C:\\Windows\\explorer.exe"),
    "win32"
  );
  assert.equal(
    _test.isDesktopForegroundWindow(zeroSizeExplorerShell, "win32"),
    false,
    "Zero-size Explorer foreground samples should not be confirmed desktop because they can appear during tool activation."
  );
  assert.equal(
    _test.getForegroundFallbackReason(zeroSizeExplorerShell, { desktopArea }, "win32"),
    "native-shell",
    "Zero-size Explorer foreground samples should go through rich shell fallback instead of directly showing the top bar."
  );
  assert.equal(
    _test.isZeroSizedExplorerShellWindow(zeroSizeExplorerShell, "win32"),
    true,
    "Zero-size Explorer foreground samples should be marked as shell noise for desktop base selection."
  );
  assert.deepEqual(
    _test.normalizeBounds(null),
    { x: 0, y: 0, width: 0, height: 0 },
    "Null native bounds should normalize to zero bounds instead of crashing the overlay coordinator."
  );
  assert.equal(
    _test.isDesktopForegroundWindow({
      processName: "Windows 资源管理器",
      title: "",
      path: "C:\\Windows\\explorer.exe",
      className: "",
      bounds: null
    }, "win32"),
    false,
    "Windows foreground samples with null bounds must not crash desktop foreground detection."
  );
  const visibleCodexWindow = nativeWindow(
    "Codex",
    "Codex",
    { x: 0, y: 0, width: 1600, height: 1000 },
    "",
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.527.3686.0_x64__2p2nqsd0c76g0\\app\\Codex.exe"
  );
  const programManagerWindow = nativeWindow(
    "explorer",
    "Program Manager",
    desktopArea,
    "",
    "C:\\Windows\\explorer.exe",
    {
      className: "Progman"
    }
  );
  const rawZeroSizeExplorerShell = nativeWindow("Windows 资源管理器", "", { x: 0, y: 0, width: 0, height: 0 }, "", "C:\\Windows\\explorer.exe");
  const selectedAfterZeroSizeShell = _test.selectDesktopBaseWindow(
    zeroSizeExplorerShell,
    [rawZeroSizeExplorerShell, programManagerWindow, visibleCodexWindow],
    { desktopArea },
    "win32"
  );
  assert.equal(
    selectedAfterZeroSizeShell?.title,
    "Codex",
    "A zero-size Explorer shell sample during tool activation should prefer the visible application over the desktop base."
  );

  assert.equal(
    _test.isDesktopForegroundWindow(
      _test.normalizeNativeWindow(
        nativeWindow("Windows 资源管理器", "", { x: 0, y: 952, width: 1600, height: 48 }, "", "C:\\Windows\\explorer.exe"),
        "win32"
      ),
      "win32"
    ),
    false,
    "The Windows taskbar foreground should not be misclassified as the desktop."
  );

  assert.equal(
    _test.isNativeShellForegroundCandidate(
      _test.normalizeNativeWindow(
        nativeWindow("Windows 资源管理器", "", { x: 0, y: 952, width: 1600, height: 48 }, "", "C:\\Windows\\explorer.exe"),
        "win32"
      ),
      "win32"
    ),
    true,
    "Native taskbar foreground reports should use Win32 fallback so blockers stay in z-order."
  );

  assert.equal(
    _test.isDesktopForegroundWindow(
      _test.normalizeNativeWindow(
        nativeWindow("explorer", "Downloads", { x: 80, y: 80, width: 1200, height: 800 }, "", "C:\\Windows\\explorer.exe"),
        "win32"
      ),
      "win32"
    ),
    false,
    "Regular File Explorer windows should not count as the Windows desktop."
  );

  assert.equal(
    _test.isDesktopForegroundWindow(
      _test.normalizeNativeWindow(
        nativeWindow(
          "SystemSettings",
          "登录选项",
          { x: 0, y: 0, width: 1600, height: 900 },
          "",
          "C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe"
        ),
        "win32"
      ),
      "win32"
    ),
    false,
    "Windows Settings should not count as a clear desktop even if no blockers are reported."
  );

  assert.equal(
    _test.isDesktopForegroundWindow(
      _test.normalizeNativeWindow(
        nativeWindow(
          "ApplicationFrameHost",
          "Windows Hello 安装程序",
          { x: 460, y: 360, width: 920, height: 840 },
          "",
          "C:\\Windows\\System32\\ApplicationFrameHost.exe"
        ),
        "win32"
      ),
      "win32"
    ),
    false,
    "Windows Hello setup dialogs should not allow the desktop top bar."
  );
}

function testWindowsDesktopAssistantForeground() {
  const desktopArea = { x: 0, y: 0, width: 1600, height: 1000 };
  const clickToDoPath = "C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CoreAI_cw5n1h2txyewy\\ClickToDo.exe";
  const clickToDo = _test.normalizeNativeWindow(
    nativeWindow("ClickToDo.exe", "单击以执行", desktopArea, "", clickToDoPath),
    "win32"
  );
  const narratorHelper = _test.normalizeNativeWindow(
    nativeWindow("svchost", "", { x: -32000, y: -32000, width: 16, height: 16 }, "", "C:\\Windows\\System32\\svchost.exe", {
      className: "NarratorHelperWindow"
    }),
    "win32"
  );
  const nativeNarratorHelper = _test.normalizeNativeWindow(
    nativeWindow("Windows 服务主进程", "", { x: -32000, y: -32000, width: 16, height: 16 }, "", "C:\\Windows\\System32\\svchost.exe"),
    "win32"
  );
  const zeroSizedHelper = _test.normalizeNativeWindow(
    nativeWindow("小米电脑管家", "", { x: -5001, y: 0, width: 0, height: 0 }, "", "C:\\Program Files\\MI\\XiaomiPCManager\\XiaomiPcManager.exe"),
    "win32"
  );
  const offscreenSmallHelper = _test.normalizeNativeWindow(
    nativeWindow("Weixin", "微信", { x: -16000, y: -16000, width: 157, height: 25 }, "", "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe"),
    "win32"
  );
  const visibleSmallWindow = _test.normalizeNativeWindow(
    nativeWindow("Weixin", "微信", { x: 80, y: 80, width: 320, height: 120 }, "", "C:\\Program Files\\Tencent\\Weixin\\Weixin.exe"),
    "win32"
  );
  const explorerHostPopup = _test.normalizeNativeWindow(
    nativeWindow("Windows 资源管理器", "主机弹出窗口", { x: 0, y: 0, width: 0, height: 0 }, "", "C:\\Windows\\explorer.exe"),
    "win32"
  );
  const explorerNormalWindow = _test.normalizeNativeWindow(
    nativeWindow("Windows 资源管理器", "Downloads", { x: 80, y: 80, width: 1200, height: 800 }, "", "C:\\Windows\\explorer.exe", {
      className: "CabinetWClass"
    }),
    "win32"
  );

  assert.equal(
    _test.isWindowsDesktopAssistantForeground(clickToDo, "win32"),
    true,
    "Windows Click to Do should be recognized as a desktop assistant foreground candidate."
  );
  assert.equal(
    _test.getForegroundFallbackReason(clickToDo, { desktopArea }, "win32"),
    "windows-desktop-assistant",
    "Click to Do should trigger rich foreground inspection before the desktop top bar is shown."
  );
  assert.equal(
    _test.shouldUseInspectedFastDesktopWindow(clickToDo, { desktopArea }, "win32"),
    false,
    "If fallback inspection still returns Click to Do, fast desktop sampling must continue to the real desktop base."
  );
  assert.equal(
    _test.isWindowsDesktopAssistantForeground(explorerHostPopup, "win32"),
    true,
    "Explorer Host Popup zero-size foregrounds should be recognized as Windows desktop assistant noise."
  );
  assert.equal(
    _test.getForegroundFallbackReason(explorerHostPopup, { desktopArea }, "win32"),
    "windows-desktop-assistant",
    "Explorer Host Popup foregrounds should trigger rich desktop fallback instead of hiding the top bar."
  );
  assert.equal(
    _test.shouldUseInspectedFastDesktopWindow(explorerHostPopup, { desktopArea }, "win32"),
    false,
    "If fallback inspection still returns Explorer Host Popup, fast desktop sampling must continue to the real desktop base."
  );
  assert.equal(
    _test.isWindowsDesktopAssistantForeground(explorerNormalWindow, "win32"),
    false,
    "Regular File Explorer windows must not be treated as desktop assistant foregrounds."
  );
  assert.equal(
    _test.shouldUseInspectedFastDesktopWindow(
      _test.normalizeNativeWindow(
        nativeWindow("explorer", "Program Manager", desktopArea, "", "C:\\Windows\\Explorer.EXE", {
          className: "Progman"
        }),
        "win32"
      ),
      { desktopArea },
      "win32"
    ),
    true,
    "Fallback inspection may still accept the real Explorer desktop base."
  );
  assert.equal(
    _test.isDesktopForegroundWindow(clickToDo, "win32"),
    false,
    "Click to Do should not be treated as a clear desktop until the blocker-aware inspection confirms it."
  );
  assert.equal(
    _test.isWindowsDesktopAssistantForeground(
      _test.normalizeNativeWindow(
        nativeWindow("ClickToDo.exe", "Click to Do", desktopArea, "", clickToDoPath),
        "win32"
      ),
      "win32"
    ),
    true,
    "The English Click to Do title should also be recognized."
  );
  assert.equal(
    _test.isWindowsDesktopAssistantForeground(
      _test.normalizeNativeWindow(
        nativeWindow("ClickToDo.exe", "Settings", desktopArea, "", clickToDoPath),
        "win32"
      ),
      "win32"
    ),
    false,
    "ClickToDo.exe windows with unrelated titles should not be promoted to desktop assistant foregrounds."
  );
  assert.equal(
    _test.isWindowsDesktopAssistantForeground(narratorHelper, "win32"),
    true,
    "NarratorHelperWindow should be recognized as a Windows desktop assistant foreground."
  );
  assert.equal(
    _test.getForegroundFallbackReason(nativeNarratorHelper, { desktopArea }, "win32"),
    "windows-desktop-assistant",
    "Offscreen svchost Narrator helper samples should also trigger rich foreground inspection when get-windows omits className."
  );
  assert.equal(
    _test.isWindowsDesktopAssistantForeground(zeroSizedHelper, "win32"),
    true,
    "Zero-sized untitled helper foregrounds should be treated as desktop assistant sampling noise."
  );
  assert.equal(
    _test.getForegroundFallbackReason(zeroSizedHelper, { desktopArea }, "win32"),
    "zero-sized-helper",
    "Zero-sized untitled helper foregrounds should trigger blocker-aware desktop fallback instead of hiding the top bar directly."
  );
  assert.equal(
    _test.shouldUseInspectedFastDesktopWindow(zeroSizedHelper, { desktopArea }, "win32"),
    false,
    "If fallback inspection still returns the zero-sized helper, fast desktop sampling must continue to the real desktop base."
  );
  assert.equal(
    _test.isOffscreenSmallDesktopHelperForeground(offscreenSmallHelper, desktopArea, "win32"),
    true,
    "Offscreen small helper foregrounds should be treated as desktop sampling noise."
  );
  assert.equal(
    _test.getForegroundFallbackReason(offscreenSmallHelper, { desktopArea }, "win32"),
    "offscreen-small-helper",
    "Offscreen small helper foregrounds should prefer desktop-base fallback instead of hiding the top bar directly."
  );
  assert.equal(
    _test.isOffscreenSmallDesktopHelperForeground(visibleSmallWindow, desktopArea, "win32"),
    false,
    "Visible small windows inside the desktop area must not be treated as offscreen helper noise."
  );
  assert.equal(
    _test.isWindowsDesktopAssistantForeground(
      _test.normalizeNativeWindow(
        nativeWindow("svchost", "", { x: -32000, y: -32000, width: 16, height: 16 }, "", "C:\\Windows\\System32\\svchost.exe", {
          className: "OtherHelperWindow"
        }),
        "win32"
      ),
      "win32"
    ),
    false,
    "Unrelated svchost helper windows should not be treated as desktop assistant foregrounds."
  );
}

function testDesktopBlockerFiltering() {
  const desktopArea = { x: 0, y: 0, width: 1440, height: 900 };
  const codexCompanionPath =
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.519.11010.0_x64__2p2nqsd0c76g0\\app\\Codex.exe";
  const windows = [
    nativeWindow("finder", "Desktop", { x: 0, y: 0, width: 1440, height: 900 }, "com.apple.finder"),
    nativeWindow("Who Eats Token", "谁在吃 token", { x: 420, y: 12, width: 720, height: 54 }),
    nativeWindow("Google Chrome", "Hermes", { x: 100, y: 100, width: 900, height: 640 }),
    nativeWindow("Tiny", "Tooltip", { x: 20, y: 20, width: 40, height: 32 }),
    nativeWindow("Offscreen", "Hidden", { x: 2000, y: 100, width: 600, height: 400 })
  ];

  const blockers = _test.getDesktopBlockers(windows, { desktopArea }, "darwin");
  assert.deepEqual(
    blockers.map((windowInfo) => windowInfo.processName),
    ["Google Chrome"],
    "Desktop blocker scan should ignore Finder, own HUD/topbar, external desktop overlays, tiny windows, and offscreen windows."
  );

  assert.equal(
    _test.isExternalDesktopOverlayWindow(
      _test.normalizeNativeWindow(
        nativeWindow("Codex", "Codex", { x: 1090, y: 585, width: 320, height: 280 }, "", codexCompanionPath),
        "win32"
      ),
      desktopArea,
      "win32"
    ),
    true,
    "The independent Codex desktop overlay should be transparent to this app's overlay arbitration."
  );

  assert.equal(
    _test.isExternalDesktopOverlayWindow(
      _test.normalizeNativeWindow(
        nativeWindow("Codex", "Codex", { x: 1090, y: 585, width: 320, height: 280 }),
        "win32"
      ),
      desktopArea,
      "win32"
    ),
    true,
    "A floating Codex desktop overlay should still be transparent when Win32 does not expose its executable path."
  );

  const windowsWithCodexCompanion = [
    nativeWindow("explorer", "Program Manager", desktopArea, "", "C:\\Windows\\explorer.exe"),
    nativeWindow("Codex", "Codex", { x: -16000, y: -16000, width: 1280, height: 900 }, "", codexCompanionPath),
    nativeWindow("Codex", "Codex", { x: 1090, y: 585, width: 320, height: 280 }, "", codexCompanionPath),
    nativeWindow("Google Chrome", "Hermes", { x: 100, y: 100, width: 900, height: 640 })
  ];
  assert.deepEqual(
    _test.getDesktopBlockers(windowsWithCodexCompanion, { desktopArea }, "win32")
      .map((windowInfo) => windowInfo.processName),
    ["Google Chrome"],
    "Windows desktop blocker scan should ignore the independent Codex desktop overlay."
  );

  const windowsWithSmallCodexOnly = [
    nativeWindow("explorer", "Program Manager", desktopArea, "", "C:\\Windows\\explorer.exe"),
    nativeWindow("Codex", "Codex", { x: 1090, y: 585, width: 320, height: 280 }, "", codexCompanionPath)
  ];
  assert.deepEqual(
    _test.getDesktopBlockers(windowsWithSmallCodexOnly, { desktopArea }, "win32")
      .map((windowInfo) => windowInfo.processName),
    [],
    "A standalone small Codex desktop overlay should remain transparent and should not block the desktop top bar."
  );

  assert.equal(
    _test.isExternalDesktopOverlayWindow(
      _test.normalizeNativeWindow(
        nativeWindow("Codex", "Codex", { x: 420, y: 210, width: 620, height: 420 }, "", codexCompanionPath),
        "win32"
      ),
      desktopArea,
      "win32"
    ),
    true,
    "A moderately larger movable Codex pet overlay should still stay out of this app's top-bar arbitration."
  );

  assert.equal(
    _test.isExternalDesktopOverlayWindow(
      _test.normalizeNativeWindow(
        nativeWindow("Codex", "Codex", { x: 940, y: 60, width: 520, height: 760 }, "", codexCompanionPath),
        "win32"
      ),
      desktopArea,
      "win32"
    ),
    false,
    "Tall Codex windows that read like full app surfaces must still be treated as ordinary foreground blockers."
  );

  assert.equal(
    _test.isDesktopBlockingWindow(
      _test.normalizeNativeWindow(nativeWindow("explorer", "Program Manager", desktopArea), "win32"),
      desktopArea,
      "win32"
    ),
    false,
    "Windows shell windows should not block desktop visibility."
  );

  assert.equal(
    _test.isShellOrOwnOverlayWindow({
      processName: "electron",
      title: "数据可信度",
      path: "",
      bounds: { x: 260, y: 90, width: 440, height: 360 }
    }, "win32"),
    true,
    "The trust popover should be treated as an owned overlay, not a desktop blocker."
  );
  assert.equal(
    _test.isShellOrOwnOverlayWindow({
      processName: "electron",
      title: "谁在吃 token 设置",
      path: "",
      bounds: { x: 750, y: 220, width: 420, height: 560 }
    }, "win32"),
    true,
    "The settings preview window should be treated as an owned overlay, not a desktop top-bar blocker."
  );
  assert.equal(
    _test.isShellOrOwnOverlayWindow({
      processName: "electron",
      title: "LLM HUD Controls",
      path: "",
      bounds: { x: 1180, y: 724, width: 164, height: 30 }
    }, "win32"),
    true,
    "The HUD interaction hitbox should be treated as an owned overlay, not a desktop blocker."
  );

  assert.equal(
    _test.isDesktopBlockingWindow({
      processName: "explorer",
      title: "隐藏的图标",
      path: "C:\\Windows\\explorer.exe",
      className: "NotifyIconOverflowWindow",
      bounds: { x: 680, y: 700, width: 420, height: 220 }
    }, desktopArea, "win32"),
    true,
    "Windows tray overflow shell popups should hide the desktop top bar while they are present."
  );

  assert.equal(
    _test.isDesktopBlockingWindow({
      processName: "explorer",
      title: "",
      path: "C:\\Windows\\explorer.exe",
      className: "#32768",
      bounds: { x: 420, y: 260, width: 260, height: 420 }
    }, desktopArea, "win32"),
    false,
    "The desktop right-click context menu should not count as a desktop popup blocker."
  );

  assert.equal(
    _test.isDesktopBlockingWindow({
      processName: "explorer",
      title: "Codex",
      path: "C:\\Windows\\explorer.exe",
      className: "TaskListThumbnailWnd",
      bounds: { x: 160, y: 555, width: 260, height: 160 }
    }, desktopArea, "win32"),
    true,
    "Windows taskbar thumbnail previews should hide the desktop top bar while they are present."
  );

  assert.equal(
    _test.isDesktopBlockingWindow({
      processName: "explorer",
      title: "任务栏",
      path: "C:\\Windows\\explorer.exe",
      className: "Shell_TrayWnd",
      bounds: { x: 0, y: 840, width: 1440, height: 60 }
    }, desktopArea, "win32"),
    false,
    "The persistent taskbar itself should not count as a desktop popup blocker."
  );

  assert.equal(
    _test.isExplorerShellFloatingWindow({
      processName: "explorer",
      title: "Codex",
      path: "C:\\Windows\\explorer.exe",
      className: "TaskListThumbnailWnd",
      bounds: { x: 160, y: 555, width: 260, height: 160 }
    }, "win32"),
    true,
    "Taskbar thumbnail previews should be treated as shell floating windows."
  );

  assert.equal(
    _test.isExplorerShellFloatingWindow({
      processName: "explorer",
      title: "Downloads",
      path: "C:\\Windows\\explorer.exe",
      className: "CabinetWClass",
      bounds: { x: 80, y: 80, width: 900, height: 640 }
    }, "win32"),
    false,
    "Regular File Explorer windows should not be treated as shell floating windows."
  );

  const fullscreenApp = _test.normalizeNativeWindow(
    nativeWindow(
      "chrome",
      "Fullscreen video",
      desktopArea,
      "",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    ),
    "win32"
  );
  assert.equal(
    _test.isDesktopBlockingWindow(fullscreenApp, desktopArea, "win32"),
    true,
    "Fullscreen ordinary app windows should block desktop top-bar visibility."
  );
  assert.equal(
    _test.isDesktopBlockingWindow(fullscreenApp, desktopArea, "win32", { desktopForeground: true }),
    false,
    "A stale fullscreen-like app from an open-window scan should not block the top bar after the real desktop is foreground."
  );
  assert.deepEqual(
    _test.getDesktopBlockers([
      nativeWindow("explorer", "Program Manager", desktopArea, "", "C:\\Windows\\explorer.exe"),
      nativeWindow("chrome", "Fullscreen video", desktopArea, "", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
    ], { desktopArea, desktopForeground: true }, "win32")
      .map((windowInfo) => windowInfo.processName),
    [],
    "Desktop blocker scans should drop stale fullscreen-like windows only after desktop foreground is confirmed."
  );
}

function testOwnedOverlayForegroundFallback() {
  const desktopArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const ownHud = nativeWindow("electron", "LLM HUD", { x: 1510, y: 910, width: 396, height: 136 });
  const codexCompanion = nativeWindow(
    "Codex",
    "Codex",
    { x: 1510, y: 700, width: 356, height: 320 },
    "",
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.519.11010.0_x64__2p2nqsd0c76g0\\app\\Codex.exe"
  );
  const desktop = nativeWindow("Windows 资源管理器", "", desktopArea, "", "C:\\Windows\\explorer.exe");
  const browser = nativeWindow("chrome", "普通页面", { x: 40, y: 40, width: 1300, height: 820 });
  const desktopContextMenu = nativeWindow(
    "explorer",
    "",
    { x: 520, y: 240, width: 280, height: 420 },
    "",
    "C:\\Windows\\explorer.exe",
    { className: "#32768" }
  );

  assert.equal(
    _test.getForegroundFallbackReason(
      _test.normalizeNativeWindow(ownHud, "win32"),
      { ignoredHwnds: [ownHud.id], desktopArea },
      "win32"
    ),
    "ignored-window",
    "Owned transparent windows should be tagged with the ignored-window fallback reason."
  );

  assert.equal(
    _test.shouldFallbackForegroundWindow(
      _test.normalizeNativeWindow(ownHud, "win32"),
      { ignoredHwnds: [ownHud.id], desktopArea },
      "win32"
    ),
    true,
    "Fast desktop sampling must use foreground fallback when an owned overlay is reported as foreground."
  );
  assert.equal(
    _test.shouldPreferDesktopBaseForForegroundFallback("ignored-window"),
    true,
    "Owned overlay foreground fallback should prefer the desktop base over an arbitrary background tool."
  );

  assert.equal(
    _test.getForegroundFallbackReason(
      _test.normalizeNativeWindow(codexCompanion, "win32"),
      { desktopArea },
      "win32"
    ),
    "external-overlay",
    "External Codex companion overlays should be tagged with the external-overlay fallback reason."
  );

  assert.equal(
    _test.shouldFallbackForegroundWindow(
      _test.normalizeNativeWindow(codexCompanion, "win32"),
      { desktopArea },
      "win32"
    ),
    true,
    "Fast desktop sampling must use foreground fallback when the independent Codex desktop overlay is reported as foreground."
  );
  assert.equal(
    _test.shouldPreferDesktopBaseForForegroundFallback("external-overlay"),
    true,
    "External overlay foreground fallback should prefer the desktop base over an arbitrary background tool."
  );
  assert.equal(
    _test.shouldPreferDesktopBaseForForegroundFallback("native-shell"),
    false,
    "Native shell fallback should keep the blocker-aware foreground path."
  );
  assert.equal(
    _test.shouldProbeDesktopForeground(
      _test.normalizeNativeWindow(nativeWindow("chrome", "ChatGPT", desktopArea), "win32"),
      { desktopArea, probeDesktopForeground: true },
      "win32"
    ),
    true,
    "Fullscreen-like tool samples should be checked against the real Win32 foreground before preserving the HUD."
  );
  assert.equal(
    _test.shouldProbeDesktopForeground(
      _test.normalizeNativeWindow(nativeWindow("chrome", "ChatGPT", desktopArea), "win32"),
      { desktopArea, probeDesktopForeground: false },
      "win32"
    ),
    false,
    "The extra Win32 desktop probe should stay opt-in for fast sampling callers."
  );

  const desktopBase = _test.selectDesktopBaseWindow(
    _test.normalizeNativeWindow(ownHud, "win32"),
    [ownHud, desktop],
    { ignoredHwnds: [ownHud.id], desktopArea },
    "win32"
  );
  assert.equal(
    desktopBase.path,
    "C:\\Windows\\explorer.exe",
    "When an owned HUD is reported as foreground, desktop sampling should fall through to the real desktop window."
  );

  const browserBase = _test.selectDesktopBaseWindow(
    _test.normalizeNativeWindow(ownHud, "win32"),
    [ownHud, browser, desktop],
    { ignoredHwnds: [ownHud.id], desktopArea },
    "win32"
  );
  assert.equal(
    browserBase.processName,
    "chrome",
    "Owned HUD foreground fallback should keep a real app window when it is actually above the desktop."
  );

  const desktopBaseFromExternalOverlay = _test.selectDesktopBaseWindow(
    _test.normalizeNativeWindow(codexCompanion, "win32"),
    [codexCompanion, desktop],
    { desktopArea },
    "win32"
  );
  assert.equal(
    desktopBaseFromExternalOverlay.path,
    "C:\\Windows\\explorer.exe",
    "A floating external Codex desktop overlay should fall through to the real desktop window."
  );

  const desktopBaseFromContextMenu = _test.selectDesktopBaseWindow(
    _test.normalizeNativeWindow(desktopContextMenu, "win32"),
    [desktopContextMenu, desktop],
    { desktopArea },
    "win32"
  );
  assert.equal(
    desktopBaseFromContextMenu.processName,
    "Windows 资源管理器",
    "A desktop right-click context menu should not become the desktop base window."
  );

  assert.equal(
    _test.selectDesktopBaseWindow(
      _test.normalizeNativeWindow(ownHud, "win32"),
      [ownHud, codexCompanion],
      { ignoredHwnds: [ownHud.id], desktopArea },
      "win32"
    ),
    null,
    "Desktop sampling should report no reliable base window when every candidate is sampling noise."
  );

  assert.deepEqual(
    _test.markForegroundFallbackMiss(_test.normalizeNativeWindow(ownHud, "win32"), "ignored-window"),
    {
      ..._test.normalizeNativeWindow(ownHud, "win32"),
      source: "get-windows-fallback-miss",
      foregroundFallbackMiss: true,
      foregroundFallbackReason: "ignored-window",
      samplingNoise: true,
      desktop: {
        clear: false,
        blockerCount: 0,
        blockers: []
      }
    },
    "Foreground fallback misses should be explicit sampling-noise reports, not fake desktop or tool foregrounds."
  );
}

function testOwnedOverlayInspectionFallback() {
  assert.match(
    activeWindowSource,
    /if \(options\.fast === "desktop"\) \{[\s\S]*?const inspectedWindow = await getPowerShellActiveWindow\(\{[\s\S]*?preferDesktopForIgnoredForeground: shouldPreferDesktopBaseForForegroundFallback\(foregroundFallbackReason\)[\s\S]*?\}\);[\s\S]*?shouldUseInspectedFastDesktopWindow\(inspectedWindow, options, process\.platform\)[\s\S]*?getNativeDesktopWindow\(options, inspectedWindow \|\| nativeWindow\)[\s\S]*?markForegroundFallbackMiss\(nativeWindow, foregroundFallbackReason\);/,
    "Fast desktop sampling should keep resolving the real desktop base when fallback inspection still returns assistant or overlay noise."
  );
  assert.match(
    activeWindowSource,
    /return withFastDesktopMetadata\(nativeWindow, process\.platform\);[\s\S]*?\}[\s\S]*?if \(shouldUseForegroundFallback\)/,
    "Fast desktop sampling should avoid a blocker scan for ordinary app/browser foreground windows."
  );
  assert.match(
    activeWindowSource,
    /if \(foregroundFallbackReason === "ignored-window" \|\| foregroundFallbackReason === "external-overlay"\) \{[\s\S]*?return markForegroundFallbackMiss\(nativeWindow, foregroundFallbackReason\);/,
    "Full foreground inspection should also surface owned HUD and external overlay misses as sampling noise when fallback fails."
  );
  assert.match(
    activeWindowSource,
    /catch \{[\s\S]*?const fallbackReason = getForegroundFallbackReason\(activeWindow, options, process\.platform\);[\s\S]*?markForegroundFallbackMiss\(activeWindow, fallbackReason\);/,
    "Native desktop inspection failures must not leak owned overlay foreground samples back into overlay arbitration."
  );
  assert.match(
    activeWindowSource,
    /GetShellWindow/,
    "Native shell foreground recovery should be able to resolve the real desktop shell window."
  );
  assert.match(
    activeWindowSource,
    /Test-WindowsDesktopAssistantForeground[\s\S]*?host popup window[\s\S]*?主机弹出窗口/,
    "Windows desktop assistant detection should include the zero-size Explorer Host Popup foreground seen during Show Desktop."
  );
  assert.match(
    activeWindowSource,
    /function Test-DesktopTopBarShellForeground[\s\S]*?TaskListThumbnailWnd[\s\S]*?NotifyIconOverflowWindow[\s\S]*?#32768[\s\S]*?Shell_TrayWnd/,
    "Native shell foreground recovery should allow desktop menus and persistent empty taskbar foregrounds while excluding shell popups."
  );
  assert.match(
    activeWindowSource,
    /if \(\$script:desktopArea -and \$script:blockingWindows\.Count -eq 0 -and \(Test-DesktopTopBarShellForeground \$payload\)\) \{[\s\S]*?\$desktopBasePayload = Get-DesktopBasePayload[\s\S]*?if \(\$desktopBasePayload\) \{ \$payload = \$desktopBasePayload \}/,
    "When the native shell foreground is clear desktop, the foreground payload should be replaced with the real desktop base instead of a shell container."
  );
  assert.match(
    activeWindowSource,
    /function Get-PreferredDesktopBaseForIgnoredForeground\(\)[\s\S]*?\$script:preferDesktopForIgnoredForeground[\s\S]*?Get-DesktopBasePayload[\s\S]*?if \(\$script:ignoredHwnds\.ContainsKey\(\[string\]\$payload\.hwnd\) -or \(Test-ExternalDesktopOverlayWindow \$payload\)\) \{[\s\S]*?\$desktopBasePayload = Get-PreferredDesktopBaseForIgnoredForeground[\s\S]*?\$payload = \$desktopBasePayload[\s\S]*?Get-FallbackForegroundPayload/,
    "Owned/external overlay foreground samples must prefer the desktop base before considering any background app fallback."
  );
  assert.match(
    activeWindowSource,
    /DESKTOP_FOREGROUND_POWERSHELL_SCRIPT[\s\S]*?GetForegroundWindow[\s\S]*?Test-DesktopTopBarShellForeground[\s\S]*?desktop[\s\S]*?clear = \$true/,
    "Fast desktop sampling should have a narrow Win32 foreground probe for Show Desktop cases where get-windows returns a stale fullscreen tool."
  );
  assert.match(
    activeWindowSource,
    /shouldProbeDesktopForeground\(nativeWindow, options, process\.platform\)[\s\S]*?getPowerShellDesktopForegroundProbe\(\)[\s\S]*?withFastDesktopMetadata\(desktopProbeWindow, process\.platform\)/,
    "A confirmed Win32 desktop foreground should override stale native fullscreen app samples before the state machine sees them."
  );
}

function testFastDesktopMetadata() {
  const desktopArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const desktopWindow = _test.normalizeNativeWindow(
    nativeWindow("explorer", "Program Manager", desktopArea, "", "C:\\Windows\\explorer.exe"),
    "win32"
  );
  const fastDesktop = _test.withFastDesktopMetadata(desktopWindow, "win32");
  assert.equal(fastDesktop.desktop.clear, true, "Fast desktop metadata should immediately mark a real desktop foreground as desktop-clear.");
  assert.equal(fastDesktop.desktop.blockerCount, 0, "Fast desktop metadata should not run blocker enumeration.");
  assert.deepEqual(fastDesktop.desktop.blockers, [], "Fast desktop metadata should not attach stale blockers to real desktop foregrounds.");

  const browserWindow = _test.normalizeNativeWindow(
    nativeWindow("chrome", "Documentation", { x: 80, y: 80, width: 1240, height: 780 }),
    "win32"
  );
  const fastBrowser = _test.withFastDesktopMetadata(browserWindow, "win32");
  assert.equal(fastBrowser.desktop.clear, false, "Ordinary app/browser foreground windows should remain non-desktop in fast metadata.");
  assert.equal(fastBrowser.desktop.blockerCount, 0, "Ordinary fast foreground sampling should stay lightweight.");
}

function testWindowStatusByHwnd() {
  assert.match(
    activeWindowSource,
    /async function getWindowStatusByHwnd\(hwnd, options = \{\}\) \{[\s\S]*?getPowerShellWindowStatusByHwnd\(normalizedHwnd\)[\s\S]*?getNativeWindowStatusByHwnd\(normalizedHwnd, options\)/,
    "Remembered HUD windows should have a lightweight hwnd status query that falls back to native window enumeration."
  );
  assert.match(
    activeWindowSource,
    /IsWindowVisible[\s\S]*?IsIconic[\s\S]*?DwmGetWindowAttribute[\s\S]*?GetWindowRect/,
    "Windows hwnd status must capture visibility, minimized, cloaked, and bounds without running a desktop blocker scan."
  );

  const visibleStatus = _test.normalizeWindowStatusPayload({
    hwnd: 1234,
    exists: true,
    visible: true,
    minimized: false,
    cloaked: false,
    pid: "4321",
    processName: "Codex",
    path: "C:\\Program Files\\Codex\\Codex.exe",
    title: "Codex",
    className: "Chrome_WidgetWin_1",
    bounds: { x: 8, y: 16, width: 1200, height: 800 },
    source: "powershell-window-status"
  }, "fallback");

  assert.equal(visibleStatus.hwnd, "1234", "Window status hwnd should be normalized to a string.");
  assert.equal(visibleStatus.exists, true, "Existing hwnds should keep exists=true.");
  assert.equal(visibleStatus.visible, true, "Visible hwnds should keep visible=true.");
  assert.equal(visibleStatus.minimized, false, "Non-minimized hwnds should keep minimized=false.");
  assert.equal(visibleStatus.cloaked, false, "Uncloaked hwnds should keep cloaked=false.");
  assert.equal(visibleStatus.pid, 4321, "Window status pid should be numeric.");
  assert.deepEqual(
    visibleStatus.bounds,
    { x: 8, y: 16, width: 1200, height: 800 },
    "Window status bounds should be normalized for HUD placement."
  );

  const missingStatus = _test.normalizeWindowStatusPayload({
    exists: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 }
  }, "missing-hwnd");

  assert.equal(missingStatus.hwnd, "missing-hwnd", "Missing hwnd status should preserve the fallback hwnd.");
  assert.equal(missingStatus.exists, false, "Missing hwnd status should report exists=false.");
  assert.equal(missingStatus.visible, false, "Missing hwnd status should not be visible.");
}

function testWindowsFallbackDecisions() {
  const desktopArea = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(
    _test.shouldUsePowerShellInspection({
      processName: "explorer",
      title: "Program Manager",
      bounds: desktopArea
    }, { desktopArea }),
    true,
    "Explorer desktop needs the PowerShell blocker scan."
  );

  assert.equal(
    _test.shouldUsePowerShellInspection({
      processName: "hermes-web-ui",
      title: "Hermes",
      bounds: { x: 0, y: 0, width: 1280, height: 720 }
    }, { desktopArea }),
    true,
    "Hermes native windows should use richer inspection for overlay hints."
  );

  assert.equal(
    _test.shouldUsePowerShellInspection({
      processName: "WindowsTerminal",
      title: "安装 Hermes 并协作",
      bounds: { x: 0, y: 0, width: 1280, height: 720 }
    }, { desktopArea }),
    false,
    "Terminal titles that merely mention Hermes should stay on the low-overhead native path."
  );

  assert.equal(
    _test.shouldUsePowerShellInspection({
      processName: "notepad",
      title: "安装 Hermes 并协作.txt - Notepad",
      bounds: { x: 0, y: 0, width: 980, height: 720 }
    }, { desktopArea }),
    false,
    "Document titles that merely mention Hermes should not trigger rich foreground inspection."
  );

  assert.equal(
    _test.shouldUsePowerShellInspection({
      processName: "electron",
      title: "Hermes",
      bounds: { x: 0, y: 0, width: 980, height: 720 }
    }, { desktopArea }),
    false,
    "Generic Electron windows named Hermes should not trigger rich foreground inspection."
  );

  assert.equal(
    _test.shouldUsePowerShellInspection({
      processName: "chrome",
      title: "Regular Page",
      bounds: { x: 0, y: 0, width: 1280, height: 720 }
    }, { desktopArea }),
    false,
    "Normal large app windows should stay on the low-overhead native path."
  );

  assert.equal(
    _test.shouldUsePowerShellInspection({
      processName: "chrome",
      title: "Download",
      bounds: { x: 100, y: 100, width: 420, height: 260 }
    }, { desktopArea, inspectSmallWindows: false }),
    false,
    "Small-window rich inspection should be disableable to avoid repeated expensive scans."
  );
}

function nativeWindow(name, title, bounds, bundleId = "", ownerPath = "", extra = {}) {
  return {
    ...extra,
    id: `${name}-${title}`,
    title,
    bounds,
    owner: {
      name,
      bundleId,
      processId: 1234,
      path: ownerPath || (name === "Who Eats Token" ? "/Applications/Who Eats Token.app" : "")
    }
  };
}
