import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createWhoEatsTokenClient } = require("../src/sdk/client.cjs");

const DEFAULT_SOURCE = "workbuddy-status";
const DEFAULT_PLAN_NAME = "WorkBuddy Credits";
const MIN_WATCH_DELAY_MS = 800;
const MAX_WATCH_DELAY_MS = 60_000;

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (options.watch && !options.file) {
    throw new Error("--watch requires --file.");
  }

  await postStatus(options);
  if (!options.watch) return;

  watchStatusFile(options);
}

async function postStatus(options) {
  const source = options.file ? readJsonFile(options.file) : {};
  const event = buildWorkBuddyEvent({
    ...source,
    ...options
  });
  const client = createWhoEatsTokenClient({
    endpoint: options.endpoint,
    token: options.token,
    timeoutMs: options.timeoutMs
  });
  const result = await client.postUsageEvent(event);
  if (options.json) {
    console.log(JSON.stringify({ ...result, event }, null, 2));
  } else {
    console.log(result.ok ? `WorkBuddy status posted: ${event.model}` : `WorkBuddy status skipped: ${result.error || result.status || "unknown"}`);
  }
  return result;
}

function watchStatusFile(options) {
  const filePath = path.resolve(options.file);
  let pending = null;
  const delayMs = clampInteger(options.watchDelayMs, MIN_WATCH_DELAY_MS, MAX_WATCH_DELAY_MS, 1200);

  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      postStatus(options).catch((error) => {
        console.error(`WorkBuddy status post failed: ${error.message}`);
      });
    }, delayMs);
  };

  fs.watch(filePath, { persistent: true }, schedule);
  console.log(`Watching WorkBuddy status file: ${filePath}`);
}

function buildWorkBuddyEvent(input = {}, now = new Date()) {
  const tokenPlan = buildTokenPlan(input, now);
  if (!tokenPlan) {
    throw new Error("WorkBuddy status requires credits fields such as remainingCredits, totalCredits, or remainingPercent.");
  }

  return {
    schema: "who-eats-token.usage.v1",
    timestamp: normalizeTimestamp(input.timestamp, now),
    provider: "workbuddy",
    tool: "WorkBuddy",
    model: optionalText(input.model || input.currentModel || input.current_model, 160) || "unknown",
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    confidence: "reported",
    token_accuracy: "official-usage",
    source: optionalText(input.source, 160) || DEFAULT_SOURCE,
    token_plan: tokenPlan,
    metadata: {
      adapter: DEFAULT_SOURCE
    }
  };
}

function buildTokenPlan(input, now = new Date()) {
  const plan = isObject(input.token_plan) ? input.token_plan : isObject(input.tokenPlan) ? input.tokenPlan : input;
  const totalCredits = numberOrZero(pick(plan, ["total_credits", "totalCredits", "creditLimit", "credit_limit", "limit"]));
  const usedCredits = numberOrZero(pick(plan, ["used_credits", "usedCredits", "creditUsed", "credit_used", "used"]));
  const remainingCredits = numberOrZero(pick(plan, ["remaining_credits", "remainingCredits", "creditRemaining", "credit_remaining", "remaining"]));
  const remainingPercent = numberOrNull(pick(plan, ["remaining_percent", "remainingPercent"]));
  const usedPercent = numberOrNull(pick(plan, ["used_percent", "usedPercent"]));

  if (totalCredits === 0 && usedCredits === 0 && remainingCredits === 0 && remainingPercent === null && usedPercent === null) {
    return null;
  }

  return {
    total_credits: totalCredits,
    used_credits: usedCredits,
    remaining_credits: remainingCredits,
    remaining_percent: remainingPercent,
    used_percent: usedPercent,
    recent_credits: numberOrZero(pick(plan, ["recent_credits", "recentCredits"])),
    source: optionalText(plan.source, 160) || DEFAULT_SOURCE,
    label: optionalText(plan.label, 160) || DEFAULT_PLAN_NAME,
    plan_name: optionalText(pick(plan, ["plan_name", "planName"]), 160) || DEFAULT_PLAN_NAME,
    valid_until: normalizeOptionalTimestamp(pick(plan, ["valid_until", "validUntil", "expires_at", "expiresAt"])),
    snapshot_at: normalizeTimestamp(pick(plan, ["snapshot_at", "snapshotAt", "updated_at", "updatedAt"]) || input.timestamp, now),
    status: optionalText(plan.status, 80) || "live",
    platform_status: optionalText(pick(plan, ["platform_status", "platformStatus"]) || plan.status, 80) || "live",
    reason: optionalText(plan.reason, 240)
  };
}

function parseArgs(argv) {
  const options = {
    timeoutMs: 1500,
    watchDelayMs: 1200,
    json: false,
    watch: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--file") options.file = argv[++index];
    else if (arg === "--endpoint") options.endpoint = argv[++index];
    else if (arg === "--token") options.token = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--watch-delay-ms") options.watchDelayMs = Number(argv[++index]);
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--remaining-credits") options.remainingCredits = Number(argv[++index]);
    else if (arg === "--total-credits") options.totalCredits = Number(argv[++index]);
    else if (arg === "--used-credits") options.usedCredits = Number(argv[++index]);
    else if (arg === "--remaining-percent") options.remainingPercent = Number(argv[++index]);
    else if (arg === "--used-percent") options.usedPercent = Number(argv[++index]);
    else if (arg === "--plan-name") options.planName = argv[++index];
    else if (arg === "--valid-until") options.validUntil = argv[++index];
    else if (arg === "--source") options.source = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run workbuddy:status -- --model hunyuan-t1 --remaining-credits 4200 --total-credits 5000
  npm run workbuddy:status -- --file .\\workbuddy-status.json --watch

The status file may contain model, remainingCredits, totalCredits, usedCredits,
remainingPercent, planName, validUntil, and tokenPlan/token_plan fields.`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function pick(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

function normalizeTimestamp(value, fallback = new Date()) {
  return normalizeOptionalTimestamp(value) || fallback.toISOString();
}

function normalizeOptionalTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export {
  buildTokenPlan,
  buildWorkBuddyEvent,
  parseArgs
};
