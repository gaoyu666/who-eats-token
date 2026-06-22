"use strict";

const SURFACES = Object.freeze({
  DESKTOP: "desktop-topbar",
  TOOL: "tool-hud",
  HIDDEN: "hidden"
});

const DEFAULT_NOISE_GRACE_MS = 300;
const DEFAULT_CONFIRMED_LATENCY_MS = 400;

function createOverlayController(options = {}) {
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const noiseGraceMs = clampMs(options.noiseGraceMs, DEFAULT_NOISE_GRACE_MS);
  const confirmedLatencyMs = clampMs(options.confirmedLatencyMs, DEFAULT_CONFIRMED_LATENCY_MS);
  let state = createInitialState(nowFn());

  return {
    getState() {
      return { ...state };
    },
    resolve(input = {}) {
      const now = Number.isFinite(Number(input.now)) ? Number(input.now) : nowFn();
      const previous = state;
      const sampleId = input.sampleId || previous.sampleId + 1;
      const requested = resolveRequestedSurface(input, previous, now, {
        noiseGraceMs,
        confirmedLatencyMs
      });
      const surfaceChanged = requested.surface !== previous.surface;
      const next = {
        surface: requested.surface,
        mode: requested.surface,
        reason: requested.reason,
        sampleId,
        version: previous.version + 1,
        changedAt: surfaceChanged ? now : previous.changedAt,
        confirmedAt: requested.confirmed ? now : previous.confirmedAt,
        stalePreserveStartedAt: requested.stalePreserveStartedAt,
        stalePreserveMs: requested.stalePreserveMs,
        activeWindow: requested.preserveOverlay
          ? input.activeWindow || previous.activeWindow || null
          : input.activeWindow || null,
        toolContext: requested.surface === SURFACES.TOOL
          ? input.toolContext || (requested.preserveOverlay ? previous.toolContext : null) || null
          : null,
        transition: {
          sampleId,
          from: previous.surface,
          to: requested.surface,
          changed: surfaceChanged,
          reason: requested.reason,
          latencyMs: Math.max(0, now - previous.changedAt),
          stalePreserveMs: requested.stalePreserveMs
        },
        suppressHud: requested.surface !== SURFACES.TOOL,
        suppressDesktopBar: requested.surface !== SURFACES.DESKTOP,
        noise: Boolean(requested.noise),
        preserveOverlay: Boolean(requested.preserveOverlay)
      };
      state = next;
      return { ...next };
    },
    reset(nextState = {}) {
      state = {
        ...createInitialState(nowFn()),
        ...nextState
      };
    }
  };
}

function createInitialState(now) {
  return {
    surface: SURFACES.HIDDEN,
    mode: SURFACES.HIDDEN,
    reason: "startup",
    sampleId: 0,
    version: 0,
    changedAt: now,
    confirmedAt: now,
    stalePreserveStartedAt: null,
    stalePreserveMs: 0,
    activeWindow: null,
    toolContext: null,
    suppressHud: true,
    suppressDesktopBar: true,
    noise: false,
    preserveOverlay: false,
    transition: {
      sampleId: 0,
      from: SURFACES.HIDDEN,
      to: SURFACES.HIDDEN,
      changed: false,
      reason: "startup",
      latencyMs: 0,
      stalePreserveMs: 0
    }
  };
}

function resolveRequestedSurface(input, previous, now, options) {
  if (input.samplingNoise) {
    return resolveSamplingNoiseSurface(input, previous, now, options);
  }

  if (isSurface(input.settingsSurface)) {
    return {
      surface: input.settingsSurface,
      reason: "settings-preserve",
      confirmed: false,
      preserveOverlay: true,
      stalePreserveStartedAt: null,
      stalePreserveMs: 0
    };
  }

  if (input.toolContext) {
    if (input.toolHudEnabled === false) {
      return requestedHidden("tool-hud-disabled", true);
    }
    return {
      surface: SURFACES.TOOL,
      reason: "tool-foreground",
      confirmed: true,
      stalePreserveStartedAt: null,
      stalePreserveMs: 0
    };
  }

  if (input.desktopVisible) {
    if (input.desktopBarEnabled === false) {
      return requestedHidden("desktop-topbar-disabled", true);
    }
    return {
      surface: SURFACES.DESKTOP,
      reason: "desktop",
      confirmed: true,
      stalePreserveStartedAt: null,
      stalePreserveMs: 0
    };
  }

  if (input.fullscreenForeground) {
    return requestedHidden("fullscreen-foreground", true);
  }

  return requestedHidden(input.toolContext ? "tool-hud-disabled" : "unsupported-foreground", false);
}

function resolveSamplingNoiseSurface(input, previous, now, options) {
  const previousSurface = isSurface(previous.surface) ? previous.surface : SURFACES.HIDDEN;
  if (previousSurface === SURFACES.DESKTOP && input.noiseReason === "active-window-timeout") {
    const preserveStartedAt = previous.reason === "active-window-timeout"
      ? previous.stalePreserveStartedAt ?? now
      : now;
    const stalePreserveMs = Math.max(0, now - preserveStartedAt);
    return {
      surface: SURFACES.DESKTOP,
      reason: "active-window-timeout",
      confirmed: false,
      noise: true,
      preserveOverlay: true,
      stalePreserveStartedAt: preserveStartedAt,
      stalePreserveMs
    };
  }

  const preserveStartedAt = previous.stalePreserveStartedAt ?? now;
  const stalePreserveMs = Math.max(0, now - preserveStartedAt);

  if (previousSurface !== SURFACES.HIDDEN && stalePreserveMs <= options.noiseGraceMs) {
    return {
      surface: previousSurface,
      reason: input.noiseReason || "sampling-noise-preserve",
      confirmed: false,
      noise: true,
      preserveOverlay: true,
      stalePreserveStartedAt: preserveStartedAt,
      stalePreserveMs
    };
  }

  return {
    surface: SURFACES.HIDDEN,
    reason: input.noiseReason || "sampling-noise-timeout",
    confirmed: false,
    noise: true,
    stalePreserveStartedAt: preserveStartedAt,
    stalePreserveMs
  };
}

function requestedHidden(reason, confirmed) {
  return {
    surface: SURFACES.HIDDEN,
    reason,
    confirmed,
    stalePreserveStartedAt: null,
    stalePreserveMs: 0
  };
}

function isSurface(surface) {
  return surface === SURFACES.DESKTOP || surface === SURFACES.TOOL || surface === SURFACES.HIDDEN;
}

function clampMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = {
  SURFACES,
  createOverlayController,
  _test: {
    createInitialState,
    resolveRequestedSurface,
    resolveSamplingNoiseSurface,
    isSurface
  }
};
