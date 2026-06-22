const els = {
  shell: document.getElementById("shell"),
  bar: document.getElementById("bar"),
  toggle: document.getElementById("toggle"),
  close: document.getElementById("close"),
  fiveHourMetric: document.getElementById("fiveHourMetric"),
  primaryMetricLabel: document.getElementById("primaryMetricLabel"),
  fiveHourRemaining: document.getElementById("fiveHourRemaining"),
  weekMetric: document.getElementById("weekMetric"),
  secondaryMetricLabel: document.getElementById("secondaryMetricLabel"),
  weekRemaining: document.getElementById("weekRemaining"),
  miniChart: document.getElementById("miniChart"),
  primaryChartCaption: document.getElementById("primaryChartCaption"),
  secondaryChartCaption: document.getElementById("secondaryChartCaption"),
  usageStrip: document.getElementById("usageStrip"),
  usageName: document.getElementById("usageName"),
  usageStatus: document.getElementById("usageStatus"),
  trustBadge: document.getElementById("trustBadge"),
  usageMascot: document.getElementById("usageMascot"),
  quotaLabel: document.getElementById("quotaLabel"),
  quotaValue: document.getElementById("quotaValue"),
  todayLabel: document.getElementById("todayLabel"),
  todayTokens: document.getElementById("todayTokens"),
  recentLabel: document.getElementById("recentLabel"),
  recentTokens: document.getElementById("recentTokens"),
  usageReset: document.getElementById("usageReset"),
  systemStrip: document.getElementById("systemStrip"),
  cpuUsage: document.getElementById("cpuUsage"),
  memoryUsage: document.getElementById("memoryUsage"),
  availableMemory: document.getElementById("availableMemory"),
  tokenGenerator: document.getElementById("tokenGenerator"),
  tokenFlow: document.getElementById("tokenFlow"),
  roamingMascot: document.getElementById("roamingMascot"),
  roamingMascotImage: document.getElementById("roamingMascotImage"),
  details: document.getElementById("details"),
  toolStrip: document.getElementById("toolStrip")
};

const ROAMING_MASCOT_SCENES = [
  {
    id: "peek",
    anchors: ["generator-left", "generator-below"]
  },
  {
    id: "catch",
    anchors: ["generator-left", "generator-right"]
  },
  {
    id: "eat",
    anchors: ["generator-right", "generator-below"]
  },
  {
    id: "wait",
    anchors: ["generator-below", "generator-left"]
  },
  {
    id: "panic",
    anchors: ["generator-below", "generator-right"]
  },
  {
    id: "guard",
    anchors: ["generator-below", "generator-left"]
  },
  {
    id: "run",
    anchors: ["generator-right", "generator-below"]
  }
];

const ROAMING_MASCOT_MIN_DELAY_MS = 4800;
const ROAMING_MASCOT_DELAY_RANGE_MS = 2800;
const ROAMING_MASCOT_EXIT_MS = 180;
const sharedFormat = window.TokenBarShared?.format || {};
const sharedQuotaViewModel = window.TokenBarShared?.quotaViewModel || {};
const sharedTrustPopover = window.TokenBarShared?.trustPopover || {};

let currentTrustPopover = null;
let trustPopoverHideTimer = null;
let trustPopoverAutoHideTimer = null;
let roamingMascotTimer = null;
let roamingMascotSceneIndex = -1;
let roamingMascotAnchor = "";
let roamingMascotStateKey = "";
let desktopBarPointerInteractive = null;

els.toggle.addEventListener("click", () => {
  els.toggle.blur();
  window.tokenBar.openSettings("desktop");
});

els.close.addEventListener("click", () => {
  window.tokenBar.close();
});

els.usageStrip?.addEventListener("click", () => {
  if (els.usageStrip.dataset.delightMood !== "login") return;
  triggerKeyholeHint(els.usageStrip);
});

els.trustBadge?.addEventListener("pointerenter", () => {
  showTrustPopover();
});

els.trustBadge?.addEventListener("pointerleave", () => {
  scheduleHideTrustPopover();
});

els.trustBadge?.addEventListener("click", () => {
  showTrustPopover({ autoHideMs: 4200 });
});

window.addEventListener("blur", () => {
  hideTrustPopover();
});

window.tokenBar.onUpdate(render);
window.tokenBar.onSystemUpdate?.(renderSystemStrip);
window.tokenBar.onSettingsUpdate(applyVisualSettings);
window.tokenBar.onToolRegistryUpdate?.(renderToolStrip);
window.tokenBar.getSnapshot().then(render);
window.tokenBar.getSettings().then(applyVisualSettings);
window.tokenBar.getToolRegistry?.().then(renderToolStrip);
setupDesktopBarPointerRegion();
setupRoamingMascot();

function render(snapshot) {
  if (!snapshot) return;
  if (snapshot.settings) applyVisualSettings(snapshot.settings);
  const providers = snapshot.providers || [];
  const currentProvider = getCurrentProvider(providers, snapshot);
  const display = getCurrentDisplay(snapshot, currentProvider);
  renderMetric(els.fiveHourMetric, els.fiveHourRemaining, display.primary.value, display.primary);
  renderMetric(els.weekMetric, els.weekRemaining, display.secondary.value, display.secondary);
  renderMiniChart(display.chart);
  renderUsageStrip(snapshot, currentProvider, display);
  renderSystemStrip(snapshot.system);
}

function renderUsageStrip(snapshot, provider, display) {
  if (!els.usageStrip) return;
  const totals = snapshot?.totals || {};
  const remaining = display?.levelValue ?? (provider ? getProviderRemaining(provider) : null);
  const remainingPercent = roundNumber(remaining);
  const quotaFill = remainingPercent === null ? 0 : clamp(remainingPercent, 0, 100);
  const level = getRemainingLevel(remaining);
  const delight = display?.delight || getProviderDelight(snapshot, provider);
  const recentUsage = display?.usageValues?.recent ?? provider?.recentTokens ?? totals.recentTokens;
  const eatSignal = getEatSignal(snapshot, provider, display);

  els.usageName.textContent = provider?.name || "等待数据";
  els.usageStatus.textContent = delight?.shortLabel || display?.statusLabel || (provider ? getUsageStatus(provider) : "同步中");
  renderTrustBadge(els.trustBadge, getTrustInfo(snapshot, provider), provider);
  if (els.quotaLabel) els.quotaLabel.textContent = getUsageQuotaLabel(display);
  if (els.quotaValue) els.quotaValue.textContent = formatPercent(remainingPercent);
  if (els.todayLabel) els.todayLabel.textContent = display?.usageLabels?.today || "今";
  if (els.recentLabel) els.recentLabel.textContent = display?.usageLabels?.recent || "1h";
  els.todayTokens.textContent = formatNullableTokens(display?.usageValues?.today ?? provider?.todayTokens ?? totals.todayTokens);
  els.recentTokens.textContent = formatNullableTokens(recentUsage);
  if (els.usageReset) els.usageReset.textContent = getUsageResetLabel(provider, display);
  const eatSpeed = getEatSpeed(eatSignal);
  els.usageStrip.style.setProperty("--eat-speed", eatSpeed);
  els.usageStrip.style.setProperty("--quota-fill", `${quotaFill}%`);
  els.usageStrip.style.setProperty("--quota-empty", `${100 - quotaFill}%`);
  els.tokenFlow?.style.setProperty("--flow-speed", eatSpeed);
  els.usageStrip.dataset.level = level;
  els.usageStrip.dataset.mode = display?.mode || "waiting";
  els.usageStrip.dataset.delightMood = delight?.mood || "watching";
  els.usageStrip.dataset.delightTone = delight?.tone || "muted";
  els.usageStrip.dataset.mascot = delight?.cue?.mascot || "watch";
  els.usageStrip.dataset.motion = delight?.motion || "none";
  syncUsageMascotState(level, display, delight, quotaFill);
  syncTokenGeneratorState(level, display, delight, quotaFill, eatSpeed);
  syncRoamingMascotToUsageState();
  if (els.usageStrip.dataset.delightMood !== "login") {
    delete els.usageStrip.dataset.keyhole;
  }
  els.usageStrip.title = provider
    ? `${delight?.label ? `${delight.label} · ` : ""}${display?.title || `${provider.name} · ${getSyncLabel(provider)} · 今日 ${formatTokens(provider.todayTokens)} · 近 1h ${formatTokens(provider.recentTokens)}`}`
    : `今日 ${formatTokens(totals.todayTokens)} · 近 1h ${formatTokens(totals.recentTokens)}`;
}

function syncUsageMascotState(level, display, delight, quotaFill) {
  if (!els.usageMascot) return;
  els.usageMascot.dataset.level = level;
  els.usageMascot.dataset.mode = display?.mode || "waiting";
  els.usageMascot.dataset.delightMood = delight?.mood || "watching";
  els.usageMascot.dataset.mascot = delight?.cue?.mascot || "watch";
  els.usageMascot.dataset.delightTone = delight?.tone || "muted";
  els.usageMascot.style.setProperty("--quota-fill", `${quotaFill}%`);
  els.usageMascot.style.setProperty("--quota-empty", `${100 - quotaFill}%`);
}

function syncTokenGeneratorState(level, display, delight, quotaFill, eatSpeed) {
  const mode = display?.mode || "waiting";
  const tone = delight?.tone || "muted";
  const quotaPercent = `${quotaFill}%`;
  const quotaEmpty = `${100 - quotaFill}%`;
  if (els.tokenGenerator) {
    els.tokenGenerator.dataset.level = level;
    els.tokenGenerator.dataset.mode = mode;
    els.tokenGenerator.dataset.delightTone = tone;
    els.tokenGenerator.style.setProperty("--quota-fill", quotaPercent);
    els.tokenGenerator.style.setProperty("--quota-empty", quotaEmpty);
    els.tokenGenerator.style.setProperty("--flow-speed", eatSpeed);
  }
  if (els.tokenFlow) {
    els.tokenFlow.dataset.level = level;
    els.tokenFlow.dataset.mode = mode;
    els.tokenFlow.dataset.delightTone = tone;
    els.tokenFlow.style.setProperty("--quota-fill", quotaPercent);
    els.tokenFlow.style.setProperty("--quota-empty", quotaEmpty);
    els.tokenFlow.style.setProperty("--flow-speed", eatSpeed);
  }
}

function triggerKeyholeHint(element) {
  if (!element) return;
  element.dataset.keyhole = "on";
  clearTimeout(element._keyholeTimer);
  element._keyholeTimer = setTimeout(() => {
    delete element.dataset.keyhole;
  }, 1100);
}

function renderTrustBadge(element, trust, provider) {
  if (!element) return;
  element.textContent = trust?.label || "等待";
  element.dataset.trust = trust?.level || "missing";
  element.title = "";
  element.setAttribute("aria-label", formatTrustTitle(trust));
  currentTrustPopover = getTrustPopoverDetails(trust, provider);
}

function getTrustPopoverDetails(trust, provider) {
  const tokenPlan = provider?.latest?.tokenPlan || null;
  const source = trust?.sourceLabel || tokenPlan?.source || provider?.source || provider?.id || "--";
  const age = getTrustAgeLabel(trust, provider);
  const freshness = trust?.freshness || provider?.status || provider?.latest?.rateLimitsTrust?.status || "unknown";
  const unit = tokenPlan ? "Credits" : "Tokens";
  const quotaBasis = getQuotaBasis(provider);
  const refreshStrategy = tokenPlan?.source && tokenPlan.source !== "local-estimate"
    ? "15s cache window"
    : provider?.status === "live"
      ? "实时同步窗口"
      : provider?.latest?.rateLimitsTrust?.label || "等待同步";
  if (sharedTrustPopover.buildTrustPopoverDetails) {
    return sharedTrustPopover.buildTrustPopoverDetails({
      trust,
      source,
      age,
      freshness,
      unit,
      quotaBasis,
      refreshStrategy,
      explainFallback: "等待 provider 数据。"
    });
  }
  return {
    status: trust?.label || "等待",
    level: trust?.level || "missing",
    rows: [
      { label: "来源", value: source },
      { label: "更新时间", value: age },
      { label: "新鲜度", value: freshness },
      { label: "单位", value: unit },
      { label: "判定口径", value: quotaBasis },
      { label: "刷新策略", value: refreshStrategy }
    ],
    privacy: "未读取 prompt / completion / API key",
    explain: trust?.explain || "等待 provider 数据。",
    action: "了解更多数据口径"
  };
}

function getTrustAgeLabel(trust, provider) {
  const explicitAge = trust?.ageMs;
  const updatedAt = trust?.updatedAt || provider?.latest?.timestamp || provider?.collectedAt || null;
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : null;
  const ageMs = explicitAge !== null && explicitAge !== undefined
    ? Number(explicitAge)
    : Number.isFinite(updatedMs)
      ? Date.now() - updatedMs
      : null;
  const age = formatAge(ageMs);
  if (!age) return "--";
  return Number.isFinite(updatedMs) ? `${age}（${formatClock(updatedMs)}）` : age;
}

function showTrustPopover(options = {}) {
  if (!currentTrustPopover || !els.trustBadge || !window.tokenBar.showHudTrustPopover) return;
  clearTimeout(trustPopoverHideTimer);
  clearTimeout(trustPopoverAutoHideTimer);
  const rect = els.trustBadge.getBoundingClientRect();
  window.tokenBar.showHudTrustPopover({
    anchor: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    details: currentTrustPopover
  });
  if (options.autoHideMs) {
    trustPopoverAutoHideTimer = setTimeout(hideTrustPopover, options.autoHideMs);
  }
}

function scheduleHideTrustPopover() {
  clearTimeout(trustPopoverHideTimer);
  trustPopoverHideTimer = setTimeout(hideTrustPopover, 180);
}

function hideTrustPopover() {
  clearTimeout(trustPopoverHideTimer);
  clearTimeout(trustPopoverAutoHideTimer);
  if (window.tokenBar.hideHudTrustPopover) {
    window.tokenBar.hideHudTrustPopover();
  }
}

function renderSystemStrip(system) {
  if (!els.systemStrip) return;
  const cpuPercent = roundNumber(system?.cpu?.percent);
  const memoryPercent = roundNumber(system?.memory?.usedPercent);
  const availablePercent = roundNumber(system?.memory?.freePercent);

  els.cpuUsage.textContent = formatSystemPercent(cpuPercent);
  els.memoryUsage.textContent = formatSystemPercent(memoryPercent);
  els.availableMemory.textContent = formatBytes(system?.memory?.freeBytes);

  els.systemStrip.dataset.cpu = getSystemLevel(cpuPercent, 70, 88);
  els.systemStrip.dataset.memory = getSystemLevel(memoryPercent, 78, 90);
  els.systemStrip.dataset.available = getAvailableMemoryLevel(availablePercent);
  const ecoMode = getSystemLevel(cpuPercent, 70, 88) !== "healthy" ||
    getSystemLevel(memoryPercent, 78, 90) !== "healthy" ||
    getAvailableMemoryLevel(availablePercent) !== "healthy";
  document.body.dataset.ecoMode = ecoMode ? "on" : "off";
  els.systemStrip.title = [
    `CPU ${formatSystemPercent(cpuPercent)}`,
    `内存 ${formatSystemPercent(memoryPercent)}${system?.memory ? ` · ${formatBytes(system.memory.usedBytes)} / ${formatBytes(system.memory.totalBytes)}` : ""}`,
    `可用 ${formatBytes(system?.memory?.freeBytes)}`
  ].join(" · ");
}

function applyVisualSettings(settings) {
  if (!settings?.appearance) return;
  const root = document.documentElement;
  root.style.setProperty("--glass-opacity", settings.appearance.glassOpacity);
  root.style.setProperty("--glass-blur", `${settings.appearance.glassBlur}px`);
  root.style.setProperty("--font-scale", settings.appearance.fontScale);
  if (settings.windows?.desktopBarHeight) {
    root.style.setProperty("--bar-height", `${settings.windows.desktopBarHeight}px`);
  }
  if (settings.desktopBarStage) {
    root.style.setProperty("--bar-x", `${settings.desktopBarStage.barX}px`);
    root.style.setProperty("--bar-y", `${settings.desktopBarStage.barY}px`);
    root.style.setProperty("--bar-width", `${settings.desktopBarStage.barWidth}px`);
  }
  positionRoamingMascot(roamingMascotAnchor);
  positionTokenFlow();
}

function setupDesktopBarPointerRegion() {
  if (!window.tokenBar.setDesktopBarMouseRegion || typeof window.addEventListener !== "function") return;
  window.addEventListener("mousemove", updateDesktopBarPointerRegion);
  window.addEventListener("mouseleave", () => setDesktopBarPointerRegion(false));
  window.addEventListener("blur", () => setDesktopBarPointerRegion(false));
  setDesktopBarPointerRegion(false);
}

function updateDesktopBarPointerRegion(event) {
  setDesktopBarPointerRegion(isPointerInsideElement(event, els.bar));
}

function setDesktopBarPointerRegion(interactive) {
  const nextInteractive = Boolean(interactive);
  if (desktopBarPointerInteractive === nextInteractive) return;
  desktopBarPointerInteractive = nextInteractive;
  const request = window.tokenBar.setDesktopBarMouseRegion?.(nextInteractive);
  if (request && typeof request.catch === "function") request.catch(() => {});
}

function isPointerInsideElement(event, element) {
  if (!event || !element || typeof element.getBoundingClientRect !== "function") return false;
  const x = Number(event.clientX);
  const y = Number(event.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function setupRoamingMascot() {
  if (!els.roamingMascot || !els.roamingMascotImage) return;
  cycleRoamingMascot({ immediate: true });
  scheduleRoamingMascot();
  if (typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => {
      positionRoamingMascot(roamingMascotAnchor);
      positionTokenFlow();
    });
  }
}

function scheduleRoamingMascot() {
  const setTimer = getRuntimeTimer("setTimeout");
  const clearTimer = getRuntimeTimer("clearTimeout");
  if (!setTimer || prefersReducedMotion()) return;
  if (clearTimer && roamingMascotTimer) clearTimer(roamingMascotTimer);
  roamingMascotTimer = setTimer(() => {
    cycleRoamingMascot();
    scheduleRoamingMascot();
  }, getRoamingMascotDelay());
}

function cycleRoamingMascot(options = {}) {
  if (!els.roamingMascot || !els.roamingMascotImage) return;
  const target = pickRoamingMascotTarget();
  const applyTarget = () => applyRoamingMascotTarget(target);
  const setTimer = getRuntimeTimer("setTimeout");
  if (options.immediate || !setTimer || prefersReducedMotion()) {
    applyTarget();
    return;
  }
  els.roamingMascot.dataset.phase = "leaving";
  if (els.tokenFlow) els.tokenFlow.dataset.phase = "leaving";
  if (els.tokenGenerator) els.tokenGenerator.dataset.phase = "leaving";
  setTimer(applyTarget, ROAMING_MASCOT_EXIT_MS);
}

function pickRoamingMascotTarget() {
  const scenePool = getRoamingMascotScenePool();
  roamingMascotSceneIndex = getNextRandomIndex(scenePool.length, roamingMascotSceneIndex);
  const scene = scenePool[roamingMascotSceneIndex];
  const previousAnchorIndex = scene.anchors.indexOf(roamingMascotAnchor);
  const anchorIndex = getNextRandomIndex(scene.anchors.length, previousAnchorIndex);
  roamingMascotAnchor = scene.anchors[anchorIndex];
  return { scene, anchor: roamingMascotAnchor };
}

function getRoamingMascotScenePool() {
  const mood = els.usageStrip?.dataset.delightMood || "";
  const level = els.usageStrip?.dataset.level || "";
  if (mood === "login") return getRoamingScenesById(["peek", "guard"]);
  if (mood === "asleep" || mood === "nap") return getRoamingScenesById(["guard", "peek"]);
  if (level === "danger") return getRoamingScenesById(["eat"]);
  if (level === "caution") return getRoamingScenesById(["wait", "catch", "eat"]);
  if (level === "healthy") return getRoamingScenesById(["wait", "catch", "run"]);
  return ROAMING_MASCOT_SCENES;
}

function syncRoamingMascotToUsageState() {
  if (!els.roamingMascot || !els.usageStrip) return;
  const key = [
    els.usageStrip.dataset.level || "",
    els.usageStrip.dataset.delightMood || "",
    els.usageStrip.dataset.delightTone || ""
  ].join(":");
  if (key === roamingMascotStateKey) {
    positionTokenFlow();
    return;
  }
  roamingMascotStateKey = key;
  roamingMascotSceneIndex = -1;
  cycleRoamingMascot({ immediate: true });
}

function getRoamingScenesById(ids) {
  const set = new Set(ids);
  const scenes = ROAMING_MASCOT_SCENES.filter((scene) => set.has(scene.id));
  return scenes.length ? scenes : ROAMING_MASCOT_SCENES;
}

function applyRoamingMascotTarget(target) {
  if (!target?.scene || !target.anchor) return;
  els.roamingMascot.dataset.scene = target.scene.id;
  els.roamingMascot.dataset.anchor = target.anchor;
  if (els.tokenFlow) els.tokenFlow.dataset.scene = target.scene.id;
  if (els.tokenGenerator) els.tokenGenerator.dataset.scene = target.scene.id;
  positionRoamingMascot(target.anchor);
  positionTokenFlow(target.scene.id);
  els.roamingMascot.dataset.phase = "visible";
  if (els.tokenFlow) els.tokenFlow.dataset.phase = "visible";
  if (els.tokenGenerator) els.tokenGenerator.dataset.phase = "visible";
}

function positionRoamingMascot(anchor) {
  if (!els.roamingMascot || typeof els.roamingMascot.getBoundingClientRect !== "function") return;
  if (!els.shell || !els.bar || typeof els.shell.getBoundingClientRect !== "function" || typeof els.bar.getBoundingClientRect !== "function") return;

  const stageRect = els.shell.getBoundingClientRect();
  const barRect = els.bar.getBoundingClientRect();
  const mascotRect = els.roamingMascot.getBoundingClientRect();
  const width = mascotRect.width || readCssPixel(els.roamingMascot, "--roaming-width", 68);
  const height = mascotRect.height || readCssPixel(els.roamingMascot, "--roaming-height", 68);
  const layout = {
    stageWidth: stageRect.width || window.innerWidth || barRect.width,
    stageHeight: stageRect.height || window.innerHeight || (barRect.height + height * 2),
    barLeft: barRect.left - stageRect.left,
    barTop: barRect.top - stageRect.top,
    barWidth: barRect.width,
    barHeight: barRect.height,
    generator: getLocalRect(els.tokenGenerator, stageRect)
  };
  const point = getRoamingAnchorPoint(anchor, layout, { width, height });
  const centerX = clampValue(point.x, width / 2 + 6, layout.stageWidth - width / 2 - 6);
  const top = clampValue(point.y, 4, layout.stageHeight - height - 4);

  els.roamingMascot.style.setProperty("--roaming-left", `${Math.round(centerX)}px`);
  els.roamingMascot.style.setProperty("--roaming-top", `${Math.round(top)}px`);
}

function getRoamingAnchorPoint(anchor, layout, mascot) {
  const bar = {
    left: layout.barLeft,
    top: layout.barTop,
    right: layout.barLeft + layout.barWidth,
    bottom: layout.barTop + layout.barHeight
  };
  const generatorCenter = layout.generator
    ? layout.generator.left + layout.generator.width * 0.5
    : bar.left + layout.barWidth * 0.72;
  const below = bar.bottom + Math.max(8, layout.barHeight * 0.12);
  const anchors = {
    "generator-left": { x: generatorCenter - mascot.width * 0.92, y: below },
    "generator-below": { x: generatorCenter, y: below + 2 },
    "generator-right": { x: generatorCenter + mascot.width * 0.9, y: below }
  };
  return anchors[anchor] || anchors["generator-below"];
}

function positionTokenFlow(sceneId = els.roamingMascot?.dataset.scene || "") {
  if (!els.tokenFlow || !els.tokenGenerator || !els.roamingMascot) return;
  if (
    typeof els.shell?.getBoundingClientRect !== "function" ||
    typeof els.tokenGenerator.getBoundingClientRect !== "function" ||
    typeof els.roamingMascot.getBoundingClientRect !== "function"
  ) {
    return;
  }
  const rootRect = els.shell.getBoundingClientRect();
  const sourceRect = els.tokenGenerator.getBoundingClientRect();
  const targetRect = els.roamingMascot.getBoundingClientRect();
  const source = {
    x: sourceRect.left - rootRect.left + sourceRect.width * 0.5,
    y: sourceRect.top - rootRect.top + sourceRect.height * 0.72
  };
  const target = getTokenFlowTarget(sceneId, targetRect, rootRect);
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const midLift = Math.min(46, Math.max(18, Math.abs(dx) * 0.16));
  const mid = {
    x: dx * 0.48,
    y: dy * 0.48 - midLift
  };
  els.tokenFlow.dataset.scene = sceneId || "wait";
  els.tokenFlow.style.setProperty("--flow-left", `${Math.round(source.x)}px`);
  els.tokenFlow.style.setProperty("--flow-top", `${Math.round(source.y)}px`);
  els.tokenFlow.style.setProperty("--flow-mid-x", `${Math.round(mid.x)}px`);
  els.tokenFlow.style.setProperty("--flow-mid-y", `${Math.round(mid.y)}px`);
  els.tokenFlow.style.setProperty("--flow-end-x", `${Math.round(dx)}px`);
  els.tokenFlow.style.setProperty("--flow-end-y", `${Math.round(dy)}px`);
  els.tokenFlow.style.setProperty("--flow-distance", `${Math.round(distance)}px`);
  els.tokenFlow.style.setProperty("--flow-angle", `${Math.round(angle)}deg`);
}

function getTokenFlowTarget(sceneId, targetRect, rootRect) {
  const local = {
    left: targetRect.left - rootRect.left,
    top: targetRect.top - rootRect.top,
    width: targetRect.width,
    height: targetRect.height
  };
  const targetByScene = {
    eat: { x: 0.46, y: 0.45 },
    catch: { x: 0.48, y: 0.38 },
    wait: { x: 0.5, y: 0.58 },
    panic: { x: 0.5, y: 0.42 },
    guard: { x: 0.47, y: 0.58 },
    run: { x: 0.44, y: 0.46 },
    peek: { x: 0.48, y: 0.56 }
  };
  const point = targetByScene[sceneId] || targetByScene.wait;
  return {
    x: local.left + local.width * point.x,
    y: local.top + local.height * point.y
  };
}

function getLocalRect(element, rootRect) {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - rootRect.left,
    top: rect.top - rootRect.top,
    width: rect.width,
    height: rect.height
  };
}

function readCssPixel(element, propertyName, fallback) {
  if (typeof getComputedStyle !== "function") return fallback;
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(propertyName));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampValue(value, min, max) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function getNextRandomIndex(length, previousIndex) {
  if (length <= 1) return 0;
  let nextIndex = Math.floor(Math.random() * length);
  if (nextIndex === previousIndex) nextIndex = (nextIndex + 1) % length;
  return nextIndex;
}

function getRoamingMascotDelay() {
  return ROAMING_MASCOT_MIN_DELAY_MS + Math.round(Math.random() * ROAMING_MASCOT_DELAY_RANGE_MS);
}

function getRuntimeTimer(name) {
  if (typeof window !== "undefined" && typeof window[name] === "function") return window[name].bind(window);
  if (typeof globalThis !== "undefined" && typeof globalThis[name] === "function") return globalThis[name].bind(globalThis);
  return null;
}

function prefersReducedMotion() {
  return Boolean(
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function renderMetric(metric, valueElement, value, options = {}) {
  if (!metric || !valueElement) return;
  const labelElement = options.labelElement || (
    metric.id === "weekMetric" ? els.secondaryMetricLabel : els.primaryMetricLabel
  );
  const formatter = options.formatter || formatPercent;
  const levelValue = options.levelValue ?? value;

  if (labelElement) labelElement.textContent = options.label || "";
  valueElement.textContent = formatter(value);
  metric.dataset.level = getRemainingLevel(levelValue);
  metric.dataset.format = options.format || "percent";
  metric.style.setProperty("--metric-color", getMetricColor(options.colorRole || metric.id, levelValue));
}

function renderToolStrip(tools) {
  const container = els.toolStrip;
  if (!container) return;
  if (!Array.isArray(tools) || tools.length === 0) {
    container.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const tool of tools) {
    const chip = document.createElement("div");
    chip.className = `tool-chip status-${tool.status}`;
    const dot = document.createElement("span");
    dot.className = "tool-dot";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;
    chip.appendChild(dot);
    chip.appendChild(name);
    const statusLabels = {
      "online-foreground": "前台",
      "online-background": "后台",
      "idle": "空闲",
      "offline": "无信号"
    };
    chip.title = `${tool.name} · ${statusLabels[tool.status] || tool.status}`;
    frag.appendChild(chip);
  }
  container.replaceChildren(frag);
}

function renderProviderStrip(providers) {
  const provider = getTightestProvider(providers);
  if (!provider) {
    els.providerStrip.replaceChildren();
    return;
  }

  const primary = provider.latest?.rateLimits?.primary;
  const tokenPlan = provider.latest?.tokenPlan || null;
  const remaining = getProviderRemaining(provider);
  const level = getRemainingLevel(remaining);
  const item = document.createElement("div");
  item.className = `provider ${provider.status}`;
  item.dataset.level = level;
  item.dataset.sync = getSyncStatus(provider);
  item.dataset.trend = getTrendStatus(provider);
  item.dataset.forecast = getForecastStatus(provider);
  item.title = tokenPlan
    ? `${provider.name} · ${getSyncLabel(provider)} · Token Plan ${formatPercent(remaining)} · ${formatTokens(tokenPlan.usedCredits)} / ${formatTokens(tokenPlan.totalCredits)} Credits`
    : `${provider.name} · ${getSyncLabel(provider)} · ${getTrendLabel(provider)} · ${getForecastLabel(provider)} · 5小时 ${formatPercent(remaining)} · ${formatResetCountdown(primary?.resetsAt)}`;

  const icon = document.createElement("span");
  icon.className = "provider-icon";
  icon.setAttribute("aria-hidden", "true");

  const copy = document.createElement("span");
  copy.className = "provider-copy";

  const state = document.createElement("span");
  state.className = "provider-state";
  state.textContent = getStatusText(level, getTrendStatus(provider));

  const reset = document.createElement("span");
  reset.className = "provider-reset";
  reset.textContent = tokenPlan
    ? `${formatTokens(tokenPlan.usedCredits)} / ${formatTokens(tokenPlan.totalCredits)} C`
    : `${getProviderSubline(provider)} · ${formatResetCountdown(primary?.resetsAt)}`;

  copy.append(state, reset);
  item.append(icon, copy);
  els.providerStrip.replaceChildren(item);
}

function getRemainingPercent(providers, key) {
  const values = providers
    .map((provider) => {
      const window = provider.latest?.rateLimits?.[key];
      return window ? Math.max(0, 100 - Math.round(window.usedPercent)) : null;
    })
    .filter((value) => value !== null && value !== undefined);
  if (values.length === 0) return null;
  return values.reduce((lowest, remaining) => {
    return Math.min(lowest, remaining);
  }, 100);
}

function getCurrentProvider(providers, snapshot) {
  const available = (providers || []).filter(Boolean);
  const activeProviderIds = snapshot?.activeTool?.providerIds || [];
  const activeProvider = available.find((provider) => (
    activeProviderIds.includes(provider.id) && hasProviderDisplayData(provider)
  ));
  if (activeProvider) return activeProvider;
  return getTightestProvider(available);
}

function hasProviderDisplayData(provider) {
  return Boolean(
    provider?.latest?.rateLimits?.primary ||
    provider?.latest?.rateLimits?.secondary ||
    provider?.latest?.tokenPlan ||
    provider?.latest?.context
  );
}

function getCurrentDisplay(snapshot, provider) {
  const totals = snapshot?.totals || {};
  const delight = getProviderDelight(snapshot, provider);
  if (!provider) {
    return {
      mode: "waiting",
      levelValue: null,
      statusLabel: "同步中",
      delight,
      usageLabels: { today: "今", recent: "1h" },
      usageValues: { today: totals.todayTokens, recent: totals.recentTokens },
      primary: {
        label: "5小时",
        labelElement: els.primaryMetricLabel,
        value: null,
        levelValue: null,
        colorRole: "fiveHourMetric"
      },
      secondary: {
        label: "一周",
        labelElement: els.secondaryMetricLabel,
        value: null,
        levelValue: null,
        colorRole: "weekMetric"
      },
      chart: {
        primaryValue: null,
        secondaryValue: null,
        primaryCaption: "5h",
        secondaryCaption: "7d",
        levelValue: null
      }
    };
  }

  const tokenPlan = provider.latest?.tokenPlan || null;
  if (tokenPlan) {
    const remaining = roundNumber(tokenPlan.remainingPercent);
    const usedPercent = roundNumber(tokenPlan.usedPercent);
    const usedCredits = numberOrNull(tokenPlan.usedCredits);
    const totalCredits = numberOrNull(tokenPlan.totalCredits);
    const remainingCredits = numberOrNull(tokenPlan.remainingCredits);
    const statusLabel = tokenPlan.label || provider.latest?.rateLimitsTrust?.label || "Token Plan";
    return {
      mode: "token-plan",
      levelValue: remaining,
      statusLabel,
      delight,
      usageLabels: { today: "已", recent: "剩" },
      usageValues: { today: usedCredits, recent: remainingCredits },
      title: `${provider.name} · ${statusLabel} · 已用 ${formatNullableTokens(usedCredits)} / ${formatNullableTokens(totalCredits)} Credits · 余量 ${formatPercent(remaining)}`,
      primary: {
        label: "总余量",
        labelElement: els.primaryMetricLabel,
        value: remaining,
        levelValue: remaining,
        colorRole: "fiveHourMetric"
      },
      secondary: {
        label: "已用",
        labelElement: els.secondaryMetricLabel,
        value: usedCredits,
        levelValue: remaining,
        colorRole: "weekMetric",
        formatter: formatNullableTokens,
        format: "compact"
      },
      chart: {
        primaryValue: remaining,
        secondaryValue: usedPercent,
        primaryCaption: "left",
        secondaryCaption: "used",
        levelValue: remaining
      }
    };
  }

  const primaryWindow = provider.latest?.rateLimits?.primary || null;
  const secondaryWindow = provider.latest?.rateLimits?.secondary || null;
  if (primaryWindow || secondaryWindow) {
    const fiveHourRemaining = getWindowRemaining(primaryWindow);
    const weekRemaining = getWindowRemaining(secondaryWindow);
    const standardRemaining = getCapacityStandardRemaining(fiveHourRemaining, weekRemaining);
    return {
      mode: "capacity",
      levelValue: standardRemaining,
      statusLabel: getUsageStatus(provider),
      delight,
      usageLabels: { today: "今", recent: "1h" },
      usageValues: { today: provider.todayTokens, recent: provider.recentTokens },
      title: `${provider.name} · ${getSyncLabel(provider)} · 5小时 ${formatPercent(fiveHourRemaining)} · 一周 ${formatPercent(weekRemaining)} · 今日 ${formatTokens(provider.todayTokens)} · 近 1h ${formatTokens(provider.recentTokens)}`,
      primary: {
        label: "5小时",
        labelElement: els.primaryMetricLabel,
        value: fiveHourRemaining,
        levelValue: fiveHourRemaining,
        colorRole: "fiveHourMetric"
      },
      secondary: {
        label: "一周",
        labelElement: els.secondaryMetricLabel,
        value: weekRemaining,
        levelValue: weekRemaining,
        colorRole: "weekMetric"
      },
      chart: {
        primaryValue: fiveHourRemaining,
        secondaryValue: weekRemaining,
        primaryCaption: "5h",
        secondaryCaption: "7d",
        levelValue: standardRemaining
      }
    };
  }

  const context = provider.latest?.context || null;
  const contextRemaining = roundNumber(context?.remainingPercent);
  const contextUsedTokens = numberOrNull(context?.usedTokens);
  return {
    mode: "context",
    levelValue: contextRemaining,
    statusLabel: getUsageStatus(provider),
    delight,
    usageLabels: { today: "今", recent: "1h" },
    usageValues: { today: provider.todayTokens, recent: provider.recentTokens },
    title: `${provider.name} · 上下文 ${formatPercent(contextRemaining)} · 今日 ${formatTokens(provider.todayTokens)} · 近 1h ${formatTokens(provider.recentTokens)}`,
    primary: {
      label: "上下文",
      labelElement: els.primaryMetricLabel,
      value: contextRemaining,
      levelValue: contextRemaining,
      colorRole: "fiveHourMetric"
    },
    secondary: {
      label: "本轮",
      labelElement: els.secondaryMetricLabel,
      value: contextUsedTokens,
      levelValue: contextRemaining,
      colorRole: "weekMetric",
      formatter: formatNullableTokens,
      format: "compact"
    },
    chart: {
      primaryValue: contextRemaining,
      secondaryValue: context?.usedPercent ? roundNumber(context.usedPercent) : null,
      primaryCaption: "ctx",
      secondaryCaption: "used",
      levelValue: contextRemaining
    }
  };
}

function getProviderDelight(snapshot, provider) {
  const health = getProviderHealth(snapshot, provider);
  return health?.delight || null;
}

function getProviderHealth(snapshot, provider) {
  if (!provider) return null;
  const healthProviders = snapshot?.providerHealth?.providers || [];
  return healthProviders.find((entry) => entry.id === provider.id) || null;
}

function getTrustInfo(snapshot, provider) {
  const health = getProviderHealth(snapshot, provider);
  if (health?.trust) return health.trust;
  if (!provider) return null;
  const syncStatus = provider.latest?.rateLimitsTrust?.status || "missing";
  if (syncStatus === "live") {
    return {
      level: "exact-local",
      label: "本地精确",
      sourceLabel: provider.source || provider.id,
      updatedAt: provider.latest?.timestamp || provider.collectedAt || null,
      explain: "来自本地明确事件汇总。"
    };
  }
  return {
    level: syncStatus,
    label: provider.latest?.rateLimitsTrust?.label || "等待",
    sourceLabel: provider.source || provider.id,
    updatedAt: provider.latest?.timestamp || provider.collectedAt || null,
    explain: provider.latest?.rateLimitsTrust?.reason || "等待 provider 数据。"
  };
}

function formatTrustTitle(trust) {
  if (sharedTrustPopover.formatTrustTitle) return sharedTrustPopover.formatTrustTitle(trust);
  if (!trust) return "等待数据可信度";
  const age = formatAge(trust.ageMs);
  return [
    `数据可信度：${trust.label}`,
    `来源：${trust.sourceLabel || "--"}`,
    age ? `更新：${age}` : null,
    `级别：${trust.level || "--"}`,
    trust.explain || null
  ].filter(Boolean).join("\n");
}

function getTightestProvider(providers) {
  const candidates = providers.filter((provider) => (
    provider.latest?.rateLimits?.primary || provider.latest?.tokenPlan
  ));
  if (candidates.length === 0) return providers[0] || null;
  return candidates.reduce((tightest, provider) => {
    const current = getProviderRemaining(provider);
    const best = getProviderRemaining(tightest);
    return current < best ? provider : tightest;
  }, candidates[0]);
}

function getProviderRemaining(provider) {
  if (provider.latest?.tokenPlan) return provider.latest.tokenPlan.remainingPercent;
  const primary = getWindowRemaining(provider.latest?.rateLimits?.primary);
  const secondary = getWindowRemaining(provider.latest?.rateLimits?.secondary);
  if (provider.latest?.context) return roundNumber(provider.latest.context.remainingPercent);
  return getCapacityStandardRemaining(primary, secondary);
}

function getCapacityStandardRemaining(fiveHourRemaining, weekRemaining) {
  return sharedQuotaViewModel.getCapacityStandardRemaining
    ? sharedQuotaViewModel.getCapacityStandardRemaining(fiveHourRemaining, weekRemaining)
    : fiveHourRemaining ?? weekRemaining ?? null;
}

function getWindowRemaining(window) {
  if (sharedQuotaViewModel.getWindowRemaining) return sharedQuotaViewModel.getWindowRemaining(window);
  if (!window) return null;
  const usedPercent = Number(window.usedPercent);
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.max(0, Math.min(100, 100 - Math.round(usedPercent)));
}

function renderMiniChart(chart) {
  if (!els.miniChart) return;
  const fiveHourRemaining = chart?.primaryValue;
  const weekRemaining = chart?.secondaryValue;
  const five = fiveHourRemaining ?? 0;
  const week = weekRemaining ?? 0;
  const lowest = chart?.levelValue ?? getLowestValue(fiveHourRemaining, weekRemaining) ?? 100;
  if (els.primaryChartCaption) els.primaryChartCaption.textContent = chart?.primaryCaption || "5h";
  if (els.secondaryChartCaption) els.secondaryChartCaption.textContent = chart?.secondaryCaption || "7d";
  els.miniChart.style.setProperty("--five-fill", `${clamp(five, 0, 100)}%`);
  els.miniChart.style.setProperty("--week-fill", `${clamp(week, 0, 100)}%`);
  els.miniChart.style.setProperty("--pulse-speed", `${getPulseSpeed(lowest)}s`);
  els.miniChart.dataset.level = getRemainingLevel(lowest);
}

function formatPercent(value) {
  return sharedFormat.formatPercent
    ? sharedFormat.formatPercent(value)
    : value === null || value === undefined ? "--" : `${value}%`;
}

function formatSystemPercent(value) {
  return value === null || value === undefined ? "--" : `${value}%`;
}

function formatTemperature(value) {
  return value === null || value === undefined ? "--°" : `${value}°`;
}

function roundNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getLowestValue(...values) {
  const normalized = values.filter((value) => value !== null && value !== undefined);
  if (normalized.length === 0) return null;
  return Math.min(...normalized);
}

function getSystemLevel(value, caution, danger) {
  if (value === null || value === undefined) return "unknown";
  if (value >= danger) return "danger";
  if (value >= caution) return "caution";
  return "healthy";
}

function getTemperatureLevel(value) {
  if (value === null || value === undefined) return "unknown";
  if (value >= 88) return "danger";
  if (value >= 76) return "caution";
  return "healthy";
}

function getAvailableMemoryLevel(value) {
  if (value === null || value === undefined) return "unknown";
  if (value <= 10) return "danger";
  if (value <= 20) return "caution";
  return "healthy";
}

function clamp(value, min, max) {
  return sharedFormat.clamp ? sharedFormat.clamp(value, min, max) : Math.min(max, Math.max(min, value));
}

function getRemainingLevel(value) {
  if (sharedQuotaViewModel.getRemainingLevel) return sharedQuotaViewModel.getRemainingLevel(value);
  if (sharedFormat.getRemainingLevel) return sharedFormat.getRemainingLevel(value);
  if (value === null || value === undefined) return "unknown";
  if (value < 20) return "danger";
  if (value < 45) return "caution";
  return "healthy";
}

function getStatusText(level, trendStatus) {
  if (level === "danger") return "告警";
  if (level === "caution") return "偏紧";
  if (level === "healthy" && trendStatus === "fast") return "消耗快";
  if (level === "healthy" && trendStatus === "using") return "消耗中";
  if (level === "healthy" && trendStatus === "recovering") return "回升";
  if (level === "healthy") return "健康";
  return "等待";
}

function getSyncStatus(provider) {
  return provider.latest?.rateLimitsTrust?.status || "missing";
}

function getSyncLabel(provider) {
  return provider.latest?.rateLimitsTrust?.label || "等待";
}

function getUsageStatus(provider) {
  const syncStatus = getSyncStatus(provider);
  const trendStatus = getTrendStatus(provider);
  if (syncStatus !== "live") return getSyncLabel(provider);
  if (["fast", "using", "recovering"].includes(trendStatus)) return getTrendLabel(provider);
  return getSyncLabel(provider);
}

function getTrendStatus(provider) {
  return provider.latest?.capacityTrend?.status || "unknown";
}

function getTrendLabel(provider) {
  return provider.latest?.capacityTrend?.label || "观察";
}

function getForecastStatus(provider) {
  return provider.latest?.capacityTrend?.forecast?.status || "unknown";
}

function getForecastLabel(provider) {
  return provider.latest?.capacityTrend?.forecast?.label || "等待估算";
}

function getForecastShortLabel(provider) {
  return provider.latest?.capacityTrend?.forecast?.shortLabel || getTrendLabel(provider);
}

function getProviderSubline(provider) {
  const syncStatus = getSyncStatus(provider);
  if (syncStatus !== "live") return getSyncLabel(provider);
  return getForecastShortLabel(provider);
}

function getWorstLevel(...values) {
  if (sharedQuotaViewModel.getWorstLevel) return sharedQuotaViewModel.getWorstLevel(...values);
  const levels = values.map(getRemainingLevel);
  if (levels.includes("danger")) return "danger";
  if (levels.includes("caution")) return "caution";
  if (levels.includes("healthy")) return "healthy";
  return "unknown";
}

function getMetricColor(metricId, value) {
  if (sharedQuotaViewModel.getMetricColor) return sharedQuotaViewModel.getMetricColor(metricId, value, "weekMetric");
  if (value === null || value === undefined) return "rgba(255, 255, 255, 0.68)";
  const isWeek = metricId === "weekMetric";
  if (getRemainingLevel(value) === "danger") return isWeek ? "#ff9f6e" : "#ff7f9f";
  return isWeek ? "#8bd7ff" : "#ffd36f";
}

function getPulseSpeed(value) {
  if (sharedQuotaViewModel.getPulseSpeed) return sharedQuotaViewModel.getPulseSpeed(value);
  if (value < 20) return 0.78;
  if (value < 45) return 1.15;
  return 2.15;
}

function formatResetCountdown(value) {
  if (!value) return "等数据";
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "等数据";
  if (ms <= 0) return "重置中";

  const minutes = Math.ceil(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) return `${mins}m`;
  if (hours < 10) return `${hours}h${String(mins).padStart(2, "0")}m`;
  return `${hours}h`;
}

function getUsageQuotaLabel(display) {
  if (display?.mode === "context") return "ctx";
  if (display?.mode === "token-plan") return "总";
  if (display?.mode === "capacity") return "5h";
  return "余";
}

function getUsageResetLabel(provider, display) {
  if (!provider) return "等数据";
  if (display?.mode === "capacity") {
    const primary = provider.latest?.rateLimits?.primary || null;
    const secondary = provider.latest?.rateLimits?.secondary || null;
    return `重 ${formatResetCountdown(primary?.resetsAt || secondary?.resetsAt)}`;
  }

  const tokenPlan = provider.latest?.tokenPlan || null;
  const tokenPlanDeadline = tokenPlan?.validUntil || tokenPlan?.expiresAt || null;
  if (tokenPlanDeadline) return `账 ${formatResetCountdown(tokenPlanDeadline)}`;

  const updatedAt = tokenPlan?.snapshotAt ||
    tokenPlan?.updatedAt ||
    provider.latest?.timestamp ||
    provider.latest?.collectedAt ||
    provider.collectedAt ||
    null;
  const age = formatShortAgeFromTimestamp(updatedAt);
  if (age) return `更 ${age}`;
  return getSyncLabel(provider);
}

function formatShortAgeFromTimestamp(value) {
  if (!value) return "";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "刚刚";
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
  return `${Math.floor(ms / 86400000)}d`;
}

function formatAge(ageMs) {
  if (sharedFormat.formatAge) return sharedFormat.formatAge(ageMs);
  return "";
}

function formatClock(timestamp) {
  if (sharedFormat.formatClock) return sharedFormat.formatClock(timestamp);
  return "--:--:--";
}

function getQuotaBasis(provider) {
  if (!provider) return "等待可用余量口径";
  const tokenPlan = provider.latest?.tokenPlan || null;
  if (tokenPlan) {
    const remaining = roundNumber(tokenPlan.remainingPercent);
    const remainingCredits = numberOrNull(tokenPlan.remainingCredits);
    const totalCredits = numberOrNull(tokenPlan.totalCredits);
    return `Token Plan 剩余 / 总量 = ${formatPercent(remaining)}（${formatNullableTokens(remainingCredits)} / ${formatNullableTokens(totalCredits)} Credits）`;
  }
  const context = provider.latest?.context || null;
  if (context) {
    return `上下文剩余 / 上下文上限 = ${formatPercent(roundNumber(context.remainingPercent))}`;
  }
  const primary = getWindowRemaining(provider.latest?.rateLimits?.primary);
  if (primary !== null) return `当前 5 小时窗口余量 = ${formatPercent(primary)}`;
  const secondary = getWindowRemaining(provider.latest?.rateLimits?.secondary);
  if (secondary !== null) return `当前一周窗口余量 = ${formatPercent(secondary)}`;
  return "仅用量节奏，无余量口径";
}

function getEatSignal(snapshot, provider, display) {
  const totals = snapshot?.totals || {};
  const tokenPlanRecent = provider?.latest?.tokenPlan?.recentCredits;
  if (tokenPlanRecent !== null && tokenPlanRecent !== undefined) return tokenPlanRecent;
  if (provider?.recentTokens !== null && provider?.recentTokens !== undefined) return provider.recentTokens;
  if (totals.recentTokens !== null && totals.recentTokens !== undefined) return totals.recentTokens;
  return display?.usageValues?.recent;
}

function getEatSpeed(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "2.8s";
  if (number >= 5_000_000) return "0.95s";
  if (number >= 1_000_000) return "1.25s";
  if (number >= 100_000) return "1.8s";
  return "2.35s";
}

function formatTokens(value) {
  if (sharedFormat.formatCompactNumber) return sharedFormat.formatCompactNumber(value);
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return String(Math.round(number));
}

function formatNullableTokens(value) {
  return sharedFormat.formatNullableCompactNumber
    ? sharedFormat.formatNullableCompactNumber(value)
    : value === null || value === undefined || value === "" ? "--" : formatTokens(value);
}

function formatBytes(value) {
  return sharedFormat.formatBytes ? sharedFormat.formatBytes(value) : "--";
}
