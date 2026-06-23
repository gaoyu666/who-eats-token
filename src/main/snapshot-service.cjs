const { summarizeProviderHealth } = require("../protocol/provider-health.cjs");
const { mergeTokenAccuracies, normalizeTokenAccuracy } = require("../protocol/token-accuracy.cjs");

function createSnapshotService({
  collectCodexUsage,
  collectHermesUsage,
  collectWorkBuddyUsage,
  getIngestServer,
  getHermesBridgeServer,
  getSystemMetrics,
  getPublicSettings,
  isProviderEnabled,
  annotateCapacityTrends,
  summarizeProviders
} = {}) {
  return {
    collectSnapshot(options = {}) {
      const collectedAt = new Date();
      const codex = isProviderEnabled("codex") ? collectCodexUsage() : null;
      const hermes = isProviderEnabled("hermes") ? collectHermesUsage() : null;
      const workbuddy = isProviderEnabled("workbuddy") && collectWorkBuddyUsage
        ? collectWorkBuddyUsage(options.workbuddy || {})
        : null;
      const ingestServer = getIngestServer();
      const hermesBridgeServer = getHermesBridgeServer();
      const ingest = ingestServer ? ingestServer.getSummary() : null;
      const providers = annotateCapacityTrends(
        mergeProviders([
          codex,
          hermes,
          workbuddy,
          ...(isProviderEnabled("ingest") ? ingest?.providers || [] : [])
        ].filter(Boolean)),
        collectedAt
      );
      const publicSettings = getPublicSettings();
      const baseSnapshot = {
        collectedAt: collectedAt.toISOString(),
        ingest: ingest
          ? {
              port: ingest.port,
              listening: ingest.listening,
              error: ingest.error,
              eventCount: ingest.eventCount,
              recentEventCount: ingest.recentEventCount,
              overlayCount: ingest.overlayCount
            }
          : null,
        bridges: {
          hermes: hermesBridgeServer ? hermesBridgeServer.getStatus() : null
        },
        system: getSystemMetrics(),
        totals: summarizeProviders(providers),
        providers,
        settings: publicSettings
      };

      return {
        ...baseSnapshot,
        providerHealth: summarizeProviderHealth(baseSnapshot)
      };
    }
  };
}

function mergeProviders(providers) {
  const byId = new Map();
  for (const provider of providers) {
    const current = byId.get(provider.id);
    byId.set(provider.id, current ? mergeProvider(current, provider) : withProviderSourceMetadata(provider));
  }
  return Array.from(byId.values());
}

function mergeProvider(base, incoming) {
  const baseWithSources = withProviderSourceMetadata(base);
  const incomingWithSources = withProviderSourceMetadata(incoming);
  const baseTimestamp = Date.parse(base.latest?.timestamp || "");
  const incomingTimestamp = Date.parse(incoming.latest?.timestamp || "");
  const preferred = Number.isFinite(baseTimestamp) && Number.isFinite(incomingTimestamp)
    ? incomingTimestamp >= baseTimestamp
      ? incomingWithSources
      : baseWithSources
    : incoming.latest
      ? incomingWithSources
      : baseWithSources;
  const other = preferred === incomingWithSources ? baseWithSources : incomingWithSources;
  const sources = mergeProviderSources(baseWithSources.sources, incomingWithSources.sources);
  const usageAggregation = aggregateProviderSources(sources);
  const tokenAccuracy = mergeTokenAccuracies([
    other.tokenAccuracy,
    preferred.tokenAccuracy,
    usageAggregation.tokenAccuracy
  ]);

  return {
    ...other,
    ...preferred,
    sourceId: preferred.sourceId || other.sourceId || sources[0]?.sourceId || preferred.id,
    sources,
    usageAggregation,
    tokenAccuracy,
    tokenEstimated: Boolean(tokenAccuracy?.estimated),
    status: preferred.status === "live" || other.status === "live" ? "live" : preferred.status,
    confidence: preferred.confidence || other.confidence,
    todayTokens: usageAggregation.todayTokens,
    recentTokens: usageAggregation.recentTokens,
    todayCostUsd: usageAggregation.todayCostUsd,
    latest: mergeLatestState(base.latest, incoming.latest, preferred.latest),
    models: preferred.models?.length ? preferred.models : other.models || []
  };
}

function withProviderSourceMetadata(provider) {
  const sources = getProviderSources(provider);
  const usageAggregation = provider.usageAggregation || aggregateProviderSources(sources);
  const tokenAccuracy = mergeTokenAccuracies([
    provider.tokenAccuracy,
    usageAggregation.tokenAccuracy,
    provider.latest?.context?.tokenAccuracy
  ]);
  return {
    ...provider,
    sourceId: provider.sourceId || sources[0]?.sourceId || provider.id,
    sources,
    usageAggregation,
    tokenAccuracy,
    tokenEstimated: Boolean(provider.tokenEstimated || tokenAccuracy?.estimated)
  };
}

function getProviderSources(provider) {
  const explicitSources = Array.isArray(provider.sources) ? provider.sources : [];
  if (explicitSources.length > 0) {
    return explicitSources.map((source) => normalizeProviderSource(source, provider));
  }
  return [normalizeProviderSource(provider, provider)];
}

function normalizeProviderSource(source, provider) {
  const sourceId = String(source.sourceId || source.source || provider.sourceId || provider.source || provider.id || "unknown");
  const tokenAccuracy = normalizeTokenAccuracy(source.tokenAccuracy || provider.tokenAccuracy || provider.latest?.context?.tokenAccuracy, {
    confidence: source.confidence || provider.confidence,
    source: source.source || provider.source || sourceId,
    estimated: source.tokenEstimated ?? provider.tokenEstimated
  });
  return {
    sourceId,
    source: source.source || provider.source || sourceId,
    status: source.status || provider.status || "unknown",
    confidence: source.confidence || provider.confidence || null,
    tokenAccuracy,
    tokenEstimated: Boolean(source.tokenEstimated || provider.tokenEstimated || tokenAccuracy.estimated),
    todayTokens: numberOrZero(source.todayTokens),
    recentTokens: numberOrZero(source.recentTokens),
    todayCostUsd: numberOrZero(source.todayCostUsd),
    eventCount: Number.isFinite(Number(source.eventCount)) ? Number(source.eventCount) : null,
    latestTimestamp: source.latestTimestamp || provider.latest?.timestamp || provider.latest?.latestTokenAt || provider.collectedAt || null
  };
}

function mergeProviderSources(baseSources = [], incomingSources = []) {
  const bySourceId = new Map();
  for (const source of [...baseSources, ...incomingSources]) {
    const current = bySourceId.get(source.sourceId);
    bySourceId.set(source.sourceId, current ? mergeProviderSource(current, source) : source);
  }
  return Array.from(bySourceId.values()).sort((a, b) => b.todayTokens - a.todayTokens);
}

function mergeProviderSource(base, incoming) {
  const baseTimestamp = Date.parse(base.latestTimestamp || "");
  const incomingTimestamp = Date.parse(incoming.latestTimestamp || "");
  const preferred = Number.isFinite(baseTimestamp) && Number.isFinite(incomingTimestamp)
    ? incomingTimestamp >= baseTimestamp
      ? incoming
      : base
    : incoming.latestTimestamp
      ? incoming
      : base;
  const other = preferred === incoming ? base : incoming;
  const tokenAccuracy = mergeTokenAccuracies([base.tokenAccuracy, incoming.tokenAccuracy]);
  return {
    ...other,
    ...preferred,
    status: preferred.status === "live" || other.status === "live" ? "live" : preferred.status,
    confidence: preferred.confidence || other.confidence,
    tokenAccuracy,
    tokenEstimated: Boolean(base.tokenEstimated || incoming.tokenEstimated || tokenAccuracy.estimated),
    todayTokens: Math.max(numberOrZero(base.todayTokens), numberOrZero(incoming.todayTokens)),
    recentTokens: Math.max(numberOrZero(base.recentTokens), numberOrZero(incoming.recentTokens)),
    todayCostUsd: Math.max(numberOrZero(base.todayCostUsd), numberOrZero(incoming.todayCostUsd)),
    eventCount: numberOrNull(base.eventCount) === null && numberOrNull(incoming.eventCount) === null
      ? null
      : numberOrZero(base.eventCount) + numberOrZero(incoming.eventCount)
  };
}

function aggregateProviderSources(sources = []) {
  const sourceIds = sources.map((source) => source.sourceId);
  const tokenAccuracy = mergeTokenAccuracies(sources.map((source) => source.tokenAccuracy));
  return {
    strategy: sources.length > 1 ? "sum-by-source-id" : "single-source",
    dedupeKey: "sourceId",
    sourceIds,
    tokenAccuracy,
    tokenEstimated: Boolean(tokenAccuracy?.estimated),
    todayTokens: sources.reduce((sum, source) => sum + numberOrZero(source.todayTokens), 0),
    recentTokens: sources.reduce((sum, source) => sum + numberOrZero(source.recentTokens), 0),
    todayCostUsd: sources.reduce((sum, source) => sum + numberOrZero(source.todayCostUsd), 0),
    note: sources.length > 1
      ? "Usage is summed across distinct sourceId values; duplicate reports within the same sourceId are merged conservatively."
      : "Usage comes from one sourceId."
  };
}

function mergeLatestState(baseLatest, incomingLatest, preferredLatest) {
  if (!baseLatest && !incomingLatest && !preferredLatest) return null;
  const preferred = preferredLatest || incomingLatest || baseLatest;
  return {
    ...baseLatest,
    ...incomingLatest,
    ...preferred,
    rateLimits: incomingLatest?.rateLimits || baseLatest?.rateLimits || preferred?.rateLimits || null,
    rateLimitsTrust:
      incomingLatest?.rateLimitsTrust ||
      baseLatest?.rateLimitsTrust ||
      preferred?.rateLimitsTrust ||
      null,
    context: incomingLatest?.context || baseLatest?.context || preferred?.context || null,
    tokenPlan: incomingLatest?.tokenPlan || baseLatest?.tokenPlan || preferred?.tokenPlan || null
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  createSnapshotService,
  mergeProviders
};
