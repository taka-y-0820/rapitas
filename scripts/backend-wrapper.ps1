# backend-wrapper.ps1
#
# Standalone supervisor loop for the rapitas backend when it is NOT managed by
# rapitas-desktop/scripts/dev.js (e.g. the desktop dev harness lost its child
# after a graceful shutdown). Mirrors dev.js's environment and respawns on any
# non-zero exit — including the self-restart code 75 used by POST /agents/restart
# and the auto-restart-merged-code scheduler — but stops on a clean exit 0 so an
# intentional shutdown stays down.
#
# All backend console output is appended to .data/logs/backend-stdout-<date>.log
# so a supervisor can read info-level progress; the pino file sink only keeps
# warn+ in backend-<date>.log.
$env:TAURI_BUILD = 'true'
$env:RAPITAS_DB_PROVIDER = 'sqlite'
$env:DATABASE_URL = 'file:C:\Projects\rapitas\rapitas-desktop\.data\rapitas-dev.db'
$env:RAPITAS_DATA_DIR = 'C:\Projects\rapitas\rapitas-desktop\.data'
$env:PORT = '3001'
$logDir = 'C:\Projects\rapitas\rapitas-desktop\.data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location 'C:\Projects\rapitas\rapitas-backend'
while ($true) {
  $stamp = Get-Date -Format 'yyyy-MM-dd'
  $log = Join-Path $logDir "backend-stdout-$stamp.log"
  Add-Content -LiteralPath $log -Value "[sup-wrapper] $(Get-Date -Format o) starting bun run dev:stable (wrapper pid $PID)"
  # cmd handles the native redirection so bun's raw bytes land in the file.
  & cmd.exe /c "bun run dev:stable >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  Add-Content -LiteralPath $log -Value "[sup-wrapper] $(Get-Date -Format o) backend exited with code $code"
  if ($code -eq 0) { break }
  Start-Sleep -Seconds 5
}
