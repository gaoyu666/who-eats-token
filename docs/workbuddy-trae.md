# WorkBuddy And Trae Adapters

WorkBuddy and Trae are exposed as configurable providers in the settings panel.

## WorkBuddy

WorkBuddy uses `workbuddy-local` by default. When the provider is enabled, the desktop app reads the local WorkBuddy auth session, calls WorkBuddy's official billing API, and exposes only the current model plus credit balance in the snapshot/HUD. Auth tokens stay local and are never posted to `/events` or rendered in the UI.

`workbuddy:status` remains available as an explicit fallback for hosts where the local auth file or billing API is unavailable. It is meant for current model and credit balance only; do not send prompts, completions, API keys, cookies, workspace paths, or source files.

One-shot report:

```powershell
npm run workbuddy:status -- -- --model hunyuan-t1 --remaining-credits 4200 --total-credits 5000
```

Watch a local status file for near-real-time updates:

```powershell
npm run workbuddy:status -- -- --file .\workbuddy-status.json --watch
```

Example status file:

```json
{
  "model": "hunyuan-t1",
  "remainingCredits": 4200,
  "totalCredits": 5000,
  "planName": "WorkBuddy Credits",
  "validUntil": "2026-07-01T00:00:00+08:00"
}
```

The script posts a `who-eats-token.usage.v1` event with `provider: "workbuddy"`, the current `model`, and a `token_plan` credits object. Who Eats Token then merges it with the local collector as token-plan health/HUD data.

## Trae

Trae is registered as an `adapter-ingest` provider. It can be enabled in settings, but usage appears only after a wrapper, MCP client, browser extension, local gateway, or import script explicitly posts `/events` with `provider: "trae"` or a model provider that Trae is using.

The desktop app does not intercept Trae private AI requests or read workspace source files.
