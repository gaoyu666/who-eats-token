const state = {
  settings: null,
  dirty: false,
  previewRunId: 0
};

const els = {
  close: document.getElementById("settingsClose"),
  save: document.getElementById("settingsSave"),
  reset: document.getElementById("settingsReset"),
  done: document.getElementById("settingsDone"),
  status: document.getElementById("settingsState"),
  providers: document.getElementById("providerSettings"),
  setupEndpoint: document.getElementById("setupEndpoint"),
  setupTokenPath: document.getElementById("setupTokenPath")
};

els.close.addEventListener("click", closeSettings);
els.save.addEventListener("click", saveSettings);
els.reset.addEventListener("click", resetSettings);
els.done.addEventListener("click", closeSettings);

for (const button of document.querySelectorAll("[data-guide]")) {
  button.addEventListener("click", () => openGuide(button.dataset.guide));
}

for (const input of document.querySelectorAll("[data-path]")) {
  input.addEventListener("input", () => {
    if (!state.settings) return;
    updateOutputs();
    const nextSettings = buildSettingsFromForm();
    applyVisualSettings(nextSettings);
    previewVisualSettings(input.dataset.path, nextSettings);
    markDirty();
  });
}

window.tokenBar.onSettingsUpdate(renderSettings);
window.tokenBar.getSettings().then(renderSettings);
renderLocalSetupInfo();

function renderSettings(settings) {
  state.settings = normalizeForForm(settings);
  state.dirty = false;
  state.previewRunId++;
  applyFormValues(state.settings);
  renderProviders(state.settings);
  applyVisualSettings(state.settings);
  updateOutputs();
  setStatus("已同步");
}

function applyFormValues(settings) {
  for (const input of document.querySelectorAll("[data-path]")) {
    const value = getPath(settings, input.dataset.path);
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value;
    }
  }
}

function renderProviders(settings) {
  renderTrackedTools();
  const registry = settings.providerRegistry || [];
  els.providers.replaceChildren(
    ...registry.map((provider) => {
      const row = document.createElement("label");
      row.className = "provider-setting";
      row.dataset.source = provider.source;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.provider = provider.id;
      input.checked = Boolean(provider.enabled);
      input.disabled = provider.source === "planned";
      input.addEventListener("change", () => {
        if (!state.settings) return;
        markDirty();
      });

      const copy = document.createElement("span");
      copy.className = "provider-setting-copy";

      const name = document.createElement("strong");
      name.textContent = provider.name;

      const source = document.createElement("span");
      source.textContent = getProviderSourceLabel(provider.source);

      copy.append(name, source);
      row.append(input, copy);
      return row;
    })
  );
}

async function renderLocalSetupInfo() {
  if (!window.tokenBar.getLocalSetupInfo) return;
  try {
    const info = await window.tokenBar.getLocalSetupInfo();
    if (els.setupEndpoint) els.setupEndpoint.textContent = info?.endpoint || "http://127.0.0.1:17667";
    if (els.setupTokenPath) els.setupTokenPath.textContent = info?.tokenFile || info?.tokenSource || "等待本机 token";
  } catch {
    if (els.setupTokenPath) els.setupTokenPath.textContent = "状态通道未连接";
  }
}

async function openGuide(guide) {
  if (!window.tokenBar.openGuide) return;
  try {
    const result = await window.tokenBar.openGuide(guide);
    setStatus(result?.ok === false ? "文档未打开" : "已打开文档");
  } catch {
    setStatus("文档未打开");
  }
}

function buildSettingsFromForm() {
  const settings = structuredClone(state.settings);
  delete settings.providerRegistry;
  for (const input of document.querySelectorAll("[data-path]")) {
    const parsed = readSettingInput(input);
    if (parsed.skip) continue;
    let value = parsed.value;
    if (input.dataset.path === "behavior.refreshSeconds") {
      setPath(settings, "behavior.refreshMs", value * 1000);
      continue;
    }
    if (input.dataset.path === "behavior.activeWindowSeconds") {
      setPath(settings, "behavior.activeWindowMs", value * 1000);
      continue;
    }
    setPath(settings, input.dataset.path, value);
  }

  for (const input of document.querySelectorAll("[data-provider]")) {
    const provider = settings.providers[input.dataset.provider];
    if (provider) provider.enabled = input.checked;
  }

  // Build tools.tracked from checkboxes
  const trackedInputs = document.querySelectorAll("#trackedTools input[type=checkbox][value]");
  const tracked = [];
  for (const input of trackedInputs) {
    if (input.checked) tracked.push(input.value);
  }
  if (tracked.length > 0) {
    setPath(settings, "tools.tracked", tracked);
  }

  delete settings.behavior.refreshSeconds;
  delete settings.behavior.activeWindowSeconds;
  return settings;
}

async function saveSettings() {
  if (!state.settings) return;
  const next = buildSettingsFromForm();
  const saved = await window.tokenBar.saveSettings(next);
  renderSettings(saved);
  setStatus("已保存");
}

async function resetSettings() {
  const saved = await window.tokenBar.resetSettings();
  renderSettings(saved);
  setStatus("已恢复");
}

async function closeSettings() {
  if (state.dirty) {
    await restoreSavedVisualPreview();
  }
  await window.tokenBar.closeSettings();
}

function normalizeForForm(settings) {
  const output = structuredClone(settings);
  output.behavior.refreshSeconds = Math.round(output.behavior.refreshMs / 1000);
  output.behavior.activeWindowSeconds = Math.round(output.behavior.activeWindowMs / 1000);
  return output;
}

function updateOutputs() {
  for (const output of document.querySelectorAll("output[data-for]")) {
    const input = document.querySelector(`[data-path="${output.dataset.for}"]`);
    if (!input) continue;
    const parsed = readNumberInput(input);
    output.textContent = parsed === null ? "" : formatOutput(output.dataset.for, parsed);
  }
}

function readSettingInput(input) {
  if (input.type === "checkbox") return { skip: false, value: input.checked };
  const value = readNumberInput(input);
  return value === null ? { skip: true, value: null } : { skip: false, value };
}

function readNumberInput(input) {
  const raw = String(input.value || "").trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function formatOutput(path, value) {
  if (path === "windows.desktopWidthRatio") return `${Math.round(value * 100)}%`;
  if (path === "windows.desktopBarHeight") return `${value}px`;
  if (path === "windows.toolHudWidth" || path === "windows.toolHudHeight") return `${value}px`;
  if (path === "windows.toolHudOffsetX" || path === "windows.toolHudOffsetY") return `${value > 0 ? "+" : ""}${value}px`;
  if (path === "appearance.glassOpacity") return `${Math.round(value * 100)}%`;
  if (path === "appearance.glassBlur") return `${value}px`;
  if (path === "appearance.fontScale") return `${Math.round(value * 100)}%`;
  if (path === "behavior.refreshSeconds" || path === "behavior.activeWindowSeconds") return `${value}s`;
  return String(value);
}

function getProviderSourceLabel(source) {
  if (source === "codex-jsonl") return "实时";
  if (source === "http-ingest") return "本地 API";
  if (source === "adapter-ingest") return "本地接入";
  if (source === "workbuddy-local") return "实时积分";
  if (source === "hermes-local") return "Token Plan";
  if (source === "hermes-bridge") return "桥接";
  return "预留";
}

function applyVisualSettings(settings) {
  if (!settings?.appearance) return;
  const root = document.documentElement;
  root.style.setProperty("--glass-opacity", settings.appearance.glassOpacity);
  root.style.setProperty("--glass-blur", `${settings.appearance.glassBlur}px`);
  root.style.setProperty("--font-scale", settings.appearance.fontScale);
}

function previewVisualSettings(path, settings) {
  if (!isLivePreviewPath(path) || !window.tokenBar.previewSettings) return;
  const runId = ++state.previewRunId;
  window.tokenBar.previewSettings(settings)
    .then((result) => {
      if (runId !== state.previewRunId) return;
      if (result?.ok === false) setStatus("预览未应用");
    })
    .catch(() => {
      if (runId === state.previewRunId) setStatus("预览通道未连接");
    });
}

async function restoreSavedVisualPreview() {
  if (!state.settings || !window.tokenBar.previewSettings) return;
  try {
    const result = await window.tokenBar.previewSettings(state.settings);
    if (result?.ok === false) setStatus("预览恢复未应用");
  } catch {
    setStatus("预览通道未连接");
  }
}

function isLivePreviewPath(path) {
  return path.startsWith("appearance.") ||
    path === "windows.desktopWidthRatio" ||
    path === "windows.desktopBarHeight" ||
    path === "windows.toolHudWidth" ||
    path === "windows.toolHudHeight" ||
    path === "windows.toolHudOffsetX" ||
    path === "windows.toolHudOffsetY";
}

function markDirty() {
  state.dirty = true;
  setStatus("未保存");
}

function setStatus(value) {
  els.status.textContent = value;
}

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const parts = path.split(".");
  const final = parts.pop();
  let cursor = object;
  for (const part of parts) {
    cursor[part] = cursor[part] || {};
    cursor = cursor[part];
  }
  cursor[final] = value;
}

async function renderTrackedTools() {
  const container = document.getElementById("trackedTools");
  if (!container) return;
  try {
    const tools = await window.tokenBar.scanAvailableTools();
    const tracked = new Set(state.settings?.tools?.tracked || []);
    container.innerHTML = "";
    for (const tool of tools) {
      const label = document.createElement("label");
      label.className = "tool-checkbox" + (tool.available ? "" : " tool-unavailable");

      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = tool.id;
      input.checked = tracked.has(tool.id);
      input.disabled = !tool.available;
      input.addEventListener("change", markDirty);

      const checkmark = document.createElement("span");
      checkmark.className = "check-icon";
      checkmark.textContent = input.checked ? "✓" : "";
      input.addEventListener("change", () => { checkmark.textContent = input.checked ? "✓" : ""; });

      const name = document.createElement("span");
      name.className = "tool-label-text";
      name.textContent = tool.name;
      if (!tool.available) {
        const unavailable = document.createElement("span");
        unavailable.className = "tool-unavailable-label";
        unavailable.textContent = " (未安装)";
        name.appendChild(unavailable);
      }

      label.appendChild(input);
      label.appendChild(checkmark);
      label.appendChild(name);
      container.appendChild(label);
    }
  } catch {
    container.textContent = "扫描失败";
  }
}
