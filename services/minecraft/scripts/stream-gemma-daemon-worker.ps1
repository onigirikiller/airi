$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'runtime\live-daemon'
$statusPath = Join-Path $runtimeDir 'launcher-status.json'
$stopFlagPath = Join-Path $runtimeDir 'stop.flag'
$sessionLogPath = Join-Path $runtimeDir 'launcher-session.log'
$fabricClientLaunchInfoPath = Join-Path $runtimeDir 'fabric-client-launch-info.json'
$supervisorStatusPath = Join-Path $repoRoot 'runtime\soak-supervisor\status.json'
$supervisorSummaryPath = Join-Path $repoRoot 'runtime\soak-supervisor\summary.json'
$envFilePath = Join-Path $repoRoot '.env'
$envLocalFilePath = Join-Path $repoRoot '.env.local'
$script:Win32ProcessInspectionUnavailableLogged = $false

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if (Test-Path $stopFlagPath) {
  Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue
}

function Write-LauncherLog {
  param(
    [string]$Message
  )

  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $sessionLogPath -Value $line -Encoding UTF8
}

function Update-LauncherStatus {
  param(
    [string]$State,
    [hashtable]$Extra = @{}
  )

  $status = [ordered]@{
    workerPid = $PID
    updatedAt = (Get-Date).ToString('o')
    state = $State
    mode = 'stream'
    model = if (-not [string]::IsNullOrWhiteSpace($env:LLM_MODEL)) { $env:LLM_MODEL } elseif (-not [string]::IsNullOrWhiteSpace($env:OPENAI_MODEL)) { $env:OPENAI_MODEL } else { 'unset' }
    stopOnVictory = $true
    repoRoot = $repoRoot
    sessionLogPath = $sessionLogPath
    supervisorStatusPath = $supervisorStatusPath
    supervisorSummaryPath = $supervisorSummaryPath
  }

  foreach ($key in $Extra.Keys) {
    $status[$key] = $Extra[$key]
  }

  $status | ConvertTo-Json | Set-Content -Path $statusPath -Encoding UTF8
}

function Get-SafeWin32ProcessSnapshot {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop)
  }
  catch {
    if (-not $script:Win32ProcessInspectionUnavailableLogged) {
      Write-LauncherLog "Win32_Process inspection unavailable; continuing with reduced runtime detection: $($_.Exception.Message)"
      $script:Win32ProcessInspectionUnavailableLogged = $true
    }

    return @()
  }
}

function Test-LocalTcpPortOpen {
  param(
    [int]$Port,
    [string]$Host = '127.0.0.1',
    [int]$TimeoutMs = 1000
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $asyncResult = $client.BeginConnect($Host, $Port, $null, $null)
    if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
      return $false
    }

    $client.EndConnect($asyncResult) | Out-Null
    return $true
  }
  catch {
    return $false
  }
  finally {
    try {
      $client.Dispose()
    }
    catch {
    }
  }
}

function Resolve-NodeExecutablePath {
  try {
    return (Get-Command node -ErrorAction Stop).Source
  }
  catch {
    Write-LauncherLog "Failed to resolve node executable: $($_.Exception.Message)"
    return $null
  }
}

function Resolve-TsxCliPath {
  $candidates = @(
    (Join-Path $repoRoot '..\..\node_modules\tsx\dist\cli.mjs'),
    (Join-Path $repoRoot 'node_modules\tsx\dist\cli.mjs')
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  Write-LauncherLog "Failed to locate tsx CLI. checked=$($candidates -join ';')"
  return $null
}

function Resolve-LatestCompiledRuntime {
  $compiledRuntimeParent = Join-Path $repoRoot 'runtime'
  if (-not (Test-Path $compiledRuntimeParent)) {
    return $null
  }

  return Get-ChildItem $compiledRuntimeParent -Directory -Filter 'compiled-run-*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Resolve-CompiledSoakSupervisorLaunch {
  $compiledRuntime = Resolve-LatestCompiledRuntime
  if (-not $compiledRuntime) {
    return $null
  }

  $supervisorScriptPath = Join-Path $compiledRuntime.FullName 'scripts\soak-supervisor.js'
  $mainScriptPath = Join-Path $compiledRuntime.FullName 'src\main.js'
  if (-not (Test-Path $supervisorScriptPath) -or -not (Test-Path $mainScriptPath)) {
    Write-LauncherLog "Compiled runtime missing soak supervisor or main entrypoint. runtime=$($compiledRuntime.FullName)"
    return $null
  }

  return [ordered]@{
    RuntimeRoot = $compiledRuntime.FullName
    SupervisorScriptPath = (Resolve-Path $supervisorScriptPath).Path
    MainScriptPath = (Resolve-Path $mainScriptPath).Path
  }
}

function Invoke-SoakSupervisor {
  param(
    [string]$RunLogPath
  )

  $nodeExecutablePath = Resolve-NodeExecutablePath
  $compiledLaunch = Resolve-CompiledSoakSupervisorLaunch
  $tsxCliPath = Resolve-TsxCliPath
  $tsSupervisorScriptPath = Join-Path $repoRoot 'scripts\soak-supervisor.ts'
  $resolvedEnvFilePath = if (Test-Path $envFilePath) { (Resolve-Path $envFilePath).Path } else { $envFilePath }
  $resolvedEnvLocalFilePath = if (Test-Path $envLocalFilePath) { (Resolve-Path $envLocalFilePath).Path } else { $envLocalFilePath }
  if ([string]::IsNullOrWhiteSpace($nodeExecutablePath)) {
    Write-LauncherLog 'Unable to launch soak supervisor because node could not be resolved.'
    return 1
  }

  $arguments = @()
  if ($compiledLaunch) {
    $env:SOAK_SUPERVISOR_COMMAND = "`"$nodeExecutablePath`" `"--env-file=$resolvedEnvFilePath`" `"--env-file-if-exists=$resolvedEnvLocalFilePath`" `"$($compiledLaunch.MainScriptPath)`""
    $env:SOAK_SUPERVISOR_LOG_DIR = Join-Path $repoRoot 'runtime\soak-supervisor'
    $arguments = @(
      "--env-file=$resolvedEnvFilePath",
      "--env-file-if-exists=$resolvedEnvLocalFilePath",
      $compiledLaunch.SupervisorScriptPath
    )
    Write-LauncherLog "Launching compiled soak supervisor runtime=$($compiledLaunch.RuntimeRoot)"
  }
  else {
    if ([string]::IsNullOrWhiteSpace($tsxCliPath) -or -not (Test-Path $tsSupervisorScriptPath)) {
      Write-LauncherLog "Unable to launch soak supervisor directly. node=$nodeExecutablePath tsx=$tsxCliPath supervisorScriptExists=$([bool](Test-Path $tsSupervisorScriptPath))"
      return 1
    }

    Remove-Item Env:SOAK_SUPERVISOR_COMMAND -ErrorAction SilentlyContinue
    Remove-Item Env:SOAK_SUPERVISOR_LOG_DIR -ErrorAction SilentlyContinue
    $arguments = @(
      $tsxCliPath,
      "--env-file=$resolvedEnvFilePath",
      "--env-file-if-exists=$resolvedEnvLocalFilePath",
      $tsSupervisorScriptPath
    )
    Write-LauncherLog 'Launching tsx soak supervisor because no compiled runtime was available'
  }

  try {
    & $nodeExecutablePath @arguments *>> $RunLogPath
    return $LASTEXITCODE
  }
  catch {
    $_ | Out-String | Add-Content -Path $RunLogPath -Encoding UTF8
    Write-LauncherLog "Direct soak supervisor launch failed: $($_.Exception.Message)"
    return 1
  }
}

function Test-StopRequested {
  return Test-Path $stopFlagPath
}

function Test-VictoryReached {
  if (-not (Test-Path $supervisorSummaryPath)) {
    return $false
  }

  try {
    $summary = Get-Content $supervisorSummaryPath -Raw | ConvertFrom-Json
    return $summary.eventTypeCounts.victory_detected -ge 1
  }
  catch {
    return $false
  }
}

function Get-MinecraftBotPort {
  foreach ($candidatePath in @($envLocalFilePath, $envFilePath)) {
    if (-not (Test-Path $candidatePath)) {
      continue
    }

    try {
      foreach ($line in Get-Content $candidatePath) {
        if ($line -match "^\s*BOT_PORT\s*=\s*['""]?(?<port>\d+)") {
          return [int]$Matches.port
        }
      }
    }
    catch {
      Write-LauncherLog "Failed to read BOT_PORT from ${candidatePath}: $($_.Exception.Message)"
    }
  }

  return 25565
}

function Get-InstanceLockPath {
  $lockDir = Join-Path ([System.IO.Path]::GetTempPath()) 'airi-minecraft-locks'
  $botPort = Get-MinecraftBotPort
  return Join-Path $lockDir "port-$botPort.lock"
}

function Test-IsLegacyMinecraftRuntimeCommandLine {
  param(
    [AllowNull()]
    [string]$CommandLine
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $false
  }

  $normalized = $CommandLine.Replace('/', '\')

  return $normalized -match '@proj-airi/minecraft-bot\s+(dev|start)\b' -or
    $normalized -match '\\services\\minecraft\\src\\main\.ts\b' -or
    $normalized -match '@proj-airi/minecraft-bot\s+soak:supervisor\b' -or
    $normalized -match '\\services\\minecraft\\scripts\\soak-supervisor\.ts\b' -or
    $normalized -match 'pnpm\.js"\s+soak:supervisor\b'
}

function Stop-ProcessTreeById {
  param(
    [int]$ProcessId,
    [string]$Reason
  )

  if ($ProcessId -le 0 -or $ProcessId -eq $PID) {
    return
  }

  $target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $target) {
    return
  }

  try {
    Write-LauncherLog "Stopping existing minecraft runtime process pid=$ProcessId reason=$Reason"
    Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$ProcessId", '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
  }
  catch {
    Write-LauncherLog "Failed to stop pid=$ProcessId reason=${Reason}: $($_.Exception.Message)"
  }
}

function Add-ProcessIdToSet {
  param(
    [System.Collections.Generic.HashSet[int]]$TargetIds,
    $Value
  )

  $parsedProcessId = 0
  if ([int]::TryParse([string]$Value, [ref]$parsedProcessId) -and $parsedProcessId -gt 0) {
    $null = $TargetIds.Add($parsedProcessId)
  }
}

function Stop-LegacyMinecraftRuntimeProcesses {
  $targetIds = [System.Collections.Generic.HashSet[int]]::new()
  $lockOwnerIds = [System.Collections.Generic.HashSet[int]]::new()
  $lockPayload = $null
  $targets = Get-SafeWin32ProcessSnapshot | Where-Object {
    $_.ProcessId -ne $PID -and (Test-IsLegacyMinecraftRuntimeCommandLine -CommandLine $_.CommandLine)
  }

  foreach ($target in $targets) {
    Add-ProcessIdToSet -TargetIds $targetIds -Value $target.ProcessId
  }

  $instanceLockPath = Get-InstanceLockPath
  if (Test-Path $instanceLockPath) {
    try {
      $lockPayload = Get-Content $instanceLockPath -Raw | ConvertFrom-Json
      foreach ($lockedProcessId in @($lockPayload.parentPid, $lockPayload.pid)) {
        Add-ProcessIdToSet -TargetIds $targetIds -Value $lockedProcessId
        Add-ProcessIdToSet -TargetIds $lockOwnerIds -Value $lockedProcessId
      }
    }
    catch {
      Write-LauncherLog "Failed to inspect instance lock at ${instanceLockPath}: $($_.Exception.Message)"
    }
  }

  foreach ($targetId in ($targetIds | Sort-Object -Descending)) {
    $reason = if ($lockOwnerIds.Contains([int]$targetId)) {
      'instance_lock_owner'
    }
    else {
      'legacy_runtime_match'
    }

    Stop-ProcessTreeById -ProcessId $targetId -Reason $reason
  }
}

function Test-LauncherRestartRequired {
  if (-not (Test-Path $supervisorStatusPath)) {
    return $false
  }

  try {
    $status = Get-Content $supervisorStatusPath -Raw | ConvertFrom-Json
    return $status.pendingRestartReason -eq 'launcher_restart_required'
  }
  catch {
    Write-LauncherLog "Failed to inspect supervisor restart request: $($_.Exception.Message)"
    return $false
  }
}

function Save-FabricMinecraftLaunchInfo {
  param(
    [hashtable]$LaunchInfo,
    [string]$Source
  )

  if (-not $LaunchInfo -or [string]::IsNullOrWhiteSpace([string]$LaunchInfo.ExecutablePath)) {
    return
  }

  $payload = [ordered]@{
    executablePath = [string]$LaunchInfo.ExecutablePath
    arguments = [string]$LaunchInfo.Arguments
    source = $Source
    updatedAt = (Get-Date).ToString('o')
  }

  try {
    $payload | ConvertTo-Json | Set-Content -Path $fabricClientLaunchInfoPath -Encoding UTF8
  }
  catch {
    Write-LauncherLog "Failed to persist Fabric client launch info: $($_.Exception.Message)"
  }
}

function Get-CachedFabricMinecraftLaunchInfo {
  if (-not (Test-Path $fabricClientLaunchInfoPath)) {
    return $null
  }

  try {
    $cached = Get-Content $fabricClientLaunchInfoPath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$cached.executablePath)) {
      return $null
    }

    return [ordered]@{
      ExecutablePath = [string]$cached.executablePath
      Arguments = [string]$cached.arguments
      Source = if ([string]::IsNullOrWhiteSpace([string]$cached.source)) { 'cache' } else { [string]$cached.source }
      UpdatedAt = [string]$cached.updatedAt
    }
  }
  catch {
    Write-LauncherLog "Failed to read cached Fabric client launch info: $($_.Exception.Message)"
    return $null
  }
}

function Get-RunningFabricMinecraftClientProcess {
  return Get-SafeWin32ProcessSnapshot | Where-Object {
    ($_.Name -in @('javaw.exe', 'java.exe')) -and
      -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
      $_.CommandLine -match 'net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient'
  } | Sort-Object CreationDate -Descending | Select-Object -First 1
}

function Get-VisibleMinecraftGameWindowProcess {
  return Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq 'javaw' -and
      -not [string]::IsNullOrWhiteSpace([string]$_.MainWindowTitle) -and
      [string]$_.MainWindowTitle -match '^Minecraft'
  } | Sort-Object Id -Descending | Select-Object -First 1
}

function Get-MinecraftLauncherUiProcesses {
  return Get-SafeWin32ProcessSnapshot | Where-Object {
    $_.Name -eq 'Minecraft.exe' -and
      -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
      ([string]$_.CommandLine).Contains('--launcherui')
  }
}

function Stop-MinecraftLauncherUiProcesses {
  param(
    [string]$Reason
  )

  $launcherUiProcessIds = [System.Collections.Generic.HashSet[int]]::new()
  $launcherUiProcesses = Get-MinecraftLauncherUiProcesses

  foreach ($launcherUiProcess in $launcherUiProcesses) {
    Add-ProcessIdToSet -TargetIds $launcherUiProcessIds -Value $launcherUiProcess.ProcessId
  }

  foreach ($launcherUiProcessId in ($launcherUiProcessIds | Sort-Object -Descending)) {
    Stop-ProcessTreeById -ProcessId $launcherUiProcessId -Reason $Reason
  }
}

function Test-FabricBridgeListenerReady {
  $bridgePort = 8089
  foreach ($candidatePath in @($envLocalFilePath, $envFilePath)) {
    if (-not (Test-Path $candidatePath)) {
      continue
    }

    try {
      foreach ($line in Get-Content $candidatePath) {
        if ($line -match "^\s*FABRIC_BRIDGE_PORT\s*=\s*['""]?(?<port>\d+)") {
          $bridgePort = [int]$Matches.port
          break
        }
      }
    }
    catch {
      Write-LauncherLog "Failed to read FABRIC_BRIDGE_PORT from ${candidatePath}: $($_.Exception.Message)"
    }
  }

  return Test-LocalTcpPortOpen -Port $bridgePort
}

function Wait-ForFabricMinecraftBridgeReady {
  param(
    [int]$TimeoutSeconds = 60,
    [int]$StableChecksRequired = 3
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stableChecks = 0

  while ((Get-Date) -lt $deadline) {
    $fabricClient = Get-RunningFabricMinecraftClientProcess
    $visibleGameWindow = Get-VisibleMinecraftGameWindowProcess
    $bridgeListening = Test-FabricBridgeListenerReady

    if ($bridgeListening) {
      $parsedCommand = Split-ProcessCommandLine -CommandLine ([string]$fabricClient.CommandLine)
      if ($parsedCommand) {
        Save-FabricMinecraftLaunchInfo -LaunchInfo $parsedCommand -Source "running_pid=$($fabricClient.ProcessId)"
      }
      elseif ($visibleGameWindow) {
        Write-LauncherLog "Fabric bridge listener recovered while Minecraft gameplay window pid=$($visibleGameWindow.Id) was active."
      }

      $stableChecks++
      if ($stableChecks -ge $StableChecksRequired) {
        return $true
      }
    }
    else {
      $stableChecks = 0
    }

    Start-Sleep -Seconds 2
  }

  return $false
}

function Split-ProcessCommandLine {
  param(
    [AllowNull()]
    [string]$CommandLine
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $null
  }

  $match = [regex]::Match($CommandLine, '^\s*(?:"(?<exe>[^"]+)"|(?<exe>\S+))(?:\s+(?<args>.*))?$')
  if (-not $match.Success) {
    return $null
  }

  return [ordered]@{
    ExecutablePath = $match.Groups['exe'].Value
    Arguments = $match.Groups['args'].Value
  }
}

function Get-FabricMinecraftLaunchInfo {
  $fabricClient = Get-RunningFabricMinecraftClientProcess
  if ($fabricClient) {
    $parsedCommand = Split-ProcessCommandLine -CommandLine ([string]$fabricClient.CommandLine)
    if ($parsedCommand) {
      Save-FabricMinecraftLaunchInfo -LaunchInfo $parsedCommand -Source "running_pid=$($fabricClient.ProcessId)"
      $parsedCommand['Source'] = "running_pid=$($fabricClient.ProcessId)"
      return $parsedCommand
    }

    Write-LauncherLog "Failed to parse running Fabric client command line for pid=$($fabricClient.ProcessId); falling back to cached launch info if available."
  }

  return Get-CachedFabricMinecraftLaunchInfo
}

function Start-FabricMinecraftClientFromLaunchInfo {
  param(
    [hashtable]$LaunchInfo,
    [string]$Reason
  )

  if (-not $LaunchInfo -or [string]::IsNullOrWhiteSpace([string]$LaunchInfo.ExecutablePath)) {
    return $false
  }

  $workingDirectory = Join-Path $env:APPDATA '.minecraft'
  $maxRelaunchAttempts = 3

  for ($relaunchAttempt = 1; $relaunchAttempt -le $maxRelaunchAttempts; $relaunchAttempt++) {
    if ($relaunchAttempt -gt 1) {
      Write-LauncherLog "Retrying Fabric Minecraft relaunch attempt=$relaunchAttempt reason=$Reason after bridge recovery failed"
      Stop-MinecraftLauncherUiProcesses -Reason "${Reason}_recovery_attempt_$relaunchAttempt"
      Start-Sleep -Seconds 2
    }

    try {
      $relaunched = Start-Process -FilePath ([string]$LaunchInfo.ExecutablePath) `
        -ArgumentList ([string]$LaunchInfo.Arguments) `
        -WorkingDirectory $workingDirectory `
        -PassThru
      Write-LauncherLog "Relaunched Fabric Minecraft client pid=$($relaunched.Id) attempt=$relaunchAttempt reason=$Reason executable=$([string]$LaunchInfo.ExecutablePath) source=$([string]$LaunchInfo.Source)"

      if (Wait-ForFabricMinecraftBridgeReady -TimeoutSeconds 60 -StableChecksRequired 3) {
        Write-LauncherLog "Fabric Minecraft bridge recovered after relaunch attempt=$relaunchAttempt reason=$Reason"
        Start-Sleep -Seconds 5
        return $true
      }

      Write-LauncherLog "Fabric Minecraft relaunch attempt=$relaunchAttempt reason=$Reason did not restore a stable Fabric bridge within timeout"
    }
    catch {
      Write-LauncherLog "Failed to relaunch Fabric Minecraft client attempt=${relaunchAttempt} reason=${Reason}: $($_.Exception.Message)"
    }
  }

  Write-LauncherLog "Fabric Minecraft client failed to restore a stable bridge after $maxRelaunchAttempts relaunch attempts reason=$Reason"
  Stop-MinecraftLauncherUiProcesses -Reason "${Reason}_recovery_exhausted"
  Start-Sleep -Seconds 2
  return $false
}

function Restart-FabricMinecraftClientIfNeeded {
  if (-not (Test-LauncherRestartRequired)) {
    return
  }

  $fabricClient = Get-RunningFabricMinecraftClientProcess
  $launchInfo = $null
  if ($fabricClient) {
    $launchInfo = Split-ProcessCommandLine -CommandLine ([string]$fabricClient.CommandLine)
    if (-not $launchInfo) {
      Write-LauncherLog "Supervisor requested a launcher restart, but the Fabric client command line could not be parsed for pid=$($fabricClient.ProcessId)."
      $launchInfo = Get-CachedFabricMinecraftLaunchInfo
    }
    else {
      Save-FabricMinecraftLaunchInfo -LaunchInfo $launchInfo -Source "running_pid=$($fabricClient.ProcessId)"
      $launchInfo['Source'] = "running_pid=$($fabricClient.ProcessId)"
    }
  }
  else {
    $launchInfo = Get-CachedFabricMinecraftLaunchInfo
  }

  if (-not $launchInfo) {
    Write-LauncherLog 'Supervisor requested a launcher restart, but no running Fabric client or cached launch info was detected.'
    return
  }

  if ($fabricClient) {
    Write-LauncherLog "Restarting Fabric Minecraft client pid=$($fabricClient.ProcessId) reason=launcher_restart_required"
    Stop-ProcessTreeById -ProcessId ([int]$fabricClient.ProcessId) -Reason 'launcher_restart_required'
    Start-Sleep -Seconds 2
  }

  [void](Start-FabricMinecraftClientFromLaunchInfo -LaunchInfo $launchInfo -Reason 'launcher_restart_required')
}

function Test-FabricBridgeDisconnectedWithoutClient {
  $launcherUiProcesses = Get-MinecraftLauncherUiProcesses
  if (-not $launcherUiProcesses) {
    return $false
  }

  return -not (Get-RunningFabricMinecraftClientProcess)
}

function Ensure-FabricMinecraftBridgeReadyBeforeSoakStart {
  $fabricClient = Get-RunningFabricMinecraftClientProcess
  $visibleGameWindow = Get-VisibleMinecraftGameWindowProcess
  $bridgeListening = Test-FabricBridgeListenerReady

  if ($bridgeListening) {
    $parsedCommand = Split-ProcessCommandLine -CommandLine ([string]$fabricClient.CommandLine)
    if ($parsedCommand) {
      Save-FabricMinecraftLaunchInfo -LaunchInfo $parsedCommand -Source "running_pid=$($fabricClient.ProcessId)"
    }
    elseif ($visibleGameWindow) {
      Write-LauncherLog "Fabric bridge listener is already live; proceeding with visible Minecraft gameplay window pid=$($visibleGameWindow.Id) even though Fabric command-line inspection was unavailable."
    }
    else {
      Write-LauncherLog 'Fabric bridge listener is already live; proceeding without a matching Fabric client process snapshot.'
    }

    return $true
  }

  if ($visibleGameWindow) {
    Write-LauncherLog "Minecraft gameplay window pid=$($visibleGameWindow.Id) is already open but the Fabric bridge listener is not ready yet; starting soak supervisor in deferred bridge-wait mode instead of forcing a client relaunch."
    return $true
  }

  $launchInfo = Get-FabricMinecraftLaunchInfo
  if (-not $launchInfo) {
    Write-LauncherLog "Fabric bridge unavailable before soak start, and no launch info was available. bridgeListening=$bridgeListening fabricClientPresent=$([bool]$fabricClient) visibleWindowPresent=$([bool]$visibleGameWindow)"
    return $false
  }

  Write-LauncherLog "Fabric bridge unavailable before soak start; attempting recovery source=$([string]$launchInfo.Source) bridgeListening=$bridgeListening fabricClientPresent=$([bool]$fabricClient)"
  return Start-FabricMinecraftClientFromLaunchInfo -LaunchInfo $launchInfo -Reason 'prelaunch_bridge_unavailable'
}

$env:AUTONOMY_MODE = 'stream'
$env:AIRA_PERSONA_MODE = 'builtin'
$env:LLM_MODEL = 'airi-gemma3-4b-chat'
$env:LLM_REASONING_MODEL = 'airi-gemma3-4b'
$env:AUTONOMY_LLM_MODEL = 'airi-gemma3-4b'
$env:MINECRAFT_BOT_MAX_RESTARTS_IN_WINDOW = '0'
$env:SOAK_SUPERVISOR_MAX_RESTARTS_PER_HOUR = '0'
$env:SOAK_SUPERVISOR_STOP_ON_VICTORY = 'true'
$env:SOAK_SUPERVISOR_STARTUP_GRACE_MS = '120000'
$env:SOAK_SUPERVISOR_MONITOR_FAILURE_TIMEOUT_MS = '300000'
$env:SOAK_SUPERVISOR_STATE_STALL_TIMEOUT_MS = '420000'
$env:SOAK_SUPERVISOR_STDOUT_IDLE_TIMEOUT_MS = '420000'

Write-LauncherLog 'launcher_started'
Update-LauncherStatus -State 'starting'
Write-LauncherLog 'legacy_runtime_cleanup_started'
Stop-LegacyMinecraftRuntimeProcesses
Write-LauncherLog 'legacy_runtime_cleanup_finished'

$attempt = 0
while (-not (Test-StopRequested)) {
  if (Test-VictoryReached) {
    Write-LauncherLog 'victory_detected_before_launch'
    break
  }

  $attempt += 1
  $runTimestamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
  $runLogPath = Join-Path $runtimeDir "soak-supervisor-$runTimestamp.log"

  Write-LauncherLog "preflight_started attempt=$attempt"
  Restart-FabricMinecraftClientIfNeeded
  if (-not (Ensure-FabricMinecraftBridgeReadyBeforeSoakStart)) {
    Write-LauncherLog "Fabric bridge preflight failed attempt=$attempt; delaying before next loop"
    Update-LauncherStatus -State 'restarting' -Extra @{
      attempt = $attempt
      activeRunLogPath = $runLogPath
      lastExitCode = 'bridge_preflight_failed'
      lastExitAt = (Get-Date).ToString('o')
    }
    Start-Sleep -Seconds 10
    continue
  }
  Stop-LegacyMinecraftRuntimeProcesses
  Update-LauncherStatus -State 'running' -Extra @{
    attempt = $attempt
    activeRunLogPath = $runLogPath
    lastLaunchAt = (Get-Date).ToString('o')
  }
  Write-LauncherLog "starting_soak_supervisor attempt=$attempt log=$runLogPath"
  $exitCode = Invoke-SoakSupervisor -RunLogPath $runLogPath

  if (Test-VictoryReached) {
    Write-LauncherLog "victory_detected_after_exit exitCode=$exitCode"
    break
  }

  if (Test-StopRequested) {
    Write-LauncherLog "stop_requested exitCode=$exitCode"
    break
  }

  Write-LauncherLog "soak_supervisor_exited exitCode=$exitCode"
  Update-LauncherStatus -State 'restarting' -Extra @{
    attempt = $attempt
    activeRunLogPath = $runLogPath
    lastExitCode = $exitCode
    lastExitAt = (Get-Date).ToString('o')
  }

  if (Test-FabricBridgeDisconnectedWithoutClient) {
    Write-LauncherLog 'Detected launcher UI without a running Fabric client after soak supervisor exit; cleaning up launcher UI before next loop'
    Stop-MinecraftLauncherUiProcesses -Reason 'launcher_ui_without_fabric_client'
  }

  Start-Sleep -Seconds 10
}

$finalState = if (Test-VictoryReached) {
  'victory'
}
elseif (Test-StopRequested) {
  'stopped'
}
else {
  'exited'
}

Update-LauncherStatus -State $finalState -Extra @{
  finishedAt = (Get-Date).ToString('o')
}
Write-LauncherLog "launcher_finished state=$finalState"
