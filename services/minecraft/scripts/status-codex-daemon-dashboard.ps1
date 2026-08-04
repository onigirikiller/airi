$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'runtime\codex-dashboard'
$statusPath = Join-Path $runtimeDir 'status.json'

if (-not (Test-Path $statusPath)) {
  Write-Output 'STATUS=missing'
  exit 0
}

$status = Get-Content $statusPath -Raw | ConvertFrom-Json
$status | ConvertTo-Json -Depth 8
