import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(read("package.json"));
const builderConfig = read("electron-builder.yml");
const ciWorkflow = read(".github/workflows/ci.yml");
const releaseWorkflow = read(".github/workflows/release-artifacts.yml");
const gitignore = read(".gitignore");
const packagedSmoke = read("scripts/lib/packaged-smoke.mjs");
const appIconIco = fs.statSync(path.join(root, "src", "assets", "app-icon.ico"));
const appIconPng = fs.statSync(path.join(root, "src", "assets", "app-icon-mascot-a.png"));

assert.ok(packageJson.devDependencies?.["electron-builder"], "electron-builder must be a devDependency.");
assert.equal(packageJson.private, false, "package.json must stay publishable/private=false.");
assert.ok(packageJson.author, "package.json should declare an author/contributor owner for release metadata.");
assertScript("package:dir");
assertScript("dist");
assertScript("dist:win");
assertScript("dist:mac");
assertScript("test:packaging");
assertScript("signing:readiness");
assertScript("test:signing-readiness");
assertScript("smoke:packaged-mac");
assertScript("smoke:packaged-win");

assertContains(builderConfig, "appId: dev.whoeatstoken.app");
assertContains(builderConfig, "productName: Who Eats Token");
assertContains(builderConfig, "asar: true");
assertContains(builderConfig, "publish: null");
assertContains(builderConfig, "target: nsis");
assertContains(builderConfig, "target: dmg");
assertContains(builderConfig, "identity: null");
assertContains(builderConfig, "src/assets/app-icon.ico");
assertContains(builderConfig, "src/assets/app-icon-mascot-a.png");
assertContains(builderConfig, "src/**/*");
assertContains(builderConfig, "output: release");
assertContains(packageJson.scripts["package:dir"], "signAndEditExecutable=false");
assert.ok(appIconIco.size > 1000, "Windows app icon must not be a tiny tray icon.");
assert.ok(appIconPng.size > 1000, "macOS app icon source must not be a tiny tray icon.");

assertContains(ciWorkflow, "npm run release:check");
assertContains(releaseWorkflow, "workflow_dispatch");
assertContains(releaseWorkflow, "npm run package:dir");
assertContains(releaseWorkflow, "npm run signing:readiness");
assertContains(releaseWorkflow, "npm run smoke:packaged-win");
assertContains(releaseWorkflow, "npm run smoke:packaged-mac");
assertContains(releaseWorkflow, "actions/upload-artifact");
assertContains(releaseWorkflow, "windows-2025-vs2026");
assertContains(releaseWorkflow, "macos-latest");

assertContains(gitignore, "release/");
assertContains(gitignore, "*.dmg");
assertContains(gitignore, "*.exe");
assert.ok(fs.existsSync(path.join(root, "docs", "release.md")), "docs/release.md is required.");
assert.ok(fs.existsSync(path.join(root, "docs", "manual-validation.md")), "manual validation checklist is required.");
assert.ok(fs.existsSync(path.join(root, ".github", "ISSUE_TEMPLATE", "bug_report.yml")), "Bug report template is required.");
assert.ok(fs.existsSync(path.join(root, ".github", "ISSUE_TEMPLATE", "performance_report.yml")), "Performance report template is required.");
assert.ok(fs.existsSync(path.join(root, ".github", "ISSUE_TEMPLATE", "adapter_request.yml")), "Adapter request template is required.");
assert.ok(fs.existsSync(path.join(root, ".github", "PULL_REQUEST_TEMPLATE.md")), "Pull request template is required.");
assert.ok(fs.existsSync(path.join(root, "scripts", "smoke-packaged-mac.mjs")), "macOS packaged smoke script is required.");
assert.ok(fs.existsSync(path.join(root, "scripts", "smoke-packaged-win.mjs")), "Windows packaged smoke script is required.");
assertContains(packagedSmoke, "expectBrowserAuthRejection");
assertContains(packagedSmoke, "/health");
assertContains(packagedSmoke, "/overlays");
assertContains(packagedSmoke, "hud-debug.ndjson");
assertContains(packagedSmoke, "WHO_EATS_TOKEN_SMOKE_MAX_RSS_MB");
assertContains(packagedSmoke, "waitForPortClosed");

console.log("Packaging checks passed.");

function assertScript(name) {
  assert.ok(packageJson.scripts?.[name], `Missing package script: ${name}`);
}

function assertContains(text, needle) {
  assert.ok(text.includes(needle), `Expected to find "${needle}".`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
