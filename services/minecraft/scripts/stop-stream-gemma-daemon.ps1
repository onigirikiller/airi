$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'runtime\live-daemon'
$statusPath = Join-Path $runtimeDir 'launcher-status.json'
$stopFlagPath = Join-Path $runtimeDir 'stop.flag'
$workerScript = Join-Path $PSScriptRoot 'stream-gemma-daemon-worker.ps1'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Set-Content -Path $stopFlagPath -Value ((Get-Date).ToString('o')) -Encoding UTF8

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
        Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$workerPid", '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
        Write-Output "STOPPED=$workerPid"
        exit 0
      }
    }
  }
  catch {
  }
}

Write-Output 'STOP_REQUESTED=true'
