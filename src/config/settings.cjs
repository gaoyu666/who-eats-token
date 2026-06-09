const fs = require("node:fs");
const path = require("node:path");
const { buildDefaultProviderSettings } = require("./providers.cjs");
const { TOOL_RULES } = require("../system/tool-detector.cjs");

const SETTINGS_FILE = "settings.json";
const VALID_TOOL_IDS = new Set(TOOL_RULES.map((rule) => rule.id));
const DEFAULT_TRACKED_TOOLS = TOOL_RULES.map((rule) => rule.id);

const DEFAULT_SETTINGS = {
  version: 1,
  tools: {
    tracked: DEFAULT_TRACKED_TOOLS
  },
  appearance: {
    glassOpacity: 0.43,
    glassBlur: 28,
    fontScale: 1
  },
  windows: {
    desktopBarEnabled: true,
    toolHudEnabled: true,
    desktopWidthRatio: 0.5,
    desktopBarHeight: 64,
    toolHudWidth: 396,
    toolHudHeight: 136,
    toolHudOffsetX: 0,
    toolHudOffsetY: 0
  },
  behavior: {
    alertsEnabled: true,
    refreshMs: 15000,
    activeWindowMs: 15000,
    debugHud: false
  },
  system: {
    startAtLogin: false
  },
  integrations: {
    hermesOverlayAutoInstall: false
  },
  security: {
    allowUnauthenticatedNoOrigin: false
  },
  alertThresholds: {
    caution: 40,
    danger: 20,
    critical: 10
  },
  providers: buildDefaultProviderSettings()
};

function loadSettings(userDataPath) {
  const filePath = getSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return sanitizeSettings(mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw)));
  } catch {
    return sanitizeSettings(DEFAULT_SETTINGS);
  }
}

function saveSettings(userDataPath, nextSettings) {
  const settings = sanitizeSettings(mergeSettings(DEFAULT_SETTINGS, nextSettings));
  const filePath = getSettingsPath(userDataPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

function getSettingsPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_FILE);
}

function mergeSettings(base, override) {
  if (!override || typeof override !== "object") return structuredClone(base);
  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base?.[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      output[key] = mergeSettings(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function sanitizeSettings(input) {
  const settings = mergeSettings(DEFAULT_SETTINGS, pickKnownSettings(input));
  settings.appearance.glassOpacity = clampNumber(settings.appearance.glassOpacity, 0.18, 0.72, 0.43);
  settings.appearance.glassBlur = clampNumber(settings.appearance.glassBlur, 12, 42, 28);
  settings.appearance.fontScale = clampNumber(settings.appearance.fontScale, 0.88, 1.16, 1);
  settings.windows.desktopWidthRatio = clampNumber(settings.windows.desktopWidthRatio, 0.32, 0.9, 0.5);
  settings.windows.desktopBarHeight = clampInteger(settings.windows.desktopBarHeight, 56, 96, 64);
  settings.windows.toolHudWidth = clampInteger(settings.windows.toolHudWidth, 300, 560, 396);
  settings.windows.toolHudHeight = clampInteger(settings.windows.toolHudHeight, 112, 220, 136);
  settings.windows.toolHudOffsetX = clampInteger(settings.windows.toolHudOffsetX, -240, 240, 0);
  settings.windows.toolHudOffsetY = clampInteger(settings.windows.toolHudOffsetY, -240, 240, 0);
  settings.windows.desktopBarEnabled = Boolean(settings.windows.desktopBarEnabled);
  settings.windows.toolHudEnabled = Boolean(settings.windows.toolHudEnabled);
  settings.behavior.alertsEnabled = Boolean(settings.behavior.alertsEnabled);
  settings.behavior.refreshMs = clampInteger(settings.behavior.refreshMs, 15000, 60000, 15000);
  settings.behavior.activeWindowMs = clampInteger(settings.behavior.activeWindowMs, 3000, 15000, 15000);
  settings.behavior.debugHud = Boolean(settings.behavior.debugHud);
  settings.system.startAtLogin = Boolean(settings.system.startAtLogin);
  settings.integrations.hermesOverlayAutoInstall = Boolean(settings.integrations.hermesOverlayAutoInstall);
  settings.security.allowUnauthenticatedNoOrigin = Boolean(settings.security.allowUnauthenticatedNoOrigin);
  settings.alertThresholds.critical = clampInteger(settings.alertThresholds.critical, 1, 30, 10);
  settings.alertThresholds.danger = clampInteger(settings.alertThresholds.danger, settings.alertThresholds.critical + 1, 60, 20);
  settings.alertThresholds.caution = clampInteger(settings.alertThresholds.caution, settings.alertThresholds.danger + 1, 90, 40);
  settings.tools.tracked = sanitizeTrackedTools(settings.tools.tracked);

  for (const [id, defaultProvider] of Object.entries(DEFAULT_SETTINGS.providers)) {
    const provider = settings.providers?.[id] || defaultProvider;
    const upgradedFromPlanned = provider.source === "planned" && defaultProvider.source !== "planned";
    settings.providers[id] = {
      ...provider,
      name: defaultProvider.name,
      source: defaultProvider.source,
      enabled: upgradedFromPlanned ? defaultProvider.enabled : Boolean(provider.enabled)
    };
  }
  return settings;
}

function pickKnownSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output = {};
  for (const [section, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    if (section === "providers") continue;
    if (!input[section] || typeof input[section] !== "object") continue;
    if (Array.isArray(defaults)) {
      output[section] = input[section];
      continue;
    }
    output[section] = {};
    for (const key of Object.keys(defaults)) {
      if (Object.hasOwn(input[section], key)) {
        output[section][key] = Array.isArray(defaults[key])
          ? input[section][key]
          : input[section][key];
      }
    }
  }
  if (input.providers && typeof input.providers === "object" && !Array.isArray(input.providers)) {
    output.providers = {};
    for (const id of Object.keys(DEFAULT_SETTINGS.providers)) {
      if (!input.providers[id] || typeof input.providers[id] !== "object") continue;
      output.providers[id] = {};
      if (Object.hasOwn(input.providers[id], "enabled")) {
        output.providers[id].enabled = Boolean(input.providers[id].enabled);
      }
    }
  }
  return output;
}

function sanitizeTrackedTools(input) {
  if (!Array.isArray(input)) return DEFAULT_TRACKED_TOOLS;
  const valid = input.filter((id) => typeof id === "string" && VALID_TOOL_IDS.has(id));
  return valid.length > 0 ? [...new Set(valid)] : DEFAULT_TRACKED_TOOLS;
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  sanitizeSettings
};
