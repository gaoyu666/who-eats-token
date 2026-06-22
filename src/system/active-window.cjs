const { execFile } = require("node:child_process");

let nativeWindowApiPromise = null;

const POWERSHELL_SCRIPT = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$config = ConvertFrom-Json @'
__CONFIG_JSON__
'@
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ForegroundReader {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

function Get-TextValue([IntPtr]$window) {
  $text = New-Object System.Text.StringBuilder 1024
  [ForegroundReader]::GetWindowText($window, $text, $text.Capacity) | Out-Null
  return $text.ToString()
}

function Get-ClassValue([IntPtr]$window) {
  $class = New-Object System.Text.StringBuilder 256
  [ForegroundReader]::GetClassName($window, $class, $class.Capacity) | Out-Null
  return $class.ToString()
}

function Get-ProcessValue([int]$processId) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $path = ""
  try {
    if ($process -and $process.Path) { $path = $process.Path }
  } catch {}
  return [pscustomobject]@{
    processName = if ($process) { $process.ProcessName } else { "" }
    path = $path
  }
}

function Get-WindowPayload([IntPtr]$window) {
  $processId = 0
  [ForegroundReader]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
  $process = Get-ProcessValue $processId
  $rect = New-Object ForegroundReader+RECT
  [ForegroundReader]::GetWindowRect($window, [ref]$rect) | Out-Null
  return [pscustomobject]@{
    hwnd = $window.ToInt64()
    pid = $processId
    processName = $process.processName
    path = $process.path
    title = Get-TextValue $window
    className = Get-ClassValue $window
    bounds = @{
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    }
  }
}

function Test-Cloaked([IntPtr]$window) {
  $cloaked = 0
  try {
    [ForegroundReader]::DwmGetWindowAttribute($window, 14, [ref]$cloaked, 4) | Out-Null
  } catch {
    $cloaked = 0
  }
  return $cloaked -ne 0
}

function Test-OffscreenTinyHelperBounds($bounds) {
  if (-not $bounds) { return $false }
  $x = [double]$bounds.x
  $y = [double]$bounds.y
  $width = [double]$bounds.width
  $height = [double]$bounds.height
  if ($width -le 0 -or $height -le 0) { return $false }
  if ($width -gt 64 -or $height -gt 64) { return $false }
  return $x -le -30000 -or $y -le -30000
}

function Test-WindowsDesktopAssistantForeground($windowInfo) {
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  $className = [string]$windowInfo.className
  $classNameLower = $className.ToLowerInvariant()
  $title = ([string]$windowInfo.title).Trim().ToLowerInvariant()
  $path = ([string]$windowInfo.path).ToLowerInvariant()

  $isExplorer = $processName -eq "explorer" -or
    $path.EndsWith("\\explorer.exe") -or
    $path.EndsWith("/explorer.exe")
  if ($isExplorer -and ($title -eq "host popup window" -or $title -eq "主机弹出窗口")) {
    $bounds = $windowInfo.bounds
    return $bounds -and [double]$bounds.width -le 1 -and [double]$bounds.height -le 1
  }

  $isClickToDo = $processName -eq "clicktodo" -or
    $processName -eq "clicktodo.exe" -or
    (($path.Contains("\\microsoftwindows.client.coreai_") -or $path.Contains("/microsoftwindows.client.coreai_")) -and
      ($path.EndsWith("\\clicktodo.exe") -or $path.EndsWith("/clicktodo.exe")))
  if ($isClickToDo) {
    return $title -eq "click to do" -or $title -eq "单击以执行"
  }

  $isSvchost = $processName -eq "svchost" -or
    $path.EndsWith("\\svchost.exe") -or
    $path.EndsWith("/svchost.exe")
  if (-not $isSvchost) { return $false }
  if (-not [string]::IsNullOrWhiteSpace($title)) { return $false }
  if ($classNameLower -eq "narratorhelperwindow") {
    return Test-OffscreenTinyHelperBounds $windowInfo.bounds
  }
  if ([string]::IsNullOrWhiteSpace($className)) {
    return Test-OffscreenTinyHelperBounds $windowInfo.bounds
  }
  return $false
}

function Test-ZeroSizedUntitledDesktopHelperForeground($windowInfo) {
  $title = ([string]$windowInfo.title).Trim()
  if (-not [string]::IsNullOrWhiteSpace($title)) { return $false }
  $bounds = $windowInfo.bounds
  if (-not $bounds) { return $false }
  return [double]$bounds.width -le 0 -or [double]$bounds.height -le 0
}

function Test-OffscreenSmallDesktopHelperForeground($windowInfo) {
  $bounds = $windowInfo.bounds
  if (-not $bounds) { return $false }
  $width = [double]$bounds.width
  $height = [double]$bounds.height
  if ($width -le 0 -or $height -le 0) { return $false }
  if ($width -gt 360 -or $height -gt 180) { return $false }
  return [double]$bounds.x -le -10000 -or [double]$bounds.y -le -10000
}

function Test-ShellOrOverlayWindow($windowInfo) {
  $processName = [string]$windowInfo.processName
  $className = [string]$windowInfo.className
  $title = [string]$windowInfo.title

  if ($script:ignoredHwnds.ContainsKey([string]$windowInfo.hwnd)) { return $true }
  if (Test-ExplorerShellFloatingWindow $windowInfo) { return $true }
  if (@("Progman", "WorkerW", "#32768", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "DV2ControlHost", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "Xaml_Hosting_WindowedPopupClass", "TaskListThumbnailWnd", "TaskSwitcherWnd", "MSTaskListWClass") -contains $className) { return $true }
  if ($processName -eq "electron" -and $title -eq "LLM HUD Controls") { return $true }
  if ($processName -eq "electron" -and @("谁在吃 token", "LLM HUD", "数据可信度", "谁在吃 token 设置") -contains $title) { return $true }
  if (Test-WindowsDesktopAssistantForeground $windowInfo) { return $true }
  if (Test-ExternalDesktopOverlayWindow $windowInfo) { return $true }
  if ($className -like "Windows.UI.Core.*" -and [string]::IsNullOrWhiteSpace($title)) { return $true }

  return $false
}

function Test-DesktopShellBaseWindow($windowInfo) {
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  $className = [string]$windowInfo.className
  $classNameLower = $className.ToLowerInvariant()
  $title = ([string]$windowInfo.title).Trim().ToLowerInvariant()
  $path = ([string]$windowInfo.path).ToLowerInvariant()
  $isExplorer = $processName -eq "explorer" -or $path.EndsWith("\explorer.exe") -or $path.EndsWith("/explorer.exe")
  if (-not $isExplorer) { return $false }

  $floatingShellClasses = @("#32768", "DV2ControlHost", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "Xaml_Hosting_WindowedPopupClass", "TaskListThumbnailWnd", "TaskSwitcherWnd", "MSTaskListWClass")
  if ($floatingShellClasses -contains $className) { return $false }
  if ([string]::IsNullOrWhiteSpace($title) -or $title -eq "program manager" -or $title -eq "desktop" -or $title -eq "桌面") {
    return [string]::IsNullOrWhiteSpace($className) -or $className -eq "Progman" -or $className -eq "WorkerW"
  }
  return $className -eq "Progman" -or $className -eq "WorkerW"
}

function Get-DesktopBasePayload() {
  $shellWindow = [ForegroundReader]::GetShellWindow()
  if ($shellWindow -eq [IntPtr]::Zero) { return $null }

  $windowInfo = Get-WindowPayload $shellWindow
  if (Test-DesktopShellBaseWindow $windowInfo) { return $windowInfo }
  return $null
}

function Test-ExplorerShellFloatingWindow($windowInfo) {
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  $className = [string]$windowInfo.className
  $title = ([string]$windowInfo.title).Trim().ToLowerInvariant()
  $path = ([string]$windowInfo.path).ToLowerInvariant()
  $isExplorer = $processName -eq "explorer" -or $path.EndsWith("\\explorer.exe") -or $path.EndsWith("/explorer.exe")
  if (-not $isExplorer) { return $false }

  if (@("Progman", "WorkerW", "#32768", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "DV2ControlHost", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "Xaml_Hosting_WindowedPopupClass", "TaskListThumbnailWnd", "TaskSwitcherWnd", "MSTaskListWClass") -contains $className) { return $true }
  if ([string]::IsNullOrWhiteSpace($title) -or $title -eq "program manager" -or $title -eq "desktop" -or $title -eq "桌面") { return $true }
  if (@("CabinetWClass", "ExploreWClass") -contains $className) { return $false }

  $bounds = $windowInfo.bounds
  if (-not $bounds) { return $false }
  return [double]$bounds.width -le 720 -and [double]$bounds.height -le 520
}

function Test-DesktopTopBarShellForeground($windowInfo) {
  if (Test-DesktopShellBaseWindow $windowInfo) { return $true }
  if (Test-WindowsDesktopAssistantForeground $windowInfo) { return $true }
  if (Test-ZeroSizedUntitledDesktopHelperForeground $windowInfo) { return $true }
  if (Test-OffscreenSmallDesktopHelperForeground $windowInfo) { return $true }

  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  $className = [string]$windowInfo.className
  $title = ([string]$windowInfo.title).Trim().ToLowerInvariant()
  $path = ([string]$windowInfo.path).ToLowerInvariant()
  $isExplorer = $processName -eq "explorer" -or $path.EndsWith("\\explorer.exe") -or $path.EndsWith("/explorer.exe")
  if (-not $isExplorer) { return $false }

  if (@("TaskListThumbnailWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "Xaml_Hosting_WindowedPopupClass", "TaskSwitcherWnd", "MSTaskListWClass") -contains $className) { return $false }
  if ($title -match "notifyicon|overflow|hidden icons|隐藏.*图标|通知区域|系统托盘") { return $false }
  if ($className -eq "#32768") { return $true }
  if (@("Shell_TrayWnd", "Shell_SecondaryTrayWnd", "DV2ControlHost") -contains $className) {
    return [string]::IsNullOrWhiteSpace($title)
  }

  $bounds = $windowInfo.bounds
  if (-not $bounds) { return $false }
  return [double]$bounds.width -le 720 -and [double]$bounds.height -le 520
}

function Test-FloatingDesktopOverlayBounds($bounds) {
  if (-not $bounds) { return $false }

  $width = [double]$bounds.width
  $height = [double]$bounds.height
  if ($width -le 0 -or $height -le 0) { return $false }
  if ($width -gt 760 -or $height -gt 760) { return $false }

  if (-not $script:desktopArea) {
    return $width -le 760 -and $height -le 760
  }
  $desktopWidth = [double]$script:desktopArea.width
  $desktopHeight = [double]$script:desktopArea.height
  if ($desktopWidth -le 0 -or $desktopHeight -le 0) {
    return $width -le 760 -and $height -le 760
  }

  if (-not (Test-IntersectsDesktopArea $bounds)) { return $false }

  $widthRatio = $width / $desktopWidth
  $heightRatio = $height / $desktopHeight
  $areaRatio = ($width * $height) / ($desktopWidth * $desktopHeight)
  if ($widthRatio -gt 0.62 -or $heightRatio -gt 0.72 -or $areaRatio -gt 0.22) { return $false }
  return $true
}

function Test-CodexDesktopOverlayCandidate($windowInfo) {
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  $title = ([string]$windowInfo.title).Trim().ToLowerInvariant()
  $path = ([string]$windowInfo.path).ToLowerInvariant()
  if (-not (
    $processName -eq "codex" -and
    ([string]::IsNullOrWhiteSpace($title) -or $title -eq "codex") -and
    ([string]::IsNullOrWhiteSpace($path) -or $path.Contains("\\openai.codex_") -or $path.EndsWith("\\codex.exe") -or $path.EndsWith("/codex.exe"))
  )) { return $false }
  return Test-FloatingDesktopOverlayBounds $windowInfo.bounds
}

function Test-ExternalDesktopOverlayWindow($windowInfo) {
  return Test-CodexDesktopOverlayCandidate $windowInfo
}

function Get-FallbackForegroundPayload() {
  $script:foregroundFallbackPayload = $null
  [ForegroundReader]::EnumWindows({
    param([IntPtr]$window, [IntPtr]$lParam)

    if (-not [ForegroundReader]::IsWindowVisible($window)) { return $true }
    if ([ForegroundReader]::IsIconic($window)) { return $true }
    if (Test-Cloaked $window) { return $true }

    $windowInfo = Get-WindowPayload $window
    if ($script:ignoredHwnds.ContainsKey([string]$windowInfo.hwnd)) { return $true }
    if ((Test-ShellOrOverlayWindow $windowInfo) -and -not (Test-DesktopShellBaseWindow $windowInfo)) { return $true }
    if (Test-ExternalDesktopOverlayWindow $windowInfo) { return $true }
    if ($windowInfo.bounds.width -le 0 -or $windowInfo.bounds.height -le 0) { return $true }

    $script:foregroundFallbackPayload = $windowInfo
    return $false
  }, [IntPtr]::Zero) | Out-Null

  return $script:foregroundFallbackPayload
}

function Get-PreferredDesktopBaseForIgnoredForeground() {
  if (-not $script:preferDesktopForIgnoredForeground) { return $null }
  return Get-DesktopBasePayload
}

function Test-HermesLikeWindow($windowInfo) {
  $processName = [string]$windowInfo.processName
  return $processName -eq "hermes-web-ui"
}

function Test-ContentOverlayWindow($windowInfo) {
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  if (Test-HermesLikeWindow $windowInfo) { return $true }
  return @("chrome", "msedge", "browser", "hermes-web-ui") -contains $processName
}

function Test-OverlayTriggerName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return $false }
  return $name -match "(消息队列|继续|还没好吗|还没好|没好|好了|重试|取消|发送|Message\s*Queue|\bQueue\b|\bContinue\b|Not\s*yet|Still\s*not|Retry|Cancel|Send)"
}

function Test-InteractiveTriggerName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return $false }
  return $name -match "(继续|结算|付款|授权|预检|确认|取消|重试|发送|1688|链接|Continue|Checkout|Pay|Authorize|Confirm|Cancel|Retry|Send)"
}

function Convert-UiaBounds($rect) {
  if ($null -eq $rect -or $rect.IsEmpty) { return $null }
  if ($rect.Width -le 1 -or $rect.Height -le 1) { return $null }
  return @{
    x = [int][Math]::Round($rect.Left)
    y = [int][Math]::Round($rect.Top)
    width = [int][Math]::Round($rect.Width)
    height = [int][Math]::Round($rect.Height)
  }
}

function Test-UsefulOverlayBounds($bounds, $rootBounds) {
  if (-not $bounds -or -not $rootBounds) { return $false }
  if ([double]$bounds.width -lt 240 -or [double]$bounds.height -lt 96) { return $false }
  if ([double]$bounds.width -gt ([double]$rootBounds.width * 0.95)) { return $false }
  if ([double]$bounds.height -gt ([double]$rootBounds.height * 0.85)) { return $false }
  return $true
}

function Expand-OverlayBounds($bounds, $rootBounds) {
  if (-not $bounds -or -not $rootBounds) { return $null }
  $left = [Math]::Max([double]$rootBounds.x, [double]$bounds.x - 220)
  $top = [Math]::Max([double]$rootBounds.y, [double]$bounds.y - 80)
  $right = [Math]::Min([double]$rootBounds.x + [double]$rootBounds.width, [double]$bounds.x + [double]$bounds.width + 420)
  $bottom = [Math]::Min([double]$rootBounds.y + [double]$rootBounds.height, [double]$bounds.y + [double]$bounds.height + 180)
  return @{
    x = [int][Math]::Round($left)
    y = [int][Math]::Round($top)
    width = [int][Math]::Round($right - $left)
    height = [int][Math]::Round($bottom - $top)
  }
}

function Expand-InteractiveBounds($bounds, $rootBounds) {
  if (-not $bounds -or -not $rootBounds) { return $null }
  $margin = 10
  $left = [Math]::Max([double]$rootBounds.x, [double]$bounds.x - $margin)
  $top = [Math]::Max([double]$rootBounds.y, [double]$bounds.y - $margin)
  $right = [Math]::Min([double]$rootBounds.x + [double]$rootBounds.width, [double]$bounds.x + [double]$bounds.width + $margin)
  $bottom = [Math]::Min([double]$rootBounds.y + [double]$rootBounds.height, [double]$bounds.y + [double]$bounds.height + $margin)
  return @{
    x = [int][Math]::Round($left)
    y = [int][Math]::Round($top)
    width = [int][Math]::Round($right - $left)
    height = [int][Math]::Round($bottom - $top)
  }
}

function Test-UsefulInteractiveBounds($bounds, $rootBounds) {
  if (-not $bounds -or -not $rootBounds) { return $false }
  if ([double]$bounds.width -lt 36 -or [double]$bounds.height -lt 24) { return $false }
  if ([double]$bounds.width -gt ([double]$rootBounds.width * 0.98) -and [double]$bounds.height -gt ([double]$rootBounds.height * 0.5)) { return $false }
  return $true
}

function Test-InteractiveElement($element, $rootBounds) {
  $controlType = [string]$element.Current.ControlType.ProgrammaticName
  $name = [string]$element.Current.Name
  $isInteractiveType = $controlType -match "ControlType\.(Button|Edit|ComboBox|Hyperlink|CheckBox|RadioButton|MenuItem|SplitButton)"
  if (-not $isInteractiveType) { return $false }
  $bounds = Convert-UiaBounds $element.Current.BoundingRectangle
  if (-not (Test-UsefulInteractiveBounds $bounds $rootBounds)) { return $false }
  if ($controlType -match "ControlType\.(Edit|ComboBox)") { return $true }
  return Test-InteractiveTriggerName $name
}

function Get-OverlayBoundsFromElement($element, $rootBounds) {
  $current = $element
  for ($i = 0; $i -lt 8 -and $null -ne $current; $i++) {
    $bounds = Convert-UiaBounds $current.Current.BoundingRectangle
    if (Test-UsefulOverlayBounds $bounds $rootBounds) { return $bounds }
    $current = $script:uiaWalker.GetParent($current)
  }

  $textBounds = Convert-UiaBounds $element.Current.BoundingRectangle
  return Expand-OverlayBounds $textBounds $rootBounds
}

function Add-OverlayHint($hints, $label, $bounds, $type = "content-overlay") {
  if (-not $bounds) { return }
  foreach ($hint in @($hints)) {
    if ([Math]::Abs([double]$hint.bounds.x - [double]$bounds.x) -lt 8 -and
        [Math]::Abs([double]$hint.bounds.y - [double]$bounds.y) -lt 8 -and
        [Math]::Abs([double]$hint.bounds.width - [double]$bounds.width) -lt 16 -and
        [Math]::Abs([double]$hint.bounds.height - [double]$bounds.height) -lt 16) {
      return
    }
  }

  $hints.Add([pscustomobject]@{
    type = $type
    label = $label
    bounds = $bounds
  }) | Out-Null
}

function Get-ContentOverlayHints([IntPtr]$window, $windowInfo) {
  $hints = New-Object System.Collections.Generic.List[object]
  if (-not (Test-ContentOverlayWindow $windowInfo)) { return @($hints) }
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  if (@("chrome", "msedge", "browser", "firefox") -contains $processName) {
    return @($hints)
  }

  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    if (-not $root) { return @($hints) }

    $script:uiaWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $rootBounds = Convert-UiaBounds $root.Current.BoundingRectangle
    if (-not $rootBounds) { return @($hints) }

    $script:overlayVisitCount = 0
    function Visit-OverlayElement($element, $depth) {
      if ($script:overlayVisitCount -ge 650 -or $null -eq $element -or $depth -gt 14) { return }
      $script:overlayVisitCount++

      $name = [string]$element.Current.Name
      if (Test-OverlayTriggerName $name) {
        Add-OverlayHint $hints $name (Get-OverlayBoundsFromElement $element $rootBounds)
      }
      if (Test-InteractiveElement $element $rootBounds) {
        $interactiveBounds = Convert-UiaBounds $element.Current.BoundingRectangle
        Add-OverlayHint $hints $name (Expand-InteractiveBounds $interactiveBounds $rootBounds) "content-interactive"
      }

      $child = $script:uiaWalker.GetFirstChild($element)
      while ($null -ne $child -and $script:overlayVisitCount -lt 650) {
        Visit-OverlayElement $child ($depth + 1)
        $child = $script:uiaWalker.GetNextSibling($child)
      }
    }

    Visit-OverlayElement $root 0
  } catch {}

  return @($hints | Select-Object -First 16)
}

function Test-IntersectsDesktopArea($bounds) {
  if (-not $script:desktopArea) { return $false }

  $left = [double]$script:desktopArea.x
  $top = [double]$script:desktopArea.y
  $right = $left + [double]$script:desktopArea.width
  $bottom = $top + [double]$script:desktopArea.height
  $windowLeft = [double]$bounds.x
  $windowTop = [double]$bounds.y
  $windowRight = $windowLeft + [double]$bounds.width
  $windowBottom = $windowTop + [double]$bounds.height

  return $windowRight -gt $left -and $windowLeft -lt $right -and $windowBottom -gt $top -and $windowTop -lt $bottom
}

function Test-NeedsBlockingWindowScan($windowInfo) {
  if (-not $script:desktopArea) { return $false }
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  if ($processName -eq "explorer") { return $true }
  if (Test-WindowsDesktopAssistantForeground $windowInfo) { return $true }
  if (Test-ZeroSizedUntitledDesktopHelperForeground $windowInfo) { return $true }
  if (Test-OffscreenSmallDesktopHelperForeground $windowInfo) { return $true }

  $bounds = $windowInfo.bounds
  if (-not $bounds) { return $false }
  $smallWidth = [double]$bounds.width -lt ([double]$script:desktopArea.width * 0.58)
  $smallHeight = [double]$bounds.height -lt ([double]$script:desktopArea.height * 0.58)
  return $smallWidth -and $smallHeight
}

$script:ignoredHwnds = @{}
foreach ($ignoredHwnd in @($config.ignoredHwnds)) {
  if ($null -ne $ignoredHwnd) { $script:ignoredHwnds[[string]$ignoredHwnd] = $true }
}
$script:desktopArea = $config.desktopArea
$script:preferDesktopForIgnoredForeground = [bool]$config.preferDesktopForIgnoredForeground
$script:blockingWindows = New-Object System.Collections.Generic.List[object]
$hwnd = [ForegroundReader]::GetForegroundWindow()
$payload = Get-WindowPayload $hwnd
$shouldUseForegroundFallback =
  $script:ignoredHwnds.ContainsKey([string]$payload.hwnd) -or
  (Test-ExternalDesktopOverlayWindow $payload) -or
  (Test-ZeroSizedUntitledDesktopHelperForeground $payload) -or
  (Test-OffscreenSmallDesktopHelperForeground $payload)
if ($shouldUseForegroundFallback) {
  $desktopBasePayload = Get-PreferredDesktopBaseForIgnoredForeground
  if ($desktopBasePayload) {
    $payload = $desktopBasePayload
  } else {
    $fallbackPayload = Get-FallbackForegroundPayload
    if ($fallbackPayload) { $payload = $fallbackPayload }
  }
}

if (Test-NeedsBlockingWindowScan $payload) {
  [ForegroundReader]::EnumWindows({
    param([IntPtr]$window, [IntPtr]$lParam)

    if (-not [ForegroundReader]::IsWindowVisible($window)) { return $true }
    if ([ForegroundReader]::IsIconic($window)) { return $true }
    if (Test-Cloaked $window) { return $true }

    $windowInfo = Get-WindowPayload $window
    if ($windowInfo.bounds.width -le 0 -or $windowInfo.bounds.height -le 0) { return $true }
    if ($windowInfo.bounds.width -lt 96 -or $windowInfo.bounds.height -lt 80) { return $true }
    if (Test-ShellOrOverlayWindow $windowInfo) { return $true }
    if (-not (Test-IntersectsDesktopArea $windowInfo.bounds)) { return $true }

    $script:blockingWindows.Add($windowInfo) | Out-Null
    return $true
  }, [IntPtr]::Zero) | Out-Null
}
if ($script:desktopArea -and $script:blockingWindows.Count -eq 0 -and (Test-DesktopTopBarShellForeground $payload)) {
  $desktopBasePayload = Get-DesktopBasePayload
  if ($desktopBasePayload) { $payload = $desktopBasePayload }
}
$payload | Add-Member -NotePropertyName contentOverlays -NotePropertyValue @(Get-ContentOverlayHints $hwnd $payload)
$payload | Add-Member -NotePropertyName desktop -NotePropertyValue @{
  clear = if ($script:desktopArea -and ([string]$payload.processName).ToLowerInvariant() -eq "explorer") { $script:blockingWindows.Count -eq 0 } else { $false }
  blockerCount = $script:blockingWindows.Count
  blockers = @($script:blockingWindows | Select-Object -First 5)
}
$payload | ConvertTo-Json -Compress -Depth 8
`;

const DESKTOP_FOREGROUND_POWERSHELL_SCRIPT = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DesktopForegroundReader {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

function Get-TextValue([IntPtr]$window) {
  $text = New-Object System.Text.StringBuilder 1024
  [DesktopForegroundReader]::GetWindowText($window, $text, $text.Capacity) | Out-Null
  return $text.ToString()
}

function Get-ClassValue([IntPtr]$window) {
  $class = New-Object System.Text.StringBuilder 256
  [DesktopForegroundReader]::GetClassName($window, $class, $class.Capacity) | Out-Null
  return $class.ToString()
}

function Get-ProcessValue([int]$processId) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $path = ""
  try {
    if ($process -and $process.Path) { $path = $process.Path }
  } catch {}
  return [pscustomobject]@{
    processName = if ($process) { $process.ProcessName } else { "" }
    path = $path
  }
}

function Get-WindowPayload([IntPtr]$window) {
  $processId = 0
  [DesktopForegroundReader]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
  $process = Get-ProcessValue $processId
  $rect = New-Object DesktopForegroundReader+RECT
  [DesktopForegroundReader]::GetWindowRect($window, [ref]$rect) | Out-Null
  return [pscustomobject]@{
    hwnd = $window.ToInt64()
    pid = $processId
    processName = $process.processName
    path = $process.path
    title = Get-TextValue $window
    className = Get-ClassValue $window
    bounds = @{
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    }
  }
}

function Test-ExplorerProcess($windowInfo) {
  $processName = ([string]$windowInfo.processName).ToLowerInvariant()
  $path = ([string]$windowInfo.path).ToLowerInvariant()
  return $processName -eq "explorer" -or $path.EndsWith("\\explorer.exe") -or $path.EndsWith("/explorer.exe")
}

function Test-DesktopShellBaseWindow($windowInfo) {
  if (-not (Test-ExplorerProcess $windowInfo)) { return $false }
  $className = [string]$windowInfo.className
  $title = ([string]$windowInfo.title).Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($title) -or $title -eq "program manager" -or $title -eq "desktop" -or $title -eq "妗岄潰") {
    return [string]::IsNullOrWhiteSpace($className) -or $className -eq "Progman" -or $className -eq "WorkerW"
  }
  return $className -eq "Progman" -or $className -eq "WorkerW"
}

function Test-DesktopTopBarShellForeground($windowInfo) {
  if (Test-DesktopShellBaseWindow $windowInfo) { return $true }
  if (-not (Test-ExplorerProcess $windowInfo)) { return $false }
  $className = [string]$windowInfo.className
  $title = ([string]$windowInfo.title).Trim().ToLowerInvariant()
  if (@("TaskListThumbnailWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "Xaml_Hosting_WindowedPopupClass", "TaskSwitcherWnd", "MSTaskListWClass") -contains $className) { return $false }
  if ($title -match "notifyicon|overflow|hidden icons|闅愯棌.*鍥炬爣|閫氱煡鍖哄煙|绯荤粺鎵樼洏") { return $false }
  if ($className -eq "#32768") { return $true }
  if (@("Shell_TrayWnd", "Shell_SecondaryTrayWnd", "DV2ControlHost") -contains $className) {
    return [string]::IsNullOrWhiteSpace($title)
  }
  $bounds = $windowInfo.bounds
  if (-not $bounds) { return $false }
  return [double]$bounds.width -le 720 -and [double]$bounds.height -le 520
}

function Get-DesktopBasePayload() {
  $shellWindow = [DesktopForegroundReader]::GetShellWindow()
  if ($shellWindow -eq [IntPtr]::Zero) { return $null }
  $windowInfo = Get-WindowPayload $shellWindow
  if (Test-DesktopShellBaseWindow $windowInfo) { return $windowInfo }
  return $null
}

$foreground = [DesktopForegroundReader]::GetForegroundWindow()
if ($foreground -ne [IntPtr]::Zero) {
  $payload = Get-WindowPayload $foreground
  if (Test-DesktopTopBarShellForeground $payload) {
    $desktopBasePayload = Get-DesktopBasePayload
    if ($desktopBasePayload) { $payload = $desktopBasePayload }
    $payload | Add-Member -NotePropertyName contentOverlays -NotePropertyValue @()
    $payload | Add-Member -NotePropertyName desktop -NotePropertyValue @{
      clear = $true
      blockerCount = 0
      blockers = @()
    }
    $payload | ConvertTo-Json -Compress -Depth 6
  }
}
`;

const WINDOW_STATUS_POWERSHELL_SCRIPT = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$config = ConvertFrom-Json @'
__CONFIG_JSON__
'@
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WindowStatusReader {
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

function Get-TextValue([IntPtr]$window) {
  $text = New-Object System.Text.StringBuilder 1024
  [WindowStatusReader]::GetWindowText($window, $text, $text.Capacity) | Out-Null
  return $text.ToString()
}

function Get-ClassValue([IntPtr]$window) {
  $class = New-Object System.Text.StringBuilder 256
  [WindowStatusReader]::GetClassName($window, $class, $class.Capacity) | Out-Null
  return $class.ToString()
}

function Get-ProcessValue([int]$processId) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $path = ""
  try {
    if ($process -and $process.Path) { $path = $process.Path }
  } catch {}
  return [pscustomobject]@{
    processName = if ($process) { $process.ProcessName } else { "" }
    path = $path
  }
}

function Test-Cloaked([IntPtr]$window) {
  $cloaked = 0
  try {
    [WindowStatusReader]::DwmGetWindowAttribute($window, 14, [ref]$cloaked, 4) | Out-Null
  } catch {
    $cloaked = 0
  }
  return $cloaked -ne 0
}

function Get-EmptyStatus([string]$hwnd, [bool]$exists = $false) {
  return [pscustomobject]@{
    hwnd = $hwnd
    exists = $exists
    visible = $false
    minimized = $false
    cloaked = $false
    pid = $null
    processName = ""
    path = ""
    title = ""
    className = ""
    bounds = @{ x = 0; y = 0; width = 0; height = 0 }
    source = "powershell-window-status"
  }
}

$hwndText = [string]$config.hwnd
$hwndValue = [Int64]0
if (-not [Int64]::TryParse($hwndText, [ref]$hwndValue) -or $hwndValue -eq 0) {
  Get-EmptyStatus $hwndText | ConvertTo-Json -Compress -Depth 4
  return
}

$window = [IntPtr]$hwndValue
if (-not [WindowStatusReader]::IsWindow($window)) {
  Get-EmptyStatus $hwndText | ConvertTo-Json -Compress -Depth 4
  return
}

$processId = 0
[WindowStatusReader]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
$process = Get-ProcessValue $processId
$rect = New-Object WindowStatusReader+RECT
[WindowStatusReader]::GetWindowRect($window, [ref]$rect) | Out-Null

[pscustomobject]@{
  hwnd = $hwndText
  exists = $true
  visible = [WindowStatusReader]::IsWindowVisible($window)
  minimized = [WindowStatusReader]::IsIconic($window)
  cloaked = Test-Cloaked $window
  pid = $processId
  processName = $process.processName
  path = $process.path
  title = Get-TextValue $window
  className = Get-ClassValue $window
  bounds = @{
    x = $rect.Left
    y = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  }
  source = "powershell-window-status"
} | ConvertTo-Json -Compress -Depth 4
`;

async function getActiveWindow(options = {}) {
  if (process.platform === "win32") {
    return getWindowsActiveWindow(options);
  }
  if (process.platform === "darwin") {
    return getMacActiveWindow(options);
  }
  return getPortableActiveWindow(options);
}

async function getWindowStatusByHwnd(hwnd, options = {}) {
  const normalizedHwnd = String(hwnd || "").trim();
  if (!normalizedHwnd) return null;
  if (process.platform === "win32") {
    const status = await getPowerShellWindowStatusByHwnd(normalizedHwnd);
    if (status) return status;
  }
  return getNativeWindowStatusByHwnd(normalizedHwnd, options);
}

async function getWindowsActiveWindow(options = {}) {
  const nativeWindow = await getNativeActiveWindow();
  const foregroundFallbackReason = getForegroundFallbackReason(nativeWindow, options, process.platform);
  const shouldUseForegroundFallback = Boolean(foregroundFallbackReason);
  if (options.fast === "desktop") {
    if (isDesktopForegroundWindow(nativeWindow, process.platform)) {
      return withFastDesktopMetadata(nativeWindow, process.platform);
    }
    if (shouldUseForegroundFallback) {
      const preferredDesktopWindow = shouldPreferDesktopBaseForForegroundFallback(foregroundFallbackReason)
        ? await getNativeDesktopWindow(options, nativeWindow)
        : null;
      if (preferredDesktopWindow && !preferredDesktopWindow.samplingNoise) {
        return preferredDesktopWindow;
      }
      if (shouldUseNativeDesktopFallbackOnly(foregroundFallbackReason, options)) {
        return preferredDesktopWindow ||
          markForegroundFallbackMiss(nativeWindow, foregroundFallbackReason);
      }
      const inspectedWindow = await getPowerShellActiveWindow({
        ...options,
        preferDesktopForIgnoredForeground: shouldPreferDesktopBaseForForegroundFallback(foregroundFallbackReason)
      });
      if (shouldUseInspectedFastDesktopWindow(inspectedWindow, options, process.platform)) {
        return withFastDesktopMetadata(inspectedWindow, process.platform);
      }
      return await getNativeDesktopWindow(options, inspectedWindow || nativeWindow) ||
        markForegroundFallbackMiss(nativeWindow, foregroundFallbackReason);
    }
    if (shouldProbeDesktopForeground(nativeWindow, options, process.platform)) {
      const desktopProbeWindow = await getPowerShellDesktopForegroundProbe();
      if (desktopProbeWindow && isDesktopForegroundWindow(desktopProbeWindow, process.platform)) {
        return withFastDesktopMetadata(desktopProbeWindow, process.platform);
      }
    }
    return withFastDesktopMetadata(nativeWindow, process.platform);
  }
  if (shouldUseForegroundFallback) {
    const inspectedWindow = await getPowerShellActiveWindow(options);
    if (inspectedWindow) return inspectedWindow;
    if (foregroundFallbackReason === "ignored-window" || foregroundFallbackReason === "external-overlay") {
      return markForegroundFallbackMiss(nativeWindow, foregroundFallbackReason);
    }
    return nativeWindow;
  }
  if (options.fast === true) {
    return nativeWindow;
  }
  if (nativeWindow && !shouldUsePowerShellInspection(nativeWindow, options)) {
    return nativeWindow;
  }

  const inspectedWindow = await getPowerShellActiveWindow(options);
  return inspectedWindow || nativeWindow;
}

function shouldFallbackForegroundWindow(activeWindow, options = {}, platform = process.platform) {
  return Boolean(getForegroundFallbackReason(activeWindow, options, platform));
}

function getForegroundFallbackReason(activeWindow, options = {}, platform = process.platform) {
  if (!activeWindow) return false;
  if (isIgnoredWindow(activeWindow, getIgnoredHwnds(options))) return "ignored-window";
  if (isNativeShellForegroundCandidate(activeWindow, platform)) return "native-shell";
  if (isZeroSizedUntitledDesktopHelperForeground(activeWindow, platform)) return "zero-sized-helper";
  if (isWindowsDesktopAssistantForeground(activeWindow, platform)) return "windows-desktop-assistant";
  if (isOffscreenSmallDesktopHelperForeground(activeWindow, options.desktopArea, platform)) return "offscreen-small-helper";
  if (isCodexDesktopOverlayCandidate(activeWindow, normalizeBounds(options.desktopArea), platform)) {
    return "external-overlay";
  }
  return "";
}

function shouldPreferDesktopBaseForForegroundFallback(reason) {
  return reason === "ignored-window" ||
    reason === "external-overlay" ||
    reason === "zero-sized-helper" ||
    reason === "offscreen-small-helper";
}

function shouldUseNativeDesktopFallbackOnly(reason, options = {}) {
  return options.nativeDesktopFallbackOnly === true &&
    shouldPreferDesktopBaseForForegroundFallback(reason);
}

function shouldProbeDesktopForeground(activeWindow, options = {}, platform = process.platform) {
  if (platform !== "win32") return false;
  if (options.probeDesktopForeground !== true) return false;
  if (!activeWindow || isDesktopForegroundWindow(activeWindow, platform)) return false;
  const desktopArea = normalizeBounds(options.desktopArea);
  const bounds = normalizeBounds(activeWindow.bounds);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  if (bounds.x <= -30000 || bounds.y <= -30000) return true;
  return Boolean(desktopArea && isFullScreenLikeWindow(bounds, desktopArea));
}

function getPowerShellDesktopForegroundProbe() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", DESKTOP_FOREGROUND_POWERSHELL_SCRIPT],
      { windowsHide: true, timeout: 900 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function shouldUseInspectedFastDesktopWindow(inspectedWindow, options = {}, platform = process.platform) {
  if (!inspectedWindow) return false;
  if (isDesktopForegroundWindow(inspectedWindow, platform)) return true;
  return !getForegroundFallbackReason(inspectedWindow, options, platform);
}

function isNativeShellForegroundCandidate(activeWindow, platform = process.platform) {
  if (platform !== "win32") return false;
  const processName = String(activeWindow?.processName || "").toLowerCase();
  const title = String(activeWindow?.title || "").trim().toLowerCase();
  const path = String(activeWindow?.path || "").toLowerCase();
  const isExplorer = processName === "explorer" ||
    path.endsWith("\\explorer.exe") ||
    path.endsWith("/explorer.exe");
  if (!isExplorer) return false;
  return !title || title === "program manager" || title === "desktop" || title === "桌面";
}

function isWindowsDesktopAssistantForeground(windowInfo, platform = process.platform) {
  if (platform !== "win32") return false;
  return isClickToDoDesktopAssistantForeground(windowInfo) ||
    isExplorerHostPopupDesktopAssistantForeground(windowInfo) ||
    isNarratorHelperDesktopAssistantForeground(windowInfo) ||
    isZeroSizedUntitledDesktopHelperForeground(windowInfo);
}

function isExplorerHostPopupDesktopAssistantForeground(windowInfo) {
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const title = String(windowInfo?.title || "").trim().toLowerCase();
  const path = String(windowInfo?.path || "").toLowerCase().replaceAll("/", "\\");
  const bounds = normalizeBounds(windowInfo?.bounds);
  const isExplorer = processName === "explorer" ||
    processName === "windows 资源管理器" ||
    path.endsWith("\\explorer.exe");
  if (!isExplorer) return false;
  if (title !== "host popup window" && title !== "主机弹出窗口") return false;
  return Boolean(bounds && bounds.width <= 1 && bounds.height <= 1);
}

function isClickToDoDesktopAssistantForeground(windowInfo) {
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const title = String(windowInfo?.title || "").trim().toLowerCase();
  const path = String(windowInfo?.path || "").toLowerCase().replaceAll("/", "\\");
  const bounds = normalizeBounds(windowInfo?.bounds);
  const isClickToDo = processName === "clicktodo" ||
    processName === "clicktodo.exe" ||
    (path.includes("\\microsoftwindows.client.coreai_") && path.endsWith("\\clicktodo.exe"));
  if (!isClickToDo) return false;
  if (title !== "click to do" && title !== "单击以执行") return false;
  return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
}

function isNarratorHelperDesktopAssistantForeground(windowInfo) {
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const title = String(windowInfo?.title || "").trim();
  const className = String(windowInfo?.className || "").trim().toLowerCase();
  const path = String(windowInfo?.path || "").toLowerCase().replaceAll("/", "\\");
  const bounds = normalizeBounds(windowInfo?.bounds);
  const isSvchost = processName === "svchost" || path.endsWith("\\svchost.exe");
  if (!isSvchost || title) return false;
  if (className && className !== "narratorhelperwindow") return false;
  return isOffscreenTinyHelperBounds(bounds);
}

function isOffscreenTinyHelperBounds(bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  if (bounds.width > 64 || bounds.height > 64) return false;
  return bounds.x <= -30000 || bounds.y <= -30000;
}

function isZeroSizedUntitledDesktopHelperForeground(windowInfo) {
  const title = String(windowInfo?.title || "").trim();
  if (title) return false;
  const bounds = normalizeBounds(windowInfo?.bounds);
  return Boolean(bounds && (bounds.width <= 0 || bounds.height <= 0));
}

function isOffscreenSmallDesktopHelperForeground(windowInfo, desktopArea = null, platform = process.platform) {
  if (platform !== "win32") return false;
  const bounds = normalizeBounds(windowInfo?.bounds);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  if (bounds.width > 360 || bounds.height > 180) return false;
  const desktopBounds = desktopArea ? normalizeBounds(desktopArea) : null;
  if (desktopBounds && desktopBounds.width > 0 && desktopBounds.height > 0 && boundsOverlap(bounds, desktopBounds)) {
    return false;
  }
  return bounds.x <= -10000 || bounds.y <= -10000;
}

async function getMacActiveWindow(options = {}) {
  const nativeWindow = await getNativeActiveWindow(getNativeWindowOptions(options));
  if (!nativeWindow) return null;

  return {
    ...nativeWindow,
    desktop: {
      clear: isMacDesktopForeground(nativeWindow),
      blockerCount: 0,
      blockers: []
    },
    source: nativeWindow.source || "get-windows-macos"
  };
}

async function getPortableActiveWindow(options = {}) {
  const nativeWindow = await getNativeActiveWindow(getNativeWindowOptions(options));
  if (!nativeWindow) return null;

  return {
    ...nativeWindow,
    desktop: {
      clear: false,
      blockerCount: 0,
      blockers: []
    }
  };
}

async function getNativeActiveWindow(options = {}) {
  try {
    const api = await loadNativeWindowApi();
    const windowInfo = await api.activeWindow(options);
    return normalizeNativeWindow(windowInfo);
  } catch {
    return null;
  }
}

function getNativeWindowOptions(options = {}, platform = process.platform) {
  if (platform !== "darwin") return {};

  if (options.fast === "desktop") {
    return {
      accessibilityPermission: false,
      screenRecordingPermission: false
    };
  }

  return {
    accessibilityPermission: options.macAccessibilityPermission !== false,
    screenRecordingPermission: options.macScreenRecordingPermission !== false
  };
}

async function loadNativeWindowApi() {
  if (!nativeWindowApiPromise) {
    nativeWindowApiPromise = import("get-windows").then((module) => {
      const activeWindow = module.activeWindow || module.default;
      const openWindows = module.openWindows;
      if (typeof activeWindow !== "function") {
        throw new Error("get-windows activeWindow API is unavailable");
      }
      if (typeof openWindows !== "function") {
        throw new Error("get-windows openWindows API is unavailable");
      }
      return { activeWindow, openWindows };
    });
  }
  return nativeWindowApiPromise;
}

async function getNativeDesktopWindow(options, activeWindow) {
  try {
    const api = await loadNativeWindowApi();
    const windows = await api.openWindows();
    const baseWindow = selectDesktopBaseWindow(activeWindow, windows, options);
    if (!baseWindow) {
      return markForegroundFallbackMiss(activeWindow, "desktop-base-missing");
    }
    const desktopForeground = isDesktopForegroundWindow(baseWindow, process.platform);
    const blockers = getDesktopBlockers(windows, { ...options, desktopForeground }, process.platform);
    return {
      ...baseWindow,
      desktop: {
        clear: desktopForeground && blockers.length === 0,
        blockerCount: blockers.length,
        blockers: blockers.slice(0, 5)
      },
      source: "get-windows-desktop"
    };
  } catch {
    const fallbackReason = getForegroundFallbackReason(activeWindow, options, process.platform);
    if (fallbackReason) return markForegroundFallbackMiss(activeWindow, fallbackReason);
    return activeWindow;
  }
}

function withFastDesktopMetadata(activeWindow, platform = process.platform) {
  if (!activeWindow) return null;
  const desktopForeground = isDesktopForegroundWindow(activeWindow, platform);
  return {
    ...activeWindow,
    desktop: {
      clear: desktopForeground,
      blockerCount: 0,
      blockers: []
    },
    source: activeWindow.source === "get-windows"
      ? "get-windows-fast-desktop"
      : (activeWindow.source || "fast-desktop")
  };
}

function selectDesktopBaseWindow(activeWindow, windows = [], options = {}, platform = process.platform) {
  const ignoredHwnds = getIgnoredHwnds(options);
  const desktopArea = normalizeBounds(options.desktopArea);
  const activeWindowUsable = isDesktopBaseCandidate(activeWindow, {
    ignoredHwnds,
    desktopArea,
    platform
  });
  if (
    activeWindowUsable
  ) {
    return activeWindow;
  }

  if (isZeroSizedExplorerShellWindow(activeWindow, platform)) {
    for (const windowInfo of windows) {
      const normalized = normalizeNativeWindow(windowInfo, platform);
      if (isDesktopBaseCandidate(normalized, {
        ignoredHwnds,
        desktopArea,
        platform,
        allowDesktopShellBase: false
      })) {
        return normalized;
      }
    }
  }

  for (const windowInfo of windows) {
    const normalized = normalizeNativeWindow(windowInfo, platform);
    if (isDesktopBaseCandidate(normalized, {
      ignoredHwnds,
      desktopArea,
      platform
    })) {
      return normalized;
    }
  }

  return activeWindowUsable ? activeWindow : null;
}

function isDesktopBaseCandidate(windowInfo, options = {}) {
  if (!windowInfo) return false;
  const ignoredHwnds = options.ignoredHwnds || new Set();
  const desktopArea = normalizeBounds(options.desktopArea);
  const platform = options.platform || process.platform;
  if (!hasUsableWindowBounds(windowInfo)) return false;
  if (isIgnoredWindow(windowInfo, ignoredHwnds)) return false;
  if (isZeroSizedExplorerShellWindow(windowInfo, platform)) return false;
  if (isZeroSizedUntitledDesktopHelperForeground(windowInfo, platform)) return false;
  if (isOffscreenSmallDesktopHelperForeground(windowInfo, desktopArea, platform)) return false;
  if (isExternalDesktopOverlayWindow(windowInfo, desktopArea, platform)) return false;
  if (options.allowDesktopShellBase === false && isDesktopShellBaseWindow(windowInfo, platform)) return false;
  return !isDesktopBaseSelectionNoise(windowInfo, platform);
}

function isDesktopBaseSelectionNoise(windowInfo, platform = process.platform) {
  if (isZeroSizedExplorerShellWindow(windowInfo, platform)) return true;
  if (isDesktopShellBaseWindow(windowInfo, platform)) return false;
  if (isExplorerShellFloatingWindow(windowInfo, platform)) return true;
  return isShellOrOwnOverlayWindow(windowInfo, platform);
}

function hasUsableWindowBounds(windowInfo) {
  const bounds = normalizeBounds(windowInfo?.bounds);
  return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
}

function isZeroSizedExplorerShellWindow(windowInfo, platform = process.platform) {
  if (platform !== "win32") return false;
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const title = String(windowInfo?.title || "").trim();
  const path = String(windowInfo?.path || "").toLowerCase();
  const bounds = normalizeBounds(windowInfo?.bounds);
  const isExplorer = processName === "explorer" ||
    processName === "windows 资源管理器" ||
    path.endsWith("\\explorer.exe") ||
    path.endsWith("/explorer.exe");
  return isExplorer &&
    !title &&
    Boolean(bounds) &&
    (bounds.width <= 0 || bounds.height <= 0);
}

function markForegroundFallbackMiss(windowInfo, reason = "foreground-fallback-miss") {
  if (!windowInfo) return null;
  return {
    ...windowInfo,
    source: `${windowInfo.source || "get-windows"}-fallback-miss`,
    foregroundFallbackMiss: true,
    foregroundFallbackReason: reason,
    samplingNoise: true,
    desktop: {
      clear: false,
      blockerCount: 0,
      blockers: []
    }
  };
}

function normalizeNativeWindow(windowInfo, platform = process.platform) {
  if (!windowInfo) return null;
  const bounds = normalizeBounds(windowInfo.bounds || windowInfo.contentBounds);
  const owner = windowInfo.owner || {};
  return {
    hwnd: String(windowInfo.id || ""),
    pid: Number.isFinite(Number(owner.processId)) ? Number(owner.processId) : null,
    processName: owner.name || "",
    bundleId: owner.bundleId || "",
    path: owner.path || "",
    title: windowInfo.title || "",
    url: windowInfo.url || "",
    platform: windowInfo.platform || platform,
    memoryUsageBytes: Number.isFinite(Number(windowInfo.memoryUsage)) ? Number(windowInfo.memoryUsage) : null,
    className: windowInfo.className || "",
    bounds,
    contentOverlays: [],
    desktop: {
      clear: false,
      blockerCount: 0,
      blockers: []
    },
    source: "get-windows"
  };
}

function normalizeBounds(bounds = {}) {
  if (!bounds || typeof bounds !== "object") {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x = Math.round(Number(bounds.x));
  const y = Math.round(Number(bounds.y));
  const width = Math.round(Number(bounds.width));
  const height = Math.round(Number(bounds.height));
  if (![x, y, width, height].every(Number.isFinite)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x, y, width, height };
}

function getDesktopBlockers(windows = [], options = {}, platform = process.platform) {
  const ignoredHwnds = getIgnoredHwnds(options);
  const desktopArea = normalizeBounds(options.desktopArea);
  return windows
    .map((windowInfo) => normalizeNativeWindow(windowInfo, platform))
    .filter(Boolean)
    .filter((windowInfo) => !ignoredHwnds.has(String(windowInfo.hwnd)))
    .filter((windowInfo) => !isExternalDesktopOverlayWindow(windowInfo, desktopArea, platform))
    .filter((windowInfo) => isDesktopBlockingWindow(windowInfo, desktopArea, platform, {
      desktopForeground: Boolean(options.desktopForeground)
    }));
}

function getIgnoredHwnds(options = {}) {
  return new Set((options.ignoredHwnds || []).map(String));
}

function isIgnoredWindow(windowInfo, ignoredHwnds) {
  return ignoredHwnds.has(String(windowInfo?.hwnd || windowInfo?.id || ""));
}

function isDesktopBlockingWindow(windowInfo, desktopArea, platform = process.platform, context = {}) {
  const bounds = windowInfo.bounds;
  if (!bounds || bounds.width < 96 || bounds.height < 80) return false;
  if (!boundsOverlap(bounds, desktopArea)) return false;
  if (isDesktopShellBaseWindow(windowInfo, platform)) return false;
  if (isDesktopContextMenuWindow(windowInfo, platform)) return false;
  if (isShellOrOwnOverlayWindow(windowInfo, platform)) return false;
  if (context.desktopForeground && isFullScreenLikeWindow(bounds, desktopArea)) return false;
  return true;
}

function isDesktopContextMenuWindow(windowInfo, platform = process.platform) {
  if (platform !== "win32") return false;
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const path = String(windowInfo?.path || "").toLowerCase();
  const classNameLower = String(windowInfo?.className || "").trim().toLowerCase();
  const bounds = normalizeBounds(windowInfo?.bounds);
  const isExplorer = processName === "explorer" ||
    path.endsWith("\\explorer.exe") ||
    path.endsWith("/explorer.exe");
  if (!isExplorer || classNameLower !== "#32768") return false;
  return bounds.width <= 720 && bounds.height <= 520;
}

function isShellOrOwnOverlayWindow(windowInfo, platform = process.platform) {
  const processName = String(windowInfo.processName || "").toLowerCase();
  const title = String(windowInfo.title || "");
  if (isDesktopShellBaseWindow(windowInfo, platform)) return true;
  if (isWindowsDesktopAssistantForeground(windowInfo, platform)) return true;
  if (platform === "darwin" && processName === "finder") return true;
  if (processName === "electron" && title === "LLM HUD Controls") return true;
  if (processName === "electron" && /^(谁在吃 token|LLM HUD|数据可信度|谁在吃 token 设置)$/i.test(title)) return true;
  return false;
}

function isDesktopShellBaseWindow(windowInfo, platform = process.platform) {
  if (platform !== "win32") return false;
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const title = String(windowInfo?.title || "").trim().toLowerCase();
  const classNameLower = String(windowInfo?.className || "").trim().toLowerCase();
  const path = String(windowInfo?.path || "").toLowerCase();
  const isExplorer = processName === "explorer" ||
    path.endsWith("\\explorer.exe") ||
    path.endsWith("/explorer.exe");
  if (!isExplorer) return false;
  const floatingShellClasses = new Set([
    "#32768",
    "dv2controlhost",
    "notifyiconoverflowwindow",
    "toplevelwindowforoverflowxamlisland",
    "xaml_hosting_windowedpopupclass",
    "tasklistthumbnailwnd",
    "taskswitcherwnd",
    "mstasklistwclass"
  ]);
  if (floatingShellClasses.has(classNameLower)) return false;
  if (!title || title === "program manager" || title === "desktop" || title === "桌面") {
    return !classNameLower || classNameLower === "progman" || classNameLower === "workerw";
  }
  return new Set([
    "progman",
    "workerw"
  ]).has(classNameLower);
}

function isExplorerShellFloatingWindow(windowInfo, platform = process.platform) {
  if (platform !== "win32") return false;
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const title = String(windowInfo?.title || "").trim().toLowerCase();
  const className = String(windowInfo?.className || "").trim();
  const classNameLower = className.toLowerCase();
  const path = String(windowInfo?.path || "").toLowerCase();
  const bounds = normalizeBounds(windowInfo?.bounds);
  const isExplorer = processName === "explorer" ||
    path.endsWith("\\explorer.exe") ||
    path.endsWith("/explorer.exe");
  if (!isExplorer) return false;

  const shellClasses = new Set([
    "progman",
    "workerw",
    "#32768",
    "shell_traywnd",
    "shell_secondarytraywnd",
    "dv2controlhost",
    "notifyiconoverflowwindow",
    "toplevelwindowforoverflowxamlisland",
    "xaml_hosting_windowedpopupclass",
    "tasklistthumbnailwnd",
    "taskswitcherwnd",
    "mstasklistwclass"
  ]);
  if (shellClasses.has(classNameLower)) return true;
  if (!title || title === "program manager" || title === "desktop" || title === "桌面") return true;
  if (classNameLower === "cabinetwclass" || classNameLower === "explorewclass") return false;
  return bounds.width <= 720 && bounds.height <= 520;
}

function isExternalDesktopOverlayWindow(windowInfo, desktopArea = null, platform = process.platform) {
  return isCodexDesktopOverlayCandidate(windowInfo, desktopArea, platform);
}

function isCodexDesktopOverlayCandidate(windowInfo, desktopArea = null, platform = process.platform) {
  if (platform !== "win32") return false;
  const processName = String(windowInfo?.processName || "").toLowerCase();
  const title = String(windowInfo?.title || "").trim().toLowerCase();
  const path = String(windowInfo?.path || "").toLowerCase();
  const bounds = normalizeBounds(windowInfo?.bounds);
  const isCodexCompanion =
    processName === "codex" &&
    (!title || title === "codex") &&
    (!path || path.includes("\\openai.codex_") || path.endsWith("\\codex.exe") || path.endsWith("/codex.exe"));

  if (!isCodexCompanion) return false;
  return isFloatingDesktopOverlayBounds(bounds, desktopArea);
}

function isFloatingDesktopOverlayBounds(bounds, desktopArea = null) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  if (bounds.width > 760 || bounds.height > 760) return false;

  const desktopBounds = desktopArea ? normalizeBounds(desktopArea) : null;
  if (!desktopBounds || desktopBounds.width <= 0 || desktopBounds.height <= 0) {
    return bounds.width <= 760 && bounds.height <= 760;
  }
  if (!boundsOverlap(bounds, desktopBounds)) return false;

  const widthRatio = bounds.width / desktopBounds.width;
  const heightRatio = bounds.height / desktopBounds.height;
  const areaRatio = (bounds.width * bounds.height) / (desktopBounds.width * desktopBounds.height);
  if (widthRatio > 0.62 || heightRatio > 0.72 || areaRatio > 0.22) return false;
  return true;
}

function isFullScreenLikeWindow(bounds, desktopArea) {
  const desktopBounds = normalizeBounds(desktopArea);
  if (!bounds || !desktopBounds || desktopBounds.width <= 0 || desktopBounds.height <= 0) return false;
  const horizontalCoverage = bounds.width / desktopBounds.width;
  const verticalCoverage = bounds.height / desktopBounds.height;
  const leftAligned = bounds.x <= desktopBounds.x + 8;
  const topAligned = bounds.y <= desktopBounds.y + 8;
  return horizontalCoverage >= 0.96 && verticalCoverage >= 0.92 && leftAligned && topAligned;
}

function isDesktopForegroundWindow(activeWindow, platform = process.platform) {
  if (!activeWindow) return false;
  if (platform === "darwin") return isMacDesktopForeground(activeWindow);
  if (platform === "win32") return isWindowsDesktopForeground(activeWindow);
  return false;
}

function isWindowsDesktopForeground(activeWindow) {
  const processName = String(activeWindow?.processName || "").toLowerCase();
  const title = String(activeWindow?.title || "").trim().toLowerCase();
  const className = String(activeWindow?.className || "").trim().toLowerCase();
  const path = String(activeWindow?.path || "").toLowerCase();
  const bounds = normalizeBounds(activeWindow?.bounds);
  const isExplorer = processName === "explorer" ||
    path.endsWith("\\explorer.exe") ||
    path.endsWith("/explorer.exe");

  if (!isExplorer) return false;
  if (title === "program manager" || title === "desktop" || title === "桌面") return true;
  return className === "progman" || className === "workerw";
}

function isMacDesktopForeground(activeWindow) {
  const processName = String(activeWindow?.processName || "").toLowerCase();
  const bundleId = String(activeWindow?.bundleId || "").toLowerCase();
  const title = String(activeWindow?.title || "").trim().toLowerCase();
  return (processName === "finder" || bundleId === "com.apple.finder") &&
    (!title || title === "desktop" || title === "桌面");
}

function boundsOverlap(first, second) {
  if (!first || !second) return false;
  const firstRight = first.x + first.width;
  const firstBottom = first.y + first.height;
  const secondRight = second.x + second.width;
  const secondBottom = second.y + second.height;
  return firstRight > second.x && first.x < secondRight && firstBottom > second.y && first.y < secondBottom;
}

function shouldUsePowerShellInspection(activeWindow, options = {}) {
  const processName = String(activeWindow.processName || "").toLowerCase();
  const title = String(activeWindow.title || "").trim().toLowerCase();

  if (isHermesWindow(activeWindow)) return true;
  if (isUnreliableShellForeground(activeWindow)) return options.inspectUnreliableShell !== false;
  if (processName === "explorer") return options.inspectExplorer !== false;
  if (title === "program manager" || title === "desktop") return options.inspectExplorer !== false;
  if (isSmallForegroundWindow(activeWindow, options.desktopArea)) return options.inspectSmallWindows !== false;

  return false;
}

function isHermesWindow(activeWindow) {
  const processName = String(activeWindow?.processName || "").toLowerCase();
  return processName === "hermes-web-ui";
}

function isUnreliableShellForeground(activeWindow) {
  const processName = String(activeWindow?.processName || "").toLowerCase();
  const title = String(activeWindow?.title || "").toLowerCase();
  const path = String(activeWindow?.path || "").toLowerCase();
  return (
    processName === "idle" ||
    processName === "lockapp.exe" ||
    path.includes("\\microsoft.lockapp_") ||
    title.includes("锁屏") ||
    title.includes("lock screen")
  );
}

function isSmallForegroundWindow(activeWindow, desktopArea) {
  const bounds = activeWindow?.bounds;
  if (!bounds || !desktopArea) return false;
  const desktopWidth = Number(desktopArea.width);
  const desktopHeight = Number(desktopArea.height);
  if (!Number.isFinite(desktopWidth) || !Number.isFinite(desktopHeight)) return false;
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  return bounds.width < desktopWidth * 0.58 && bounds.height < desktopHeight * 0.58;
}

function getPowerShellActiveWindow(options = {}) {
  const config = JSON.stringify({
    ignoredHwnds: (options.ignoredHwnds || []).map(String),
    desktopArea: options.desktopArea || null,
    preferDesktopForIgnoredForeground: Boolean(options.preferDesktopForIgnoredForeground)
  });
  const script = POWERSHELL_SCRIPT.replace("__CONFIG_JSON__", config);

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 3500 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

async function getNativeWindowStatusByHwnd(hwnd, options = {}) {
  try {
    const api = await loadNativeWindowApi();
    const windows = await api.openWindows();
    const match = windows.find((windowInfo) => String(windowInfo.id || "") === String(hwnd));
    if (!match) return normalizeWindowStatusPayload({ hwnd, exists: false, source: "get-windows-status" }, hwnd);
    const normalized = normalizeNativeWindow(match, options.platform || process.platform);
    return normalizeWindowStatusPayload({
      ...normalized,
      exists: true,
      visible: true,
      minimized: false,
      cloaked: false,
      source: "get-windows-status"
    }, hwnd);
  } catch {
    return normalizeWindowStatusPayload({ hwnd, exists: false, source: "get-windows-status" }, hwnd);
  }
}

function getPowerShellWindowStatusByHwnd(hwnd) {
  const config = JSON.stringify({ hwnd: String(hwnd || "") });
  const script = WINDOW_STATUS_POWERSHELL_SCRIPT.replace("__CONFIG_JSON__", config);

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 1500 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }

        try {
          resolve(normalizeWindowStatusPayload(JSON.parse(stdout), hwnd));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function normalizeWindowStatusPayload(payload, fallbackHwnd = "") {
  if (!payload) return null;
  return {
    hwnd: String(payload.hwnd || fallbackHwnd || ""),
    exists: Boolean(payload.exists),
    visible: Boolean(payload.visible),
    minimized: Boolean(payload.minimized),
    cloaked: Boolean(payload.cloaked),
    pid: Number.isFinite(Number(payload.pid)) ? Number(payload.pid) : null,
    processName: payload.processName || "",
    path: payload.path || "",
    title: payload.title || "",
    className: payload.className || "",
    bounds: normalizeBounds(payload.bounds),
    source: payload.source || "window-status"
  };
}

module.exports = {
  getActiveWindow,
  getWindowStatusByHwnd,
  isDesktopForegroundWindow,
  isExternalDesktopOverlayWindow,
  _test: {
    boundsOverlap,
    getForegroundFallbackReason,
    getDesktopBlockers,
    getNativeWindowOptions,
    isCodexDesktopOverlayCandidate,
    isDesktopContextMenuWindow,
    isDesktopForegroundWindow,
    isDesktopBlockingWindow,
    isExternalDesktopOverlayWindow,
    isExplorerShellFloatingWindow,
    isFloatingDesktopOverlayBounds,
    isFullScreenLikeWindow,
    isMacDesktopForeground,
    isNativeShellForegroundCandidate,
    isOffscreenSmallDesktopHelperForeground,
    isWindowsDesktopAssistantForeground,
    isZeroSizedUntitledDesktopHelperForeground,
    isZeroSizedExplorerShellWindow,
    isShellOrOwnOverlayWindow,
    isWindowsDesktopForeground,
    markForegroundFallbackMiss,
    normalizeBounds,
    normalizeNativeWindow,
    normalizeWindowStatusPayload,
    selectDesktopBaseWindow,
    shouldFallbackForegroundWindow,
    shouldProbeDesktopForeground,
    shouldPreferDesktopBaseForForegroundFallback,
    shouldUseNativeDesktopFallbackOnly,
    shouldUseInspectedFastDesktopWindow,
    shouldUsePowerShellInspection,
    withFastDesktopMetadata
  }
};
