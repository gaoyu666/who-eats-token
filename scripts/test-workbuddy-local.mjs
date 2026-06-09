import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const {
  collectWorkBuddyUsage,
  getAuthFileCandidates,
  normalizeEnterpriseUsageResponse,
  normalizePersonalUsageResponse,
  readCurrentWorkBuddyModelId,
  readLatestWorkBuddyModel,
  readWorkBuddySession,
  resetWorkBuddyUsageCache,
  setWorkBuddyRefreshHandler
} = require("../src/collectors/workbuddy-local.cjs");

await testLocalCollectorRefresh();
testSelectedModelDiscovery();
testSessionModelFallback();
testAuthFileDiscovery();
testUsageNormalizers();

console.log("WorkBuddy local collector checks passed.");

async function testLocalCollectorRefresh() {
  resetWorkBuddyUsageCache();
  const dir = makeTempDir();
  try {
    const localAppData = path.join(dir, "local-app-data");
    const authDir = path.join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "workbuddy-desktop.info"), JSON.stringify({
      account: {
        uid: "fake-user",
        type: "personal"
      },
      auth: {
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        domain: "www.codebuddy.cn",
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    }, null, 2));

    const modelStorageDir = path.join(dir, ".workbuddy", "app", "session", "Local Storage", "leveldb");
    fs.mkdirSync(modelStorageDir, { recursive: true });
    fs.writeFileSync(path.join(modelStorageDir, "000001.log"), [
      "META:file:// cb-newtask:model:test-workspace {\"id\":\"minimax-m2.7\",\"isThinking\":true}",
      "META:file:// cb-newtask:model:test-workspace {\"id\":\"glm-5.1\",\"isThinking\":true}"
    ].join("\n"));

    const modelCatalogDir = path.join(dir, ".workbuddy", "local_storage");
    fs.mkdirSync(modelCatalogDir, { recursive: true });
    fs.writeFileSync(path.join(modelCatalogDir, "entry_models.info"), JSON.stringify([
      {
        data: {
          models: [
            { id: "glm-5.1", name: "GLM-5.1" },
            { id: "minimax-m2.7", name: "MiniMax-M2.7" }
          ]
        }
      }
    ]));

    const dbPath = path.join(dir, "workbuddy.db");
    withDatabase(dbPath, (db) => {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          model TEXT,
          deleted_at INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          last_activity_at INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO sessions (id, model, deleted_at, created_at, updated_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("session-1", "ark-code-latest", null, 1, 2, 3);
    });

    let requestedPath = null;
    let requestCount = 0;
    const fetchImpl = async (url, init) => {
      requestCount += 1;
      requestedPath = new URL(url).pathname;
      assert.equal(init.headers.Authorization, "Bearer fake-access-token");
      assert.equal(init.headers["X-User-Id"], "fake-user");
      assert.equal(JSON.parse(init.body).ProductCode, "p_tcaca");
      return new Response(JSON.stringify(makePersonalUsageBody()), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const refreshed = new Promise((resolve) => setWorkBuddyRefreshHandler(resolve));
    const first = collectWorkBuddyUsage({
      localAppData,
      dbPath,
      userProfile: dir,
      modelStorageDir,
      modelCatalogDir,
      fetchImpl,
      now: new Date("2026-06-07T00:00:00.000Z")
    });
    assert.equal(first.id, "workbuddy");
    assert.equal(first.sourceId, "workbuddy-local");
    assert.equal(first.latest.model, "GLM-5.1");
    assert.equal(first.latest.tokenPlan.platformStatus, "refreshing");

    await refreshed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requestedPath, "/v2/billing/meter/get-user-resource");

    const second = collectWorkBuddyUsage({
      localAppData,
      dbPath,
      userProfile: dir,
      modelStorageDir,
      modelCatalogDir,
      fetchImpl,
      now: new Date("2026-06-07T00:00:01.000Z")
    });
    assert.equal(second.status, "live");
    assert.equal(second.confidence, "reported");
    assert.equal(second.latest.tokenPlan.remainingCredits, 3450);
    assert.equal(second.latest.tokenPlan.totalCredits, 9950);
    assert.equal(second.latest.tokenPlan.remainingPercent, 35);
    assert.equal(second.latest.tokenPlan.source, "workbuddy-official-billing");
    assert.equal(second.tokenAccuracy.level, "official-usage");
    assert.equal(second.latest.model, "GLM-5.1");
    assert.equal(requestCount, 1, "Default collector calls should reuse the fresh billing cache.");

    const quickRefreshed = new Promise((resolve) => setWorkBuddyRefreshHandler(resolve));
    const quick = collectWorkBuddyUsage({
      localAppData,
      dbPath,
      userProfile: dir,
      modelStorageDir,
      modelCatalogDir,
      fetchImpl,
      refreshMinMs: 1,
      cacheStaleMs: 10_000,
      clockMs: Date.now() + 2000,
      now: new Date("2026-06-07T00:00:02.000Z")
    });
    assert.equal(quick.status, "live", "Visible WorkBuddy HUD refreshes should keep showing cached credits while revalidating.");
    await quickRefreshed;
    assert.equal(requestCount, 2, "Visible WorkBuddy HUD refreshes should be able to bypass the default 30s billing throttle.");
  } finally {
    resetWorkBuddyUsageCache();
    removeTempDir(dir);
  }
}

function testSelectedModelDiscovery() {
  const dir = makeTempDir();
  try {
    const modelStorageDir = path.join(dir, "leveldb");
    const modelCatalogDir = path.join(dir, "local_storage");
    fs.mkdirSync(modelStorageDir, { recursive: true });
    fs.mkdirSync(modelCatalogDir, { recursive: true });
    fs.writeFileSync(path.join(modelStorageDir, "000007.log"), [
      "cb-newtask:model:workspace-a {\"id\":\"ark-code-latest\",\"isThinking\":true}",
      "cb-newtask:model:workspace-a {\"id\":\"glm-5.1\",\"isThinking\":true}"
    ].join("\n"));
    fs.writeFileSync(path.join(modelCatalogDir, "entry_models.info"), JSON.stringify([
      { data: { models: [{ id: "glm-5.1", name: "GLM-5.1" }] } }
    ]));

    assert.equal(readCurrentWorkBuddyModelId({ modelStorageDir, userProfile: dir }), "glm-5.1");
    assert.equal(readLatestWorkBuddyModel({ modelStorageDir, modelCatalogDir, userProfile: dir }), "GLM-5.1");
  } finally {
    removeTempDir(dir);
  }
}

function testSessionModelFallback() {
  const dir = makeTempDir();
  try {
    const dbPath = path.join(dir, "workbuddy.db");
    withDatabase(dbPath, (db) => {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          model TEXT,
          deleted_at INTEGER,
          created_at INTEGER,
          updated_at INTEGER,
          last_activity_at INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO sessions (id, model, deleted_at, created_at, updated_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("session-1", "ark-code-latest", null, 1, 2, 3);
    });

    assert.equal(readLatestWorkBuddyModel({ dbPath, userProfile: dir }), "ark-code-latest");
  } finally {
    removeTempDir(dir);
  }
}

function testAuthFileDiscovery() {
  const dir = makeTempDir();
  try {
    const localAppData = path.join(dir, "local-app-data");
    const authDir = path.join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth");
    fs.mkdirSync(authDir, { recursive: true });
    const backup = path.join(authDir, "workbuddy-desktop.2026-01-01.info");
    const current = path.join(authDir, "workbuddy-desktop.info");
    fs.writeFileSync(backup, JSON.stringify({ auth: {}, account: {} }));
    fs.writeFileSync(current, JSON.stringify({
      auth: { accessToken: "fake-token" },
      account: { uid: "fake-user" }
    }));

    const candidates = getAuthFileCandidates({ localAppData });
    assert.equal(candidates[0], current);
    const session = readWorkBuddySession({ localAppData });
    assert.equal(session.file, current);
    assert.equal(session.session.account.uid, "fake-user");
  } finally {
    removeTempDir(dir);
  }
}

function testUsageNormalizers() {
  const personal = normalizePersonalUsageResponse(makePersonalUsageBody(), new Date("2026-06-07T00:00:00.000Z"));
  assert.equal(personal.remainingCredits, 3450);
  assert.equal(personal.usedCredits, 6500);
  assert.equal(personal.totalCredits, 9950);
  assert.equal(personal.remainingPercent, 35);
  assert.equal(personal.platformStatus, "live");

  const enterprise = normalizeEnterpriseUsageResponse({
    data: {
      data: {
        limitNum: 10000,
        credit: 2500,
        cycleResetTime: "2026-07-01T00:00:00+08:00"
      }
    }
  }, { account: { type: "ultimate", enterpriseId: "enterprise" } }, new Date("2026-06-07T00:00:00.000Z"));
  assert.equal(enterprise.remainingCredits, 7500);
  assert.equal(enterprise.remainingPercent, 75);
  assert.equal(enterprise.refreshAt, "2026-06-30T16:00:00.000Z");
}

function makePersonalUsageBody() {
  return {
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            {
              PackageCode: "TCACA_code_002_AkiJS3ZHF5",
              CycleCapacitySizePrecise: "5000",
              CycleCapacityRemainPrecise: "0",
              CycleEndTime: "2026-07-01T00:00:00+08:00",
              DeductionEndTime: "2026-07-01T00:00:00+08:00",
              Status: 3
            },
            {
              PackageCode: "TCACA_code_006_DbXS0lrypC",
              CycleCapacitySizePrecise: "4450",
              CycleCapacityRemainPrecise: "2950",
              CycleEndTime: "2026-07-01T00:00:00+08:00",
              DeductionEndTime: "2026-07-01T00:00:00+08:00",
              Status: 0
            },
            {
              PackageCode: "TCACA_code_001_PqouKr6QWV",
              CycleCapacitySizePrecise: "500",
              CycleCapacityRemainPrecise: "500",
              CycleEndTime: "2026-06-08T00:00:00+08:00",
              DeductionEndTime: "2026-06-08T00:00:00+08:00",
              Status: 0
            }
          ]
        }
      }
    }
  };
}

function withDatabase(dbPath, setup) {
  const db = new DatabaseSync(dbPath);
  try {
    setup(db);
  } finally {
    db.close();
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "who-eats-token-workbuddy-"));
}

function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
