const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_POPOVER_BYTES = 8 * 1024;

const SETTINGS_SCHEMA = {
  tools: ["tracked"],
  appearance: ["glassOpacity", "glassBlur", "fontScale"],
  windows: [
    "desktopBarEnabled",
    "toolHudEnabled",
    "desktopWidthRatio",
    "desktopBarHeight",
    "toolHudWidth",
    "toolHudHeight",
    "toolHudOffsetX",
    "toolHudOffsetY"
  ],
  behavior: ["alertsEnabled", "refreshMs", "activeWindowMs", "debugHud"],
  system: ["startAtLogin"],
  integrations: ["hermesOverlayAutoInstall"],
  security: ["allowUnauthenticatedNoOrigin"],
  alertThresholds: ["caution", "danger", "critical"]
};

function guardSettingsPayload(payload) {
  if (!isPlainObject(payload) || !fitsJsonBudget(payload, MAX_SETTINGS_BYTES)) return {};
  const guarded = {};
  for (const [section, keys] of Object.entries(SETTINGS_SCHEMA)) {
    if (!isPlainObject(payload[section])) continue;
    guarded[section] = {};
    for (const key of keys) {
      if (Object.hasOwn(payload[section], key)) guarded[section][key] = payload[section][key];
    }
  }
  if (isPlainObject(payload.providers)) {
    guarded.providers = {};
    for (const [id, provider] of Object.entries(payload.providers).slice(0, 64)) {
      if (!/^[a-z0-9._-]{1,80}$/i.test(id) || !isPlainObject(provider)) continue;
      guarded.providers[id] = {};
      if (Object.hasOwn(provider, "enabled")) guarded.providers[id].enabled = Boolean(provider.enabled);
    }
  }
  return guarded;
}

function guardBooleanPayload(value) {
  return value === true;
}

function guardHudTrustPopoverPayload(payload) {
  if (!isPlainObject(payload) || !fitsJsonBudget(payload, MAX_POPOVER_BYTES)) return {};
  return {
    anchor: guardAnchor(payload.anchor),
    details: guardPopoverDetails(payload.details)
  };
}

function guardHudTrustPopoverSize(size) {
  if (!isPlainObject(size)) return {};
  return {
    width: clampInteger(size.width, 240, 720, undefined),
    height: clampInteger(size.height, 120, 720, undefined)
  };
}

function guardAnchor(anchor) {
  if (!isPlainObject(anchor)) return {};
  return {
    x: clampNumber(anchor.x, -100000, 100000, 0),
    y: clampNumber(anchor.y, -100000, 100000, 0),
    width: clampNumber(anchor.width, 0, 2000, 0),
    height: clampNumber(anchor.height, 0, 2000, 0)
  };
}

function guardPopoverDetails(details) {
  if (!isPlainObject(details)) return null;
  return JSON.parse(JSON.stringify(details, (_key, value) => {
    if (typeof value === "string") return value.slice(0, 500);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 16);
    if (isPlainObject(value)) return value;
    return undefined;
  }));
}

function fitsJsonBudget(value, maxBytes) {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= maxBytes;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampInteger(value, min, max, fallback) {
  const number = clampNumber(value, min, max, fallback);
  return number === undefined ? undefined : Math.round(number);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

module.exports = {
  guardBooleanPayload,
  guardHudTrustPopoverPayload,
  guardHudTrustPopoverSize,
  guardSettingsPayload
};
