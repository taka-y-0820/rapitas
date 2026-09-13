$env:TAURI_BUILD='true'
$env:RAPITAS_DB_PROVIDER='sqlite'
$env:DATABASE_URL='file:C:\Projects\rapitas\rapitas-desktop\.data\rapitas-dev.db'
$env:RAPITAS_DATA_DIR='C:\Projects\rapitas\rapitas-desktop\.data'
$env:PORT='3001'
Set-Location 'C:\Projects\rapitas\rapitas-backend'
while ($true) {
  bun run dev:stable
  $code = $LASTEXITCODE
  Write-Host "[sup-wrapper] backend exited with code $code"
  if ($code -eq 0) { break }
  Write-Host '[sup-wrapper] respawning in 5s (close this window to stop)...'
  Start-Sleep -Seconds 5
}
