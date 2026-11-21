# Our Shared Roots: build, check and deploy to Firebase (Windows PowerShell 5.1 or PowerShell 7).
# macOS / Linux users can run deploy.sh, which takes the same options.
#
# Usage (from any folder):
#   .\deploy.ps1                  # build, check, confirm, deploy everything firebase.json defines
#   .\deploy.ps1 -DryRun          # do every check and the build, print the firebase commands, deploy nothing
#   .\deploy.ps1 -Test            # also run npm test and the Firestore rules tests first (slow; needs Chrome / Java)
#   .\deploy.ps1 -Only hosting    # hosting | rules | all (default all)
#   .\deploy.ps1 -Preview         # deploy the site to a temporary preview channel instead of live
#   .\deploy.ps1 -Yes             # skip the "type DEPLOY" confirmation
# More: -Channel NAME (preview channel, default "preview"), -Project ID, -Site DIR,
#       -SkipInstall (do not run npm ci / npm install).
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -DryRun

[CmdletBinding()]
param(
  [switch]$Test,
  [ValidateSet('hosting', 'rules', 'all')]
  [string]$Only = 'all',
  [switch]$Preview,
  [string]$Channel = 'preview',
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$SkipInstall,
  [string]$Project = '',
  [string]$Site = '',
  # Accepted for old habits; the script now deploys after the DEPLOY confirmation anyway.
  [switch]$DoDeploy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# Firebase project used when .firebaserc is missing. Leave empty to require .firebaserc or -Project.
$DefaultProject = ''

$Root = $PSScriptRoot
Set-Location -LiteralPath $Root

function Fail([string]$msg) {
  Write-Host ""
  Write-Host "ERROR: $msg" -ForegroundColor Red
  exit 1
}
function Warn([string]$msg) { Write-Host "  WARNING: $msg" -ForegroundColor Yellow }
function Ok([string]$msg) { Write-Host "  ok  $msg" }
function Step($n, [string]$text) {
  Write-Host ""
  Write-Host ("[{0}] {1}" -f $n, $text) -ForegroundColor Cyan
}
function Test-Cmd([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Run a native command; return its exit code. Output goes straight to the console.
function Invoke-Native([string]$exe, [string[]]$argList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # Out-Host keeps the command's output on screen and out of this function's return value.
  try { & $exe @argList | Out-Host; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  if ($null -eq $code) { $code = 0 }
  return $code
}
# Run a native command and capture stdout+stderr as text (stderr lines must not stop the script).
function Get-NativeOutput([string]$exe, [string[]]$argList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $exe @argList 2>&1 | ForEach-Object { "$_" }; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  return @{ Code = $code; Text = (@($out) -join "`n") }
}

if ($Channel -notmatch '^[A-Za-z0-9_-]+$') { Fail "-Channel may only use letters, digits, - and _." }
if ($Preview -and $Only -eq 'rules') { Fail "-Preview deploys only the site to a preview channel; it cannot be combined with -Only rules." }

if (-not $Site) { $Site = $Root }
if (-not (Test-Path -LiteralPath $Site -PathType Container)) { Fail "Site folder not found: $Site" }
$Site = (Resolve-Path -LiteralPath $Site).Path

Write-Host "Our Shared Roots deploy" -ForegroundColor Green
Write-Host "Project folder: $Root"
if ($Site -ne $Root) { Write-Host "Deploy folder:  $Site" }
if ($DryRun) { Write-Host "Mode: dry run (nothing will be deployed)" }
if ($DoDeploy) { Write-Host "Note: -DoDeploy is no longer needed; the script asks you to type DEPLOY before publishing." }

# ---------------------------------------------------------------------------
Step 1 "Check project files."
if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) { Fail "package.json is missing in $Root." }
Ok "package.json"
$fbPath = Join-Path $Site 'firebase.json'
if (-not (Test-Path -LiteralPath $fbPath)) {
  $cands = @(Get-ChildItem -LiteralPath $Root -Directory -Filter 'deploy-*' -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'firebase.json') } | ForEach-Object { $_.Name })
  if ($cands.Count -gt 0) { Fail ("firebase.json is missing in $Site. Pass the deploy folder made by setup, e.g. -Site " + $cands[0] + " (found: " + ($cands -join ', ') + ").") }
  Fail "firebase.json is missing in $Site. Run from the project folder (or pass -Site DIR)."
}
try { $fb = Get-Content -LiteralPath $fbPath -Raw | ConvertFrom-Json } catch { Fail "firebase.json is not valid JSON." }
Ok "firebase.json"

function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [array]) { $obj = $obj[0] }
  $p = $obj.PSObject.Properties[$name]
  if ($p) { return $p.Value } else { return $null }
}
$hosting = Get-Prop $fb 'hosting'
$fsCfg = Get-Prop $fb 'firestore'
$stCfg = Get-Prop $fb 'storage'
$allTargets = @()
$ruleFiles = @()
if ($hosting) { $allTargets += 'hosting' }
if (Get-Prop $fsCfg 'rules') { $allTargets += 'firestore:rules'; $ruleFiles += (Get-Prop $fsCfg 'rules') }
if (Get-Prop $fsCfg 'indexes') { $allTargets += 'firestore:indexes'; $ruleFiles += (Get-Prop $fsCfg 'indexes') }
if (Get-Prop $stCfg 'rules') { $allTargets += 'storage'; $ruleFiles += (Get-Prop $stCfg 'rules') }
if ($allTargets.Count -eq 0) { Fail "firebase.json defines nothing to deploy." }
$hostingPublic = Get-Prop $hosting 'public'
if ($hostingPublic -and $hostingPublic -ne 'dist') { Fail "firebase.json hosting.public is '$hostingPublic'; this project builds into dist/." }
foreach ($f in $ruleFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $Site $f))) { Fail "firebase.json refers to $f, which is missing." }
  Ok $f
}

# Project id: -Project, else .firebaserc, else $DefaultProject.
$rcProject = ''
$rcPath = Join-Path $Site '.firebaserc'
if (Test-Path -LiteralPath $rcPath) {
  try { $rc = Get-Content -LiteralPath $rcPath -Raw | ConvertFrom-Json } catch { Fail ".firebaserc is not valid JSON." }
  $rcProject = [string](Get-Prop (Get-Prop $rc 'projects') 'default')
}
if (-not $Project) {
  if ($rcProject -and $DefaultProject -and $rcProject -ne $DefaultProject) {
    Fail ".firebaserc names '$rcProject' but this script expects '$DefaultProject'. Pass -Project to choose."
  }
  if ($rcProject) { $Project = $rcProject } else { $Project = $DefaultProject }
}
if (-not $Project) { Fail "No Firebase project id. Add .firebaserc or pass -Project ID." }
if ($Project -cnotmatch '^[a-z0-9-]+$') { Fail "Project id '$Project' looks wrong (lowercase letters, digits and - only)." }
Ok "Firebase project: $Project"

# ---------------------------------------------------------------------------
Step 2 "Check tools."
if (-not (Test-Cmd 'node')) { Fail "Node.js is not installed. Install Node 22 LTS from https://nodejs.org and re-run." }
if (-not (Test-Cmd 'npm')) { Fail "npm is not on PATH (it comes with Node.js)." }
$nodeVer = (Get-NativeOutput 'node' @('-p', 'process.versions.node')).Text.Trim()
$parts = $nodeVer.Split('.')
$major = [int]$parts[0]; $minor = [int]$parts[1]
$nodeOldForTests = $false
if ($major -lt 20) { Fail "Node $nodeVer is too old. Vite needs Node 20 or newer (Node 22 LTS recommended)." }
Ok "Node $nodeVer"
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 12)) {
  $nodeOldForTests = $true
  Warn "Node is older than 22.12; the build works, but the browser tests (-Test) may not run."
}
Ok ("npm " + (Get-NativeOutput 'npm' @('-v')).Text.Trim())

$firebaseOk = $true
if (-not (Test-Cmd 'firebase')) {
  $firebaseOk = $false
  if ($DryRun) { Warn "Firebase CLI not found (needed for a real deploy): npm install -g firebase-tools" }
  else { Fail "Firebase CLI not found. Install it with: npm install -g firebase-tools, then run: firebase login" }
} else {
  $fv = (Get-NativeOutput 'firebase' @('--version')).Text.Trim().Split("`n")
  Ok ("Firebase CLI " + $fv[-1].Trim())
  $login = Get-NativeOutput 'firebase' @('login:list')
  $line = @($login.Text.Split("`n") | Where-Object { $_ -match 'logged in as' }) | Select-Object -First 1
  if ($line) {
    Ok ($line -replace '^[^A-Za-z]*', '')
  } else {
    $firebaseOk = $false
    if ($DryRun) { Warn "Firebase CLI is not logged in (run: firebase login)." }
    else { Fail "Firebase CLI is not logged in. Run: firebase login" }
  }
}

# ---------------------------------------------------------------------------
Step 3 "Install dependencies."
if ($SkipInstall) {
  Write-Host "  skipped (-SkipInstall)"
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) { Fail "node_modules is missing; run without -SkipInstall." }
} else {
  if (Test-Path -LiteralPath (Join-Path $Root 'package-lock.json')) { $npmArgs = @('ci', '--no-audit', '--no-fund') }
  else { $npmArgs = @('install', '--no-audit', '--no-fund') }
  Write-Host ("  npm " + $npmArgs[0])
  $res = Get-NativeOutput 'npm' $npmArgs
  Write-Host $res.Text
  if ($res.Code -ne 0) { Fail "npm $($npmArgs[0]) failed (exit $($res.Code))." }
  if ($res.Text -match 'fsevents') {
    Write-Host "  Note: the fsevents install-script message above is harmless. fsevents is an optional"
    Write-Host "  macOS file-watcher used only by the dev server; the build does not need it."
  }
}

# ---------------------------------------------------------------------------
function Find-Chrome {
  $c = @()
  if ($env:PUPPETEER_EXECUTABLE_PATH) { $c += $env:PUPPETEER_EXECUTABLE_PATH }
  if ($env:CHROME_PATH) { $c += $env:CHROME_PATH }
  if ($env:ProgramFiles) { $c += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($pf86) { $c += (Join-Path $pf86 'Google\Chrome\Application\chrome.exe') }
  if ($env:LOCALAPPDATA) { $c += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') }
  $c += '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  foreach ($p in $c) { if ($p -and (Test-Path -LiteralPath $p)) { return $true } }
  return (Test-Cmd 'google-chrome') -or (Test-Cmd 'chromium')
}
$pkg = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
function Test-NpmScript([string]$name) { $s = Get-Prop $pkg 'scripts'; return [bool](Get-Prop $s $name) }

Step 4 "Tests."
if (-not $Test) {
  Write-Host "  skipped (add -Test to run npm test and the Firestore rules tests first)"
} else {
  if (-not (Test-NpmScript 'test') -or -not (Test-Path -LiteralPath (Join-Path $Root 'test'))) {
    Warn "No test\ folder or test script here; skipping npm test."
  } elseif ($nodeOldForTests) {
    Warn "Node $nodeVer is older than 22.12; skipping the browser tests."
  } elseif (-not (Find-Chrome)) {
    Warn "Chrome not found (set PUPPETEER_EXECUTABLE_PATH); skipping the browser tests."
  } else {
    Write-Host "  npm test (builds and runs the page tests in headless Chrome; this takes a few minutes)"
    if ((Invoke-Native 'npm' @('test')) -ne 0) { Fail "npm test failed. Nothing was deployed." }
    Ok "npm test passed"
  }
  $javaOk = $false
  if (Test-Cmd 'java') { $javaOk = ((Get-NativeOutput 'java' @('-version')).Code -eq 0) }
  if (-not (Test-NpmScript 'test:rules') -or -not (Test-Path -LiteralPath (Join-Path $Root 'rules-test'))) {
    Warn "No rules-test\ folder here; skipping the Firestore rules tests."
  } elseif (-not $javaOk) {
    Warn "Java is not installed (the Firestore emulator needs it); skipping the rules tests."
  } else {
    Write-Host "  npm run test:rules (Firestore emulator)"
    if ((Invoke-Native 'npm' @('run', 'test:rules')) -ne 0) { Fail "Firestore rules tests failed. Nothing was deployed." }
    Ok "rules tests passed"
  }
}

# ---------------------------------------------------------------------------
Step 5 "Build the production site (npm run build)."
if ((Invoke-Native 'npm' @('run', 'build')) -ne 0) { Fail "Build failed. Nothing was deployed." }

Step 6 "Check the build."
$dist = Join-Path $Root 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) { Fail "dist\index.html is missing after the build." }
Ok "dist\index.html"
$assets = Join-Path $dist 'assets'
if (-not (Test-Path -LiteralPath $assets -PathType Container)) { Fail "dist\assets\ is missing after the build." }
$jsCount = @(Get-ChildItem -LiteralPath $assets -Filter '*.js' -File).Count
if ($jsCount -lt 1) { Fail "dist\assets\ has no JavaScript files." }
Ok "dist\assets ($jsCount JavaScript files)"
$bad = @('__TREE', '__ADMIN', '__MIGRATE', '__OSR_TEST_HOOKS__', 'installTestSession', 'setTestWrite')
$hits = @(Get-ChildItem -LiteralPath $dist -Recurse -File | Where-Object { $_.Extension -in '.js', '.mjs', '.html' } |
  Select-String -SimpleMatch -Pattern $bad | ForEach-Object { $_.Path.Substring($dist.Length + 1) + ': ' + $_.Pattern } | Sort-Object -Unique)
if ($hits.Count -gt 0) { Fail ("dist contains test hooks; do not deploy a test build:`n" + ($hits -join "`n")) }
Ok "no test hooks in dist"

if ($Site -ne $Root) {
  $siteDist = Join-Path $Site 'dist'
  if (-not (Test-Path -LiteralPath (Join-Path $siteDist 'config.js'))) { Fail "$siteDist\config.js is missing; re-run setup for that folder." }
  if ($DryRun) {
    Write-Host "  dry run: would copy the new dist into $siteDist (keeping its config.js)"
  } else {
    $new = Join-Path $Site 'dist.new'; $old = Join-Path $Site 'dist.old'
    foreach ($p in $new, $old) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }
    Copy-Item -LiteralPath $dist -Destination $new -Recurse
    Copy-Item -LiteralPath (Join-Path $siteDist 'config.js') -Destination (Join-Path $new 'config.js')
    Rename-Item -LiteralPath $siteDist -NewName 'dist.old'
    Rename-Item -LiteralPath $new -NewName 'dist'
    Remove-Item -LiteralPath $old -Recurse -Force
    Ok "copied the new dist into $siteDist (kept config.js)"
  }
}

# ---------------------------------------------------------------------------
Step 7 "Deploy."
$targets = @()
foreach ($t in $allTargets) {
  if ($Only -eq 'all' -or ($Only -eq 'hosting' -and $t -eq 'hosting') -or ($Only -eq 'rules' -and $t -ne 'hosting')) { $targets += $t }
}
if ($Preview) {
  if ($allTargets -notcontains 'hosting') { Fail "firebase.json has no hosting section to preview." }
  $desc = "the site to preview channel '$Channel' (expires in 7 days; it uses the LIVE database and rules)"
  $fbArgs = @('hosting:channel:deploy', $Channel, '--project', $Project, '--expires', '7d')
} else {
  if ($targets.Count -eq 0) { Fail "Nothing to deploy for -Only $Only with this firebase.json." }
  $desc = ($targets -join ',') + " to the LIVE project"
  $fbArgs = @('deploy', '--project', $Project, '--only', ($targets -join ','))
}
Write-Host "  Will deploy ${desc}:"
Write-Host ("    cd `"$Site`"; firebase " + ($fbArgs -join ' '))

if ($DryRun) {
  Write-Host ""
  Write-Host "Dry run finished. Nothing was deployed." -ForegroundColor Yellow
  if (-not $firebaseOk) { Write-Host "Before a real deploy: install the Firebase CLI and run firebase login." }
  exit 0
}

if (-not $Yes) {
  Write-Host ""
  $answer = Read-Host "Type DEPLOY to publish to $Project"
  if ($answer -cne 'DEPLOY') { Fail "Deploy cancelled. Nothing was deployed." }
}

Push-Location -LiteralPath $Site
try { $code = Invoke-Native 'firebase' $fbArgs } finally { Pop-Location }
if ($code -ne 0) { Fail "firebase reported an error (exit $code; see above)." }

Write-Host ""
Write-Host "Deploy finished." -ForegroundColor Green
Write-Host ""
Write-Host "After deploying:"
Write-Host "  1. Super Admin: sign in and make one small edit (any save). That save writes the"
Write-Host "     protected adminEmails list; then check Admin > People & access for the Admin roles."
Write-Host "  2. Reload (or close) tabs that were open before this deploy, on every device. Old tabs"
Write-Host "     run the old code and will say someone else saved first."
Write-Host "  3. Test on your phone: open the site, sign in, check the tree loads and an edit saves."
Write-Host "  4. Smoke-check: /  /admin.html  /admin  /migrate-log.html"
if ($Preview) { Write-Host "  The preview URL is printed above. It talks to the live database: test carefully." }
