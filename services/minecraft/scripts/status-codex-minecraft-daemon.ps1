$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $repoRoot 'runtime\codex-daemon'
$statusPath = Join-Path $runtimeDir 'status.json'

if (-not (Test-Path $statusPath)) {
  Write-Output 'STATUS=missing'
  exit 0
}

$status = Get-Content $statusPath -Raw | ConvertFrom-Json
$status | ConvertTo-Json -Depth 8
