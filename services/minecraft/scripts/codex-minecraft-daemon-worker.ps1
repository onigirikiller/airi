$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path $PSScriptRoot -Parent
$codexRepoRoot = Split-Path (Split-Path $repoRoot -Parent) -Parent
$runtimeDir = Join-Path $repoRoot 'runtime\codex-daemon'
$statusPath = Join-Path $runtimeDir 'status.json'
$stopFlagPath = Join-Path $runtimeDir 'stop.flag'
$sessionLogPath = Join-Path $runtimeDir 'worker.log'
$worklogPath = Join-Path $runtimeDir 'change-log.md'
$promptPath = Join-Path $PSScriptRoot 'codex-minecraft-daemon-prompt.txt'
$minecraftDaemonStatusScript = Join-Path $PSScriptRoot 'status-stream-gemma-daemon.ps1'
$minecraftDaemonStartScript = Join-Path $PSScriptRoot 'start-stream-gemma-daemon.ps1'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if (Test-Path $stopFlagPath) {
  Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue
}

function Write-WorkerLog {
  param(
    [string]$Message
  )

  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $sessionLogPath -Value $line -Encoding UTF8
}

function Update-Status {
  param(
    [string]$State,
    [hashtable]$Extra = @{}
  )

  $status = [ordered]@{
    workerPid = $PID
    updatedAt = (Get-Date).ToString('o')
    state = $State
    repoRoot = $repoRoot
    promptPath = $promptPath
    sessionLogPath = $sessionLogPath
    worklogPath = $worklogPath
  }

  foreach ($key in $Extra.Keys) {
    $status[$key] = $Extra[$key]
  }

  $status | ConvertTo-Json -Depth 8 | Set-Content -Path $statusPath -Encoding UTF8
}

function Test-StopRequested {
  return Test-Path $stopFlagPath
}

function Ensure-WorklogFile {
  if (Test-Path $worklogPath) {
    return
  }

  @(
    '# Codex Daemon Change Log'
    ''
    '- Seeded by worker because no prior change log existed yet.'
  ) | Set-Content -Path $worklogPath -Encoding UTF8
}

function Get-RecentWorklogText {
  Ensure-WorklogFile

  try {
    $lines = Get-Content $worklogPath -Encoding UTF8
    if (-not $lines) {
      return '(worklog is empty)'
    }

    $tail = $lines | Select-Object -Last 20
    return ($tail -join [Environment]::NewLine)
  }
  catch {
    return '(failed to read worklog)'
  }
}

function Write-IterationPrompt {
  param(
    [string]$DestinationPath
  )

  Ensure-WorklogFile

  $basePrompt = Get-Content $promptPath -Raw -Encoding UTF8
  $recentWorklog = Get-RecentWorklogText

  @(
    $basePrompt.TrimEnd()
    ''
    'Persistent worklog for this daemon:'
    "- Path: ``$worklogPath``"
    '- Read it before making changes, and use it to avoid repeating already-landed fixes unless fresh evidence shows regression.'
    '- Append one new bullet before exiting every iteration, even if the iteration only investigated and did not patch code.'
    ''
    'Recent worklog entries:'
    $recentWorklog
    ''
  ) | Set-Content -Path $DestinationPath -Encoding UTF8
}

function Ensure-WorklogEntry {
  param(
    [int]$Iteration,
    [datetime]$IterationStartedAt,
    [string]$LastMessagePath
  )

  Ensure-WorklogFile

  try {
    $worklogItem = Get-Item $worklogPath -ErrorAction Stop
    if ($worklogItem.LastWriteTimeUtc -ge $IterationStartedAt.ToUniversalTime()) {
      return
    }
  }
  catch {
  }

  $fallbackMessage = 'No explicit worklog update was written during this iteration.'
  if (Test-Path $LastMessagePath) {
    try {
      $raw = (Get-Content $LastMessagePath -Raw -Encoding UTF8).Trim()
      if ($raw.Length -gt 0) {
        $singleLine = ($raw -replace '\s+', ' ').Trim()
        if ($singleLine.Length -gt 220) {
          $singleLine = $singleLine.Substring(0, 220).TrimEnd()
        }
        $fallbackMessage = "No explicit worklog update was written; fallback summary from final message: $singleLine"
      }
    }
    catch {
    }
  }

  $timestamp = (Get-Date).ToString('o')
  Add-Content -Path $worklogPath -Encoding UTF8 -Value "- ${timestamp}: Iteration $Iteration fallback note. $fallbackMessage"
}

function Ensure-MinecraftDaemon {
  try {
    $statusRaw = & powershell -ExecutionPolicy Bypass -File $minecraftDaemonStatusScript
    if ($LASTEXITCODE -eq 0 -and $statusRaw) {
      return
    }
  }
  catch {
  }

  Write-WorkerLog 'starting stream+gemma minecraft daemon'
  & powershell -ExecutionPolicy Bypass -File $minecraftDaemonStartScript | Out-Null
}

function Get-BackoffSeconds {
  param(
    [int]$ExitCode,
    [string]$LastMessagePath
  )

  $delay = 15
  if ($ExitCode -ne 0) {
    $delay = 30
  }

  if (Test-Path $LastMessagePath) {
    try {
      $text = Get-Content $LastMessagePath -Raw
      if ($text -match 'rate limit|429|too many requests') {
        return 300
      }
    }
    catch {
    }
  }

  return $delay
}

Write-WorkerLog 'codex_worker_started'
Ensure-WorklogFile
Update-Status -State 'starting'

$iteration = 0
while (-not (Test-StopRequested)) {
  $iteration += 1
  Ensure-MinecraftDaemon

  $timestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
  $iterationDir = Join-Path $runtimeDir "iteration-$timestamp"
  New-Item -ItemType Directory -Force -Path $iterationDir | Out-Null

  $stdoutPath = Join-Path $iterationDir 'codex.stdout.log'
  $stderrPath = Join-Path $iterationDir 'codex.stderr.log'
  $lastMessagePath = Join-Path $iterationDir 'codex-last-message.txt'
  $iterationPromptPath = Join-Path $iterationDir 'codex-prompt.txt'
  $iterationStartedAt = Get-Date

  Write-IterationPrompt -DestinationPath $iterationPromptPath

  Update-Status -State 'running' -Extra @{
    iteration = $iteration
    iterationDir = $iterationDir
    lastLaunchAt = (Get-Date).ToString('o')
    lastMessagePath = $lastMessagePath
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    iterationPromptPath = $iterationPromptPath
  }

  Write-WorkerLog "starting codex iteration=$iteration dir=$iterationDir"

  try {
    Get-Content $iterationPromptPath -Raw | codex exec `
      --dangerously-bypass-approvals-and-sandbox `
      --skip-git-repo-check `
      -C $codexRepoRoot `
      -o $lastMessagePath `
      - > $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
  }
  catch {
    $_ | Out-String | Set-Content -Path $stderrPath -Encoding UTF8
    $exitCode = 1
  }

  Write-WorkerLog "finished codex iteration=$iteration exitCode=$exitCode"
  Ensure-WorklogEntry -Iteration $iteration -IterationStartedAt $iterationStartedAt -LastMessagePath $lastMessagePath
  Update-Status -State 'waiting' -Extra @{
    iteration = $iteration
    iterationDir = $iterationDir
    lastExitCode = $exitCode
    lastExitAt = (Get-Date).ToString('o')
    lastMessagePath = $lastMessagePath
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    iterationPromptPath = $iterationPromptPath
  }

  if (Test-StopRequested) {
    break
  }

  $delay = Get-BackoffSeconds -ExitCode $exitCode -LastMessagePath $lastMessagePath
  Write-WorkerLog "sleeping seconds=$delay"
  Start-Sleep -Seconds $delay
}

Update-Status -State 'stopped' -Extra @{
  finishedAt = (Get-Date).ToString('o')
}
Write-WorkerLog 'codex_worker_stopped'
