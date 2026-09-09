$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-aux-job.cs')
    $launchToken = $env:RAPITAS_AUX_JOB_TOKEN
    $launchCommand = $env:RAPITAS_AUX_JOB_COMMAND
    $launchDirectory = $env:RAPITAS_AUX_JOB_DIRECTORY
    $launchTimeout = [uint32]120000
    if ($env:RAPITAS_AUX_AI_CLI_TIMEOUT_MS) { $launchTimeout = [uint32]::Parse($env:RAPITAS_AUX_AI_CLI_TIMEOUT_MS) }
    # Do not propagate launch metadata into the CLI or its children.
    Remove-Item Env:RAPITAS_AUX_JOB_TOKEN, Env:RAPITAS_AUX_JOB_COMMAND, Env:RAPITAS_AUX_JOB_DIRECTORY
    [RapitasAuxJob]::Run($launchToken, $launchCommand, $launchDirectory, $launchTimeout)
} catch {
    [Console]::Error.WriteLine('Auxiliary job launcher failed: ' + $_.Exception.Message)
    exit 1
}
