$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'runtime\codex-dashboard'
$statusPath = Join-Path $runtimeDir 'status.json'
$logPath = Join-Path $runtimeDir 'server.log'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

if (Test-Path $statusPath) {
  try {
    $status = Get-Content $statusPath -Raw | ConvertFrom-Json
    if ($status.pid) {
      $existing = Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue
      if ($existing) {
        Write-Output "ALREADY_RUNNING=$($status.pid)"
        Write-Output "URL=http://localhost:$($status.port)/"
        exit 0
      }
    }
  }
  catch {
  }
}

$command = "cd /d `"$repoRoot`" && pnpm exec tsx scripts/codex-daemon-dashboard.ts >> `"$logPath`" 2>&1"
$process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $command -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 2

Write-Output "PID=$($process.Id)"
Write-Output 'URL=http://localhost:3004/'
