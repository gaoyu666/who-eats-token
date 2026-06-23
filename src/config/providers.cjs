const PROVIDER_REGISTRY = [
  {
    id: "codex",
    name: "Codex",
    source: "codex-jsonl",
    description: "读取本机 Codex 会话日志里的实时额度窗口。",
    configurable: false,
    enabledByDefault: true
  },
  {
    id: "ingest",
    name: "本地接入 API",
    source: "http-ingest",
    description: "通过 http://127.0.0.1:17667/events 接收其他工具上报。",
    configurable: true,
    enabledByDefault: true
  },
  {
    id: "cursor",
    name: "Cursor",
    source: "adapter-ingest",
    description: "通过本地接入 API、IDE 插件或 wrapper 上报 Cursor 用量。",
    configurable: true,
    enabledByDefault: true
  },
  {
    id: "claude",
    name: "Claude",
    source: "adapter-ingest",
    description: "通过本地接入 API、CLI wrapper 或 importer 上报 Claude 用量。",
    configurable: true,
    enabledByDefault: true
  },
  {
    id: "gemini",
    name: "Gemini",
    source: "adapter-ingest",
    description: "通过本地接入 API、CLI wrapper 或 importer 上报 Gemini 用量。",
    configurable: true,
    enabledByDefault: true
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    source: "workbuddy-local",
    description: "读取本地 WorkBuddy 登录态并同步官方 billing 实时积分余额。",
    configurable: true,
    enabledByDefault: true
  },
  {
    id: "trae",
    name: "Trae",
    source: "adapter-ingest",
    description: "通过本地接入 API、MCP、wrapper 或 importer 上报 Trae 用量。",
    configurable: true,
    enabledByDefault: true
  },
  {
    id: "hermes",
    name: "Hermes",
    source: "hermes-local",
    description: "读取本地 Hermes 会话库里的用量和上下文；检测到 Xiaomi/MiMo 配置时可额外同步 Token Plan Credits。",
    configurable: true,
    enabledByDefault: true
  }
];

function buildDefaultProviderSettings() {
  return Object.fromEntries(
    PROVIDER_REGISTRY.map((provider) => [
      provider.id,
      {
        enabled: provider.enabledByDefault,
        name: provider.name,
        source: provider.source
      }
    ])
  );
}

function getProviderRegistry(settings) {
  return PROVIDER_REGISTRY.map((provider) => ({
    ...provider,
    enabled: settings?.providers?.[provider.id]?.enabled ?? provider.enabledByDefault
  }));
}

module.exports = {
  PROVIDER_REGISTRY,
  buildDefaultProviderSettings,
  getProviderRegistry
};
