param(
  [ValidateSet('Preflight', 'Prepare', 'Apply', 'Recover')]
  [string]$Action = 'Preflight',
  [string]$RecoveryDirectory,
  [string]$RepositoryRoot
)

$ErrorActionPreference = 'Stop'
$repo = if ($RepositoryRoot) {
  (Resolve-Path -LiteralPath $RepositoryRoot).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$backend = Join-Path $repo 'rapitas-backend'
$db = Join-Path $repo 'rapitas-desktop\.data\rapitas-dev.db'
$baselineCommit = '8627f8e7581b4ba270dc84b5c2cc78d593fa0637'
$hashManifest = Join-Path $repo 'scripts\requirement-review-validated-hashes.json'
$savedLocation = Get-Location
$savedUrl = $env:DATABASE_URL
$savedProvider = $env:RAPITAS_DB_PROVIDER

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  Write-Output "START $Command $($Arguments -join ' ')"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
  Write-Output "SUCCESS $Command"
}

function Assert-ValidatedFiles {
  $manifest = Get-Content -LiteralPath $hashManifest -Raw | ConvertFrom-Json
  foreach ($property in $manifest.PSObject.Properties) {
    $path = Join-Path $repo $property.Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing validated file: $path" }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($actual -ne $property.Value) { throw "Validated hash mismatch: $($property.Name)" }
  }
  Write-Output "SUCCESS validated hashes: $(@($manifest.PSObject.Properties).Count) files"
}

function Assert-BaselineCommit {
  $type = & git -C $repo cat-file -t $baselineCommit
  if ($LASTEXITCODE -ne 0 -or $type -ne 'commit') { throw "Recovery commit unavailable: $baselineCommit" }
  $metadata = & git -C $repo show -s '--format=%H %cI %s' $baselineCommit
  if ($LASTEXITCODE -ne 0) { throw 'Could not read recovery commit' }
  Write-Output "SUCCESS recovery baseline: $metadata"
}

function Assert-ThemeStopped {
  $snapshot = Get-Content -LiteralPath (Join-Path $repo '.supervisor\measurements\continuous-monitor.jsonl') -Tail 1 | ConvertFrom-Json
  if ($snapshot.autoRun.enabled -ne $false -or $snapshot.autoRun.status -ne 'idle' -or
      $snapshot.system.activeExecutions -ne 0 -or $snapshot.system.runningExecutions -ne 0 -or
      $snapshot.system.queueDepth -ne 0 -or $snapshot.system.activePreviewCount -ne 0) {
    throw 'Theme/queue/execution state is not safely stopped'
  }
  Write-Output 'SUCCESS Theme and execution queues are stopped'
}

function Stop-BackendVerified {
  $listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction Stop
  if (@($listener).Count -ne 1) { throw 'Port 3001 listener is not unique' }
  $backendPid = $listener.OwningProcess
  $backendProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$backendPid"
  $wrapperPid = $backendProcess.ParentProcessId
  if (-not (Get-Process -Id $wrapperPid -ErrorAction SilentlyContinue)) { throw 'Backend wrapper not found' }
  $headers = @{}
  if ($env:ADMIN_SECRET) { $headers['x-admin-token'] = $env:ADMIN_SECRET }
  $response = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/agents/shutdown' -Headers $headers
  if (-not $response.success) { throw 'Graceful shutdown was rejected' }
  $deadline = (Get-Date).AddSeconds(35)
  do {
    Start-Sleep -Seconds 1
    $healthResponded = $false
    try { $null = Invoke-WebRequest 'http://localhost:3001/health' -TimeoutSec 2; $healthResponded = $true } catch {}
    $backendAlive = [bool](Get-Process -Id $backendPid -ErrorAction SilentlyContinue)
    $wrapperAlive = [bool](Get-Process -Id $wrapperPid -ErrorAction SilentlyContinue)
    if (-not $healthResponded -and -not $backendAlive -and -not $wrapperAlive) { break }
  } while ((Get-Date) -lt $deadline)
  if ($healthResponded -or $backendAlive -or $wrapperAlive) { throw 'Backend shutdown could not be proved' }
  foreach ($path in @($db, "$db-wal", "$db-shm")) {
    if (Test-Path -LiteralPath $path) {
      $stream = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')
      $stream.Dispose()
    }
  }
  Write-Output 'SUCCESS backend, wrapper and SQLite handles are stopped'
}

function Start-WrapperAndVerify([string]$Wrapper) {
  Start-Process powershell.exe -ArgumentList @('-NoProfile', '-File', $Wrapper) -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(40)
  do {
    Start-Sleep -Seconds 1
    try {
      $health = Invoke-RestMethod 'http://localhost:3001/health' -TimeoutSec 2
      if ($health.status -eq 'healthy') { Write-Output 'SUCCESS backend health'; return }
    } catch {}
  } while ((Get-Date) -lt $deadline)
  throw 'Backend did not become healthy'
}

try {
  Set-Location $repo
  Assert-ValidatedFiles
  Assert-BaselineCommit
  Assert-ThemeStopped
  if ($Action -eq 'Preflight') {
    Write-Output 'PREFLIGHT ONLY: no filesystem, DB, process or environment mutation performed'
    return
  }

  if ($Action -eq 'Prepare') {
    if (-not $RecoveryDirectory) {
      $RecoveryDirectory = Join-Path $repo ('rapitas-desktop\.data\requirement-review-recovery-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    if (Test-Path -LiteralPath $RecoveryDirectory) { throw 'Recovery directory already exists' }
    New-Item -ItemType Directory -Path $RecoveryDirectory | Out-Null
    $statusBefore = & git -C $repo status --porcelain=v1
    if ($LASTEXITCODE -ne 0) { throw 'Could not record working-tree status' }
    Set-Content -LiteralPath (Join-Path $RecoveryDirectory 'working-status.txt') -Value $statusBefore
    Invoke-Checked git @('-C', $repo, 'diff', '--binary', "--output=$(Join-Path $RecoveryDirectory 'working-unstaged.patch')")
    Invoke-Checked git @('-C', $repo, 'diff', '--cached', '--binary', "--output=$(Join-Path $RecoveryDirectory 'working-staged.patch')")
    $untrackedRoot = Join-Path $RecoveryDirectory 'working-untracked'
    New-Item -ItemType Directory -Path $untrackedRoot | Out-Null
    $untracked = & git -C $repo ls-files --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate untracked files' }
    foreach ($relative in $untracked) {
      $destination = Join-Path $untrackedRoot $relative
      New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
      Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination
    }
    $recoveryCode = Join-Path $RecoveryDirectory 'recovery-code'
    Invoke-Checked git @('clone', '--no-hardlinks', $repo, $recoveryCode)
    Invoke-Checked git @('-C', $recoveryCode, 'checkout', '--detach', $baselineCommit)
    New-Item -ItemType Junction -Path (Join-Path $recoveryCode 'node_modules') -Target (Join-Path $repo 'node_modules') | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $recoveryCode 'rapitas-backend\node_modules') -Target (Join-Path $repo 'rapitas-backend\node_modules') | Out-Null
    if (Test-Path -LiteralPath (Join-Path $backend '.env')) {
      Copy-Item -LiteralPath (Join-Path $backend '.env') -Destination (Join-Path $recoveryCode 'rapitas-backend\.env')
    }
    New-Item -ItemType Directory -Path (Join-Path $RecoveryDirectory 'clients-before') | Out-Null
    Copy-Item -LiteralPath (Join-Path $backend 'generated\prisma-sqlite') -Destination (Join-Path $RecoveryDirectory 'clients-before') -Recurse
    Copy-Item -LiteralPath (Join-Path $backend 'generated\prisma-postgres') -Destination (Join-Path $RecoveryDirectory 'clients-before') -Recurse
    Copy-Item -LiteralPath (Join-Path $backend 'generated') -Destination (Join-Path $recoveryCode 'rapitas-backend') -Recurse
    Set-Content -LiteralPath (Join-Path $RecoveryDirectory 'baseline-commit.txt') -Value $baselineCommit -NoNewline
    Write-Output "SUCCESS recovery set prepared: $RecoveryDirectory"
    return
  }

  if (-not $RecoveryDirectory -or -not (Test-Path -LiteralPath (Join-Path $RecoveryDirectory 'baseline-commit.txt'))) {
    throw 'A prepared RecoveryDirectory is required'
  }
  if ((Get-Content -LiteralPath (Join-Path $RecoveryDirectory 'baseline-commit.txt') -Raw) -ne $baselineCommit) {
    throw 'Recovery directory baseline mismatch'
  }

  if ($Action -eq 'Apply') {
    Stop-BackendVerified
    $raw = Join-Path $RecoveryDirectory 'sqlite-before'
    New-Item -ItemType Directory -Path $raw | Out-Null
    foreach ($path in @($db, "$db-wal", "$db-shm")) { if (Test-Path $path) { Copy-Item -LiteralPath $path -Destination $raw } }
    $consistent = Join-Path $RecoveryDirectory 'rapitas-dev.consistent.db'
    Invoke-Checked bun @('run', (Join-Path $backend 'scripts\sqlite-online-backup.ts'), "--source=$db", "--target=$consistent")
    Set-Location $backend
    Invoke-Checked bun @('run', 'scripts/apply-requirement-review-schema-sqlite.ts', "--database=$db")
    $prisma = Join-Path $backend 'node_modules\.bin\prisma.cmd'
    $env:RAPITAS_DB_PROVIDER = 'sqlite'; $env:DATABASE_URL = 'file:' + ($db -replace '\\', '/')
    Invoke-Checked $prisma @('generate')
    $env:RAPITAS_DB_PROVIDER = 'postgresql'; $env:DATABASE_URL = 'postgresql://generate_only:generate_only@127.0.0.1:1/generate_only'
    Invoke-Checked $prisma @('generate')
    $env:RAPITAS_DB_PROVIDER = 'sqlite'; $env:DATABASE_URL = 'file:' + ($db -replace '\\', '/')
    Invoke-Checked bun @('run', 'scripts/backfill-requirement-review-claim.ts', '--task-id=901', '--reason=legacy_repeated_unknown', '--verify-automatic')
    Start-WrapperAndVerify (Join-Path $repo 'scripts\backend-wrapper.ps1')
    Assert-ThemeStopped
    Write-Output 'SUCCESS production apply; auto-run remains stopped'
    return
  }

  Stop-BackendVerified
  $failed = Join-Path $RecoveryDirectory ('failed-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $failed | Out-Null
  foreach ($path in @($db, "$db-wal", "$db-shm")) { if (Test-Path $path) { Move-Item -LiteralPath $path -Destination $failed } }
  Copy-Item -LiteralPath (Join-Path $RecoveryDirectory 'rapitas-dev.consistent.db') -Destination $db
  $recoveryCode = Join-Path $RecoveryDirectory 'recovery-code'
  $wrapper = Join-Path $RecoveryDirectory 'start-recovery.ps1'
  $wrapperBody = @"
`$env:TAURI_BUILD='true'
`$env:RAPITAS_DB_PROVIDER='sqlite'
`$env:DATABASE_URL='file:$($db -replace '\\','/')'
`$env:RAPITAS_DATA_DIR='$($repo)\rapitas-desktop\.data'
`$env:PORT='3001'
Set-Location '$recoveryCode\rapitas-backend'
bun run dev:stable
"@
  Set-Content -LiteralPath $wrapper -Value $wrapperBody
  Start-WrapperAndVerify $wrapper
  Write-Output "SUCCESS recovered with dedicated code $baselineCommit; current worktree untouched"
} finally {
  Set-Location $savedLocation
  $env:DATABASE_URL = $savedUrl
  $env:RAPITAS_DB_PROVIDER = $savedProvider
}
