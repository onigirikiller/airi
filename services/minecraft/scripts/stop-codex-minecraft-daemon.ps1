$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $repoRoot 'runtime\codex-daemon'
$statusPath = Join-Path $runtimeDir 'status.json'
$stopFlagPath = Join-Path $runtimeDir 'stop.flag'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Set-Content -Path $stopFlagPath -Value ((Get-Date).ToString('o')) -Encoding UTF8

if (Test-Path $statusPath) {
  try {
    $status = Get-Content $statusPath -Raw | ConvertFrom-Json
    if ($status.workerPid) {
      Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$([int]$status.workerPid)", '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
      Write-Output "STOPPED=$([int]$status.workerPid)"
      exit 0
    }
  }
  catch {
  }
}

Write-Output 'STOP_REQUESTED=true'
