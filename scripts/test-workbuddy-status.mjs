import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildWorkBuddyEvent, parseArgs } from "./workbuddy-status.mjs";

const require = createRequire(import.meta.url);
const { normalizeUsageEvent } = require("../src/protocol/usage-event.cjs");

const event = buildWorkBuddyEvent({
  model: "hunyuan-t1",
  remainingCredits: 4200,
  totalCredits: 5000,
  planName: "WorkBuddy Pro",
  validUntil: "2026-07-01T00:00:00+08:00"
}, new Date("2026-06-07T00:00:00.000Z"));

assert.equal(event.provider, "workbuddy");
assert.equal(event.tool, "WorkBuddy");
assert.equal(event.model, "hunyuan-t1");
assert.equal(event.token_plan.remaining_credits, 4200);
assert.equal(event.token_plan.total_credits, 5000);
assert.equal(event.token_plan.plan_name, "WorkBuddy Pro");

const normalized = normalizeUsageEvent(event, new Date("2026-06-07T00:00:00.000Z"));
assert.equal(normalized.inputTokens, 0);
assert.equal(normalized.outputTokens, 0);
assert.equal(normalized.tokenPlan.remainingPercent, 84);
assert.equal(normalized.tokenPlan.remainingCredits, 4200);
assert.equal(normalized.tokenPlan.totalCredits, 5000);
assert.equal(normalized.tokenPlan.planName, "WorkBuddy Pro");
assert.equal(normalized.tokenPlan.platformStatus, "live");

const percentOnly = normalizeUsageEvent(buildWorkBuddyEvent({
  current_model: "hunyuan-lite",
  remainingPercent: 55
}));
assert.equal(percentOnly.model, "hunyuan-lite");
assert.equal(percentOnly.tokenPlan.remainingPercent, 55);

assert.deepEqual(
  parseArgs(["--model", "m", "--remaining-credits", "1", "--total-credits", "2", "--json"]),
  {
    timeoutMs: 1500,
    watchDelayMs: 1200,
    json: true,
    watch: false,
    help: false,
    model: "m",
    remainingCredits: 1,
    totalCredits: 2
  }
);

console.log("WorkBuddy status adapter checks passed.");
