const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tokenBar", {
  getSnapshot: () => ipcRenderer.invoke("metrics:snapshot"),
  getHudSnapshot: () => ipcRenderer.invoke("hud:snapshot"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getLocalSetupInfo: () => ipcRenderer.invoke("setup:info"),
  openGuide: (guide) => ipcRenderer.invoke("guide:open", guide),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  previewSettings: (settings) => ipcRenderer.invoke("settings:preview", settings),
  resetSettings: () => ipcRenderer.invoke("settings:reset"),
  setDesktopBarMouseRegion: (interactive) => ipcRenderer.invoke("desktop-bar:mouse-region", Boolean(interactive)),
  setToolHudMouseRegion: (interactive) => ipcRenderer.invoke("hud:mouse-region", Boolean(interactive)),
  setToolHudHitboxMouseRegion: (interactive) => ipcRenderer.invoke("hud-hitbox:mouse-region", Boolean(interactive)),
  openSettings: (source) => ipcRenderer.invoke("settings:open", source),
  closeSettings: () => ipcRenderer.invoke("settings:close"),
  showHudTrustPopover: (payload) => ipcRenderer.invoke("hud-trust-popover:show", payload),
  hideHudTrustPopover: () => ipcRenderer.invoke("hud-trust-popover:hide"),
  resizeHudTrustPopover: (size) => ipcRenderer.invoke("hud-trust-popover:resize", size),
  toggleExpanded: () => ipcRenderer.invoke("window:toggle-expanded"),
  close: () => ipcRenderer.invoke("window:close"),
  scanAvailableTools: () => ipcRenderer.invoke("tools:scan"),
  getToolRegistry: () => ipcRenderer.invoke("tools:registry"),
  onToolRegistryUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("tool-registry:update", listener);
    return () => ipcRenderer.removeListener("tool-registry:update", listener);
  },
  onUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("metrics:update", listener);
    return () => ipcRenderer.removeListener("metrics:update", listener);
  },
  onSystemUpdate: (callback) => {
    const listener = (_event, system) => callback(system);
    ipcRenderer.on("system:update", listener);
    return () => ipcRenderer.removeListener("system:update", listener);
  },
  onHudUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("hud:update", listener);
    return () => ipcRenderer.removeListener("hud:update", listener);
  },
  onSettingsUpdate: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on("settings:update", listener);
    return () => ipcRenderer.removeListener("settings:update", listener);
  },
  onHudTrustPopoverUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("hud-trust-popover:update", listener);
    return () => ipcRenderer.removeListener("hud-trust-popover:update", listener);
  }
});
