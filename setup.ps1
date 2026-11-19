# Cross-platform entry point (Windows PowerShell). macOS / Linux users can run ./setup.sh.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js is required. Install it from https://nodejs.org and re-run."
}
& node (Join-Path $Root 'setup.mjs') @args
exit $LASTEXITCODE
