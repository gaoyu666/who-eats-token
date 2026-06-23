"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOOL_RULES } = require("./tool-detector.cjs");

/**
 * File-system probes for locally installed tools.
 * Browser/adapter-based tools (chatgpt, gemini, hermes-web-ui, workbuddy, trae,
 * deepseek, qwen, doubao)
 * are always available since they only need a browser.
 * Desktop tools are detected by checking known install/session paths.
 */
const INSTALL_PROBES = {
  codex: () => fs.existsSync(path.join(os.homedir(), ".codex", "sessions")),
  cursor: () => {
    const local = path.join(os.homedir(), "AppData", "Local", "Programs", "cursor");
    const roaming = path.join(os.homedir(), "AppData", "Roaming", "Cursor");
    return fs.existsSync(local) || fs.existsSync(roaming);
  },
  claude: () => fs.existsSync(path.join(os.homedir(), "AppData", "Roaming", "Claude")),
  chatgpt: () => true,
  "hermes-web-ui": () => true,
  workbuddy: () => true,
  gemini: () => true,
  deepseek: () => true,
  trae: () => true,
  qwen: () => true,
  doubao: () => true,
  "vscode-ai": () => {
    // VS Code is always "available" — the AI plugin check is informational only.
    // Plain VS Code matches via processName === "code" in tool-detector.cjs.
    const codeDir = path.join(os.homedir(), "AppData", "Local", "Programs", "Microsoft VS Code");
    if (fs.existsSync(codeDir)) return true;
    const extDir = path.join(os.homedir(), ".vscode", "extensions");
    if (!fs.existsSync(extDir)) return false;
    try {
      return fs.readdirSync(extDir).some((name) =>
        /^(cline|continue\.continue|github\.copilot|rooveterinaryinc\.roo-cline|aider)/i.test(name)
      );
    } catch {
      return false;
    }
  }
};

function scanAvailableTools() {
  return TOOL_RULES.map((rule) => ({
    id: rule.id,
    name: rule.name,
    providerIds: rule.providerIds,
    available: (INSTALL_PROBES[rule.id] || (() => false))()
  }));
}

module.exports = { scanAvailableTools };
