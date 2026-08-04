$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'runtime\codex-dashboard'
$statusPath = Join-Path $runtimeDir 'status.json'

if (-not (Test-Path $statusPath)) {
  Write-Output 'STOP_REQUESTED=false'
  exit 0
}

try {
  $status = Get-Content $statusPath -Raw | ConvertFrom-Json
  if ($status.pid) {
    Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$([int]$status.pid)", '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
    Write-Output "STOPPED=$([int]$status.pid)"
    exit 0
  }
}
catch {
}

Write-Output 'STOP_REQUESTED=true'
