$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'runtime\live-daemon'
$workerScript = Join-Path $PSScriptRoot 'stream-gemma-daemon-worker.ps1'
$statusPath = Join-Path $runtimeDir 'launcher-status.json'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Test-MatchingDaemonWorker {
  param(
    [int]$ProcessId
  )

  if ($ProcessId -le 0) {
    return $false
  }

  $workerProcess = $null
  try {
    $workerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  }
  catch {
    return $false
  }

  if (-not $workerProcess) {
    return $false
  }

  $commandLine = [string]$workerProcess.CommandLine
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    return $false
  }

  $normalizedCommandLine = $commandLine.Replace('/', '\')
  $normalizedWorkerScript = $workerScript.Replace('/', '\')

  return $workerProcess.Name -eq 'powershell.exe' -and $normalizedCommandLine.Contains($normalizedWorkerScript)
}

if (Test-Path $statusPath) {
  try {
    $status = Get-Content $statusPath -Raw | ConvertFrom-Json
    if ($status.workerPid) {
      $workerPid = [int]$status.workerPid
      if (Test-MatchingDaemonWorker -ProcessId $workerPid) {
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
