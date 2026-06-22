import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SURFACES,
  createOverlayController
} = require("../src/main/overlay-controller.cjs");

testSamplingNoiseCannotPreserveTopbarIndefinitely();
testActiveWindowTimeoutDoesNotHideConfirmedDesktop();
testActiveWindowTimeoutPreservesConfirmedDesktopUntilSignal();
testDesktopAssistantSequenceSettlesOnDesktop();
testRapidDesktopToolCyclesHaveOneTransitionPerPhase();
testUnknownFullscreenFallsBackToHidden();
testRememberedToolCannotReviveHud();

console.log("Overlay state checks passed.");

function testSamplingNoiseCannotPreserveTopbarIndefinitely() {
  const clock = createClock();
  const controller = createOverlayController({ now: clock.now, noiseGraceMs: 300 });

  let decision = controller.resolve({
    now: clock.tick(0),
    sampleId: 1,
    desktopVisible: true
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);

  decision = controller.resolve({
    now: clock.tick(120),
    sampleId: 2,
    samplingNoise: true,
    noiseReason: "own-topbar-sampling-noise"
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);
  assert.equal(decision.preserveOverlay, true);

  decision = controller.resolve({
    now: clock.tick(320),
    sampleId: 3,
    samplingNoise: true,
    noiseReason: "own-topbar-sampling-noise"
  });
  assert.equal(decision.surface, SURFACES.HIDDEN);
  assert.equal(decision.reason, "own-topbar-sampling-noise");
  assert.ok(decision.stalePreserveMs > 300);

  decision = controller.resolve({
    now: clock.tick(20),
    sampleId: 4,
    toolContext: codexContext()
  });
  assert.equal(decision.surface, SURFACES.TOOL);
  assert.equal(decision.reason, "tool-foreground");
}

function testActiveWindowTimeoutDoesNotHideConfirmedDesktop() {
  const clock = createClock();
  const controller = createOverlayController({ now: clock.now, noiseGraceMs: 300 });

  let decision = controller.resolve({
    now: clock.tick(0),
    sampleId: 1,
    desktopVisible: true
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);

  decision = controller.resolve({
    now: clock.tick(1200),
    sampleId: 2,
    samplingNoise: true,
    noiseReason: "active-window-timeout"
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);
  assert.equal(decision.preserveOverlay, true);
  assert.equal(decision.stalePreserveMs, 0);

  decision = controller.resolve({
    now: clock.tick(20),
    sampleId: 3,
    toolContext: codexContext()
  });
  assert.equal(decision.surface, SURFACES.TOOL);
  assert.equal(decision.reason, "tool-foreground");
}

function testActiveWindowTimeoutPreservesConfirmedDesktopUntilSignal() {
  const clock = createClock();
  const controller = createOverlayController({ now: clock.now, noiseGraceMs: 300 });

  let decision = controller.resolve({
    now: clock.tick(0),
    sampleId: 1,
    desktopVisible: true
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);

  decision = controller.resolve({
    now: clock.tick(1200),
    sampleId: 2,
    samplingNoise: true,
    noiseReason: "active-window-timeout"
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);
  assert.equal(decision.preserveOverlay, true);
  assert.equal(decision.stalePreserveMs, 0);

  decision = controller.resolve({
    now: clock.tick(320),
    sampleId: 3,
    samplingNoise: true,
    noiseReason: "active-window-timeout"
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);
  assert.equal(decision.reason, "active-window-timeout");
  assert.equal(decision.preserveOverlay, true);
  assert.ok(decision.stalePreserveMs > 300);

  decision = controller.resolve({
    now: clock.tick(20),
    sampleId: 4,
    toolContext: codexContext()
  });
  assert.equal(decision.surface, SURFACES.TOOL);
  assert.equal(decision.reason, "tool-foreground");
}

function testDesktopAssistantSequenceSettlesOnDesktop() {
  const clock = createClock();
  const controller = createOverlayController({ now: clock.now, noiseGraceMs: 300 });

  let decision = controller.resolve({
    now: clock.tick(0),
    sampleId: 1,
    toolContext: codexContext()
  });
  assert.equal(decision.surface, SURFACES.TOOL);

  for (const reason of ["ClickToDo.exe", "Host Popup Window", "NarratorHelperWindow"]) {
    decision = controller.resolve({
      now: clock.tick(70),
      sampleId: reason,
      samplingNoise: true,
      noiseReason: reason
    });
    assert.equal(decision.surface, SURFACES.TOOL);
  }

  decision = controller.resolve({
    now: clock.tick(70),
    sampleId: 5,
    desktopVisible: true
  });
  assert.equal(decision.surface, SURFACES.DESKTOP);
  assert.equal(decision.suppressHud, true);
}

function testRapidDesktopToolCyclesHaveOneTransitionPerPhase() {
  const controller = createOverlayController({ now: () => 0, noiseGraceMs: 300 });
  const transitions = [];

  for (let cycle = 1; cycle <= 50; cycle += 1) {
    const tool = controller.resolve({
      now: cycle * 1000,
      sampleId: `tool-${cycle}`,
      toolContext: codexContext(`hwnd-${cycle}`)
    });
    transitions.push(tool.transition);
    assert.equal(tool.surface, SURFACES.TOOL);

    const desktop = controller.resolve({
      now: cycle * 1000 + 200,
      sampleId: `desktop-${cycle}`,
      desktopVisible: true
    });
    transitions.push(desktop.transition);
    assert.equal(desktop.surface, SURFACES.DESKTOP);
  }

  const changed = transitions.filter((transition) => transition.changed);
  assert.equal(changed.length, 100);
  assert.ok(changed.every((transition) =>
    transition.to === SURFACES.TOOL || transition.to === SURFACES.DESKTOP
  ));
}

function testUnknownFullscreenFallsBackToHidden() {
  const controller = createOverlayController({ now: () => 0 });
  const lockApp = controller.resolve({
    now: 1,
    sampleId: "lockapp",
    fullscreenForeground: true,
    activeWindow: {
      processName: "LockApp.exe",
      title: "Windows 默认锁屏界面"
    }
  });
  assert.equal(lockApp.surface, SURFACES.HIDDEN);
  assert.equal(lockApp.reason, "fullscreen-foreground");

  const notification = controller.resolve({
    now: 2,
    sampleId: "notification",
    activeWindow: {
      processName: "ShellExperienceHost.exe",
      title: "Notification"
    }
  });
  assert.equal(notification.surface, SURFACES.HIDDEN);
  assert.equal(notification.reason, "unsupported-foreground");
}

function testRememberedToolCannotReviveHud() {
  const controller = createOverlayController({ now: () => 0 });
  controller.resolve({
    now: 1,
    sampleId: "tool",
    toolContext: codexContext("remembered")
  });

  const desktop = controller.resolve({
    now: 2,
    sampleId: "desktop",
    desktopVisible: true,
    rememberedToolContext: codexContext("remembered")
  });
  assert.equal(desktop.surface, SURFACES.DESKTOP);

  const unknown = controller.resolve({
    now: 3,
    sampleId: "unknown",
    rememberedToolContext: codexContext("remembered")
  });
  assert.equal(unknown.surface, SURFACES.HIDDEN);
}

function codexContext(hwnd = "codex") {
  return {
    tool: {
      id: "codex",
      name: "Codex",
      providerIds: ["codex"]
    },
    window: {
      hwnd,
      processName: "Codex",
      title: "Codex",
      bounds: { x: 0, y: 0, width: 1200, height: 900 }
    }
  };
}

function createClock() {
  let current = 0;
  return {
    now: () => current,
    tick(ms) {
      current += ms;
      return current;
    }
  };
}
