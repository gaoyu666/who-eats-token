# Performance Budget

Who Eats Token should stay boring in the background: visible enough to help, quiet enough not to steal the machine.

## Runtime Budgets

| Area | Budget | Reason |
| --- | --- | --- |
| Desktop snapshot/provider refresh | default `>= 15s`, minimum `>= 15s` | The desktop top bar follows the user's data refresh setting without allowing sub-15s provider polling. |
| Tool HUD steady snapshot refresh | `>= 5min` after foreground entry | Returning to a supported tool refreshes immediately, then avoids steady provider polling. |
| Overlay foreground coordinator | `200ms`, window-state only, no provider reads | Desktop/window switching needs near-immediate response without tightening quota collection. |
| System metrics | `>= 2s` | CPU/memory numbers are useful but not worth per-frame updates. |
| Browser extension DOM scan | event-driven, no `setInterval` | Avoid wakeups on every page while the user works. |
| Hermes Web UI overlay script | opt-in and event-driven, no `setInterval` | DOM scanning is the highest-risk lag source. |
| Debug HUD logs | off by default, cap `<= 1MB` | Debugging should not become a disk or memory leak. |
| Port retry (EADDRINUSE) | `10s` interval, `.unref()`, cleared on listen/close | Only fires when port is occupied; recovers automatically without manual restart. |
| Tool process scan | `30s`, only active when tracked tools exist, cleared on empty registry | Periodic liveness check for tracked tools; guarded by `toolRegistry.size === 0` check. |

`npm run adapter:guard` statically checks the browser and IDE adapter privacy/performance boundary: precise browser permissions, no prompt/completion scraping APIs, usage payload allowlists, short IDE timeouts, and no unbounded polling.

## Adapter Rules

- Adapters must fail quietly when the desktop app is closed.
- Browser adapters must avoid `<all_urls>` and use precise host permissions.
- SDK wrappers must use short timeouts and must not block model calls.
- Provider billing/API polling must respect provider cache windows.
- Restart watchdogs must not restart external services every minute.

## Packaged Idle Soak

Run a repeatable idle soak from an unpacked package:

```powershell
npm run package:dir
npm run soak:packaged-win
```

macOS:

```sh
npm run package:dir
npm run soak:packaged-mac
```

By default the soak samples for 10 minutes. For quick local checks, lower the duration:

```powershell
$env:WHO_EATS_TOKEN_SOAK_DURATION_MS = "30000"
$env:WHO_EATS_TOKEN_SOAK_INTERVAL_MS = "2000"
npm run soak:packaged-win
```

Budgets:

- `WHO_EATS_TOKEN_SOAK_MAX_RSS_MB`, default `450`
- `WHO_EATS_TOKEN_SOAK_MAX_GROWTH_MB`, default `80`
- `WHO_EATS_TOKEN_SOAK_MAX_CPU_PERCENT`, default `35`

The soak uses isolated temp user data, checks `/health`, samples process memory/CPU, confirms debug HUD logs stay off, and verifies the local API closes after exit.

`npm run release:check` validates the soak script wiring with `npm run test:soak-script`; it does not run the full 10-minute soak. Release candidates should still run the packaged soak on each target OS.

## Manual Performance Smoke

For a release candidate, test the app with:

1. Desktop visible for 10 minutes.
2. Codex or Hermes active for 10 minutes.
3. Browser extension loaded in Chrome/Edge for 10 minutes.
4. Debug HUD disabled.

Record:

- app RSS before/after
- CPU spikes over 5 seconds
- foreground switch latency
- whether HUD appears/disappears without blank loading

The automated gate is intentionally conservative and static; it catches the easy regressions before manual profiling.

Before deeper profiling, run:

```powershell
npm run diagnostics -- -- --json
npm run stability -- -- --json
npm run lag:triage -- -- --json
npm run support:bundle -- -- --json
npm run performance:summary
npm run performance:summary -- -- --json
npm run delight:contract -- -- --check
```

The diagnostics bundle, stability report, lag triage, support bundle, performance summary, and delight contract are one-shot diagnostics. They record CPU, memory, app RSS, provider health, active overlay hints, low-memory configuration warnings, static polling risk, dependency weight, adapter review health, recorded soak evidence, and lightweight interaction budget without adding a background sampler.

## One-shot Performance Summary

`npm run performance:summary` is the maintainer-friendly lightweight report for "is this getting heavy again?" checks. It aggregates:

- package weight from `package.json` and `package-lock.json`
- reviewed runtime timers and unreviewed `setInterval` risk
- adapter privacy/performance review results from `npm run adapter:review`
- packaged smoke/soak RSS and CPU budgets
- recorded Windows/macOS soak evidence from `docs/release-evidence.json`

It is read-only and does not launch Electron, attach to browsers, or scan real pages:

```powershell
npm run performance:summary
npm run performance:summary -- -- --json
npm run test:performance-summary
```

## HUD Stability Gate

`npm run test:hud-stability` covers the high-risk regressions that previously made the app feel unpredictable:

- active Codex windows must render Codex quota instead of falling back to Hermes
- active Hermes windows must render Token Plan data and keep the `bottomOffset: 115` placement
- unrelated browser tabs must not trigger the Hermes HUD
- content overlays only hide or move the HUD when they overlap the HUD rectangle
- mini charts and warning pills must be driven by the same remaining quota values shown as text
- switching to desktop, shell popups, or unsupported foreground windows uses the unified 200ms overlay coordinator to retire stale HUDs; it must stay window-state-only and must not add a provider polling loop
- the desktop top bar requires the real desktop foreground; desktop blockers are diagnostic only under the positive desktop-state model, while shell/tray previews remain explicit non-desktop foregrounds
- terminal window titles that are only filesystem paths must not be treated as Codex/Claude/Gemini sessions
