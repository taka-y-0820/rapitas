param(
  [string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent),
  [Parameter(Mandatory=$true)][string]$DatabasePath,
  [ValidateRange(0,65535)][int]$Port = 3001,
  [ValidateSet('health','api')][string]$Mode = 'health'
)
$ErrorActionPreference = 'Stop'
$task901Repo = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$task901Database = (Resolve-Path -LiteralPath $DatabasePath).Path
if (-not (Test-Path -LiteralPath $task901Database -PathType Leaf)) { throw 'Existing SQLite file required' }
$env:RAPITAS_TASK901_MAINTENANCE=if($Mode -eq 'api'){'api'}else{'1'}
$env:RAPITAS_AUX_AI='off'
$env:TAURI_BUILD='true'
$env:RAPITAS_DB_PROVIDER='sqlite'
$env:DATABASE_URL='file:' + $task901Database
$env:RAPITAS_DATA_DIR=Split-Path $task901Database -Parent
$env:PORT=[string]$Port
Set-Location -LiteralPath (Join-Path $task901Repo 'rapitas-backend')
# Exactly one invocation. No dev.js, schema sync, generation, retry or normal-mode fallback.
& bun run dev:stable
exit $LASTEXITCODE
