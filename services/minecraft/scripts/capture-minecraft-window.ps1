param(
  [string]$TitlePattern = 'Minecraft',
  [string]$ProcessName = 'javaw',
  [string]$OutputDir = 'runtime/minecraft-observation',
  [switch]$ActivateWindow,
  [switch]$PreferScreenCopy
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexWindowCapture {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$process = Get-Process | Where-Object {
  $_.MainWindowTitle -match $TitlePattern -and ($ProcessName -eq '' -or $_.ProcessName -eq $ProcessName)
} | Select-Object -First 1
if (-not $process) {
  $process = Get-Process | Where-Object { $_.MainWindowTitle -match $TitlePattern } | Select-Object -First 1
}
if (-not $process) {
  throw "Window not found for pattern: $TitlePattern"
}

if ($ActivateWindow) {
  [CodexWindowCapture]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
  [CodexWindowCapture]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 300
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$resolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
  $OutputDir
}
else {
  Join-Path $repoRoot.Path $OutputDir
}
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null

$rect = New-Object CodexWindowCapture+RECT
[CodexWindowCapture]::GetWindowRect($process.MainWindowHandle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphicsHdc = $graphics.GetHdc()
$printed = $false
try {
  if (-not $PreferScreenCopy) {
    $printed = [CodexWindowCapture]::PrintWindow($process.MainWindowHandle, $graphicsHdc, 0)
  }
}
finally {
  $graphics.ReleaseHdc($graphicsHdc)
}

if (-not $printed) {
  $graphics.CopyFromScreen(
    (New-Object System.Drawing.Point($rect.Left, $rect.Top)),
    [System.Drawing.Point]::Empty,
    (New-Object System.Drawing.Size($width, $height))
  )
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputPath = Join-Path $resolvedOutputDir "minecraft-window-$timestamp.png"
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Output $outputPath
