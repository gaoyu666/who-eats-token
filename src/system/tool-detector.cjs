const BROWSER_PROCESSES = new Set([
  "arc",
  "brave",
  "brave browser",
  "browser",
  "chrome",
  "firefox",
  "google chrome",
  "microsoft edge",
  "msedge",
  "opera",
  "safari",
  "vivaldi"
]);
const TERMINAL_PROCESSES = new Set([
  "cmd",
  "iterm",
  "iterm2",
  "powershell",
  "pwsh",
  "terminal",
  "wezterm",
  "windowsterminal",
  "warp",
  "wt"
]);

const COMMON_DIALOG_CLASSES = new Set(["#32770"]);
const DIALOG_TITLE_PATTERN =
  /^(打开|保存|另存为|选择文件夹|选择文件|选择目录|浏览文件夹|Open|Save|Save As|Select Folder|Choose Folder|Choose File|Browse For Folder)$/i;
const CONTENT_OVERLAY_KEYWORD_PATTERN =
  /(消息队列|继续|还没好吗|还没好|没好|好了|重试|取消|发送|选择文件夹|选择文件|Message\s*Queue|\bQueue\b|\bContinue\b|Not\s*yet|Still\s*not|Retry|Cancel|Send|Choose\s*Folder|Choose\s*File)/i;
const ROOT_LAYOUT_PATTERN =
  /(^|\s|[-_])(app-main|main-layout|router-view|page-shell|app-shell|chat-view|app\s*main)(\s|[-_]|$)/i;

const TOOL_RULES = [
  {
    id: "codex",
    name: "Codex",
    providerIds: ["codex"],
    match: ({ processName, title }) =>
      processName === "codex" ||
      (TERMINAL_PROCESSES.has(processName) && terminalTitleMentionsTool(title, /\bcodex\b/i))
  },
  {
    id: "cursor",
    name: "Cursor",
    providerIds: ["cursor", "openai", "anthropic"],
    match: ({ processName, title }) =>
      processName === "cursor" || /\bcursor\b/i.test(title)
  },
  {
    id: "claude",
    name: "Claude",
    providerIds: ["anthropic", "claude"],
    match: ({ processName, title }) =>
      processName === "claude" ||
      titleMentionsTool(processName, title, /claude/i)
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    providerIds: ["openai", "chatgpt"],
    match: ({ processName, title }) =>
      /chatgpt/i.test(title) ||
      (BROWSER_PROCESSES.has(processName) && /\bopenai\b/i.test(title))
  },
  {
    id: "hermes-web-ui",
    name: "Hermes",
    providerIds: ["hermes"],
    match: ({ processName, title, path, url }) =>
      processName === "hermes-web-ui" ||
      (BROWSER_PROCESSES.has(processName) && isHermesBrowserWindow(title, path, url))
  },
  {
    id: "gemini",
    name: "Gemini",
    providerIds: ["gemini", "google"],
    match: ({ processName, title }) =>
      processName === "gemini" ||
      titleMentionsTool(processName, title, /gemini/i)
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    providerIds: ["deepseek"],
    match: ({ processName, title }) =>
      processName === "deepseek" || titleMentionsTool(processName, title, /deepseek/i)
  },
  {
    id: "qwen",
    name: "Qwen",
    providerIds: ["qwen", "dashscope", "aliyun"],
    match: ({ processName, title }) => titleMentionsTool(processName, title, /(qwen|通义|千问)/i)
  },
  {
    id: "doubao",
    name: "豆包",
    providerIds: ["doubao", "volcengine"],
    match: ({ processName, title }) => titleMentionsTool(processName, title, /(豆包|doubao)/i)
  },
  {
    id: "vscode-ai",
    name: "VS Code AI",
    providerIds: ["openai", "anthropic", "gemini"],
    match: ({ processName, title }) =>
      (processName === "code" || processName === "visual studio code") &&
      /(cline|continue|copilot|roo code|aider)/i.test(title)
  }
];

function titleMentionsTool(processName, title, pattern) {
  const text = String(title || "");
  if (!TERMINAL_PROCESSES.has(processName)) return pattern.test(text);
  return terminalTitleMentionsTool(text, pattern);
}

function terminalTitleMentionsTool(title, pattern) {
  const text = String(title || "").trim();
  if (!pattern.test(text)) return false;
  return !isPathLikeTerminalTitle(text);
}

function isPathLikeTerminalTitle(title) {
  const text = String(title || "")
    .trim()
    .replace(/^(administrator|管理员)\s*:\s*/i, "")
    .replace(/^(command prompt|cmd|windows powershell|powershell|pwsh)\s*[-:]\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();

  return /^[a-z]:[\\/]/i.test(text) ||
    /^\\\\/.test(text) ||
    /^~?[\\/]/.test(text);
}

function isHermesBrowserWindow(title, path, url) {
  const normalizedTitle = String(title || "").trim();
  const target = `${normalizedTitle} ${path || ""} ${url || ""}`;
  return /^hermes(?:\s+(?:web\s*ui|agent|chat))?(?:\s*-\s*(google chrome|microsoft edge|mozilla firefox|firefox|safari))?$/i.test(normalizedTitle) ||
    /(127\.0\.0\.1:8648|localhost:8648|\/hermes\/chat)/i.test(target);
}

function detectTool(activeWindow) {
  if (!activeWindow) return null;

  const input = {
    processName: String(activeWindow.processName || "").toLowerCase(),
    title: String(activeWindow.title || ""),
    path: String(activeWindow.path || ""),
    url: String(activeWindow.url || ""),
    className: String(activeWindow.className || "")
  };

  const rule = TOOL_RULES.find((candidate) => candidate.match(input));
  if (!rule) return null;

  return {
    id: rule.id,
    name: rule.name,
    providerIds: rule.providerIds,
    hud: rule.hud || null
  };
}

function shouldSuppressHud(activeWindow, hudBounds = null, anchorWindow = activeWindow) {
  if (!hudBounds) return false;
  return Boolean(getHudCoveringDialog(activeWindow, hudBounds, anchorWindow));
}

function getHudCoveringDialog(activeWindow, hudBounds, anchorWindow = activeWindow) {
  if (!activeWindow || !hudBounds) return null;
  const activeInfo = normalizeWindowInfo(activeWindow);
  const anchorInfo = normalizeWindowInfo(anchorWindow);
  const hudInfo = normalizeBounds(hudBounds);
  if (!hudInfo) return null;

  const blockers = Array.isArray(activeWindow.desktop?.blockers)
    ? activeWindow.desktop.blockers
    : [];
  const dialogCandidates = [activeWindow, ...blockers]
    .map(normalizeWindowInfo)
    .filter((windowInfo) => windowInfo.bounds && isDialogLikeWindow(windowInfo))
    .filter((windowInfo) => isRelevantDialog(activeInfo, anchorInfo, windowInfo));
  const overlayCandidates = getContentOverlayCandidates(activeWindow);
  const candidates = [...dialogCandidates, ...overlayCandidates];

  const hudWithMargin = expandBounds(hudInfo, 8);
  return candidates.find((windowInfo) => boundsOverlap(hudWithMargin, windowInfo.bounds)) || null;
}

function isDialogWindow(windowInfo) {
  return isDialogLikeWindow(normalizeWindowInfo(windowInfo));
}

function normalizeWindowInfo(windowInfo = {}) {
  windowInfo = windowInfo || {};
  return {
    hwnd: String(windowInfo.hwnd || ""),
    pid: Number(windowInfo.pid) || null,
    processName: String(windowInfo.processName || "").toLowerCase(),
    title: String(windowInfo.title || "").trim(),
    path: String(windowInfo.path || ""),
    className: String(windowInfo.className || "").trim(),
    bounds: normalizeBounds(windowInfo.bounds)
  };
}

function normalizeBounds(bounds = {}) {
  if (!bounds || typeof bounds !== "object") return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function getContentOverlayCandidates(activeWindow) {
  const overlays = Array.isArray(activeWindow.contentOverlays)
    ? activeWindow.contentOverlays
    : [];
  const rootBounds = normalizeBounds(activeWindow.bounds);
  return overlays
    .map((overlay) => ({
      hwnd: "",
      pid: null,
      processName: "",
      title: String(overlay.label || overlay.type || "content-overlay"),
      path: "",
      className: String(overlay.type || "content-overlay"),
      bounds: normalizeBounds(overlay.bounds || overlay)
    }))
    .filter((overlay) => overlay.bounds && isUsefulContentOverlay(overlay, rootBounds));
}

function isUsefulContentOverlay(overlay, rootBounds) {
  const label = `${overlay.title || ""} ${overlay.className || ""}`.trim();
  const bounds = overlay.bounds;
  if (!bounds) return false;
  if (!rootBounds) return true;

  const widthRatio = bounds.width / Math.max(1, rootBounds.width);
  const heightRatio = bounds.height / Math.max(1, rootBounds.height);
  const hasOverlayKeyword = CONTENT_OVERLAY_KEYWORD_PATTERN.test(label);

  if (ROOT_LAYOUT_PATTERN.test(label) && widthRatio >= 0.55 && heightRatio >= 0.55) {
    return false;
  }

  if (!hasOverlayKeyword && widthRatio >= 0.8 && heightRatio >= 0.8) {
    return false;
  }

  return true;
}

function isDialogLikeWindow(windowInfo) {
  if (COMMON_DIALOG_CLASSES.has(windowInfo.className)) return true;
  return DIALOG_TITLE_PATTERN.test(windowInfo.title);
}

function isRelevantDialog(activeInfo, anchorInfo, dialogInfo) {
  if (activeInfo.hwnd && dialogInfo.hwnd && activeInfo.hwnd === dialogInfo.hwnd) return true;
  if (isSameProcess(anchorInfo, dialogInfo)) return true;
  if (isSameProcess(activeInfo, dialogInfo)) return true;
  return boundsOverlap(anchorInfo.bounds, dialogInfo.bounds);
}

function isSameProcess(activeInfo, blockerInfo) {
  return Boolean(activeInfo.pid && blockerInfo.pid && activeInfo.pid === blockerInfo.pid);
}

function expandBounds(bounds, margin) {
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2
  };
}

function boundsOverlap(first, second) {
  if (!first || !second) return false;
  const firstRight = first.x + first.width;
  const firstBottom = first.y + first.height;
  const secondRight = second.x + second.width;
  const secondBottom = second.y + second.height;
  return firstRight > second.x && first.x < secondRight && firstBottom > second.y && first.y < secondBottom;
}

module.exports = {
  detectTool,
  getHudCoveringDialog,
  isDialogWindow,
  shouldSuppressHud,
  TOOL_RULES
};
