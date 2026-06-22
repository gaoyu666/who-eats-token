# 真机验收失败根因分析

## 问题概述

木木 3 月 16 日真机跑验收，结果 S1/S2/S5 异常，S7 未判过。mock 时钟单测 20/20 但 UI 不工作。

## 根因分析

### 根因 1：VS Code chip 不出现

**症状**：勾选 VS Code 后前台无 chip；VS Code/Cursor 切换无 foreground/background 区分。

**代码路径**：
1. 用户打开 VS Code → `getForegroundToolContext` 调用 `detectTool(activeWindow)`
2. `detectTool` (tool-detector.cjs:157) 遍历 `TOOL_RULES`，找第一个 `match` 的
3. VS Code 规则 (L104-111)：`processName === "code"` ✅ 或 `title` 含 Cline/Continue/Copilot/Roo/Aider

**问题**：`processName === "code"` 应该匹配。但需要确认：
- PowerShell `$process.ProcessName` 返回 `"code"`（不带 `.exe`），这个匹配是对的
- **但 `detectTool` 返回 null 说明 match 失败**

**可能原因**：
1. VS Code 窗口标题包含 AI 扩展名 → 应该能匹配 L110
2. VS Code 进程名不是 `"code"` → 可能是 `"code.exe"` 或别的（Windows 进程名采集差异）
3. `getForegroundToolContext` 过滤掉了检测到的工具（比如因为 fullscreen/overlay blocker）

**验证方法**：需要在 app 日志或 `/health` 查看 `activeWindow.processName` 的实际值。

### 根因 2：桌面顶部栏不出现 (S5)

**症状**：桌面模式（无工具激活）时，顶部状态栏不出现。

**代码路径**：
```
applyOverlayTransition(decision)
  → decision.mode === SURFACES.DESKTOP (line 991)
  → showDesktopBarForTransition(decision) (line 995)
    → if (!settings.windows.desktopBarEnabled || !shouldShowDesktopBar(activeWindow)) return; (line 1291)
```

`shouldShowDesktopBar`:
```
return !isOwnDesktopBar(activeWindow)
    && !hasDesktopForegroundBlocker(activeWindow)
    && isDesktopOverlayForeground(activeWindow);
```

`isDesktopOverlayForeground`:
```
return isDesktopForeground(activeWindow) || isDesktopShellTransientForeground(activeWindow);
```

**可能原因**：
1. **`hasDesktopForegroundBlocker` 返回 true** — 桌面有"前台阻挡窗口"，比如 Windows 搜索栏、任务栏拖拽、某些桌面工具（Everything 搜索框等）。这些窗口会让 `isDesktopForeground` 返回 false。
2. **`isOwnDesktopBar` 误判** — 状态栏自身的 hwnd 被当成了 active window（不太可能）
3. **`showDesktopBarForTransition` 的 `needsRestore` 逻辑** — `decision.transition?.changed` 为 false 时，如果窗口已经 visible，不会重复 show

### 根因 3：S7 WorkBuddy overlayCount=0, activeTool=null

**症状**：画面里有 WorkBuddy 额度 HUD，但 `/health` 显示 `overlayCount=0, activeTool=null`。

**分析**：
- `/health` 的 `overlayCount` 来自 `latestOverlayDecision` 的计数
- `activeTool=null` 说明 `detectTool` 没匹配到任何工具
- WorkBuddy 的 HUD 可能来自浏览器窗口（chatgpt rule 匹配）而非 WorkBuddy 本身
- 需要确认 WorkBuddy 的进程名和窗口标题

## 修复方案

### 修复 1：增加 VS Code 检测鲁棒性

在 `detectTool` 前加调试 log，把 `activeWindow.processName` 和 `activeWindow.title` 打印出来，让木木看到实际匹配情况。

### 修复 2：增加桌面栏显示的诊断

在 `showDesktopBarForTransition` 里加 debug log，输出：
- `desktopBarEnabled` 值
- `shouldShowDesktopBar` 为 false 时的具体原因

### 修复 3：增加 tool-detector 调试端点

加一个 `/debug/active-window` API，返回当前活跃窗口的完整信息，让木木可以确认 VS Code/Cursor 窗口的 processName/title。
