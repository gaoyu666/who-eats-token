import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  detectTool,
  getHudCoveringDialog,
  isDialogWindow
} = require("../src/system/tool-detector.cjs");

testToolDetectionAndOverlayAvoidance();
testDesktopRendererProviderSelection();
testHudRendererCoupledVisuals();
testHudWindowLifecycleGuards();
testSettingsPreviewGuards();

console.log("HUD stability checks passed.");

function testToolDetectionAndOverlayAvoidance() {
  const codex = detectTool({
    processName: "Codex",
    title: "要在 谁在吃token 中构建什么?"
  });
  assert.equal(codex?.id, "codex", "Codex windows should resolve to the Codex tool.");
  assert.deepEqual(codex.providerIds, ["codex"], "Codex HUD must only read Codex provider data.");

  const terminalCodex = detectTool({
    processName: "pwsh",
    title: "Codex - 谁在吃token"
  });
  assert.equal(terminalCodex?.id, "codex", "An explicit Codex terminal session should resolve to Codex.");

  const codexPathOnlyTerminal = detectTool({
    processName: "powershell",
    title: "C:\\Users\\lhy10\\.codex\\worktrees\\95d9"
  });
  assert.equal(codexPathOnlyTerminal, null, "A path-only terminal title containing .codex must not show the Codex HUD.");

  const codexFolderOnlyTerminal = detectTool({
    processName: "cmd",
    title: "Command Prompt - C:\\Users\\lhy10\\Documents\\Codex\\2026-05-26"
  });
  assert.equal(codexFolderOnlyTerminal, null, "A Codex-named folder in cmd must not be treated as an active Codex tool.");

  const plainTerminal = detectTool({
    processName: "powershell",
    title: "Windows PowerShell"
  });
  assert.equal(plainTerminal, null, "Plain cmd/PowerShell windows should not inherit a stale in-tool HUD.");

  const terminalHermesTask = detectTool({
    processName: "WindowsTerminal",
    title: "安装 Hermes 并协作"
  });
  assert.equal(terminalHermesTask, null, "A terminal title that merely mentions Hermes must not show the Hermes HUD.");

  const terminalHermesPath = detectTool({
    processName: "powershell",
    title: "C:\\Users\\lhy10\\AppData\\Local\\hermes"
  });
  assert.equal(terminalHermesPath, null, "A path-only terminal title containing Hermes must not show the Hermes HUD.");

  const documentHermesTask = detectTool({
    processName: "notepad",
    title: "安装 Hermes 并协作.txt - Notepad"
  });
  assert.equal(documentHermesTask, null, "A normal document title that mentions Hermes must not show the Hermes HUD.");

  const unrelatedExactHermes = detectTool({
    processName: "electron",
    title: "Hermes"
  });
  assert.equal(unrelatedExactHermes, null, "A generic app window named Hermes must not show the Hermes HUD.");
  assert.equal(
    isDialogWindow({ processName: "Windows 资源管理器", title: "Program Manager", bounds: null }),
    false,
    "Foreground samples with null bounds must not crash dialog detection."
  );

  const hermesProcess = detectTool({
    processName: "hermes-web-ui",
    title: "Hermes"
  });
  assert.equal(hermesProcess?.id, "hermes-web-ui", "The real Hermes Web UI process should still resolve to Hermes.");

  const hermes = detectTool({
    processName: "Google Chrome",
    title: "Hermes - Google Chrome",
    url: "http://127.0.0.1:8648/hermes/chat"
  });
  assert.equal(hermes?.id, "hermes-web-ui", "Hermes Web UI should be detected inside supported browsers.");
  assert.equal(hermes.hud?.bottomOffset, undefined, "Hermes Web UI should use the same default HUD anchor as other tools.");
  assert.deepEqual(hermes.providerIds, ["hermes"], "Hermes HUD must only read Hermes provider data.");

  const workbuddyProcess = detectTool({
    processName: "WorkBuddy",
    title: "WorkBuddy"
  });
  assert.equal(workbuddyProcess?.id, "workbuddy", "The WorkBuddy desktop process should resolve to WorkBuddy.");
  assert.deepEqual(workbuddyProcess.providerIds, ["workbuddy"], "WorkBuddy HUD must only read WorkBuddy provider data.");

  const workbuddyBrowser = detectTool({
    processName: "Google Chrome",
    title: "CodeBuddy IDE - Google Chrome",
    url: "https://www.codebuddy.cn/"
  });
  assert.equal(workbuddyBrowser?.id, "workbuddy", "CodeBuddy/WorkBuddy browser hosts should resolve to WorkBuddy.");

  const workbuddyExtensionProcess = detectTool({
    processName: "CodeBuddyExtension",
    title: "WorkBuddy"
  });
  assert.equal(workbuddyExtensionProcess?.id, "workbuddy", "CodeBuddyExtension process names should resolve to WorkBuddy.");

  const traeProcess = detectTool({
    processName: "Trae",
    title: "Trae"
  });
  assert.equal(traeProcess?.id, "trae", "The Trae desktop process should resolve to Trae.");
  assert.deepEqual(traeProcess.providerIds, ["trae"], "Trae HUD must read Trae adapter data first.");

  const unrelatedChrome = detectTool({
    processName: "Google Chrome",
    title: "Example Domain - Google Chrome",
    url: "https://example.com"
  });
  assert.equal(unrelatedChrome, null, "Non-Hermes browser tabs must not show the Hermes HUD.");

  const activeWindow = {
    processName: "Google Chrome",
    title: "Hermes - Google Chrome",
    pid: 101,
    bounds: { x: 0, y: 0, width: 1100, height: 700 },
    contentOverlays: [
      {
        type: "message-queue",
        label: "继续",
        bounds: { x: 760, y: 430, width: 120, height: 90 }
      }
    ]
  };
  const hudBounds = { x: 740, y: 420, width: 324, height: 112 };
  const blocker = getHudCoveringDialog(activeWindow, hudBounds, activeWindow);
  assert.equal(blocker?.title, "继续", "Overlapping content controls should hide or move the HUD.");

  const safeWindow = {
    ...activeWindow,
    contentOverlays: [
      {
        type: "message-queue",
        label: "继续",
        bounds: { x: 40, y: 40, width: 120, height: 90 }
      }
    ]
  };
  assert.equal(
    getHudCoveringDialog(safeWindow, hudBounds, safeWindow),
    null,
    "Non-overlapping dialogs should not hide the HUD."
  );

  const rootLayoutWindow = {
    ...activeWindow,
    contentOverlays: [
      {
        type: "app-main",
        label: "app-main",
        bounds: { x: 0, y: 0, width: 1100, height: 700 }
      }
    ]
  };
  assert.equal(
    getHudCoveringDialog(rootLayoutWindow, hudBounds, rootLayoutWindow),
    null,
    "Large root layout panels should not be treated as blocking popups."
  );
}

function testDesktopRendererProviderSelection() {
  const harness = loadRendererScript("src/renderer/app.js");
  const snapshot = buildRendererSnapshot();

  harness.callbacks.onUpdate(snapshot);
  assert.equal(harness.text("usageName"), "Codex", "Active Codex tool should select Codex, not the tightest provider.");
  assert.equal(harness.text("primaryMetricLabel"), "5小时", "Codex should render capacity labels.");
  assert.equal(harness.text("secondaryMetricLabel"), "一周", "Codex should render weekly capacity labels.");
  assert.equal(harness.text("fiveHourRemaining"), "85%", "Codex five-hour remaining should render from Codex data.");
  assert.equal(harness.text("weekRemaining"), "80%", "Codex weekly remaining should render from Codex data.");
  assert.equal(harness.text("trustBadge"), "本地精确", "Top bar should expose Codex trust status.");
  assert.equal(harness.text("quotaLabel"), "5h", "Top bar quota chip should show the current quota basis.");
  assert.equal(harness.text("quotaValue"), "85%", "Top bar quota chip should show the same standard remaining as the frame.");
  assert.ok(harness.text("usageReset").startsWith("重 "), "Top bar should show the active capacity reset window.");
  assert.equal(harness.style("miniChart", "--five-fill"), "85%", "Mini chart should track Codex five-hour remaining.");
  assert.equal(harness.style("miniChart", "--week-fill"), "80%", "Mini chart should track Codex weekly remaining.");
  assert.equal(harness.style("usageStrip", "--eat-speed"), "0.95s", "Top bar token eating speed should follow recent usage.");
  assert.equal(harness.style("usageStrip", "--quota-fill"), "85%", "Top bar usage strip should expose quota fill for its compact chip.");
  assert.equal(harness.style("usageMascot", "--quota-fill"), "85%", "Top bar in-strip mascot should receive the active quota fill.");
  assert.equal(harness.style("tokenGenerator", "--quota-fill"), "85%", "Token generator should receive the active remaining quota fill.");
  assert.equal(harness.style("tokenFlow", "--quota-fill"), "85%", "Token flow should receive the active quota fill.");
  assert.equal(harness.style("tokenFlow", "--flow-speed"), "0.95s", "Token generator particles should follow recent usage speed.");
  assert.equal(harness.dataset("usageStrip", "delightMood"), "comfy", "Top bar mascot mood should follow Codex delight state.");
  assert.equal(harness.dataset("usageStrip", "mascot"), "stretch", "Top bar mascot sprite should follow Codex delight cue.");
  assert.equal(harness.dataset("usageMascot", "level"), "healthy", "In-strip quota mascot should follow the active quota level.");
  assert.equal(harness.dataset("tokenGenerator", "level"), "healthy", "Token generator should inherit the active quota level.");
  assert.equal(harness.dataset("tokenFlow", "level"), "healthy", "Token flow should inherit the active quota level.");
  assert.ok(
    ["peek", "catch", "eat", "wait", "panic", "guard", "run"].includes(harness.dataset("roamingMascot", "scene")),
    "Top bar should initialize a roaming mascot scene."
  );
  assert.ok(harness.dataset("roamingMascot", "anchor"), "Top bar roaming mascot should initialize at a bar anchor.");
  assert.ok(harness.dataset("tokenFlow", "scene"), "Token particles should target the active mascot scene.");

  harness.callbacks.onUpdate({
    ...snapshot,
    providers: snapshot.providers.map((provider) => provider.id === "codex"
      ? {
          ...provider,
          latest: {
            ...provider.latest,
            rateLimits: {
              ...provider.latest.rateLimits,
              secondary: { usedPercent: 92, resetsAt: "2026-05-31T08:00:00.000Z" }
            }
          }
        }
      : provider)
  });
  assert.equal(harness.style("miniChart", "--week-fill"), "8%", "Top bar should still render weekly remaining separately.");
  assert.equal(harness.dataset("miniChart", "level"), "healthy", "Codex top bar visual level should follow the current five-hour quota standard.");
  assert.equal(harness.dataset("usageStrip", "level"), "healthy", "Codex mascot/frame level should follow current five-hour remaining, not weekly remaining.");

  harness.callbacks.onUpdate({
    ...snapshot,
    activeTool: { providerIds: ["hermes"] }
  });
  assert.equal(harness.text("usageName"), "Hermes", "Active Hermes tool should select Hermes data.");
  assert.equal(harness.text("primaryMetricLabel"), "总余量", "Hermes token plan should render total remaining.");
  assert.equal(harness.text("secondaryMetricLabel"), "已用", "Hermes token plan should render used credits.");
  assert.equal(harness.text("fiveHourRemaining"), "24%", "Hermes remaining should render from token plan.");
  assert.equal(harness.text("weekRemaining"), "152.75M", "Hermes used credits should render compactly.");
  assert.equal(harness.text("trustBadge"), "本地精确", "Top bar should expose Hermes trust fallback when provider health is absent.");
  assert.equal(harness.text("quotaLabel"), "总", "Token-plan mode should label the quota chip with the total-plan basis.");
  assert.equal(harness.text("quotaValue"), "24%", "Top bar quota chip should switch with the active token-plan provider.");
  assert.ok(harness.text("usageReset").startsWith("更 "), "Token plan mode should show data freshness when no reset deadline exists.");
  assert.equal(harness.style("miniChart", "--five-fill"), "24%", "Mini chart should track Hermes remaining.");
  assert.equal(harness.style("miniChart", "--week-fill"), "76%", "Mini chart should track Hermes used percent.");
  assert.equal(harness.style("usageStrip", "--eat-speed"), "1.8s", "Token plan eating speed should follow recent credits, not remaining credits.");
  assert.equal(harness.style("tokenGenerator", "--quota-fill"), "24%", "Token generator should update its quota fill when the provider changes.");
  assert.equal(harness.style("tokenFlow", "--quota-fill"), "24%", "Token flow should update quota fill when the provider changes.");
  assert.equal(harness.dataset("usageStrip", "delightMood"), "low", "Top bar should switch to the low-quota mascot state.");
  assert.equal(harness.dataset("usageStrip", "mascot"), "small-bites", "Top bar should switch to the anxious low-quota sprite cue.");
  assert.equal(harness.dataset("usageMascot", "level"), "caution", "In-strip quota mascot should switch with token-plan remaining.");
  assert.equal(harness.dataset("tokenGenerator", "level"), "caution", "Token generator should switch level with token-plan remaining.");
  assert.equal(harness.dataset("tokenFlow", "level"), "caution", "Token particles should switch level with token-plan remaining.");

  harness.callbacks.onUpdate({
    ...snapshot,
    activeTool: null
  });
  assert.equal(harness.text("usageName"), "Hermes", "Without an active tool, the top bar should fall back to the tightest provider.");
}

function testHudRendererCoupledVisuals() {
  const harness = loadRendererScript("src/renderer/hud.js");

  harness.callbacks.onHudUpdate({
    visible: true,
    tool: { name: "Hermes" },
    provider: {
      id: "hermes",
      name: "Hermes",
      displayMode: "token-plan",
      tokenPlanRemaining: 17,
      tokenPlanUsedPercent: 83,
      tokenPlanUsedCredits: 166_510_000,
      tokenPlanTotalCredits: 200_000_000,
      tokenPlanSource: "xiaomi-platform",
      tokenPlanValidUntil: "2026-05-28T23:59:00Z",
      delight: {
        mood: "low",
        cue: { mascot: "small-bites" },
        a11yLabel: "余量告急：省着点"
      }
    }
  });
  assert.equal(harness.text("toolName"), "Hermes", "HUD should show the active tool name.");
  assert.equal(harness.text("hudFiveLabelText"), "总余量", "Token plan HUD should label remaining credits.");
  assert.equal(harness.text("hudWeekLabelText"), "已用", "Token plan HUD should label used credits.");
  assert.equal(harness.text("hudFiveHour"), "17%", "Token plan remaining should render as percent.");
  assert.equal(harness.text("hudWeek"), "166.51M", "Token plan used credits should render compactly.");
  assert.equal(harness.text("hudPlan"), "Token Plan", "HUD plan pill should show the active plan.");
  assert.equal(harness.text("hudTrust"), "精确", "HUD trust pill should expose provider exactness.");
  assert.equal(harness.text("hudPredict"), "轻量对话更稳", "HUD should show an action-oriented low-quota hint.");
  assert.equal(harness.dataset("hudChart", "level"), "danger", "HUD chart level must follow low remaining.");
  assert.equal(harness.dataset("hudMascot", "delightMood"), "low", "HUD mascot mood must follow provider delight.");
  assert.equal(harness.dataset("hudMascot", "mascot"), "small-bites", "HUD mascot sprite must follow provider delight cue.");
  assert.equal(harness.style("hudChart", "--five-fill"), "17%", "HUD chart left bar should follow remaining.");
  assert.equal(harness.style("hudChart", "--week-fill"), "83%", "HUD chart used bar should follow used percent.");
  assert.equal(harness.style("hudMascot", "--eat-speed"), "2.8s", "HUD token eating should slow down when no recent token signal is available.");
  assert.match(harness.text("hudMeta"), /平台实时/, "HUD meta should expose live platform source.");

  harness.callbacks.onHudUpdate({
    visible: true,
    tool: { name: "WorkBuddy" },
    provider: {
      id: "workbuddy",
      name: "WorkBuddy",
      displayMode: "token-plan",
      syncStatus: "live",
      tokenPlanRemaining: 34,
      tokenPlanUsedPercent: 66,
      tokenPlanRemainingCredits: 3422.33,
      tokenPlanUsedCredits: 6577.67,
      tokenPlanTotalCredits: 10000,
      tokenPlanSource: "workbuddy-official-billing",
      tokenPlanPlanName: "WorkBuddy Pro Daily",
      trust: { level: "exact-provider", label: "精确", sourceLabel: "workbuddy-official-billing", ageMs: 0 },
      delight: {
        mood: "tight",
        cue: { mascot: "careful" },
        a11yLabel: "余量偏紧：轻量推进"
      }
    }
  });
  assert.equal(harness.text("toolName"), "WorkBuddy", "WorkBuddy HUD should keep the active tool name.");
  assert.equal(harness.text("hudFiveLabelText"), "实时积分", "WorkBuddy HUD should label live credits directly.");
  assert.equal(harness.text("hudWeekLabelText"), "总额度", "WorkBuddy HUD should label total plan credits directly.");
  assert.equal(harness.text("hudFiveHour"), "3422.33", "WorkBuddy remaining credits must not be compacted to k/M.");
  assert.equal(harness.text("hudWeek"), "10000", "WorkBuddy total credits must not be compacted to k/M.");
  assert.equal(harness.style("hudChart", "--five-fill"), "34%", "WorkBuddy chart should keep showing remaining percent.");
  assert.equal(harness.style("hudChart", "--week-fill"), "66%", "WorkBuddy chart should keep showing used percent.");
  assert.equal(harness.dataset("hudMascot", "mascot"), "careful", "WorkBuddy HUD must keep the mascot visible and stateful.");
  assert.match(harness.text("hudMeta"), /已用 6577\.67 · 实时积分/, "WorkBuddy HUD footer should explain used credits without a raw remaining/total slash.");

  harness.callbacks.onHudUpdate({
    visible: true,
    tool: { name: "Codex" },
    provider: {
      id: "codex",
      name: "Codex",
      displayMode: "capacity",
      fiveHourRemaining: 95,
      weekRemaining: 12,
      recentTokens: 7_190_000,
      syncStatus: "live",
      trendLabel: "稳定",
      delight: {
        mood: "comfy",
        cue: { mascot: "stretch" },
        a11yLabel: "余量充足：放心吃"
      }
    }
  });
  assert.equal(harness.text("toolName"), "Codex", "HUD should switch tool names.");
  assert.equal(harness.text("hudFiveLabelText"), "5小时", "Codex HUD should label five-hour capacity.");
  assert.equal(harness.text("hudWeekLabelText"), "一周", "Codex HUD should label weekly capacity.");
  assert.equal(harness.text("hudFiveHour"), "95%", "Codex five-hour remaining should render.");
  assert.equal(harness.text("hudWeek"), "12%", "Codex weekly remaining should render.");
  assert.equal(harness.text("hudTrust"), "本地精确", "Codex HUD should expose local exactness.");
  assert.equal(harness.text("hudPredict"), "可以继续工作", "Healthy Codex HUD should show a calm work hint.");
  assert.equal(harness.dataset("hudChart", "level"), "healthy", "HUD chart level should recover with healthy capacity.");
  assert.equal(harness.dataset("hudMascot", "delightMood"), "comfy", "Healthy HUD should use the relaxed mascot state.");
  assert.equal(harness.dataset("hudMascot", "mascot"), "stretch", "Healthy HUD should use the overflow-token mascot cue.");
  assert.equal(harness.style("hudChart", "--five-fill"), "95%", "HUD chart should follow Codex five-hour remaining.");
  assert.equal(harness.style("hudChart", "--week-fill"), "12%", "HUD chart should still show weekly remaining independently.");
  assert.equal(harness.style("hudMascot", "--eat-speed"), "0.95s", "HUD token eating speed should follow recent usage.");
}

function testHudWindowLifecycleGuards() {
  const mainSource = read("src/main.cjs");
  const wakeProbeSource = read("src/main/wake-probe.ps1");
  const activeWindowSource = read("src/system/active-window.cjs");
  const overlayControllerSource = read("src/main/overlay-controller.cjs");
  const snapshotServiceSource = read("src/main/snapshot-service.cjs");
  const stressSource = read("scripts/stress-overlay-switch.mjs");
  const preloadSource = read("src/preload.cjs");
  const hudHitboxSource = read("src/renderer/hud-hitbox.js");
  const toolDetectionSource = read("src/main/tool-detection.cjs");
  const displayAdapterSource = read("src/main/display-adapter.cjs");
  const shouldInspectBlockersSource = extractFunction(toolDetectionSource, "function shouldInspectDesktopBlockersForToolDetection");
  const shouldShowDesktopBarSource = extractFunction(toolDetectionSource, "function shouldShowDesktopBar");
  const isDesktopForegroundSource = extractFunction(toolDetectionSource, "function isDesktopForeground");
  const resolveOverlayDecisionSource = extractFunction(mainSource, "async function resolveOverlayDecision");
  const runToolDesktopWakeSource = extractFunction(mainSource, "async function runToolDesktopWake");
  const handleToolDesktopWakeProbeLineSource = extractFunction(mainSource, "function handleToolDesktopWakeProbeLine");
  const toolDesktopWakeInspectionSource = extractFunction(mainSource, "function getToolDesktopWakeInspectionOptions");
  assert.match(
    mainSource,
    /collectWorkBuddyUsage, setWorkBuddyRefreshHandler/,
    "The main process should import the WorkBuddy local billing collector and refresh callback."
  );
  assert.match(
    snapshotServiceSource,
    /collectWorkBuddyUsage[\s\S]*?isProviderEnabled\("workbuddy"\)[\s\S]*?collectWorkBuddyUsage\(options\.workbuddy \|\| \{\}\)/,
    "The snapshot service should collect WorkBuddy local billing data when the WorkBuddy provider is enabled."
  );
  assert.match(
    snapshotServiceSource,
    /codex,[\s\S]*?hermes,[\s\S]*?workbuddy,[\s\S]*?\.\.\.\(isProviderEnabled\("ingest"\)/,
    "WorkBuddy local data should merge before generic ingest events so status fallback remains additive."
  );
  assert.match(
    mainSource,
    /collectWorkBuddyUsage,/,
    "Snapshot service wiring should receive the WorkBuddy local collector."
  );
  assert.match(
    mainSource,
    /function scheduleWorkBuddySnapshotRefresh\(\)[\s\S]*?isWorkBuddyToolHudVisible\(\)[\s\S]*?sendSnapshot\(\)/,
    "WorkBuddy billing refresh completion should trigger a follow-up snapshot while its HUD is visible."
  );
  assert.match(
    mainSource,
    /refreshMinMs: toolSM\.WORKBUDDY_HUD_SNAPSHOT_REFRESH_MS/,
    "Visible WorkBuddy HUD snapshots should pass the short refresh window to the local collector."
  );
  assert.match(
    mainSource,
    /function hideToolHudForUnsupportedForeground/,
    "The fast desktop foreground pass should also retire stale in-tool HUDs."
  );
  assert.match(
    toolDetectionSource,
    /function getDetectedToolContext/,
    "HUD tool detection should be shared by fast and full foreground passes."
  );
  assert.match(
    toolDetectionSource,
    /function shouldInspectDesktopBlockersForToolDetection/,
    "Tool detection should explicitly gate when desktop blocker windows are eligible."
  );
  assert.match(
    toolDetectionSource,
    /function getToolDetectionBlockers/,
    "Tool detection should centralize blocker filtering before using background windows."
  );
  assert.match(
    toolDetectionSource,
    /activePid && blockerPid && activePid === blockerPid/,
    "Dialog parent matching should keep same-process parent windows eligible."
  );
  assert.match(
    toolDetectionSource,
    /if \(!shouldInspectDesktopBlockersForToolDetection\(activeWindow\)\) \{\s*return candidates;\s*\}/,
    "Ordinary unsupported foreground apps must not inherit a HUD from background desktop blockers."
  );
  assert.ok(
    !shouldInspectBlockersSource.includes("isDesktopForeground("),
    "Desktop foreground must not scan blockers to resurrect a background tool HUD."
  );
  assert.match(
    toolDetectionSource,
    /function isShellForegroundWindow/,
    "Shell and taskbar foreground reports should be recognized so they can be arbitrated explicitly."
  );
  assert.match(
    toolDetectionSource,
    /function isHudSuppressingForegroundPopup/,
    "Tray/taskbar popups and tool-owned popup menus should explicitly suppress in-tool HUDs."
  );
  assert.match(
    shouldInspectBlockersSource,
    /isHudSuppressingForegroundPopup\(activeWindow\)[\s\S]*?return false/,
    "HUD-suppressing tray/menu popups must not scan desktop blockers and resurrect a background tool HUD."
  );
  assert.match(
    mainSource,
    /function refreshOverlayCoordinator/,
    "A single overlay coordinator should arbitrate the top bar and HUD lifecycle."
  );
  assert.match(
    mainSource,
    /const OVERLAY_COORDINATOR_REFRESH_MS = 200;/,
    "Switching from a tool/browser to the desktop should be detected by a near-immediate lightweight coordinator."
  );
  assert.match(
    mainSource,
    /const OVERLAY_DEFERRED_RETRY_MS = 75;/,
    "Owned-overlay foreground noise should retry quickly so desktop switches do not preserve a stale HUD."
  );
  assert.match(
    mainSource,
    /let overlayCoordinatorPending = false;/,
    "The overlay coordinator should remember refresh requests that arrive while a foreground sample is still running."
  );
  assert.match(
    mainSource,
    /let overlayCoordinatorGeneration = 0;/,
    "Priority desktop wake samples should be able to invalidate stale in-flight foreground samples."
  );
  assert.match(
    mainSource,
    /let overlayCoordinatorPriorityInFlight = false;/,
    "Priority desktop wake samples should block new ordinary coordinator passes until the priority transition is applied."
  );
  assert.match(
    mainSource,
    /if \(!priority && \(overlayCoordinatorInFlight \|\| overlayCoordinatorPriorityInFlight\)\) \{[\s\S]*?overlayCoordinatorPending = true;[\s\S]*?return;/,
    "Ordinary concurrent overlay refreshes should be queued while any coordinator pass or priority desktop wake sample is in flight."
  );
  assert.match(
    mainSource,
    /const generation = priority \? \+\+overlayCoordinatorGeneration : overlayCoordinatorGeneration;[\s\S]*?generation !== overlayCoordinatorGeneration[\s\S]*?return;/,
    "A stale foreground sample must not apply after a priority desktop wake sample has already advanced the overlay decision."
  );
  assert.match(
    mainSource,
    /!overlayCoordinatorInFlight && !overlayCoordinatorPriorityInFlight && overlayCoordinatorPending && !isQuitting[\s\S]*?overlayCoordinatorPending = false;[\s\S]*?setTimeout\(refreshOverlayCoordinator, 0\)/,
    "Queued overlay refreshes should rerun only after ordinary and priority arbitration passes have both finished."
  );
  assert.match(
    mainSource,
    /createOverlayController\(\{[\s\S]*?noiseGraceMs: 500,[\s\S]*?confirmedLatencyMs: 400/,
    "Overlay arbitration should be centralized in a state controller with bounded sampling-noise preservation."
  );
  assert.match(
    mainSource,
    /overlayController\.resolve\(\{[\s\S]*?samplingNoise: !settingsDecision && !hudSuppressedByPopup && isForegroundSamplingNoise\(activeWindow\)[\s\S]*?desktopVisible: !settingsDecision && !hudSuppressedByPopup && shouldShowDesktopBar\(activeWindow\)[\s\S]*?fullscreenForeground: !settingsDecision && !hudSuppressedByPopup && !isDesktopForegroundWindow\(activeWindow, process\.platform\) && isForegroundFullscreen\(activeWindow\)/,
    "Foreground samples should be classified once and then handed to the overlay state controller."
  );
  assert.match(
    mainSource,
    /const OVERLAY_ACTIVE_WINDOW_TIMEOUT_MS = 1000;[\s\S]*?function createOverlayActiveWindowTimeoutSample\(\)[\s\S]*?samplingNoise: true/,
    "A slow foreground sampler should have enough budget to finish the tool-scoped desktop foreground probe before becoming sampling noise."
  );
  assert.match(
    mainSource,
    /const TOOL_DESKTOP_WAKE_MS = 75;[\s\S]*?const TOOL_DESKTOP_WAKE_TIMEOUT_MS = 300;[\s\S]*?const TOOL_DESKTOP_WAKE_PROBE_INTERVAL_MS = 50;/,
    "Tool-to-desktop transitions should have a bounded lightweight wake path for immediate HUD suppression."
  );
  assert.match(
    mainSource,
    /function getFastWindowInspectionOptions\(\) \{[\s\S]*?fast: "desktop",[\s\S]*?probeDesktopForeground: latestOverlayDecision\?\.mode === SURFACES\.TOOL/,
    "Overlay sampling should confirm real Win32 desktop foregrounds only while leaving tool mode, so desktop-to-tool recovery stays fast."
  );
  assert.match(
    toolDesktopWakeInspectionSource,
    /getFastWindowInspectionOptions\(\)[\s\S]*?nativeDesktopFallbackOnly: true[\s\S]*?probeDesktopForeground: false/,
    "The tool-desktop wake guard must stay lightweight and must not run the slow Win32 foreground fallback or desktop probe."
  );
  assert.match(
    activeWindowSource,
    /const preferredDesktopWindow = shouldPreferDesktopBaseForForegroundFallback\(foregroundFallbackReason\)[\s\S]*?getNativeDesktopWindow\(options, nativeWindow\)[\s\S]*?preferredDesktopWindow && !preferredDesktopWindow\.samplingNoise[\s\S]*?return preferredDesktopWindow[\s\S]*?shouldUseNativeDesktopFallbackOnly\(foregroundFallbackReason, options\)[\s\S]*?return preferredDesktopWindow \|\|[\s\S]*?function shouldPreferDesktopBaseForForegroundFallback\(reason\)[\s\S]*?reason === "ignored-window"[\s\S]*?reason === "external-overlay"[\s\S]*?reason === "zero-sized-helper"[\s\S]*?reason === "offscreen-small-helper"/,
    "Fast desktop fallback should try native desktop-base selection before slow PowerShell for owned, external, zero-sized, or offscreen helper foregrounds."
  );
  assert.match(
    mainSource,
    /const TOOL_DESKTOP_WAKE_PROBE_PS1 = path\.join\(__dirname, "main", "wake-probe\.ps1"\)/,
    "The wake probe PowerShell script should be loaded from an external file."
  );
  assert.match(
    wakeProbeSource,
    /GetForegroundWindow[\s\S]*?Start-Sleep -Milliseconds \$IntervalMs/,
    "The Windows tool-desktop wake helper should keep Win32 foreground access warm instead of spawning a slow probe per sample."
  );
  assert.match(
    wakeProbeSource,
    /GetShellWindow[\s\S]*?IsIconic[\s\S]*?\$isOffscreenForeground[\s\S]*?tool-desktop-wake-offscreen-probe/,
    "The Windows tool-desktop wake helper should treat minimized or offscreen foreground tools as Show Desktop evidence and feed the real shell window back to the coordinator."
  );
  assert.match(
    mainSource,
    /function scheduleToolDesktopWake\(\) \{[\s\S]*?startToolDesktopWakeProbe\(\)[\s\S]*?setTimeout\(runToolDesktopWake, TOOL_DESKTOP_WAKE_MS\)/,
    "The tool-desktop wake scheduler should prefer the persistent Win32 helper and keep the timer as a fallback."
  );
  assert.match(
    mainSource,
    /function shouldRunToolDesktopWake\(\) \{[\s\S]*?latestOverlayDecision\?\.mode === SURFACES\.TOOL[\s\S]*?!latestOverlayDecision\.settingsOverlay[\s\S]*?toolHudWindow\.isVisible\(\)/,
    "The tool-desktop wake guard should only run for a confirmed visible tool HUD."
  );
  assert.match(
    runToolDesktopWakeSource,
    /getToolDesktopWakeActiveWindow\(\)[\s\S]*?shouldShowDesktopBar\(activeWindow\)[\s\S]*?runOverlayCoordinatorPass\(\(\) => activeWindow\)/,
    "The tool-desktop wake guard should only feed a confirmed desktop sample back into the unified overlay coordinator."
  );
  assert.match(
    handleToolDesktopWakeProbeLineSource,
    /normalizeToolDesktopWakeProbeWindow\(JSON\.parse\(line\)\)[\s\S]*?shouldShowDesktopBar\(activeWindow\)[\s\S]*?runOverlayCoordinatorPass\(\(\) => activeWindow, \{ priority: true \}\)/,
    "The persistent tool-desktop wake helper should feed confirmed desktop samples into the unified overlay coordinator as priority samples."
  );
  assert.doesNotMatch(
    `${runToolDesktopWakeSource}\n${handleToolDesktopWakeProbeLineSource}`,
    /hideToolHudForDesktop|showDesktopBarForTransition|hideDesktopBarWindow|showToolHudWindow|overlayController\.resolve/,
    "The tool-desktop wake guard must not directly change overlay visibility or bypass the state machine."
  );
  assert.match(
    mainSource,
    /function scheduleOverlayDeferredRetry\(\) \{[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?refreshOverlayCoordinator\(\);/,
    "Deferred foreground noise should trigger a short retry instead of waiting for the next one-second coordinator tick."
  );
  assert.match(
    mainSource,
    /if \(decision\.noise && decision\.preserveOverlay\) \{[\s\S]*?scheduleOverlayDeferredRetry\(\);[\s\S]*?writeOverlayDecisionDebug\(decision, previousDecision\);[\s\S]*?return;/,
    "Sampling-noise preservation should be bounded by the state controller and schedule a quick recovery pass."
  );
  assert.match(
    overlayControllerSource,
    /previousSurface === SURFACES\.DESKTOP && input\.noiseReason === "active-window-timeout"[\s\S]*?const stalePreserveMs = Math\.max\(0, now - preserveStartedAt\);[\s\S]*?return \{[\s\S]*?surface: SURFACES\.DESKTOP[\s\S]*?preserveOverlay: true/,
    "A foreground sampler timeout should preserve a confirmed desktop until a real signal arrives."
  );
  assert.match(
    mainSource,
    /async function applyOverlayTransition\(decision, previousDecision\)[\s\S]*?decision\.mode === SURFACES\.DESKTOP[\s\S]*?decision\.mode === SURFACES\.TOOL[\s\S]*?hideDesktopBarWindow\(decision\.reason\)/,
    "All top-bar and HUD show/hide operations should flow through one transition function."
  );
  assert.match(
    mainSource,
    /decision\.mode === SURFACES\.DESKTOP[\s\S]*?clearToolDesktopWake\(\)[\s\S]*?hideToolHudForDesktop\(decision\.activeWindow\)/,
    "A confirmed desktop transition should stop the tool-desktop wake loop before hiding the HUD through the central transition."
  );
  assert.match(
    mainSource,
    /decision\.mode === SURFACES\.TOOL[\s\S]*?await refreshToolHud\([\s\S]*?scheduleToolDesktopWake\(\)/,
    "A confirmed visible tool HUD should start the lightweight desktop wake guard after normal HUD rendering."
  );
  assert.match(
    stressSource,
    /topbarVisibleWhileToolMs[\s\S]*?hudVisibleWhileDesktopMs[\s\S]*?surfaceTransitionCount[\s\S]*?stalePreserveMs/,
    "The stress switch script should report residual visibility time, transition count, and stale preserve duration."
  );
  assert.match(
    stressSource,
    /maxAllowedLeakMs = getNonNegativeNumberArg\("--max-leak-ms", 400\)[\s\S]*?topbarVisibleWhileToolMs <= maxAllowedLeakMs[\s\S]*?hudVisibleWhileDesktopMs <= maxAllowedLeakMs/,
    "Stress evidence should enforce a configurable residual-overlay budget with 400ms as the legacy ceiling."
  );
  assert.match(
    stressSource,
    /function getSurfaceTransitionStats\(samples, debugEntries = \[\]\) \{[\s\S]*?const realSurfaceSequence = samples\.map\(getRealWindowSurface\)\.filter\(Boolean\);[\s\S]*?if \(realWindowsOnly\)[\s\S]*?source: "real-windows"/,
    "Real-window stress mode should derive surfaceTransitionCount from actual overlay window visibility."
  );
  assert.match(
    stressSource,
    /function getRealWindowSurface\(item\) \{[\s\S]*?desktopVisible && hudVisible[\s\S]*?return "mixed"[\s\S]*?return "desktop-topbar"[\s\S]*?return "tool-hud"[\s\S]*?return "hidden"/,
    "Real-window transition counting should include top-bar, HUD, hidden, and mixed visible states."
  );
  assert.match(
    stressSource,
    /smoothLeakTargetMs = 0[\s\S]*?smoothPassed: topbarVisibleWhileToolMs <= smoothLeakTargetMs[\s\S]*?hudVisibleWhileDesktopMs <= smoothLeakTargetMs/,
    "Stress evidence should separately expose the immediate-response target instead of treating 400ms as the UX goal."
  );
  assert.match(
    stressSource,
    /topbarVisibleWhileToolMs = estimateVisibleMs[\s\S]*?isToolPhaseSample\(item\)[\s\S]*?isToolForegroundSample\(item\)[\s\S]*?hudVisibleWhileDesktopMs = estimateVisibleMs[\s\S]*?isDesktopPhaseSample\(item\)[\s\S]*?activeWindow\?\.desktop\?\.clear === true/,
    "Residual-overlay metrics should only count valid samples from their own switch phase, while activation misses stay in environmentInterference."
  );
  assert.match(
    stressSource,
    /function isDesktopPhaseSample\(item\)[\s\S]*?:desktop-\(early\|settled\)\$[\s\S]*?function isToolPhaseSample\(item\)[\s\S]*?:tool-\(before-desktop\|return\)\$/,
    "Stress phase guards should keep desktop and tool residual metrics from contaminating each other."
  );
  assert.match(
    stressSource,
    /waitForTargetForeground\(target, foregroundWaitMs\);\s*await waitForAppOverlay\(isToolOverlayReady, toolSettleMs\);[\s\S]*?stage: item\.stage,[\s\S]*?desktopBar: item\.overlay\.desktopBar,[\s\S]*?hud: item\.overlay\.hud/,
    "Tool-return stress samples should wait for the tool surface and report HUD/top-bar state in failures."
  );
  assert.match(
    stressSource,
    /waitForDesktopForeground[\s\S]*?waitForAppOverlay\(isDesktopOverlayReady, foregroundSettleMs\)/,
    "Desktop-settled stress samples should wait for the desktop surface before judging the final state."
  );
  assert.match(
    stressSource,
    /-EncodedCommand[\s\S]*?\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/,
    "Stress PowerShell probes should use encoded UTF-8 output so Chinese window titles are not misread."
  );
  assert.match(
    stressSource,
    /async function readCurrentOverlayState\(\)[\s\S]*?readAppDebugState\(\)[\s\S]*?getOverlayStateFromWindows\(windows\)/,
    "Stress waiting should fall back to real window enumeration when HUD debug logging is disabled."
  );
  assert.match(
    stressSource,
    /function isDesktopOverlayReady\(state\) \{[\s\S]*?!state\?\.decision \|\| state\.decision\.mode === "desktop-topbar"[\s\S]*?desktopBar\?\.visible === true/,
    "Desktop readiness should accept real visible windows when there is no debug decision state."
  );
  assert.match(
    stressSource,
    /const toolFailures = validToolReturn\.filter\(\(item\) =>[\s\S]*?!isHudVisible\(item\) \|\|[\s\S]*?isDesktopBarVisible\(item\)/,
    "Tool-return stress checks must require the HUD to be visible and the desktop top bar to be hidden."
  );
  assert.match(
    stressSource,
    /const desktopEnvironmentInterference = desktopSettled\.filter[\s\S]*?desktop\?\.clear !== true[\s\S]*?const validDesktopSettled = desktopSettled\.filter[\s\S]*?desktop\?\.clear === true/,
    "Stress evidence should separate desktop foreground failures from product overlay failures."
  );
  assert.match(
    stressSource,
    /const toolEnvironmentInterference = toolReturn\.filter[\s\S]*?!isToolForegroundSample\(item\)[\s\S]*?const validToolReturn = toolReturn\.filter[\s\S]*?isToolForegroundSample\(item\)/,
    "Stress evidence should separate tool activation failures from product overlay failures."
  );
  assert.match(
    stressSource,
    /environmentInterferenceCount[\s\S]*?productPassed[\s\S]*?environmentClean[\s\S]*?passed: productPassed/,
    "Stress summaries should keep product pass/fail distinct from environment interference."
  );
  assert.match(
    stressSource,
    /const realWindowsOnly = hasFlag\("--real-windows-only"\)/,
    "Stress runs should be able to judge real windows while keeping debug logs as diagnostics."
  );
  assert.match(
    stressSource,
    /if \(!realWindowsOnly\) \{[\s\S]*?readAppDebugState\(\)[\s\S]*?getOverlayStateFromWindows\(windows\)/,
    "Real-window stress mode must not use app debug state as the overlay-ready source."
  );
  assert.match(
    stressSource,
    /function isDesktopBarVisible\(item\) \{[\s\S]*?return !realWindowsOnly && item\.appDebug\?\.desktopBar\?\.visible === true;[\s\S]*?function isHudVisible\(item\) \{[\s\S]*?return !realWindowsOnly && item\.appDebug\?\.hud\?\.visible === true;/,
    "Real-window stress mode must not let debug logs mask actual top-bar or HUD visibility."
  );
  assert.match(
    stressSource,
    /findPreviousOverlayHideAt\(debugEntries, overlayKind, current - 150, current\)/,
    "Residual-overlay metrics should tolerate debug-log read races when a hide event landed just before sampling."
  );
  const refreshToolHudSource = extractFunction(mainSource, "async function refreshToolHud");
  assert.doesNotMatch(
    refreshToolHudSource,
    new RegExp("getActiveWindow|getVisible" + "RememberedToolContext|getDetectedToolContext|rememberActiveTool"),
    "HUD rendering must not resample foreground state, revive a remembered tool, or update tool memory."
  );
  const warmShowToolHudSource = extractFunction(mainSource, "function warmShowToolHudForTransition");
  assert.match(
    warmShowToolHudSource,
    /decision\?\.toolContext\?\.tool[\s\S]*?isOverlayDecisionCurrent\(decision, SURFACES\.TOOL\)[\s\S]*?warmToolHudPayload[\s\S]*?payload\.tool\.id !== decision\.toolContext\.tool\.id[\s\S]*?const anchorWindow = decision\.toolContext\.window \|\| decision\.activeWindow \|\| payload\.activeWindow[\s\S]*?showToolHudWindow\(hudBounds\)/,
    "Tool HUD warm-show should only run after the state machine has confirmed tool-hud for the same tool."
  );
  assert.doesNotMatch(
    warmShowToolHudSource,
    new RegExp("getActiveWindow|getVisible" + "RememberedToolContext|getDetectedToolContext|rememberActiveTool"),
    "Tool HUD warm-show must not resample foreground state or revive remembered tools."
  );
  const warmShowGuardSource = extractFunction(mainSource, "function shouldWarmShowToolHudForDecision");
  assert.match(
    warmShowGuardSource,
    /previousDecision\?\.mode !== SURFACES\.TOOL[\s\S]*?toolHudWindow[\s\S]*?isVisible[\s\S]*?isMinimized/,
    "Warm-show guard must allow recovery on desktop->tool, missing window, hidden window, or minimized window."
  );
  assert.match(
    mainSource,
    /if \(shouldWarmShowToolHudForDecision\(decision, previousDecision\)\) \{\s*warmShown = warmShowToolHudForTransition\(decision\) \|\| quickShowToolHudForTransition\(decision\);\s*\}/,
    "Steady tool-hud -> tool-hud must not call warm or quick HUD show when HUD is already visible."
  );
  assert.doesNotMatch(
    extractFunction(mainSource, "function shouldRefreshToolHudForDecision"),
    /warmShowToolHudForTransition|showToolHudWindow/,
    "shouldRefreshToolHudForDecision must stay scoped to content refresh, not warm-show."
  );
  assert.match(
    mainSource,
    /function showToolHudWindow\(hudBounds = null, options = \{\}\) \{[\s\S]*?const promoteVisible = options\.promoteVisible !== false;[\s\S]*?showInactive\(\)[\s\S]*?promoteVisible && [\s\S]*?moveTop\(\)/,
    "showToolHudWindow must gate moveTop behind promoteVisible to prevent steady-state flicker."
  );
  assert.match(
    mainSource,
    /hideDesktopBarWindow\("tool-hud"\);[\s\S]*?if \(shouldWarmShowToolHudForDecision\(decision, previousDecision\)\) \{\s*warmShown = warmShowToolHudForTransition\(decision\) \|\| quickShowToolHudForTransition\(decision\);\s*\}[\s\S]*?await refreshToolHud\(/,
    "Switching from desktop to a confirmed tool should show a reusable HUD payload before async content refresh, gated by the warm-show guard."
  );
  assert.match(
    extractFunction(mainSource, "function preserveSettingsOverlaySurface"),
    /!toolHudWindow\.isVisible\(\) \|\| .*?isMinimized/,
    "Settings-overlay preserve must not call showToolHudWindow while HUD is already visible, preventing steady-state moveTop."
  );
  assert.match(
    mainSource,
    /function showToolHudHitbox\(hudBounds = null, options = \{\}\) \{[\s\S]*?const promoteVisible = options\.promoteVisible !== false;[\s\S]*?promoteVisible && [\s\S]*?moveTop/,
    "showToolHudHitbox must accept promoteVisible to prevent cascading moveTop from showToolHudWindow."
  );
  assert.match(
    mainSource,
    /updateToolHudHitboxForPayload\(hudBounds \|\| toolHudWindow\.getBounds\(\), \{ promoteVisible \}\)/,
    "showToolHudWindow must forward promoteVisible through the payload-aware hitbox gate."
  );
  assert.match(
    refreshToolHudSource,
    /isStaleToolHudRefresh\(options, toolContext\)[\s\S]*?retireStaleToolHudRefresh\(activeWindow\)[\s\S]*?outcome: "stale-decision"/,
    "Stale tool-HUD refreshes must be dropped before they can mutate the current overlay surface."
  );
  assert.match(
    refreshToolHudSource,
    /sendHudUpdate\(latestHudPayload\)[\s\S]*?isStaleToolHudRefresh\(options, toolContext\)[\s\S]*?outcome: "stale-before-show"[\s\S]*?showToolHudWindow\(hudBounds\)/,
    "A tool-HUD refresh must recheck the state-machine decision before showing the HUD window."
  );
  assert.match(
    mainSource,
    /function isOverlayDecisionCurrent\(decision, expectedMode = null\)[\s\S]*?latestOverlayDecision\?\.version !== decision\.version[\s\S]*?latestOverlayDecision\?\.mode !== expectedMode/,
    "Overlay transitions should be gated by the current state-machine decision version."
  );
  assert.match(
    mainSource,
    /await refreshToolHud\([\s\S]*?if \(!isOverlayDecisionCurrent\(decision, SURFACES\.TOOL\)\) \{[\s\S]*?outcome: "stale-tool-transition"[\s\S]*?return;[\s\S]*?if \(decision\.toolContext\) \{[\s\S]*?rememberActiveTool/,
    "An old tool transition must not update active-tool metadata after a newer state-machine decision has taken over."
  );
  assert.match(
    mainSource,
    /test:overlay-state|overlay-controller/,
    "The top-bar/HUD arbitration contract should be covered by a dedicated overlay state test."
  );
  assert.doesNotMatch(
    mainSource,
    new RegExp('reason: "' + "remembered-" + 'tool-visible"'),
    "Ordinary non-fullscreen foreground windows must not inherit a HUD from a remembered background tool."
  );
  assert.doesNotMatch(
    mainSource,
    new RegExp("async function getVisible" + "RememberedToolContext\\("),
    "Remembered tool visibility helpers should not remain in main overlay arbitration code."
  );
  assert.doesNotMatch(
    mainSource,
    new RegExp("function isRemembered" + "ToolWindowStatusUsable\\("),
    "Remembered tool window status checks must not be available as a HUD revival path."
  );
  assert.doesNotMatch(
    mainSource,
    /reason:\s*"shell-underlying-tool"/,
    "Taskbar/shell foreground reports should not resurrect an underlying tool HUD."
  );
  assert.doesNotMatch(
    mainSource,
    /reason:\s*"shell-foreground"/,
    "Shell and taskbar foreground reports should not use a separate legacy top-bar reason."
  );
  assert.match(
    activeWindowSource,
    /function isWindowsDesktopAssistantForeground\(windowInfo[\s\S]*?ClickToDo[\s\S]*?narratorhelperwindow/,
    "Windows Click to Do and Narrator helper foregrounds should be recognized as narrow desktop assistant candidates."
  );
  assert.match(
    activeWindowSource,
    /function getForegroundFallbackReason\(activeWindow[\s\S]*?isWindowsDesktopAssistantForeground\(activeWindow, platform\)[\s\S]*?"windows-desktop-assistant"/,
    "Desktop assistant foregrounds should take the blocker-aware foreground fallback path before showing the desktop top bar."
  );
  assert.match(
    activeWindowSource,
    /function Test-WindowsDesktopAssistantForeground\(\$windowInfo\)[\s\S]*?ClickToDo[\s\S]*?narratorhelperwindow/,
    "The PowerShell foreground sampler should share the same Click to Do and Narrator helper recognition."
  );
  assert.match(
    activeWindowSource,
    /function Test-NeedsBlockingWindowScan\(\$windowInfo\)[\s\S]*?Test-WindowsDesktopAssistantForeground \$windowInfo/,
    "Desktop assistant foregrounds should scan blockers so Click to Do over a real app does not show the desktop top bar."
  );
  assert.match(
    activeWindowSource,
    /function Test-ShellOrOverlayWindow\(\$windowInfo\)[\s\S]*?Test-WindowsDesktopAssistantForeground \$windowInfo/,
    "Desktop assistant foreground windows should be skipped as shell noise during blocker scans."
  );
  assert.match(
    activeWindowSource,
    /function Test-DesktopTopBarShellForeground\(\$windowInfo\)[\s\S]*?Test-WindowsDesktopAssistantForeground \$windowInfo/,
    "A clear desktop behind a desktop assistant foreground should be allowed to resolve back to the Explorer desktop base."
  );
  assert.match(
    mainSource,
    /desktopVisible: !settingsDecision && !hudSuppressedByPopup && shouldShowDesktopBar\(activeWindow\)/,
    "Only desktop foregrounds, including desktop right-click context menus, should be a direct desktop-topbar decision unless a tray/menu popup is suppressing HUD surfaces."
  );
  assert.doesNotMatch(
    resolveOverlayDecisionSource,
    /non-fullscreen-foreground/,
    "Ordinary non-desktop foreground windows must not show the desktop top bar just because they are not fullscreen."
  );
  assert.match(
    mainSource,
    /async function applyOverlayTransition\(decision, previousDecision\) \{[\s\S]*?decision\.mode === SURFACES\.DESKTOP[\s\S]*?hideToolHudForDesktop\(decision\.activeWindow\);[\s\S]*?showDesktopBarForTransition\(decision\)/,
    "Desktop top-bar decisions must clear stale in-tool HUDs before showing the top bar."
  );
  assert.doesNotMatch(
    resolveOverlayDecisionSource,
    new RegExp("getVisible" + "RememberedToolContext\\("),
    "Overlay decisions should not keep HUDs alive solely because a remembered tool window is still visible."
  );
  assert.doesNotMatch(
    resolveOverlayDecisionSource,
    /getDetectedToolContext\(/,
    "Overlay decisions should not keep HUDs alive from desktop blockers; only the confirmed foreground tool should select tool-hud."
  );
  assert.match(
    resolveOverlayDecisionSource,
    /getForegroundToolContext\(activeWindow\)/,
    "Overlay decisions should use strict foreground tool detection."
  );
  assert.match(
    mainSource,
    /hideDesktopBarWindow\(decision\.reason\);[\s\S]*?hideToolHudForUnsupportedForeground\(decision\.activeWindow, null\)/,
    "Non-tool decisions should still hide the desktop top bar before suppressing the HUD."
  );
  assert.doesNotMatch(
    mainSource,
    /\n  hideDesktopBarWindow\(latestOverlayDecision\.reason\);\n\n  if \(latestOverlayDecision\.suppressHud\)/,
    "Tool HUD decisions should not create a blank gap by hiding the desktop top bar before the HUD is visible."
  );
  assert.match(
    mainSource,
    /function shouldHideToolHudForDesktopForeground\(activeWindow\) \{[\s\S]*?return shouldShowDesktopBar\(activeWindow\);[\s\S]*?\}/,
    "Any foreground that resolves to the desktop top bar must suppress the HUD."
  );
  assert.match(
    mainSource,
    /function shouldRefreshSnapshotForToolDecision\(decision, previousDecision\) \{[\s\S]*?previousDecision\?\.mode !== "tool-hud"[\s\S]*?previousToolId !== nextToolId/,
    "Returning to a supported tool should request a foreground quota refresh without tightening steady-state refresh."
  );
  assert.match(
    mainSource,
    /function scheduleToolDecisionSnapshotRefresh\(decision\) \{[\s\S]*?const decisionVersion = decision\.version;[\s\S]*?latestOverlayDecision\?\.version !== decisionVersion \|\| latestOverlayDecision\?\.mode !== SURFACES\.TOOL[\s\S]*?sendSnapshot\(\);/,
    "Tool-entry snapshot refreshes must be deferred and guarded by the current overlay decision version."
  );
  assert.match(
    mainSource,
    /if \(shouldRefreshSnapshotForToolDecision\(decision, previousDecision\)\) \{[\s\S]*?scheduleToolDecisionSnapshotRefresh\(decision\);[\s\S]*?\}/,
    "Tool transitions should schedule provider refreshes instead of blocking the overlay transaction with sendSnapshot()."
  );
  assert.match(
    mainSource,
    /function shouldRefreshToolHudForDecision\(decision, previousDecision\) \{[\s\S]*?latestHudPayload\?\.visible[\s\S]*?hudAnchorBoundsCloseEnough/,
    "The coordinator should ignore tiny tool-bound jitters while staying on the same tool window."
  );
  assert.match(
    mainSource,
    /function refreshToolHud\(options = \{\}\) \{[\s\S]*?const hudBounds = getHudBounds\(display, tool, anchorWindow \|\| activeWindow, settings\);[\s\S]*?setWindowBoundsIfChanged\(toolHudWindow, hudBounds\)/,
    "The HUD render path should position from the state-controller tool bounds without dialog-overlap arbitration."
  );
  assert.match(
    mainSource,
    /const preservedToolPopupContext = !settingsDecision \? getPreservedToolPopupContext\(activeWindow\) : null;[\s\S]*?const hudSuppressedByPopup = !settingsDecision && !preservedToolPopupContext && isHudSuppressingForegroundPopup\(activeWindow\);[\s\S]*?preservedToolPopupContext \|\| \(hudSuppressedByPopup \? null : getForegroundToolContext\(activeWindow\)\)/,
    "Strict foreground tool detection should happen before the state controller decides between HUD, top bar, and hidden, while WorkBuddy auxiliary popups can preserve the previous tool context."
  );
  assert.doesNotMatch(
    refreshToolHudSource,
    new RegExp("getActiveWindow|getDetectedToolContext|getVisible" + "RememberedToolContext|rememberActiveTool"),
    "HUD rendering should not perform a second foreground/tool decision."
  );
  assert.doesNotMatch(
    mainSource,
    /hidden-dialog-overlap|preserved-dialog-overlap|dialog-overlap-preserved|getHudCoveringDialog\(activeWindow/,
    "Tool dialogs and content overlays should not close, preserve, or reposition the HUD via overlap logic."
  );
  assert.match(
    mainSource,
    /hiddenReason:\s*"unsupported-foreground"/,
    "Unsupported foreground windows should clear stale HUD payloads immediately."
  );
  assert.match(
    mainSource,
    /hidden-unsupported-foreground/,
    "Unsupported foreground HUD hides should be logged for diagnostics."
  );
  assert.doesNotMatch(
    mainSource,
    /function hideToolHudForUnsupportedForeground\(activeWindow, foregroundTool\) \{[\s\S]*?if \(isOwnDesktopBar\(activeWindow\)\) return;/,
    "Owned overlay foreground samples must not protect stale HUD payloads from being hidden."
  );
  assert.match(
    mainSource,
    /setFocusable\(false\)/,
    "The HUD window must stay non-focusable so Explorer rename/edit focus is not stolen."
  );
  assert.match(
    mainSource,
    /function reinforceNonActivatingWindow\(window\) \{[\s\S]*?window\.setFocusable\(false\);[\s\S]*?window\.blur\(\);/,
    "Overlay show and hitbox paths should actively reassert non-activating behavior so Codex keeps keyboard focus."
  );
  assert.match(
    mainSource,
    /function setToolHudMouseRegion\(interactive\) \{[\s\S]*?toolHudWindow\.setIgnoreMouseEvents\(true, \{ forward: true \}\)/,
    "The HUD display window must stay mouse-pass-through even when renderer code asks for interaction."
  );
  assert.match(
    mainSource,
    /function setToolHudHitboxMouseRegion\(interactive\) \{[\s\S]*?toolHudHitboxWindow\.setIgnoreMouseEvents\(!nextInteractive, \{ forward: true \}\)/,
    "The HUD interaction hitbox should default to pass-through and only become interactive over exact controls."
  );
  assert.match(
    mainSource,
    /const TOOL_HUD_HITBOX_ENABLED = false;/,
    "The tool HUD transparent hitbox should stay globally disabled so IME input in tools is not disturbed."
  );
  assert.match(
    mainSource,
    /function createToolHudHitboxWindow\(\) \{[\s\S]*?!TOOL_HUD_HITBOX_ENABLED[\s\S]*?destroyToolHudHitbox\(\);[\s\S]*?return;/,
    "The disabled HUD hitbox path must destroy any stale hitbox instead of keeping a hidden transparent window alive."
  );
  assert.match(
    mainSource,
    /function hideToolHudHitbox\(\) \{[\s\S]*?!TOOL_HUD_HITBOX_ENABLED[\s\S]*?destroyToolHudHitbox\(\);[\s\S]*?return;/,
    "Hiding the HUD hitbox while globally disabled must remove the transparent window."
  );
  assert.match(
    mainSource,
    /function setToolHudHitboxMouseRegion\(interactive\) \{[\s\S]*?const nextInteractive = shouldUseToolHudHitbox\(\) && Boolean\(interactive\)/,
    "The hitbox mouse-region IPC path must still be hard-gated by the global hitbox flag."
  );
  assert.match(
    mainSource,
    /function shouldUseToolHudHitbox\(payload = latestHudPayload\) \{[\s\S]*?TOOL_HUD_HITBOX_ENABLED && Boolean\(payload\?\.visible\)/,
    "Tools keep the visual HUD but disable the separate interaction hitbox to avoid input interference."
  );
  assert.match(
    mainSource,
    /function setToolHudHitboxMouseRegion\(interactive\) \{[\s\S]*?reinforceNonActivatingWindow\(toolHudHitboxWindow\)[\s\S]*?setIgnoreMouseEvents\(!nextInteractive/,
    "Enabling the HUD hitbox must not make it an activating foreground target."
  );
  assert.match(
    mainSource,
    /toolHudHitboxMouseInteractive = null;[\s\S]*?setToolHudHitboxMouseRegion\(false\);/,
    "The HUD hitbox should reset to mouse-pass-through when it is created."
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("hud-hitbox:mouse-region"/,
    "The main process should expose a dedicated HUD hitbox mouse-region IPC path."
  );
  assert.match(
    preloadSource,
    /setToolHudHitboxMouseRegion:\s*\(interactive\) => ipcRenderer\.invoke\("hud-hitbox:mouse-region", Boolean\(interactive\)\)/,
    "The preload bridge should expose the dedicated HUD hitbox mouse-region IPC path."
  );
  assert.match(
    hudHitboxSource,
    /function setupHitboxPointerRegion\(\) \{[\s\S]*?setToolHudHitboxMouseRegion[\s\S]*?mousemove/,
    "The HUD hitbox renderer should toggle mouse interaction from pointer location."
  );
  assert.match(
    hudHitboxSource,
    /isPointerInsideElement\(event, els\.trust\)[\s\S]*?isPointerInsideElement\(event, els\.settings\)/,
    "The HUD hitbox should only accept mouse input over the trust and settings buttons."
  );
  assert.match(
    mainSource,
    /function createToolHudHitboxWindow/,
    "The disabled HUD hitbox code path should remain isolated behind the global flag."
  );
  assert.doesNotMatch(
    extractFunction(mainSource, "function createToolHudWindow"),
    /createToolHudHitboxWindow\(/,
    "Creating the visual HUD must not eagerly create the transparent hitbox window."
  );
  assert.match(
    mainSource,
    /function getPreservedToolPopupContext\(activeWindow\) \{[\s\S]*?previousContext\.tool\.id !== "workbuddy"[\s\S]*?className[\s\S]*?=== "#32768"[\s\S]*?isLikelyTrayCornerPopup\(activeWindow\)/,
    "WorkBuddy auxiliary popups may preserve the HUD, but menu-class and tray-corner popups must still suppress it."
  );
  assert.match(
    mainSource,
    /title:\s*"LLM HUD Controls"[\s\S]*?focusable:\s*false/,
    "The HUD interaction hitbox must stay non-focusable."
  );
  assert.match(
    mainSource,
    /function createToolHudWindow\(\) \{[\s\S]*?alwaysOnTop:\s*false[\s\S]*?toolHudWindow\.setAlwaysOnTop\(true,\s*"floating"\)/,
    "The display HUD should be created non-topmost and then promoted with the same non-menu floating level as the desktop bar."
  );
  assert.match(
    mainSource,
    /function createToolHudHitboxWindow\(\) \{[\s\S]*?alwaysOnTop:\s*false[\s\S]*?toolHudHitboxWindow\.setAlwaysOnTop\(true,\s*"floating"\)/,
    "The HUD hitbox should avoid pop-up-menu z-order semantics that can perturb the focused tool."
  );
  assert.doesNotMatch(
    mainSource,
    /toolHud(?:Hitbox)?Window\.setAlwaysOnTop\(true,\s*"pop-up-menu"\)/,
    "HUD windows must not use pop-up-menu topmost level because it can participate in Windows foreground/menu arbitration."
  );
  assert.match(
    mainSource,
    /getOwnedWindowHwnds\(\) \{[\s\S]*?\[desktopBarWindow, toolHudWindow, toolHudHitboxWindow, hudTrustPopoverWindow, settingsWindow\]/,
    "The HUD hitbox must be ignored by foreground/blocker scans like the display HUD."
  );
  assert.match(
    mainSource,
    /function showDesktopBarWindow/,
    "The desktop top bar should centralize non-activating display behavior."
  );
  assert.match(
    toolDetectionSource,
    /function shouldShowDesktopBar/,
    "The desktop top bar should centralize its positive desktop visibility gate."
  );
  assert.doesNotMatch(
    mainSource,
    /desktop-after-tool-transition|shouldDeferTransientDesktopAfterTool|DESKTOP_AFTER_TOOL_TRANSIENT_GRACE_MS/,
    "Desktop decisions must not preserve a HUD on the real desktop just because a remembered tool hwnd is still visible."
  );
  assert.ok(
    !shouldShowDesktopBarSource.includes("isForegroundFullscreen("),
    "The desktop top bar gate must not hide the real desktop just because the desktop surface spans the display."
  );
  assert.ok(
    !shouldShowDesktopBarSource.includes("isShellForegroundWindow("),
    "Generic shell foreground windows must not be promoted to desktop visibility inside shouldShowDesktopBar."
  );
  assert.ok(
    !shouldShowDesktopBarSource.includes("desktop.blockers") && !shouldShowDesktopBarSource.includes("hasDesktopBarBlocker"),
    "The desktop top-bar gate must not return to broad desktop blocker list arbitration."
  );
  assert.match(
    toolDetectionSource,
    /function doesWindowOverlapDesktopBar/,
    "The desktop top bar should keep a shared overlap helper for HUD/popover placement and diagnostics."
  );
  assert.doesNotMatch(
    mainSource,
    /function hasDesktopBarBlocker|hasDesktopBarBlocker\(activeWindow\)/,
    "Desktop blocker checks should no longer be part of top-bar show/hide arbitration."
  );
  assert.match(
    mainSource,
    /desktopBarWindow\.setFocusable\(false\)/,
    "The desktop top bar must stay non-focusable so typing in other apps is not interrupted."
  );
  assert.match(
    mainSource,
    /desktopBarWindow\.showInactive\(\)/,
    "The desktop top bar must use non-activating show calls."
  );
  assert.match(
    mainSource,
    /if \(!desktopBarWindow\.isVisible\(\) \|\| forceShow\)/,
    "The desktop top bar must not repeat z-order show calls while already visible unless a transition explicitly force-shows it."
  );
  assert.match(
    mainSource,
    /function shouldHideToolHudForDesktopForeground\(activeWindow\) \{[\s\S]*?return shouldShowDesktopBar\(activeWindow\);[\s\S]*?\}/,
    "The tool HUD refresh must stop before remembered-tool fallback whenever the foreground should show the top bar."
  );
  assert.ok(
    !isDesktopForegroundSource.includes("isOwnDesktopBar("),
    "Owned top-bar windows must be sampling noise, not real desktop foreground."
  );
  assert.match(
    toolDetectionSource,
    /isDesktopForegroundWindow\(activeWindow, process\.platform\)/,
    "The main process desktop gate should share native desktop foreground detection, including localized Windows Explorer names."
  );
  assert.doesNotMatch(
    mainSource,
    /activeWindow\?\.desktop\?\.clear === true\) return true/,
    "A clear desktop report from native scanning must not bypass foreground desktop validation."
  );
  assert.match(
    mainSource,
    /function setWindowBoundsIfChanged\(window, bounds\) \{[\s\S]*?boundsCloseEnough\(current, bounds\)[\s\S]*?window\.setBounds\(bounds\)/,
    "The tool HUD must not reapply jitter-equivalent bounds on every refresh."
  );
  assert.match(
    mainSource,
    /async function applyOverlayTransition\(decision, previousDecision\) \{[\s\S]*?decision\.mode === SURFACES\.TOOL[\s\S]*?hideDesktopBarWindow\("tool-hud"\);[\s\S]*?await refreshToolHud\(/,
    "Switching from the desktop to a tool should hide the stale desktop top bar before waiting for HUD rendering."
  );
  assert.match(
    mainSource,
    /function restoreOverlayWindowIfMinimized\(window\) \{[\s\S]*?window\.isMinimized\(\)[\s\S]*?window\.restore\(\)/,
    "Overlay windows minimized by Windows Show Desktop should be restored before they are shown again."
  );
  assert.match(
    mainSource,
    /function showDesktopBarWindow\(options = \{\}\) \{[\s\S]*?restoreOverlayWindowIfMinimized\(desktopBarWindow\)[\s\S]*?desktopBarWindow\.setAlwaysOnTop\(true, "floating"\)[\s\S]*?showInactive\(\)/,
    "The desktop top bar should restore and re-promote itself after Windows Show Desktop changes overlay z-order."
  );
  assert.match(
    mainSource,
    /function showDesktopBarForTransition\(decision\) \{[\s\S]*?const needsRestore = !state\?\.visible \|\| state\.minimized[\s\S]*?if \(decision\.transition\?\.changed \|\| needsRestore\) \{[\s\S]*?showDesktopBarWindow\(\{ promoteVisible: Boolean\(decision\.transition\?\.changed\) \}\)/,
    "A steady desktop-topbar decision must not keep calling moveTop; only transitions and restore paths should promote the top bar."
  );
  assert.match(
    mainSource,
    /function showToolHudWindow\(hudBounds = null, options = \{\}\) \{[\s\S]*?restoreOverlayWindowIfMinimized\(toolHudWindow\)[\s\S]*?toolHudWindow\.setAlwaysOnTop\(true, "floating"\)[\s\S]*?showInactive\(\)/,
    "The tool HUD should restore and re-promote itself after a desktop switch changes overlay z-order."
  );
  assert.match(
    mainSource,
    /hidden-desktop/,
    "Desktop and shell foreground HUD suppression should be diagnosable."
  );
  assert.doesNotMatch(
    mainSource,
    /desktopBarWindow\.show\(\)/,
    "The desktop top bar must not use show(), because it can steal focus during refresh."
  );
  assert.doesNotMatch(
    mainSource,
    /setTimeout\(refreshToolHud/,
    "Startup should not bypass the overlay coordinator with a direct HUD refresh."
  );
  assert.match(
    mainSource,
    /setTimeout\(refreshOverlayCoordinator, 500\)/,
    "Startup should use the overlay coordinator for the initial visible-surface decision."
  );

  // -- display-adapter guards (PR #14: factory + smoke) --
  assert.match(
    mainSource,
    /createDisplayAdapter\(\{ screen \}\)/,
    "main.cjs should import display-adapter via DI factory with screen."
  );
  assert.match(
    displayAdapterSource,
    /function getPrimaryDisplay\(\)/,
    "Display-adapter module should provide getPrimaryDisplay() primitive."
  );
  assert.match(
    displayAdapterSource,
    /function getMatchingDisplay\(bounds\)/,
    "Display-adapter module should provide getMatchingDisplay(bounds) primitive."
  );
  assert.match(
    displayAdapterSource,
    /function getDisplayBounds\(activeWindow\)/,
    "Display-adapter module should host getDisplayBounds function."
  );
  assert.match(
    displayAdapterSource,
    /function isDisplayFillingBounds\(bounds\)/,
    "Display-adapter module should host isDisplayFillingBounds function."
  );
  assert.match(
    displayAdapterSource,
    /function getDisplayForActiveWindow\(activeWindow\)/,
    "Display-adapter module should host getDisplayForActiveWindow function."
  );
  assert.match(
    displayAdapterSource,
    /screen\.getPrimaryDisplay\(\)/,
    "Display-adapter primitives should wrap screen.getPrimaryDisplay()."
  );
  assert.match(
    displayAdapterSource,
    /screen\.getDisplayMatching\(bounds\)/,
    "Display-adapter primitives should wrap screen.getDisplayMatching(bounds)."
  );
  assert.doesNotMatch(
    mainSource,
    /screen\.getPrimaryDisplay\(\)/,
    "main.cjs should not call screen.getPrimaryDisplay() directly."
  );
  assert.doesNotMatch(
    mainSource,
    /screen\.getDisplayMatching\(/,
    "main.cjs should not call screen.getDisplayMatching() directly."
  );
  assert.match(
    mainSource,
    /const display = getMatchingDisplay\(current\)/,
    "resizeToolHud should call getMatchingDisplay(current)."
  );
  assert.match(
    mainSource,
    /const display = getMatchingDisplay\(sourceBounds\)/,
    "getHudTrustPopoverBounds should call getMatchingDisplay(sourceBounds)."
  );
  assert.match(
    mainSource,
    /screen\.on\('display-added'/,
    "main.cjs should listen for display-added to reposition overlay on hot-plug."
  );
  assert.match(
    mainSource,
    /screen\.on\('display-removed'/,
    "main.cjs should listen for display-removed to reposition overlay on hot-unplug."
  );
  assert.match(
    mainSource,
    /screen\.on\('display-metrics-changed'/,
    "main.cjs should listen for display-metrics-changed to reposition overlay on resolution/position change."
  );
}

function testSettingsPreviewGuards() {
  const mainSource = read("src/main.cjs");
  const toolDetectionSource = read("src/main/tool-detection.cjs");
  const preloadSource = read("src/preload.cjs");
  const appSource = read("src/renderer/app.js");
  const settingsSource = read("src/renderer/settings.js");
  const settingsHtml = read("src/renderer/settings.html");
  const hudSource = read("src/renderer/hud.js");
  const hudHtml = read("src/renderer/hud.html");
  const hudHitboxSource = read("src/renderer/hud-hitbox.js");
  const hudHitboxHtml = read("src/renderer/hud-hitbox.html");
  const hudPopoverSource = read("src/renderer/hud-trust-popover.js");
  const hudPopoverHtml = read("src/renderer/hud-trust-popover.html");
  const indexHtml = read("src/renderer/index.html");
  const stylesSource = read("src/renderer/styles.css");
  const activeWindowSource = read("src/system/active-window.cjs");
  for (const fileName of [
    "token-peek.png",
    "token-generator.png",
    "token-catch.png",
    "token-eat.png",
    "token-wait.png",
    "token-panic.png",
    "token-guard.png",
    "token-run.png"
  ]) {
    assert.ok(
      fs.existsSync(path.join(root, "src", "assets", "delight", "roaming", fileName)),
      `Roaming mascot asset should exist: ${fileName}`
    );
  }

  assert.match(
    mainSource,
    /ipcMain\.handle\("settings:preview"/,
    "Settings appearance edits should have a preview IPC path."
  );
  assert.match(
    mainSource,
    /broadcastSettings\(preview, \[desktopBarWindow, toolHudWindow, toolHudHitboxWindow, hudTrustPopoverWindow\]\)/,
    "Live settings preview should update the top bar, HUD, HUD hitbox, and HUD popover renderers."
  );
  assert.match(
    mainSource,
    /desktopBarHeight: guardedSettings\?\.windows\?\.desktopBarHeight/,
    "Live settings preview should include desktop bar height."
  );
  assert.match(
    mainSource,
    /toolHudWidth: guardedSettings\?\.windows\?\.toolHudWidth/,
    "Live settings preview should include independent tool HUD width."
  );
  assert.match(
    mainSource,
    /toolHudOffsetX: guardedSettings\?\.windows\?\.toolHudOffsetX/,
    "Live settings preview should include independent tool HUD horizontal offset."
  );
  assert.match(
    mainSource,
    /toolHudOffsetY: guardedSettings\?\.windows\?\.toolHudOffsetY/,
    "Live settings preview should include independent tool HUD vertical offset."
  );
  assert.match(
    mainSource,
    /getHudBounds\(display, latestHudPayload\.tool, latestHudPayload\.activeWindow, sourceSettings\)/,
    "Live HUD position preview should be recalculated from the current anchor window instead of accumulating slider deltas."
  );
  assert.match(
    mainSource,
    /resizeToolHud\(preview, settings\)/,
    "Live settings preview should resize the tool HUD immediately."
  );
  assert.match(
    preloadSource,
    /previewSettings:\s*\(settings\) => ipcRenderer\.invoke\("settings:preview", settings\)/,
    "The preload bridge should expose settings preview to the settings renderer."
  );
  assert.match(
    preloadSource,
    /showHudTrustPopover:\s*\(payload\) => ipcRenderer\.invoke\("hud-trust-popover:show", payload\)/,
    "The preload bridge should expose the HUD trust popover show path."
  );
  assert.match(
    preloadSource,
    /resizeHudTrustPopover:\s*\(size\) => ipcRenderer\.invoke\("hud-trust-popover:resize", size\)/,
    "The preload bridge should expose the HUD trust popover resize path."
  );
  assert.match(
    preloadSource,
    /getLocalSetupInfo:\s*\(\) => ipcRenderer\.invoke\("setup:info"\)/,
    "The preload bridge should expose local setup info to the settings renderer."
  );
  assert.match(
    preloadSource,
    /openGuide:\s*\(guide\) => ipcRenderer\.invoke\("guide:open", guide\)/,
    "The preload bridge should expose allowlisted guide opening to the settings renderer."
  );
  assert.match(
    preloadSource,
    /onHudTrustPopoverUpdate/,
    "The preload bridge should expose HUD trust popover update events."
  );
  assert.match(
    settingsSource,
    /isLivePreviewPath/,
    "The settings page should restrict live preview to visual paths."
  );
  assert.match(
    settingsSource,
    /windows\.desktopBarHeight/,
    "The settings page should allow live desktop bar height preview."
  );
  assert.match(
    settingsSource,
    /windows\.toolHudWidth/,
    "The settings page should allow independent tool HUD width preview."
  );
  assert.match(
    settingsSource,
    /renderLocalSetupInfo/,
    "The settings page should show local setup info for first-run users."
  );
  assert.match(
    settingsSource,
    /workbuddy-local[\s\S]*实时积分/,
    "The settings page should label WorkBuddy as a live credit source, not a planned placeholder."
  );
  assert.match(
    settingsSource,
    /adapter-ingest[\s\S]*本地接入/,
    "Adapter-backed tools should render as configurable local ingest sources."
  );
  assert.match(
    read("src/renderer/settings.html"),
    /data-guide="user"[\s\S]*data-guide="agent"/,
    "The settings page should link both user and agent first-run guides."
  );
  assert.match(
    settingsSource,
    /windows\.toolHudOffsetX/,
    "The settings page should live-preview the tool HUD horizontal offset."
  );
  assert.match(
    settingsHtml,
    /data-path="windows\.toolHudHeight"/,
    "The settings page should expose independent tool HUD height controls."
  );
  assert.match(
    settingsHtml,
    /data-path="windows\.toolHudOffsetX"/,
    "The settings page should expose the tool HUD horizontal offset inside the HUD group."
  );
  assert.match(
    settingsHtml,
    /data-path="windows\.toolHudOffsetY"/,
    "The settings page should expose the tool HUD vertical offset inside the HUD group."
  );
  assert.match(
    settingsHtml,
    /<h2>右侧 HUD<\/h2>/,
    "The settings page should group tool HUD controls independently from top bar controls."
  );
  assert.match(
    indexHtml,
    /usage-meta-today/,
    "Top bar usage metadata should have stable layout hooks."
  );
  assert.match(
    stylesSource,
    /grid-template-rows:\s*1fr 1fr/,
    "Top bar usage strip should use two compact rows so status and usage values do not crush the tool name."
  );
  assert.match(
    settingsSource,
    /window\.tokenBar\.previewSettings/,
    "The settings page should request live visual preview while sliders move."
  );
  assert.match(
    settingsSource,
    /function readNumberInput/,
    "The settings page should parse numeric inputs through a helper that can represent empty values."
  );
  assert.doesNotMatch(
    settingsSource,
    /Number\(input\.value\)/,
    "Empty settings number fields must not be coerced to 0 while the user is editing."
  );
  assert.match(
    settingsHtml,
    /id="settingsDone"/,
    "The settings footer should include a bottom close button."
  );
  assert.match(
    settingsSource,
    /settingsDone/,
    "The bottom close button should be wired in the settings renderer."
  );
  assert.match(
    hudHtml,
    /id="hudSettings"/,
    "The HUD should expose a direct settings control."
  );
  assert.match(
    indexHtml,
    /id="usageMascot"/,
    "The top bar usage strip should include the compact quota mascot inside the information box."
  );
  assert.doesNotMatch(
    indexHtml,
    /usage-mascot[\s\S]*?token-link/,
    "The in-strip quota mascot must not receive token interaction layers."
  );
  assert.match(
    indexHtml,
    /id="tokenGenerator"/,
    "The top bar should include a fixed token generator source."
  );
  assert.match(
    indexHtml,
    /id="quotaValue"/,
    "The top bar usage strip should expose the current remaining quota in its compact content area."
  );
  assert.match(
    indexHtml,
    /id="usageReset"/,
    "The top bar usage strip should expose reset or freshness timing instead of leaving empty space."
  );
  assert.match(
    indexHtml,
    /id="tokenFlow"/,
    "The top bar should animate token particles from the generator to the mascot."
  );
  assert.match(
    indexHtml,
    /id="roamingMascot"/,
    "The top bar should include a separate transparent roaming mascot layer."
  );
  assert.doesNotMatch(
    indexHtml,
    /class="roaming-token/,
    "Roaming mascots should not carry fake local token particles; tokens should come from the generator."
  );
  assert.doesNotMatch(
    stylesSource,
    /roaming-token|token-bite|token-bowl|token-hang|token-chase|token-nap/,
    "The old local-token mascot scenes should not remain in CSS after the generator-to-mascot redesign."
  );
  assert.match(
    hudHtml,
    /class="token-link token-main"/,
    "The HUD mascot should include token-linked animation layers."
  );
  assert.match(
    hudSource,
    /window\.tokenBar\.openSettings\("hud"\)/,
    "The HUD settings control should open the settings window without losing its HUD owner."
  );
  assert.doesNotMatch(
    hudSource,
    /setupHudPointerRegion\(\)/,
    "The HUD display renderer should no longer toggle the display window into an interactive pointer region."
  );
  assert.match(
    hudHitboxHtml,
    /id="hitboxSettings"/,
    "A separate HUD hitbox window should expose the settings control without making the full HUD interactive."
  );
  assert.match(
    hudHitboxSource,
    /window\.tokenBar\.openSettings\("hud"\)/,
    "The HUD hitbox settings control should open the settings window without losing its HUD owner."
  );
  assert.match(
    appSource,
    /window\.tokenBar\.openSettings\("desktop"\)/,
    "The top bar settings control should open the settings window without losing its desktop owner."
  );
  assert.match(
    preloadSource,
    /openSettings:\s*\(source\) => ipcRenderer\.invoke\("settings:open", source\)/,
    "The preload bridge should pass the settings overlay owner to the main process."
  );
  assert.match(
    mainSource,
    /settingsOverlayOwner[\s\S]*?settingsPreservedOverlayDecision/,
    "The main process should remember which overlay opened settings."
  );
  assert.match(
    mainSource,
    /function resolveSettingsOverlayDecision\(activeWindow\) \{[\s\S]*?mode: "settings-overlay"[\s\S]*?preserveOverlay: true/,
    "The overlay coordinator should preserve the current top bar or HUD while settings is visible."
  );
  assert.match(
    mainSource,
    /function preserveSettingsOverlaySurface\(decision\) \{[\s\S]*?showDesktopBarForTransition\(decision\)[\s\S]*?showToolHudWindow\(lastVisibleHudBounds\)/,
    "Settings preservation should restore either the top bar or HUD surface."
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("settings:open", \(event, owner\) => \{[\s\S]*?getSettingsOverlayOwnerFromWindow\(BrowserWindow\.fromWebContents\(event\.sender\)\)/,
    "Opening settings should infer the owner window when the renderer does not pass one."
  );
  assert.match(
    activeWindowSource,
    /Test-ShellOrOverlayWindow[\s\S]*?谁在吃 token 设置/,
    "The Windows foreground sampler should ignore the app settings window as an own overlay."
  );
  assert.match(
    activeWindowSource,
    /function Get-FallbackForegroundPayload\(\) \{[\s\S]*?Test-ShellOrOverlayWindow \$windowInfo[\s\S]*?Test-DesktopShellBaseWindow \$windowInfo/,
    "The Windows foreground fallback should skip shell popups and owned overlays while still allowing the real desktop base."
  );
  assert.match(
    activeWindowSource,
    /function selectDesktopBaseWindow\(activeWindow[\s\S]*?isDesktopBaseCandidate\(activeWindow[\s\S]*?isDesktopBaseCandidate\(normalized/,
    "Desktop base selection should skip shell popups and owned overlays in both the active and enumerated window paths."
  );
  assert.match(
    activeWindowSource,
    /function selectDesktopBaseWindow\(activeWindow[\s\S]*?isZeroSizedExplorerShellWindow\(activeWindow, platform\)[\s\S]*?allowDesktopShellBase: false/,
    "Zero-size Explorer shell samples should prefer a real visible app before falling back to the desktop base."
  );
  assert.match(
    activeWindowSource,
    /function isDesktopBaseSelectionNoise\(windowInfo[\s\S]*?isZeroSizedExplorerShellWindow\(windowInfo, platform\)[\s\S]*?isDesktopShellBaseWindow\(windowInfo, platform\)[\s\S]*?return false;[\s\S]*?isShellOrOwnOverlayWindow\(windowInfo, platform\)/,
    "Desktop base selection should still allow the real Explorer desktop base window."
  );
  assert.match(
    activeWindowSource,
    /function isDesktopBaseSelectionNoise\(windowInfo[\s\S]*?isExplorerShellFloatingWindow\(windowInfo, platform\)/,
    "Desktop base selection should skip Explorer shell floating windows such as desktop context menus."
  );
  assert.match(
    mainSource,
    /title:\s*"谁在吃 token 设置"/,
    "The settings BrowserWindow should have a stable title for foreground filtering."
  );
  assert.match(
    hudHitboxSource,
    /window\.tokenBar\.showHudTrustPopover/,
    "The HUD hitbox trust control should show the detailed trust popover."
  );
  assert.match(
    hudSource,
    /getTrustPopoverDetails/,
    "The HUD should build detailed trust popover content instead of relying on a native title tooltip."
  );
  assert.match(
    hudSource,
    /判定口径/,
    "The HUD trust popover should disclose which quota basis drives mascot and frame state."
  );
  assert.match(
    hudSource,
    /getCapacityStandardRemaining/,
    "HUD capacity state should use the provider-specific quota standard helper."
  );
  assert.match(
    hudSource,
    /window\.tokenBar\.showHudTrustPopover/,
    "The HUD trust badge should open the custom trust popover."
  );
  assert.match(
    hudSource,
    /els\.hudTrust\.title = ""/,
    "The HUD trust badge should not show the native title tooltip over the custom popover."
  );
  assert.match(
    appSource,
    /els\.trustBadge\?\.addEventListener\("pointerenter"/,
    "The top bar trust badge should open the same custom trust popover."
  );
  assert.match(
    appSource,
    /判定口径/,
    "The top bar trust popover should disclose which quota basis drives mascot and frame state."
  );
  assert.match(
    appSource,
    /当前 5 小时窗口余量/,
    "Codex capacity mode should disclose current five-hour remaining as the state basis."
  );
  assert.match(
    appSource,
    /Token Plan 剩余 \/ 总量/,
    "Token-plan mode should disclose remaining over total as the state basis."
  );
  assert.match(
    appSource,
    /getCapacityStandardRemaining/,
    "Top bar capacity state should use the provider-specific quota standard helper."
  );
  assert.match(
    appSource,
    /element\.title = ""/,
    "The top bar trust badge should not show the native title tooltip over the custom popover."
  );
  assert.match(
    appSource,
    /ROAMING_MASCOT_SCENES/,
    "The top bar should define separate roaming mascot action assets."
  );
  assert.match(
    appSource,
    /function positionRoamingMascot/,
    "The top bar should place roaming mascots from measured DOM bounds instead of fixed percentages."
  );
  assert.match(
    appSource,
    /clampValue\(point\.x[\s\S]*?layout\.stageWidth/,
    "Roaming mascot placement should clamp horizontally inside the transparent stage."
  );
  assert.match(
    appSource,
    /getLocalRect\(els\.tokenGenerator, stageRect\)/,
    "Roaming mascot placement should measure the fixed token generator against the larger transparent stage."
  );
  assert.match(
    appSource,
    /setDesktopBarMouseRegion/,
    "The larger transparent top-bar stage should report whether the pointer is over the real bar."
  );
  assert.match(
    preloadSource,
    /setToolHudMouseRegion:\s*\(interactive\) => ipcRenderer\.invoke\("hud:mouse-region", Boolean\(interactive\)\)/,
    "The preload bridge should expose a dedicated HUD mouse-region IPC path."
  );
  assert.match(
    appSource,
    /scheduleRoamingMascot/,
    "The top bar should periodically move the roaming mascot to another anchor."
  );
  assert.match(
    appSource,
    /prefersReducedMotion/,
    "The roaming mascot should respect reduced-motion environments."
  );
  assert.match(
    mainSource,
    /HUD_TRUST_POPOVER_WIDTH/,
    "The main process should create a dedicated HUD trust popover window."
  );
  assert.match(
    mainSource,
    /HUD_TRUST_POPOVER_MAX_HEIGHT/,
    "The trust popover should have a larger bounded height so details are not clipped."
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("hud-trust-popover:show"/,
    "The main process should expose a HUD trust popover show IPC handler."
  );
  assert.match(
    mainSource,
    /hudTrustPopoverWindow\.setFocusable\(false\)/,
    "The trust popover must stay non-focusable so it does not steal input focus."
  );
  assert.match(
    mainSource,
    /latestHudTrustPopoverOwner/,
    "The shared trust popover should track whether it belongs to the top bar or HUD."
  );
  assert.match(
    mainSource,
    /hideHudTrustPopover\("hud"\)/,
    "HUD hide paths should not close a top-bar trust popover."
  );
  assert.match(
    mainSource,
    /hideHudTrustPopover\(getHudTrustPopoverOwner\(BrowserWindow\.fromWebContents\(event\.sender\)\)\)/,
    "Renderer hide requests should close only the popover owned by the requesting window."
  );
  assert.match(
    mainSource,
    /getDesktopBarWindowBounds/,
    "The desktop top bar should use a larger transparent window for the mascot stage."
  );
  assert.match(
    stylesSource,
    /--bar-y:\s*4px/,
    "The renderer fallback layout should also keep the glass bar near the top edge."
  );
  assert.match(
    mainSource,
    /getDesktopBarVisualBounds/,
    "Desktop blocker checks should still use the actual glass bar bounds, not the full transparent stage."
  );
  assert.match(
    mainSource,
    /desktopBarWindow\.setIgnoreMouseEvents\(!nextInteractive, \{ forward: true \}\)/,
    "Transparent stage areas must pass mouse events through to the desktop."
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("desktop-bar:mouse-region"/,
    "The renderer should be able to toggle mouse passthrough for the desktop bar stage."
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("hud:mouse-region"/,
    "The legacy HUD mouse-region IPC should remain harmless while the display window is always pass-through."
  );
  assert.match(
    hudHitboxHtml,
    /id="hitboxSettings"/,
    "The HUD hitbox should provide a tool-local settings click target."
  );
  assert.match(
    hudHitboxHtml,
    /id="hitboxTrust"/,
    "The HUD hitbox should provide a tool-local trust details target."
  );
  assert.match(
    hudHitboxSource,
    /window\.tokenBar\.openSettings\("hud"\)/,
    "The HUD hitbox settings target should still open the HUD settings surface from the tool."
  );
  assert.match(
    hudHitboxSource,
    /showHudTrustPopover/,
    "The HUD hitbox trust target should show the detailed trust popover."
  );
  assert.match(
    hudHitboxSource,
    /const HITBOX_INPUT_GRACE_MS = 650;/,
    "The HUD hitbox should wait briefly after HUD creation before accepting hover so it cannot steal focus during a desktop-to-Codex switch."
  );
  assert.match(
    hudHitboxSource,
    /function isHitboxInputReady\(\)[\s\S]*?Date\.now\(\) >= hitboxInputReadyAt/,
    "HUD hitbox hover handling should be gated by a stable input-ready timestamp."
  );
  assert.match(
    hudHitboxSource,
    /if \(!isHitboxInputReady\(\)\) return;[\s\S]*?showTrustPopover/,
    "The HUD trust popover should not open during the input grace period."
  );
  assert.doesNotMatch(
    hudHitboxSource,
    /window\.addEventListener\("blur",\s*hideTrustPopover\)|window\.addEventListener\("mouseleave",\s*\(\) => \{\s*scheduleHideTrustPopover/,
    "The HUD hitbox must not repeatedly hide the trust popover from window blur/mouseleave noise."
  );
  assert.match(
    hudHitboxSource,
    /function scheduleHideTrustPopover\(\) \{[\s\S]*?clearTimeout\(trustPopoverHideTimer\);[\s\S]*?hideTrustPopover\(\);[\s\S]*?\}/,
    "The HUD trust popover should hide immediately when the pointer leaves the trust target."
  );
  assert.doesNotMatch(
    hudSource,
    /setToolHudMouseRegion\?\.\(nextInteractive\)/,
    "The HUD display renderer should no longer flip the whole display window into an interactive hit target."
  );
  assert.match(
    mainSource,
    /getOwnedWindowHwnds\(\) \{[\s\S]*?\[desktopBarWindow, toolHudWindow, toolHudHitboxWindow, hudTrustPopoverWindow, settingsWindow\]/,
    "The HUD hitbox, trust popover, and settings preview windows should be ignored by desktop blocker scans so they cannot hide the top bar."
  );
  assert.match(
    activeWindowSource,
    /谁在吃 token 设置/,
    "The settings preview window should be treated as an owned overlay so desktop top-bar previews stay visible."
  );
  assert.match(
    hudPopoverHtml,
    /id="trustRows"/,
    "The HUD trust popover HTML should include a row container for detailed trust metadata."
  );
  assert.match(
    hudPopoverSource,
    /onHudTrustPopoverUpdate\(renderPopover\)/,
    "The HUD trust popover renderer should update from IPC payloads."
  );
  assert.match(
    hudPopoverSource,
    /applyVisualSettings/,
    "The HUD trust popover should follow the same appearance settings as the HUD."
  );
  assert.match(
    hudPopoverSource,
    /requestPopoverResize/,
    "The HUD trust popover should request a height update after rendering detailed content."
  );
  assert.match(
    stylesSource,
    /\.hud-trust-popover/,
    "The trust details should render as a custom glass popover."
  );
  assert.match(
    stylesSource,
    /token-feed-loop var\(--eat-speed/,
    "Mascot token layers should visibly animate with healthy quota and usage speed."
  );
  assert.match(
    appSource,
    /function syncUsageMascotState\(level, display, delight, quotaFill\)/,
    "The in-strip mascot should be driven by quota state only."
  );
  assert.match(
    stylesSource,
    /\.usage-mascot\s*\{[\s\S]*?display:\s*block;/,
    "The compact quota mascot should be visible inside the usage strip."
  );
  assert.match(
    stylesSource,
    /\.usage-mascot\s*>\s*\.quota-orbit[\s\S]*?--quota-fill/,
    "The compact quota mascot should visualize remaining quota rather than eating tokens."
  );
  assert.match(
    appSource,
    /function syncTokenGeneratorState\(level, display, delight, quotaFill, eatSpeed\)/,
    "The top bar should drive token generator and token particles from the same quota state as the usage strip."
  );
  assert.match(
    stylesSource,
    /\.usage-quota[\s\S]*?--quota-fill/,
    "The top bar usage strip should turn remaining quota into a compact fill chip."
  );
  assert.match(
    stylesSource,
    /\.token-generator\[data-level="danger"\][\s\S]*?--quota-color/,
    "The token generator should visibly react when remaining quota becomes dangerous."
  );
  assert.match(
    stylesSource,
    /\.token-flow\[data-level="healthy"\]::before/,
    "Token particles should tint from the same quota level as the token generator."
  );
  assert.match(
    stylesSource,
    /\.token-flow\[data-level="caution"\]::before/,
    "Token flow should visibly respond to caution quota states."
  );
  assert.match(
    stylesSource,
    /\.token-generator\[data-level="danger"\] \.token-generator-art[\s\S]*?generator-danger-pulse/,
    "Token generator should have a quota-driven danger motion."
  );
  assert.match(
    stylesSource,
    /\.roaming-mascot\[data-phase="visible"\]\[data-scene="eat"\] \.roaming-mascot-image[\s\S]*?roaming-image-chomp/,
    "Static mascot art should receive scene-specific image motion."
  );
  assert.match(
    hudSource,
    /document\.body\.style\.setProperty\("--eat-speed", eatSpeed\)/,
    "HUD frame effects should share the same token eating speed signal as the mascot."
  );
  assert.match(
    stylesSource,
    /\.usage-strip::after/,
    "Top bar usage strip should expose a quota frame effect around the mascot state."
  );
  assert.match(
    stylesSource,
    /\.hud::after/,
    "HUD should expose a stable quota frame around the compact panel."
  );
  assert.doesNotMatch(
    stylesSource,
    /\.usage-strip[\s\S]*?::after[\s\S]*?animation:\s*quota-frame/,
    "Top bar quota frame should stay stable so the whole bar does not look like it is flickering."
  );
  assert.doesNotMatch(
    stylesSource,
    /\.hud[\s\S]*?::after[\s\S]*?animation:\s*quota-frame/,
    "HUD quota frame should stay stable so the whole panel does not look like it is flickering."
  );
  assert.match(
    stylesSource,
    /\.usage-strip\[data-delight-mood="steady"\][\s\S]*?background-image: var\(--mascot-comfy\);/,
    "Top bar steady quota must not use the worried mascot expression."
  );
  assert.match(
    stylesSource,
    /\.hud-mascot\[data-delight-mood="steady"\][\s\S]*?background-image: var\(--mascot-comfy\);/,
    "HUD steady quota must not use the worried mascot expression."
  );
  assert.match(
    stylesSource,
    /animation-delay: calc\(var\(--flow-speed/,
    "Token generator particles should use staggered coins so the eating interaction is continuously visible."
  );
  assert.match(
    stylesSource,
    /token-generator-flight var\(--flow-speed/,
    "Token particles should visibly travel from the generator to the mascot."
  );
  assert.match(
    appSource,
    /Math\.hypot\(dx, dy\)[\s\S]*?--flow-distance[\s\S]*?--flow-angle/,
    "Token flow should expose distance and angle so the generator-to-mascot connection can be drawn."
  );
  assert.match(
    appSource,
    /els\.tokenGenerator\.dataset\.scene = target\.scene\.id/,
    "The token generator should know the current mascot scene and react to the interaction."
  );
  assert.match(
    stylesSource,
    /\.token-flow::before[\s\S]*?width:\s*var\(--flow-distance\)[\s\S]*?rotate\(var\(--flow-angle\)\)/,
    "The generator-to-mascot interaction should include a visible feed line, not only loose coins."
  );
  assert.match(
    stylesSource,
    /\.token-flow::after[\s\S]*?left:\s*var\(--flow-end-x\)[\s\S]*?token-catch-flare/,
    "Token arrival should create a catch/eat response at the mascot target."
  );
  assert.match(
    stylesSource,
    /\.token-generator\[data-scene="catch"\][\s\S]*?generator-feed-kick/,
    "The token generator should visibly respond when the mascot catches or eats tokens."
  );
  assert.match(
    stylesSource,
    /\.roaming-mascot\[data-phase="visible"\]\[data-scene="eat"\][\s\S]*?roaming-eat-loop/,
    "The mascot should have scene-specific motion when it is eating generated tokens."
  );
  assert.match(
    stylesSource,
    /token-generator-spill/,
    "Low-token states should be able to show a messier generator-to-mascot path without local fake coins."
  );
  assert.match(
    stylesSource,
    /\.roaming-mascot\[data-anchor="generator-below"\]/,
    "Roaming mascot scenes should anchor around the token generator instead of arbitrary bar positions."
  );
  assert.doesNotMatch(
    appSource,
    /"top-usage"|"usage-top"|"bottom-bowl"|"chart-run"|"right-chase"/,
    "Large mascot scenes should only anchor around the token generator, not arbitrary bar content."
  );
  assert.match(
    stylesSource,
    /--roaming-unit:\s*96px/,
    "Roaming mascot actions should be larger without scaling the top-bar height."
  );
  assert.doesNotMatch(
    stylesSource,
    /--roaming-unit:[^;]*--bar-height/,
    "Roaming mascot size should be decoupled from the top-bar height."
  );
  assert.match(
    appSource,
    /function getRoamingMascotScenePool\(\)/,
    "Roaming mascot should choose a scene pool from the current quota state."
  );
  assert.match(
    appSource,
    /level === "healthy"[\s\S]*?\["wait", "catch", "run"\]/,
    "Healthy quota should allow playful generator-fed mascot scenes."
  );
  assert.match(
    appSource,
    /function syncRoamingMascotToUsageState\(\)/,
    "Top bar should immediately reselect mascot scenes when quota state changes."
  );
  assert.match(
    appSource,
    /level === "caution"[\s\S]*?\["wait", "catch", "eat"\]/,
    "Caution quota should bias the roaming mascot toward catching and eating generated tokens."
  );
  assert.match(
    appSource,
    /level === "danger"[\s\S]*?\["eat"\]/,
    "Danger quota should keep the roaming mascot in a clear generator-fed eating scene."
  );
  assert.match(
    stylesSource,
    /\.roaming-mascot\[data-scene="run"\]\s*\{[\s\S]*?--roaming-width:\s*var\(--roaming-unit\);[\s\S]*?--roaming-height:\s*var\(--roaming-unit\);/,
    "Wide roaming actions should still live inside the same visual frame as the other poses."
  );
  assert.match(
    stylesSource,
    /\.bar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*var\(--bar-y\);/,
    "The glass top bar should be positioned inside a larger transparent stage."
  );
  assert.doesNotMatch(
    stylesSource,
    /\.usage-mascot\s*\{[^}]*display:\s*none;/,
    "The in-strip quota mascot should remain visible while the external stage mascot handles token actions."
  );
  assert.doesNotMatch(
    stylesSource,
    /--roaming-top:\s*-/,
    "Roaming mascot anchors must stay inside the Electron top-bar window so the sprite is not clipped."
  );
  assert.doesNotMatch(
    stylesSource,
    /--roaming-left:\s*0%/,
    "Roaming mascot anchors must keep enough horizontal inset to avoid clipping at the window edge."
  );
  assert.match(
    stylesSource,
    /token-generator-flight/,
    "Roaming mascot scenes should use generator-origin token animations."
  );
  assert.match(
    stylesSource,
    /grid-template-rows:\s*18px minmax\(0, 1fr\) 23px/,
    "The HUD should use bounded rows so the footer cannot overlap the metrics."
  );
  assert.match(
    stylesSource,
    /body\[data-metric-layout="rows"\] \.hud-stats[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 46px 66px/,
    "WorkBuddy long exact credits should use a rows metric layout while reserving chart and mascot columns."
  );
  assert.match(
    stylesSource,
    /body\[data-metric-layout="rows"\] \.hud-chart[\s\S]*?grid-column:\s*2[\s\S]*?body\[data-metric-layout="rows"\] \.hud-mascot[\s\S]*?grid-column:\s*3/,
    "WorkBuddy rows layout must keep both the chart and the mascot visible."
  );
  assert.match(
    stylesSource,
    /\.hud-meta\s*\{[\s\S]*?text-overflow:\s*ellipsis;/,
    "The HUD footer meta text should truncate instead of colliding with the status pill."
  );
}

function buildRendererSnapshot() {
  return {
    collectedAt: "2026-05-24T08:00:00.000Z",
    activeTool: {
      providerIds: ["codex"]
    },
    totals: {
      todayTokens: 0,
      recentTokens: 0
    },
    providers: [
      {
        id: "hermes",
        name: "Hermes",
        status: "live",
        todayTokens: 0,
        recentTokens: 0,
        latest: {
          timestamp: "2026-05-24T08:00:00.000Z",
          rateLimitsTrust: { status: "live", label: "Token Plan" },
          tokenPlan: {
            remainingPercent: 24,
            usedPercent: 76,
            usedCredits: 152_750_000,
            totalCredits: 200_000_000,
            remainingCredits: 47_250_000,
            recentCredits: 560_000,
            label: "Token Plan"
          }
        }
      },
      {
        id: "codex",
        name: "Codex",
        status: "live",
        todayTokens: 1_100_000,
        recentTokens: 7_190_000,
        latest: {
          timestamp: "2026-05-24T08:00:00.000Z",
          rateLimitsTrust: { status: "live", label: "稳定" },
          rateLimits: {
            primary: { usedPercent: 15, resetsAt: "2026-05-24T13:00:00.000Z" },
            secondary: { usedPercent: 20, resetsAt: "2026-05-31T08:00:00.000Z" }
          },
          capacityTrend: { status: "steady", label: "稳定" }
        }
      }
    ],
    providerHealth: {
      providers: [
        {
          id: "codex",
          trust: { level: "exact-local", label: "本地精确", sourceLabel: "codex-jsonl" },
          delight: {
            mood: "comfy",
            shortLabel: "放心吃",
            cue: { mascot: "stretch" }
          }
        },
        {
          id: "hermes",
          trust: { level: "exact-local", label: "本地精确", sourceLabel: "hermes-local" },
          delight: {
            mood: "low",
            shortLabel: "省着点",
            cue: { mascot: "small-bites" }
          }
        }
      ]
    },
    system: {
      cpu: { percent: 7 },
      memory: {
        usedPercent: 61,
        freePercent: 39,
        freeBytes: 12.4 * 1024 ** 3
      }
    }
  };
}

function loadRendererScript(relativePath) {
  const elements = new Map();
  const callbacks = {};
  const context = {
    console,
    Promise,
    Date,
    Math,
    Number,
    RegExp,
    document: {
      body: createElement("body"),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement(id));
        return elements.get(id);
      },
      createElement(tagName) {
        return createElement(tagName);
      },
      documentElement: createElement("documentElement")
    },
    window: {
      addEventListener() {},
      tokenBar: {
        onUpdate(callback) {
          callbacks.onUpdate = callback;
        },
        onHudUpdate(callback) {
          callbacks.onHudUpdate = callback;
        },
        onSystemUpdate(callback) {
          callbacks.onSystemUpdate = callback;
        },
        onSettingsUpdate(callback) {
          callbacks.onSettingsUpdate = callback;
        },
        onHudTrustPopoverUpdate(callback) {
          callbacks.onHudTrustPopoverUpdate = callback;
        },
        getSnapshot() {
          return Promise.resolve(null);
        },
        getHudSnapshot() {
          return Promise.resolve(null);
        },
        getSettings() {
          return Promise.resolve(null);
        },
        showHudTrustPopover() {
          return Promise.resolve(true);
        },
        hideHudTrustPopover() {
          return Promise.resolve(true);
        },
        resizeHudTrustPopover() {
          return Promise.resolve(true);
        },
        openSettings() {},
        close() {}
      }
    }
  };

  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read("src/renderer/shared/format.js"), context, { filename: "src/renderer/shared/format.js" });
  vm.runInContext(read("src/renderer/shared/quota-view-model.js"), context, { filename: "src/renderer/shared/quota-view-model.js" });
  vm.runInContext(read("src/renderer/shared/trust-popover.js"), context, { filename: "src/renderer/shared/trust-popover.js" });
  vm.runInContext(read(relativePath), context, { filename: relativePath });

  return {
    callbacks,
    text(id) {
      return elements.get(id)?.textContent ?? "";
    },
    dataset(id, key) {
      return elements.get(id)?.dataset?.[key];
    },
    style(id, key) {
      return elements.get(id)?.style?.values?.get(key);
    }
  };

  function createElement(id) {
    return {
      id,
      tagName: id,
      textContent: "",
      title: "",
      className: "",
      dataset: {},
      children: [],
      style: {
        values: new Map(),
        setProperty(key, value) {
          this.values.set(key, value);
        }
      },
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute(name, value) {
        this[name] = value;
      },
      addEventListener() {},
      blur() {}
    };
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing function: ${signature}`);
  let open = -1;
  let parenDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (char === "{" && parenDepth === 0) {
      open = index;
      break;
    }
  }
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
