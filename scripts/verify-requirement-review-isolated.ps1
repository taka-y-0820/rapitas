param(
  [string]$SourceDb = (Join-Path $PSScriptRoot '..\rapitas-desktop\.data\rapitas-dev.db'),
  [switch]$CleanupStale
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$originalLocation = Get-Location
$savedDatabaseUrl = $env:DATABASE_URL
$savedProvider = $env:RAPITAS_DB_PROVIDER
$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("rapitas-claim-verify-" + [guid]::NewGuid())
$checkout = Join-Path $sandbox 'checkout'
$testDb = Join-Path $sandbox 'task901-copy.db'
$rootModulesLink = Join-Path $checkout 'node_modules'
$backendModulesLink = Join-Path $checkout 'rapitas-backend\node_modules'
$sqliteClientOutput = Join-Path $checkout 'rapitas-backend\generated\prisma-sqlite'
$postgresClientOutput = Join-Path $checkout 'rapitas-backend\generated\prisma-postgres'
$sharedPrismaRoots = $null
$sharedModulesBefore = $null

function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList) {
  Write-Output "START external: $FilePath $($ArgumentList -join ' ')"
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    Write-Output "FAILED external: $FilePath (exit $LASTEXITCODE)"
    throw "$FilePath failed with exit code $LASTEXITCODE"
  }
  Write-Output "SUCCESS external: $FilePath"
}

function Assert-PathWithin([string]$Child, [string]$Parent, [string]$Label) {
  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes its required parent: $childFull"
  }
}

function Get-TreeFingerprint([string[]]$Roots) {
  $records = foreach ($root in $Roots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -File -Recurse | Sort-Object FullName | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        "$($_.FullName)|$($_.Length)|$hash"
      }
    }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
    return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
  } finally {
    $sha.Dispose()
  }
}

function Remove-VerifiedJunction([string]$Link, [string]$ExpectedTarget) {
  if (-not (Test-Path -LiteralPath $Link)) { return }
  $item = Get-Item -LiteralPath $Link -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw "Refusing to remove a non-junction dependency path: $Link"
  }
  $actualTarget = [System.IO.Path]::GetFullPath([string]$item.Target).TrimEnd('\')
  $requiredTarget = [System.IO.Path]::GetFullPath($ExpectedTarget).TrimEnd('\')
  if (-not $actualTarget.Equals($requiredTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove junction with unexpected target: $Link -> $actualTarget"
  }
  # Remove the reparse point itself. Unlike Remove-Item, this non-recursive
  # API does not enumerate or delete any child in the junction target.
  [System.IO.Directory]::Delete($item.FullName, $false)
  if (Test-Path -LiteralPath $Link) {
    throw "Junction remains after non-recursive unlink: $Link"
  }
}

try {
  $staleSandboxes = Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) `
    -Directory -Filter 'rapitas-claim-verify-*' -ErrorAction SilentlyContinue
  if ($CleanupStale) {
    if (@($staleSandboxes).Count -ne 1) {
      throw "Cleanup requires exactly one stale isolated-verification directory; found $(@($staleSandboxes).Count)"
    }
    $stale = $staleSandboxes[0].FullName
    Assert-PathWithin $stale ([System.IO.Path]::GetTempPath()) 'Stale cleanup target'
    $staleBackendLink = Join-Path $stale 'checkout\rapitas-backend\node_modules'
    $staleRootLink = Join-Path $stale 'checkout\node_modules'
    Remove-VerifiedJunction $staleBackendLink (Join-Path $repo 'rapitas-backend\node_modules')
    Remove-VerifiedJunction $staleRootLink (Join-Path $repo 'node_modules')
    $remainingLinks = Get-ChildItem -LiteralPath $stale -Force -Recurse -Attributes ReparsePoint `
      -ErrorAction Stop
    if ($remainingLinks) {
      throw "Refusing recursive cleanup because another reparse point remains: $($remainingLinks.FullName -join ', ')"
    }
    Remove-Item -LiteralPath $stale -Recurse -Force
    if (Test-Path -LiteralPath $stale) {
      throw "Stale cleanup target remains: $stale"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules') -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $repo 'rapitas-backend\node_modules') -PathType Container)) {
      throw 'A shared node_modules source is missing after cleanup'
    }
    Write-Output "Removed stale isolated-verification directory: $stale"
    return
  }
  if ($staleSandboxes) {
    $paths = ($staleSandboxes.FullName -join ', ')
    throw "Stale isolated-verification directory exists; inspect its processes and junctions before retrying: $paths"
  }
  New-Item -ItemType Directory -Path $sandbox | Out-Null
  Invoke-Checked 'git' @('clone', '--no-hardlinks', $repo, $checkout)
  Set-Location $checkout

  $overlay = @(
    'rapitas-backend/prisma/schema/core.prisma',
    'rapitas-backend/prisma/schema/workflow.prisma',
    'rapitas-backend/prisma/schema.desktop/core.prisma',
    'rapitas-backend/prisma/schema.desktop/workflow.prisma',
    'rapitas-backend/prisma/schema-changes/20260911010000_add_requirement_review_claims.postgresql.sql',
    'rapitas-backend/prisma/schema-changes/20260911010000_add_requirement_review_claims.sqlite.sql',
    'rapitas-backend/routes/tasks/task-retry-handler.ts',
    'rapitas-backend/routes/tasks/task-retry-handler.test.ts',
    'rapitas-backend/routes/tasks/tasks.ts',
    'rapitas-backend/services/workflow/queue-skip-policy.ts',
    'rapitas-backend/services/workflow/queue-skip-policy.test.ts',
    'rapitas-backend/services/workflow/requirement-replan-commit.ts',
    'rapitas-backend/services/workflow/requirement-replan-commit.test.ts',
    'rapitas-backend/services/workflow/requirement-replan-service.ts',
    'rapitas-backend/services/workflow/requirement-review-claim.ts',
    'rapitas-backend/services/workflow/requirement-review-claim.test.ts',
    'rapitas-backend/scripts/backfill-requirement-review-claim.ts',
    'rapitas-backend/scripts/apply-requirement-review-schema-sqlite.ts',
    'rapitas-backend/scripts/sqlite-online-backup.ts'
  )
  foreach ($relative in $overlay) {
    $source = Join-Path $repo $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Overlay source is missing: $source"
    }
    $destination = Join-Path $checkout $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($sourceHash -ne $destinationHash) {
      throw "Overlay hash mismatch: $relative"
    }
    Write-Output "overlay SHA256 $sourceHash $relative"
  }

  New-Item -ItemType Junction -Path $rootModulesLink -Target (Join-Path $repo 'node_modules') | Out-Null
  New-Item -ItemType Junction -Path $backendModulesLink -Target (Join-Path $repo 'rapitas-backend\node_modules') | Out-Null

  Assert-PathWithin $sqliteClientOutput $checkout 'SQLite Prisma output'
  Assert-PathWithin $postgresClientOutput $checkout 'PostgreSQL Prisma output'
  if ($sqliteClientOutput.StartsWith((Join-Path $repo 'node_modules'), [System.StringComparison]::OrdinalIgnoreCase) -or
      $sqliteClientOutput.StartsWith((Join-Path $repo 'rapitas-backend\node_modules'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Prisma output resolves inside shared node_modules: $sqliteClientOutput"
  }
  Write-Output "SQLite Prisma output: $sqliteClientOutput"
  Write-Output "PostgreSQL Prisma output: $postgresClientOutput"

  $sharedPrismaRoots = @(
    (Join-Path $repo 'rapitas-backend\node_modules\.prisma'),
    (Join-Path $repo 'rapitas-backend\node_modules\@prisma\client'),
    (Join-Path $repo 'rapitas-backend\node_modules\prisma')
  )
  $sharedModulesBefore = Get-TreeFingerprint $sharedPrismaRoots

  Invoke-Checked 'bun' @((Join-Path $repo 'rapitas-backend\scripts\sqlite-online-backup.ts'), "--source=$SourceDb", "--target=$testDb")

  Set-Location (Join-Path $checkout 'rapitas-backend')
  $env:RAPITAS_DB_PROVIDER = 'sqlite'
  $env:DATABASE_URL = 'file:' + ($testDb -replace '\\', '/')

  Invoke-Checked 'bun' @('run', 'scripts/generate-sqlite-prisma-schema.cjs')
  $prisma = Join-Path $backendModulesLink '.bin\prisma.cmd'
  $eslint = Join-Path $backendModulesLink '.bin\eslint.cmd'
  $tsc = Join-Path $backendModulesLink '.bin\tsc.cmd'
  Invoke-Checked 'bun' @('run', 'scripts/apply-requirement-review-schema-sqlite.ts', "--database=$testDb")
  Write-Output 'START generate: SQLite Prisma Client (no database connection)'
  Invoke-Checked $prisma @('generate')
  $resolvedSqliteOutput = (Resolve-Path -LiteralPath $sqliteClientOutput).Path
  Assert-PathWithin $resolvedSqliteOutput $checkout 'Generated SQLite Prisma client'
  if (((Get-Item -LiteralPath $sqliteClientOutput).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Generated SQLite Prisma client is unexpectedly a link: $sqliteClientOutput"
  }
  Write-Output "SUCCESS generate: SQLite Prisma Client at $resolvedSqliteOutput"

  # TypeScript statically imports the PostgreSQL client even during SQLite
  # tests. `prisma generate` reads schema/config only; this syntactically valid
  # URL is never connected to and the generated output remains inside clone.
  $env:RAPITAS_DB_PROVIDER = 'postgresql'
  $env:DATABASE_URL = 'postgresql://generate_only:generate_only@127.0.0.1:1/generate_only'
  Write-Output 'START generate: PostgreSQL Prisma Client (no database connection)'
  Invoke-Checked $prisma @('generate')
  $resolvedPostgresOutput = (Resolve-Path -LiteralPath $postgresClientOutput).Path
  Assert-PathWithin $resolvedPostgresOutput $checkout 'Generated PostgreSQL Prisma client'
  if (((Get-Item -LiteralPath $postgresClientOutput).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Generated PostgreSQL Prisma client is unexpectedly a link: $postgresClientOutput"
  }
  Write-Output "SUCCESS generate: PostgreSQL Prisma Client at $resolvedPostgresOutput"

  $env:RAPITAS_DB_PROVIDER = 'sqlite'
  $env:DATABASE_URL = 'file:' + ($testDb -replace '\\', '/')
  Invoke-Checked 'bun' @('run', 'scripts/backfill-requirement-review-claim.ts', '--task-id=901', '--reason=legacy_repeated_unknown', '--verify-automatic')
  Invoke-Checked 'bun' @('run', 'scripts/backfill-requirement-review-claim.ts', '--task-id=901', '--reason=legacy_repeated_unknown', '--verify-automatic')
  Invoke-Checked 'bun' @('test', '--isolate', 'services/workflow/requirement-review-claim.test.ts', 'services/workflow/requirement-replan-commit.test.ts', 'services/workflow/queue-skip-policy.test.ts', 'routes/tasks/task-retry-handler.test.ts')
  Invoke-Checked $eslint @('services/workflow/requirement-review-claim.ts', 'services/workflow/requirement-replan-service.ts', 'services/workflow/requirement-review-claim.test.ts', 'scripts/backfill-requirement-review-claim.ts', 'scripts/apply-requirement-review-schema-sqlite.ts')
  Invoke-Checked $tsc @('--noEmit')
  Invoke-Checked 'bun' @('build', 'index.ts', '--target=bun', "--outdir=$sandbox/build")
} finally {
  Set-Location $originalLocation
  $env:DATABASE_URL = $savedDatabaseUrl
  $env:RAPITAS_DB_PROVIDER = $savedProvider
  $fingerprintError = $null
  if ($null -ne $sharedModulesBefore -and $null -ne $sharedPrismaRoots) {
    Write-Output 'START safety: shared Prisma dependency fingerprint comparison'
    try {
      $sharedModulesAfter = Get-TreeFingerprint $sharedPrismaRoots
      if ($sharedModulesBefore -ne $sharedModulesAfter) {
        throw 'Shared Prisma dependency files changed during isolated verification'
      }
      Write-Output 'SUCCESS safety: shared Prisma dependency fingerprint unchanged'
    } catch {
      $fingerprintError = $_
      Write-Output "FAILED safety: shared Prisma dependency fingerprint comparison: $($_.Exception.Message)"
    }
  }
  if (Test-Path -LiteralPath $sandbox) {
    Write-Output "START cleanup: $sandbox"
    Assert-PathWithin $sandbox ([System.IO.Path]::GetTempPath()) 'Cleanup target'
    Remove-VerifiedJunction $backendModulesLink (Join-Path $repo 'rapitas-backend\node_modules')
    Remove-VerifiedJunction $rootModulesLink (Join-Path $repo 'node_modules')
    Remove-Item -LiteralPath $sandbox -Recurse -Force
    Write-Output "SUCCESS cleanup: $sandbox"
  }
  if ($null -ne $fingerprintError) {
    throw $fingerprintError
  }
}
