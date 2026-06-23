const PROTOCOL_VERSION = "who-eats-token.usage.v1";
const { normalizeTokenAccuracy } = require("./token-accuracy.cjs");
const MAX_ID_LENGTH = 80;
const MAX_TEXT_LENGTH = 240;
const CONFIDENCE_VALUES = new Set(["reported", "estimated", "derived", "manual", "unknown"]);
const SENSITIVE_METADATA_KEY_RE = /(^|[_-])(api[_-]?key|cookie|authorization|bearer|password|secret|service[_-]?token|access[_-]?token|refresh[_-]?token|prompt(?![_-]?tokens?\b)|completion(?![_-]?tokens?\b)|messages?|chat[_-]?content|source[_-]?file|file[_-]?path|workspace[_-]?path)([_-]|$)/i;
const SENSITIVE_METADATA_VALUE_RE = /(api-platform_serviceToken|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|gh[opsu]_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function normalizeUsageEvent(payload = {}, now = new Date()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Usage event must be a JSON object.");
  }

  const provider = normalizeId(payload.provider, "custom");
  const inputTokens = nonNegativeNumber(payload.input_tokens ?? payload.inputTokens);
  const outputTokens = nonNegativeNumber(payload.output_tokens ?? payload.outputTokens);
  const totalTokens = nonNegativeNumber(payload.total_tokens ?? payload.totalTokens);
  const inferredInput = inputTokens || Math.max(0, totalTokens - outputTokens);
  const normalizedInput = inferredInput || inputTokens;
  const normalizedOutput = outputTokens;
  const confidence = normalizeConfidence(payload.confidence);
  const source = optionalText(payload.source, MAX_TEXT_LENGTH);
  const tokenAccuracy = normalizeTokenAccuracy(payload.token_accuracy ?? payload.tokenAccuracy, {
    confidence,
    source: optionalText(payload.token_source ?? payload.tokenSource, MAX_TEXT_LENGTH) || source
  });
  const rateLimits = normalizeRateLimits(payload.rate_limits || payload.rateLimits || null);
  const context = normalizeContext(payload.context || null);
  const tokenPlan = normalizeTokenPlan(payload.token_plan ?? payload.tokenPlan ?? null);

  if (normalizedInput === 0 && normalizedOutput === 0 && totalTokens === 0 && !rateLimits && !context && !tokenPlan) {
    throw new Error("Usage event must include token usage or rate limit data.");
  }

  return {
    schema: String(payload.schema || payload.type || PROTOCOL_VERSION).slice(0, MAX_TEXT_LENGTH),
    timestamp: normalizeTimestamp(payload.timestamp, now),
    provider,
    tool: optionalText(payload.tool || payload.app || payload.client, MAX_ID_LENGTH),
    model: optionalText(payload.model, MAX_TEXT_LENGTH) || "unknown",
    requestId: optionalText(payload.request_id ?? payload.requestId, MAX_ID_LENGTH),
    sessionId: optionalText(payload.session_id ?? payload.sessionId, MAX_ID_LENGTH),
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: totalTokens || normalizedInput + normalizedOutput,
    costUsd: nonNegativeNumber(payload.cost_usd ?? payload.costUsd),
    confidence,
    source,
    tokenAccuracy,
    rateLimits,
    context,
    tokenPlan,
    metadata: normalizeMetadata(payload.metadata || null)
  };
}

function normalizeOverlayReport(payload = {}, now = new Date()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Overlay report must be a JSON object.");
  }

  const overlays = Array.isArray(payload.overlays)
    ? payload.overlays.map(normalizeOverlay).filter(Boolean).slice(0, 48)
    : [];

  return {
    schema: String(payload.schema || payload.type || "who-eats-token.overlay.v1").slice(0, MAX_TEXT_LENGTH),
    timestamp: normalizeTimestamp(payload.timestamp, now),
    source: optionalText(payload.source, MAX_ID_LENGTH) || "overlay-dom",
    url: optionalText(payload.url, 500) || "",
    title: optionalText(payload.title, 160) || "",
    overlays
  };
}

function normalizeRateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const primary = normalizeRateLimitWindow(value.primary || value.five_hour || value.fiveHour);
  const secondary = normalizeRateLimitWindow(value.secondary || value.week || value.seven_day || value.sevenDay);
  if (!primary && !secondary) return null;
  return {
    limitId: optionalText(value.limit_id || value.limitId, MAX_ID_LENGTH),
    planType: optionalText(value.plan_type || value.planType, MAX_ID_LENGTH),
    primary,
    secondary,
    reachedType: optionalText(value.reached_type || value.reachedType, MAX_ID_LENGTH)
  };
}

function normalizeRateLimitWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usedPercent = numericOrNull(value.used_percent ?? value.usedPercent);
  const remainingPercent = numericOrNull(value.remaining_percent ?? value.remainingPercent);
  const normalizedUsedPercent = usedPercent ?? (remainingPercent === null ? null : 100 - remainingPercent);
  if (normalizedUsedPercent === null) return null;

  return {
    usedPercent: clampNumber(normalizedUsedPercent, 0, 100),
    windowMinutes: numericOrNull(value.window_minutes ?? value.windowMinutes),
    resetsAt: normalizeOptionalTimestamp(value.resets_at || value.resetsAt)
  };
}

function normalizeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usedTokens = nonNegativeNumber(value.used_tokens ?? value.usedTokens);
  const limitTokens = nonNegativeNumber(value.limit_tokens ?? value.limitTokens);
  if (usedTokens === 0 && limitTokens === 0) return null;
  const tokenAccuracy = normalizeTokenAccuracy(value.token_accuracy ?? value.tokenAccuracy, {
    confidence: value.confidence,
    source: value.token_source ?? value.tokenSource ?? value.source,
    estimated: value.estimated
  });
  return {
    usedTokens,
    limitTokens,
    remainingPercent: numericOrNull(value.remaining_percent ?? value.remainingPercent),
    source: optionalText(value.source, MAX_TEXT_LENGTH),
    estimated: Boolean(value.estimated || tokenAccuracy.estimated),
    tokenAccuracy
  };
}

function normalizeTokenPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const remainingCredits = nonNegativeNumberOrNull(value.remaining_credits ?? value.remainingCredits);
  const totalCredits = nonNegativeNumberOrNull(value.total_credits ?? value.totalCredits);
  const usedCredits = nonNegativeNumberOrNull(value.used_credits ?? value.usedCredits);
  const recentCredits = nonNegativeNumberOrNull(value.recent_credits ?? value.recentCredits);
  const fiveHourCredits = nonNegativeNumberOrNull(value.five_hour_credits ?? value.fiveHourCredits);
  const localDeltaCredits = numericOrNull(value.local_delta_credits ?? value.localDeltaCredits);
  const reportedRemainingPercent = numericOrNull(value.remaining_percent ?? value.remainingPercent);
  const reportedUsedPercent = numericOrNull(value.used_percent ?? value.usedPercent);
  const remainingPercent = reportedRemainingPercent ??
    (totalCredits && remainingCredits !== null ? (remainingCredits / totalCredits) * 100 : null);
  const usedPercent = reportedUsedPercent ??
    (totalCredits && usedCredits !== null ? (usedCredits / totalCredits) * 100 :
      remainingPercent === null ? null : 100 - remainingPercent);

  if (
    remainingCredits === null &&
    totalCredits === null &&
    usedCredits === null &&
    remainingPercent === null &&
    usedPercent === null
  ) {
    return null;
  }

  return {
    remainingCredits,
    totalCredits,
    usedCredits,
    recentCredits,
    fiveHourCredits,
    localDeltaCredits,
    remainingPercent: remainingPercent === null ? null : clampNumber(remainingPercent, 0, 100),
    usedPercent: usedPercent === null ? null : clampNumber(usedPercent, 0, 100),
    source: optionalText(value.source, MAX_TEXT_LENGTH),
    planName: optionalText(value.plan_name ?? value.planName, MAX_TEXT_LENGTH),
    validUntil: normalizeOptionalTimestamp(value.valid_until ?? value.validUntil),
    snapshotAt: normalizeOptionalTimestamp(value.snapshot_at ?? value.snapshotAt),
    platformStatus: optionalText(value.platform_status ?? value.platformStatus, MAX_ID_LENGTH) || "live",
    platformReason: optionalText(value.platform_reason ?? value.platformReason, MAX_TEXT_LENGTH),
    label: optionalText(value.label, MAX_TEXT_LENGTH)
  };
}

function normalizeOverlay(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bounds = normalizeBounds(value.bounds || value);
  if (!bounds) return null;
  return {
    type: optionalText(value.type, MAX_ID_LENGTH) || "content-overlay",
    label: optionalText(value.label, 160) || "content-overlay",
    bounds
  };
}

function normalizeBounds(value = {}) {
  const x = numericOrNull(value.x);
  const y = numericOrNull(value.y);
  const width = numericOrNull(value.width);
  const height = numericOrNull(value.height);
  if ([x, y, width, height].some((part) => part === null)) return null;
  if (width < 16 || height < 16) return null;
  return { x, y, width, height };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value).slice(0, 24);
  const metadata = {};
  for (const [key, entryValue] of entries) {
    const normalizedKey = normalizeId(key, "");
    if (!normalizedKey) continue;
    if (SENSITIVE_METADATA_KEY_RE.test(normalizedKey)) continue;
    if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
      metadata[normalizedKey] = entryValue;
    } else if (typeof entryValue === "boolean") {
      metadata[normalizedKey] = entryValue;
    } else if (entryValue !== null && entryValue !== undefined) {
      const textValue = String(entryValue).slice(0, MAX_TEXT_LENGTH);
      if (SENSITIVE_METADATA_VALUE_RE.test(textValue)) continue;
      metadata[normalizedKey] = textValue;
    }
  }
  return Object.keys(metadata).length ? metadata : null;
}

function normalizeId(value, fallback) {
  const text = optionalText(value, MAX_ID_LENGTH);
  if (!text) return fallback;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_LENGTH) || fallback;
}

function normalizeTimestamp(value, now = new Date()) {
  return normalizeOptionalTimestamp(value) || now.toISOString();
}

function normalizeOptionalTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeConfidence(value) {
  const normalized = String(value || "reported").toLowerCase();
  return CONFIDENCE_VALUES.has(normalized) ? normalized : "unknown";
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, number);
}

function nonNegativeNumberOrNull(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, number);
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  PROTOCOL_VERSION,
  normalizeOverlayReport,
  normalizeRateLimits,
  normalizeUsageEvent
};
