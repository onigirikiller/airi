$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $repoRoot 'runtime\codex-daemon'
$statusPath = Join-Path $runtimeDir 'status.json'
$workerScript = Join-Path $PSScriptRoot 'codex-minecraft-daemon-worker.ps1'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

if (Test-Path $statusPath) {
  try {
    $status = Get-Content $statusPath -Raw | ConvertFrom-Json
    if ($status.workerPid) {
      $existing = Get-Process -Id ([int]$status.workerPid) -ErrorAction SilentlyContinue
      if ($existing) {
        Write-Output "ALREADY_RUNNING=$($status.workerPid)"
        Write-Output "STATUS=$statusPath"
        exit 0
      }
    }
  }
  catch {
  }
}

$process = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $workerScript
  ) `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Seconds 2

Write-Output "WORKER_PID=$($process.Id)"
Write-Output "STATUS=$statusPath"
