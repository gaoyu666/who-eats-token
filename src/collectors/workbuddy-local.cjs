const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_ENDPOINT = "https://copilot.tencent.com";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_REFRESH_MIN_MS = 30 * 1000;
const DEFAULT_CACHE_STALE_MS = 2 * 60 * 1000;
const AUTH_FILE_NAMES = [
  "workbuddy-desktop.info",
  "Tencent-Cloud.genie-ide-cn.info",
  "auth.info"
];
const COMMODITY_CODES = {
  free: "TCACA_code_001_PqouKr6QWV",
  proMon: "TCACA_code_002_AkiJS3ZHF5",
  proMonPlus: "TCACA_code_005_maRGyrHhw1",
  gift: "TCACA_code_006_DbXS0lrypC",
  activity: "TCACA_code_007_nzdH5h4Nl0",
  proYear: "TCACA_code_003_FAnt7lcmRT",
  freeMon: "TCACA_code_008_cfWoLwvjU4",
  extra: "TCACA_code_009_0XmEQc2xOf"
};
const DAILY_CREDITS = new Set([COMMODITY_CODES.free]);
const COMMODITY_LABELS = {
  [COMMODITY_CODES.free]: "WorkBuddy Free",
  [COMMODITY_CODES.proMon]: "WorkBuddy Pro Monthly",
  [COMMODITY_CODES.proMonPlus]: "WorkBuddy Pro Monthly",
  [COMMODITY_CODES.gift]: "WorkBuddy Pro Trial",
  [COMMODITY_CODES.activity]: "WorkBuddy Growth Credits",
  [COMMODITY_CODES.proYear]: "WorkBuddy Pro Yearly",
  [COMMODITY_CODES.freeMon]: "WorkBuddy Pro Daily",
  [COMMODITY_CODES.extra]: "WorkBuddy Credit Package"
};

let usageCache = null;
let refreshPromise = null;
let refreshStartedAt = 0;
let refreshKey = null;
let refreshHandler = null;

function collectWorkBuddyUsage(options = {}) {
  const collectedAt = normalizeDate(options.now);
  const clockNowMs = normalizeClockMs(options.clockMs);
  const refreshMinMs = normalizeDurationMs(options.refreshMinMs, DEFAULT_REFRESH_MIN_MS);
  const cacheStaleMs = normalizeDurationMs(options.cacheStaleMs, DEFAULT_CACHE_STALE_MS);
  const model = readLatestWorkBuddyModel(options);
  const sessionInfo = readWorkBuddySession(options);
  const endpoint = normalizeEndpoint(options.endpoint || process.env.WORKBUDDY_ENDPOINT || DEFAULT_ENDPOINT);

  if (!sessionInfo.session) {
    return buildProvider({
      collectedAt,
      model,
      status: "missing",
      tokenPlan: buildStatusTokenPlan({
        collectedAt,
        status: "auth-missing",
        reason: sessionInfo.reason || "WorkBuddy auth session was not found."
      }),
      note: "WorkBuddy local auth session was not found; open WorkBuddy and sign in before live credits can sync."
    });
  }

  if (isSessionExpired(sessionInfo.session, collectedAt)) {
    return buildProvider({
      collectedAt,
      model,
      status: "missing",
      tokenPlan: buildStatusTokenPlan({
        collectedAt,
        status: "auth-expired",
        reason: "WorkBuddy auth session is expired."
      }),
      note: "WorkBuddy auth session is expired; sign in to WorkBuddy again to refresh live credits."
    });
  }

  const key = getRefreshKey({ session: sessionInfo.session, endpoint, authFile: sessionInfo.file });
  queueWorkBuddyRefresh({
    key,
    endpoint,
    session: sessionInfo.session,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: numberOrNull(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
    refreshMinMs,
    clockNowMs,
    now: collectedAt
  });

  if (usageCache?.key === key && usageCache.quota && clockNowMs - usageCache.fetchedAt <= cacheStaleMs) {
    return buildProvider({
      collectedAt,
      model,
      status: "live",
      tokenPlan: {
        ...usageCache.quota,
        snapshotAt: usageCache.snapshotAt
      },
      note: "WorkBuddy live credits are read from the official billing API using the local auth session. Credentials stay local and are not exposed in snapshots."
    });
  }

  const cachedStatus = usageCache?.key === key ? usageCache.status : null;
  const cachedReason = usageCache?.key === key ? usageCache.reason : null;
  return buildProvider({
    collectedAt,
    model,
    status: "missing",
    tokenPlan: buildStatusTokenPlan({
      collectedAt,
      status: cachedStatus === "error" ? "error" : "refreshing",
      reason: cachedReason || "WorkBuddy billing refresh is pending."
    }),
    note: cachedReason || "WorkBuddy live credit refresh is pending."
  });
}

function setWorkBuddyRefreshHandler(handler) {
  refreshHandler = typeof handler === "function" ? handler : null;
}

function resetWorkBuddyUsageCache() {
  usageCache = null;
  refreshPromise = null;
  refreshStartedAt = 0;
  refreshKey = null;
  refreshHandler = null;
}

function queueWorkBuddyRefresh({ key, endpoint, session, fetchImpl, timeoutMs, refreshMinMs, clockNowMs, now }) {
  if (typeof fetchImpl !== "function") return;
  if (refreshPromise) return;
  const normalizedRefreshMinMs = normalizeDurationMs(refreshMinMs, DEFAULT_REFRESH_MIN_MS);
  const startedAtMs = normalizeClockMs(clockNowMs);
  const keyChanged = key !== refreshKey;
  if (!keyChanged && startedAtMs - refreshStartedAt < normalizedRefreshMinMs) return;
  if (!keyChanged && usageCache?.quota && startedAtMs - usageCache.fetchedAt <= normalizedRefreshMinMs) return;

  refreshStartedAt = startedAtMs;
  refreshKey = key;
  refreshPromise = refreshWorkBuddyUsage({
    endpoint,
    session,
    fetchImpl,
    timeoutMs,
    now
  })
    .then((quota) => {
      usageCache = {
        key,
        status: "live",
        reason: null,
        quota,
        fetchedAt: normalizeClockMs(clockNowMs),
        snapshotAt: new Date().toISOString()
      };
      notifyRefresh();
    })
    .catch((error) => {
      usageCache = {
        key,
        status: "error",
        reason: safeErrorMessage(error),
        quota: null,
        fetchedAt: normalizeClockMs(clockNowMs),
        snapshotAt: new Date().toISOString()
      };
      notifyRefresh();
    })
    .finally(() => {
      refreshPromise = null;
    });
}

async function refreshWorkBuddyUsage({ endpoint = DEFAULT_ENDPOINT, session, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = new Date() } = {}) {
  if (!session?.auth?.accessToken || !session?.account?.uid) {
    throw new Error("WorkBuddy auth session is missing access token or uid.");
  }
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (session.account.enterpriseId) {
    const body = await fetchWorkBuddyJson({
      endpoint: normalizedEndpoint,
      pathName: "/v2/billing/meter/get-enterprise-user-usage",
      session,
      fetchImpl,
      timeoutMs,
      body: {}
    });
    return normalizeEnterpriseUsageResponse(body, session, now);
  }

  const body = await fetchWorkBuddyJson({
    endpoint: normalizedEndpoint,
    pathName: "/v2/billing/meter/get-user-resource",
    session,
    fetchImpl,
    timeoutMs,
    body: buildPersonalUsageRequest(now)
  });
  return normalizePersonalUsageResponse(body, now);
}

async function fetchWorkBuddyJson({ endpoint, pathName, session, fetchImpl, timeoutMs, body }) {
  const response = await fetchImpl(`${endpoint}${pathName}`, {
    method: "POST",
    headers: buildAuthHeaders(session),
    body: JSON.stringify(body || {}),
    signal: buildTimeoutSignal(timeoutMs)
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`WorkBuddy billing API returned HTTP ${response.status}.`);
  }
  if (json && typeof json.code === "number" && json.code !== 0) {
    throw new Error(`WorkBuddy billing API returned code ${json.code}.`);
  }
  return json;
}

function buildAuthHeaders(session) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${session.auth.accessToken}`,
    "Content-Type": "application/json",
    "X-User-Id": session.account.uid
  };
  if (session.account.enterpriseId) {
    headers["X-Enterprise-Id"] = session.account.enterpriseId;
    headers["X-Tenant-Id"] = session.account.enterpriseId;
  }
  if (session.auth.domain) headers["X-Domain"] = session.auth.domain;
  return headers;
}

function buildPersonalUsageRequest(now = new Date()) {
  const current = normalizeDate(now);
  const futureDate = new Date(current.getTime() + 101 * 365 * 24 * 60 * 60 * 1000);
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatWorkBuddyDate(current),
    PackageEndTimeRangeEnd: formatWorkBuddyDate(futureDate)
  };
}

function normalizeEnterpriseUsageResponse(body, session = {}, now = new Date()) {
  const usageData = body?.data?.data || body?.data || body;
  const editionType = getEditionDisplayType(session.account?.type, false);
  if (!usageData || typeof usageData.limitNum !== "number") {
    return buildQuota({
      totalCredits: 0,
      usedCredits: 0,
      remainingCredits: 0,
      planName: `WorkBuddy ${editionType}`
    });
  }
  if (usageData.limitNum === -1) {
    return {
      ...buildQuota({
        totalCredits: null,
        usedCredits: null,
        remainingCredits: null,
        remainingPercent: 100,
        planName: "WorkBuddy Enterprise"
      }),
      unlimited: true,
      validUntil: timestampToIso(usageData.cycleResetTime),
      refreshAt: timestampToIso(usageData.cycleResetTime),
      source: "workbuddy-official-billing",
      status: "live",
      platformStatus: "live",
      label: "WorkBuddy Credits",
      fetchedAt: normalizeDate(now).toISOString()
    };
  }
  const total = usageData.limitNum;
  const used = numberOrNull(usageData.credit) || 0;
  const remaining = Math.max(0, total - used);
  return {
    ...buildQuota({
      totalCredits: total,
      usedCredits: used,
      remainingCredits: remaining,
      planName: "WorkBuddy Enterprise"
    }),
    validUntil: timestampToIso(usageData.cycleResetTime),
    refreshAt: timestampToIso(usageData.cycleResetTime),
    source: "workbuddy-official-billing",
    status: "live",
    platformStatus: "live",
    label: "WorkBuddy Credits",
    fetchedAt: normalizeDate(now).toISOString()
  };
}

function normalizePersonalUsageResponse(body, now = new Date()) {
  const resources = body?.data?.Response?.Data?.Accounts ||
    body?.data?.data?.Response?.Data?.Accounts ||
    body?.Response?.Data?.Accounts ||
    [];
  const planResources = Array.isArray(resources)
    ? resources.map(normalizePlanResource).sort(comparePlanResourcePriority)
    : [];
  const totalCredits = planResources.reduce((sum, resource) => sum + resource.total, 0);
  const usedCredits = planResources.reduce((sum, resource) => sum + resource.used, 0);
  const remainingCredits = planResources.reduce((sum, resource) => sum + resource.left, 0);
  const activePlan = findActivePlan(resources);
  const activeResource = activePlan ? normalizePlanResource(activePlan) : planResources[0] || null;
  const validUntil = timestampToIso(activeResource?.expireAt);
  const refreshAt = timestampToIso(activeResource?.refreshAt);

  return {
    ...buildQuota({
      totalCredits,
      usedCredits,
      remainingCredits,
      planName: activeResource?.name || "WorkBuddy Credits",
      validUntil
    }),
    refreshAt,
    source: "workbuddy-official-billing",
    status: "live",
    platformStatus: "live",
    label: "WorkBuddy Credits",
    fetchedAt: normalizeDate(now).toISOString(),
    resourcesCount: planResources.length
  };
}

function normalizePlanResource(resource = {}) {
  const isDaily = DAILY_CREDITS.has(resource.PackageCode);
  const endTime = isDaily ? resource.CycleEndTime : resource.DeductionEndTime;
  const total = clampNonNegative(resource.CycleCapacitySizePrecise);
  const left = clampNonNegative(resource.CycleCapacityRemainPrecise);
  return {
    packageCode: resource.PackageCode || null,
    name: isDaily ? "WorkBuddy Daily Credits" : COMMODITY_LABELS[resource.PackageCode] || "WorkBuddy Credits",
    isDaily,
    total,
    used: Math.max(0, total - left),
    left,
    expireAt: parseTime(endTime),
    refreshAt: isDaily ? null : parseTime(resource.CycleEndTime) + 1000,
    status: resource.Status
  };
}

function findActivePlan(resources = []) {
  if (!Array.isArray(resources)) return null;
  return resources.find((resource) =>
    [COMMODITY_CODES.proYear, COMMODITY_CODES.proMon, COMMODITY_CODES.proMonPlus].includes(resource.PackageCode)
  ) || resources.find((resource) =>
    [COMMODITY_CODES.gift, COMMODITY_CODES.freeMon].includes(resource.PackageCode)
  ) || null;
}

function comparePlanResourcePriority(a, b) {
  return getPlanPriority(a.packageCode) - getPlanPriority(b.packageCode);
}

function getPlanPriority(code) {
  if ([COMMODITY_CODES.proMon, COMMODITY_CODES.proMonPlus, COMMODITY_CODES.proYear, COMMODITY_CODES.freeMon, COMMODITY_CODES.extra].includes(code)) return 1;
  if ([COMMODITY_CODES.gift, COMMODITY_CODES.activity].includes(code)) return 2;
  if (code === COMMODITY_CODES.free) return 3;
  return 4;
}

function buildQuota({ totalCredits, usedCredits, remainingCredits, remainingPercent = null, planName, validUntil }) {
  const total = numberOrNull(totalCredits);
  const used = numberOrNull(usedCredits);
  const remaining = numberOrNull(remainingCredits);
  const normalizedRemainingPercent = remainingPercent ??
    (total && remaining !== null ? percentage(remaining, total) : null);
  const normalizedUsedPercent = total && used !== null ? percentage(used, total) :
    normalizedRemainingPercent === null ? null : 100 - normalizedRemainingPercent;
  return {
    totalCredits: total,
    usedCredits: used,
    remainingCredits: remaining,
    usedPercent: normalizedUsedPercent === null ? null : clampPercent(normalizedUsedPercent),
    remainingPercent: normalizedRemainingPercent === null ? null : clampPercent(normalizedRemainingPercent),
    planName: planName || "WorkBuddy Credits",
    validUntil: validUntil || null
  };
}

function buildStatusTokenPlan({ collectedAt, status, reason }) {
  return {
    totalCredits: null,
    usedCredits: null,
    remainingCredits: null,
    usedPercent: null,
    remainingPercent: null,
    planName: "WorkBuddy Credits",
    validUntil: null,
    source: "workbuddy-official-billing",
    status,
    platformStatus: status,
    platformReason: reason || null,
    label: status === "refreshing" ? "Refreshing" : "WorkBuddy Credits",
    snapshotAt: collectedAt.toISOString()
  };
}

function buildProvider({ collectedAt, model, status, tokenPlan, note }) {
  const isLive = tokenPlan?.platformStatus === "live";
  const timestamp = tokenPlan?.snapshotAt || tokenPlan?.fetchedAt || collectedAt.toISOString();
  const tokenAccuracy = isLive
    ? {
        level: "official-usage",
        source: "workbuddy-official-billing",
        estimated: false,
        label: "reported",
        reason: "WorkBuddy official billing API reported credit balance."
      }
    : {
        level: "unknown",
        source: "workbuddy-official-billing",
        estimated: false,
        label: "unknown",
        reason: "WorkBuddy billing refresh has not produced live credit data yet."
      };
  return {
    id: "workbuddy",
    sourceId: "workbuddy-local",
    name: "WorkBuddy",
    status,
    source: "workbuddy-official-billing",
    confidence: isLive ? "reported" : "unknown",
    tokenAccuracy,
    tokenEstimated: false,
    note,
    collectedAt: collectedAt.toISOString(),
    todayTokens: 0,
    recentTokens: 0,
    todayCostUsd: 0,
    latest: {
      timestamp,
      model: model || "unknown",
      lastTurnTokens: 0,
      rateLimits: null,
      rateLimitsTrust: {
        status: isLive ? "live" : tokenPlan?.platformStatus || "missing",
        label: "WorkBuddy Credits",
        reason: isLive ? null : tokenPlan?.platformReason || note || null,
        ageMs: 0
      },
      tokenPlan,
      context: null
    },
    models: model
      ? [{ model, todayTokens: 0, todayCostUsd: 0, requests: null }]
      : []
  };
}

function readWorkBuddySession({
  authFile = process.env.WORKBUDDY_AUTH_FILE,
  authDir = process.env.WORKBUDDY_AUTH_DIR,
  localAppData = process.env.LOCALAPPDATA,
  userProfile = process.env.USERPROFILE || process.env.HOME
} = {}) {
  const candidates = getAuthFileCandidates({ authFile, authDir, localAppData, userProfile });
  for (const file of candidates) {
    const session = readJsonFile(file);
    if (session?.auth?.accessToken && session?.account?.uid) return { file, session };
  }
  return {
    file: null,
    session: null,
    reason: candidates.length ? "No readable WorkBuddy auth session contained an access token and uid." : "No WorkBuddy auth file candidates were found."
  };
}

function getAuthFileCandidates({ authFile, authDir, localAppData, userProfile } = {}) {
  const explicit = [authFile].filter(Boolean);
  const dirs = [
    authDir,
    ...(localAppData
      ? ["CodeBuddyExtension", "WorkBuddyExtension", "WorkBuddy"].map((name) => path.join(localAppData, name, "Data", "Public", "auth"))
      : []),
    ...(userProfile
      ? ["CodeBuddyExtension", "WorkBuddyExtension", "WorkBuddy"].map((name) => path.join(userProfile, "Library", "Application Support", name, "Data", "Public", "auth"))
      : []),
    ...(userProfile
      ? ["CodeBuddyExtension", "WorkBuddyExtension", "WorkBuddy"].map((name) => path.join(userProfile, ".local", "share", name, "Data", "Public", "auth"))
      : []),
    userProfile ? path.join(userProfile, ".workbuddy", "auth") : null
  ].filter(Boolean);
  const candidates = [];
  for (const file of explicit) addCandidate(candidates, file, 0);
  for (const dir of dirs) {
    for (const name of AUTH_FILE_NAMES) addCandidate(candidates, path.join(dir, name), 1);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".info")) addCandidate(candidates, path.join(dir, entry.name), 2);
      }
    } catch {}
  }
  return candidates
    .filter((entry) => fs.existsSync(entry.file))
    .sort((a, b) => a.rank - b.rank || getMtimeMs(b.file) - getMtimeMs(a.file))
    .map((entry) => entry.file);
}

function addCandidate(candidates, file, rank) {
  if (!file) return;
  const resolved = path.resolve(file);
  if (candidates.some((entry) => entry.file === resolved)) return;
  candidates.push({ file: resolved, rank });
}

function readLatestWorkBuddyModel({
  dbPath = process.env.WORKBUDDY_DB_PATH,
  userProfile = process.env.USERPROFILE || process.env.HOME,
  appData = process.env.APPDATA,
  modelStorageDir = process.env.WORKBUDDY_MODEL_STORAGE_DIR,
  modelCatalogDir = process.env.WORKBUDDY_MODEL_CATALOG_DIR,
  modelCatalogFile = process.env.WORKBUDDY_MODEL_CATALOG_FILE
} = {}) {
  const selectedModel = readCurrentWorkBuddyModel({
    userProfile,
    appData,
    modelStorageDir,
    modelCatalogDir,
    modelCatalogFile
  });
  if (selectedModel) return selectedModel;

  return readLatestWorkBuddySessionModel({ dbPath, userProfile });
}

function readLatestWorkBuddySessionModel({
  dbPath = process.env.WORKBUDDY_DB_PATH,
  userProfile = process.env.USERPROFILE || process.env.HOME
} = {}) {
  const resolvedDbPath = dbPath || (userProfile ? path.join(userProfile, ".workbuddy", "workbuddy.db") : null);
  if (!resolvedDbPath || !fs.existsSync(resolvedDbPath)) return null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
    try {
      const row = db.prepare(`
        SELECT model
        FROM sessions
        WHERE deleted_at IS NULL AND model IS NOT NULL AND model != ''
        ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
        LIMIT 1
      `).get();
      return row?.model ? String(row.model) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readCurrentWorkBuddyModel(options = {}) {
  const selectedId = readCurrentWorkBuddyModelId(options);
  if (!selectedId) return null;
  const catalog = readWorkBuddyModelCatalog(options);
  return catalog.get(selectedId) || selectedId;
}

function readCurrentWorkBuddyModelId({
  modelStorageDir = process.env.WORKBUDDY_MODEL_STORAGE_DIR,
  userProfile = process.env.USERPROFILE || process.env.HOME,
  appData = process.env.APPDATA
} = {}) {
  const candidates = getWorkBuddyModelStorageFiles({ modelStorageDir, userProfile, appData });
  let latest = null;
  for (const file of candidates) {
    const stat = safeStat(file);
    if (!stat || stat.size > 2 * 1024 * 1024) continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const matcher = /cb-newtask:model:[^\s\x00"'{}]+[\s\S]{0,120}?\{\s*"id"\s*:\s*"([^"]{1,120})"/g;
    let match = null;
    while ((match = matcher.exec(text))) {
      const modelId = normalizeModelId(match[1]);
      if (!modelId) continue;
      const candidate = {
        modelId,
        mtimeMs: stat.mtimeMs,
        index: match.index
      };
      if (!latest ||
        candidate.mtimeMs > latest.mtimeMs ||
        (candidate.mtimeMs === latest.mtimeMs && candidate.index > latest.index)) {
        latest = candidate;
      }
    }
  }
  return latest?.modelId || null;
}

function getWorkBuddyModelStorageFiles({
  modelStorageDir = process.env.WORKBUDDY_MODEL_STORAGE_DIR,
  userProfile = process.env.USERPROFILE || process.env.HOME,
  appData = process.env.APPDATA
} = {}) {
  const dirs = [
    modelStorageDir,
    userProfile ? path.join(userProfile, ".workbuddy", "app", "session", "Local Storage", "leveldb") : null,
    appData ? path.join(appData, "WorkBuddy", "Local Storage", "leveldb") : null
  ].filter(Boolean);
  const files = [];
  for (const dir of dirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(log|ldb)$/i.test(entry.name)) continue;
        files.push(path.join(dir, entry.name));
      }
    } catch {}
  }
  return Array.from(new Set(files));
}

function readWorkBuddyModelCatalog({
  modelCatalogDir = process.env.WORKBUDDY_MODEL_CATALOG_DIR,
  modelCatalogFile = process.env.WORKBUDDY_MODEL_CATALOG_FILE,
  userProfile = process.env.USERPROFILE || process.env.HOME
} = {}) {
  const catalog = new Map();
  const files = [
    userProfile ? path.join(userProfile, ".workbuddy", "models.json") : null,
    modelCatalogFile
  ].filter(Boolean);
  for (const file of files) {
    addModelsToCatalog(catalog, readJsonFile(file));
  }

  const dirs = [
    userProfile ? path.join(userProfile, ".workbuddy", "local_storage") : null,
    modelCatalogDir
  ].filter(Boolean);
  for (const dir of dirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".info")) continue;
        addModelsToCatalog(catalog, readJsonFile(path.join(dir, entry.name)));
      }
    } catch {}
  }
  return catalog;
}

function addModelsToCatalog(catalog, body) {
  const records = Array.isArray(body) ? body : [body];
  for (const record of records) {
    const models = Array.isArray(record?.data?.models)
      ? record.data.models
      : Array.isArray(record?.models)
        ? record.models
        : record?.id
          ? [record]
        : Array.isArray(record)
          ? record
          : [];
    for (const model of models) {
      const id = normalizeModelId(model?.id);
      const name = normalizeModelName(model?.name);
      if (id && name) catalog.set(id, name);
    }
  }
}

function normalizeModelId(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 100) return null;
  if (/[\x00-\x1f\s]/.test(text)) return null;
  if (/^(Bearer|sk-|eyJ)/i.test(text)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(text)) return null;
  return text;
}

function normalizeModelName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 100) return null;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return null;
  if (/^(Bearer|sk-|eyJ)/i.test(text)) return null;
  return text;
}

function isSessionExpired(session, now = new Date()) {
  const expiresAt = numberOrNull(session?.auth?.expiresAt);
  return expiresAt !== null && expiresAt <= normalizeDate(now).getTime();
}

function getRefreshKey({ session, endpoint, authFile }) {
  const tokenFingerprint = crypto
    .createHash("sha256")
    .update(String(session?.auth?.accessToken || "missing"))
    .digest("hex");
  return [
    normalizeEndpoint(endpoint),
    authFile || "unknown",
    tokenFingerprint,
    session?.account?.enterpriseId ? "enterprise" : "personal"
  ].join("|");
}

function notifyRefresh() {
  if (!refreshHandler) return;
  try {
    refreshHandler();
  } catch {}
}

function buildTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function normalizeEndpoint(value) {
  return String(value || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function normalizeClockMs(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function normalizeDurationMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.round(number);
}

function formatWorkBuddyDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getEditionDisplayType(type, isPro) {
  if (type === "personal") return isPro ? "pro" : "free";
  if (type === "ultimate") return "ultimate";
  if (type === "exclusive") return "exclusive";
  return "free";
}

function parseTime(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function timestampToIso(value) {
  const timestamp = typeof value === "number" ? value : parseTime(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function percentage(part, total) {
  if (!Number.isFinite(Number(part)) || !Number.isFinite(Number(total)) || Number(total) <= 0) return null;
  return Math.round((Number(part) / Number(total)) * 100);
}

function clampPercent(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

function getMtimeMs(file) {
  return safeStat(file)?.mtimeMs || 0;
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]").slice(0, 240);
}

module.exports = {
  buildAuthHeaders,
  buildPersonalUsageRequest,
  collectWorkBuddyUsage,
  getAuthFileCandidates,
  normalizeEnterpriseUsageResponse,
  normalizePersonalUsageResponse,
  readCurrentWorkBuddyModel,
  readCurrentWorkBuddyModelId,
  readLatestWorkBuddyModel,
  readLatestWorkBuddySessionModel,
  readWorkBuddyModelCatalog,
  readWorkBuddySession,
  refreshWorkBuddyUsage,
  resetWorkBuddyUsageCache,
  setWorkBuddyRefreshHandler
};
