@@echo off
@@rem ==========================================================================
@@rem Deckhand - Windows installer, downloaded from a fleet hub's /install page.
@@rem Double-click to install. SmartScreen may warn about an unknown publisher:
@@rem "More info" -> "Run anyway".
@@rem Dry run (prints every step, changes nothing):  deckhand-install.cmd -DryRun
@@rem The lines starting with @@ are the cmd wrapper; everything else is
@@rem PowerShell, extracted to %TEMP% and run from there.
@@rem ==========================================================================
@@setlocal
@@set "PSFILE=%TEMP%\deckhand-web-install.ps1"
@@findstr /v "^@@" "%~f0" > "%PSFILE%"
@@powershell -NoProfile -ExecutionPolicy Bypass -File "%PSFILE%" %*
@@echo.
@@pause
@@endlocal
@@goto :eof
param([switch]$DryRun, [switch]$Elevated)

# Deckhand web installer - PowerShell body (the @@ lines above are the cmd
# wrapper). Downloads the current release from the fleet's shelf, installs
# the hub as a Windows service, then explains how to make it run as you.
$ErrorActionPreference = 'Stop'
# the install subtree this file was downloaded from, e.g. http://host:5959/install
$Base = '__DECKHAND_BASE_URL__'
$Name = 'Deckhand'
$LogFile = Join-Path $env:TEMP 'deckhand-install.log'

function Say([string]$msg) { Write-Host ''; Write-Host "== $msg ==" }

function Done([int]$code) {
  try { Stop-Transcript | Out-Null } catch {}
  Write-Host ''
  Write-Host "Log of this run: $LogFile"
  Read-Host 'Press Enter to close this window'
  exit $code
}

# Print the step always; perform it only outside a dry run.
function Step([string]$what, [scriptblock]$action) {
  Write-Host ">> $what"
  if (-not $DryRun) { & $action }
}

function NodeMajor {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return 0 }
  $v = & node --version
  if ($v -match 'v(\d+)') { return [int]$Matches[1] }
  return 0
}

try { Start-Transcript -Path $LogFile -Append | Out-Null } catch {}

try {
  Write-Host "Deckhand installer - release shelf: $Base"
  if ($DryRun) { Write-Host 'DRY RUN: every step is printed, nothing is changed.' }
  if ($Base -like '__*') {
    Write-Host "This file must be downloaded from a hub's /install page (no shelf URL is embedded)."
    Done 1
  }

  # -- never clobber a running hub -----------------------------------------
  $existing = $null
  if (Get-Service $Name -ErrorAction SilentlyContinue) { $existing = "the Windows service '$Name' already exists" }
  elseif (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) { $existing = "the startup task '$Name' already exists" }
  else {
    try {
      $info = Invoke-RestMethod -Uri 'http://127.0.0.1:5959/api/hub-info' -TimeoutSec 3
      if ($info.hub) { $existing = "a hub already answers on port 5959 (machine '$($info.machine)', build $($info.build))" }
    } catch {}
  }
  if ($existing) {
    Write-Host "Not installing: $existing."
    Write-Host 'A running hub updates itself: dashboard -> ADMIN -> UPDATE.'
    Write-Host 'To remove an old install first (elevated PowerShell):'
    Write-Host '  powershell -ExecutionPolicy Bypass -File <install dir>\scripts\install.ps1 -Uninstall'
    Done 1
  }

  # -- the shelf must answer before anything is touched ---------------------
  try {
    $shelf = Invoke-RestMethod -Uri "$Base/version.json" -TimeoutSec 10
    Write-Host "Release on the shelf: build $($shelf.build) ($($shelf.version))"
  } catch {
    Write-Host "Cannot read $Base/version.json - is this machine on the tailnet (Tailscale signed in)?"
    Done 1
  }

  # -- self-elevate: the service and the firewall rules need admin ----------
  $me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $isAdmin = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin -and -not $DryRun) {
    Say 'requesting administrator rights (UAC) - the service and firewall rules need them'
    try {
      Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
      Write-Host 'The elevated installer window has finished.'
    } catch {
      Write-Host 'UAC was declined - nothing was installed.'
    }
    exit 0
  }

  # -- prerequisites ---------------------------------------------------------
  Say 'checking Tailscale'
  $ts = (Get-Command tailscale -ErrorAction SilentlyContinue) -or (Test-Path 'C:\Program Files\Tailscale\tailscale.exe')
  if ($ts) { Write-Host 'Tailscale: found' }
  else {
    Write-Host 'Tailscale was NOT found. The fleet needs every machine on the tailnet.'
    Write-Host 'Install it from https://tailscale.com/download and sign in, then re-run this installer.'
    if (-not $DryRun) {
      $go = Read-Host 'Continue without Tailscale (single-machine dashboard only)? [y/N]'
      if ($go -notmatch '^[yY]') { Done 1 }
    }
  }

  Say 'checking Node.js (20+ required)'
  $major = NodeMajor
  if ($major -ge 20) { Write-Host "Node.js: $(& node --version)" }
  else {
    if ($major -gt 0) { Write-Host "Node.js $(& node --version) is too old (20+ needed)." }
    else { Write-Host 'Node.js was not found.' }
    if ($DryRun) { Write-Host '>> would offer: winget install OpenJS.NodeJS.LTS' }
    else {
      $go = Read-Host 'Install Node.js LTS now with winget? [Y/n]'
      if ($go -match '^[nN]') { Write-Host 'Install Node.js 20+ yourself, then re-run this installer.'; Done 1 }
      winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      if ((NodeMajor) -lt 20) { Write-Host 'node is still not on PATH (a fresh terminal may be needed) - re-run this installer.'; Done 1 }
      Write-Host "Node.js: $(& node --version)"
    }
  }
  Write-Host 'Also needed for agent sessions: Claude Code installed and signed in as you'
  Write-Host '(https://claude.com/claude-code) - the hub itself runs without it.'

  # -- where -----------------------------------------------------------------
  Say 'where to install'
  $defaultDir = 'C:\Deckhand'
  $defaultProjects = Join-Path $env:USERPROFILE 'Projects'
  if ($DryRun) {
    $InstallDir = $defaultDir
    $ProjectsRoot = $defaultProjects
    Write-Host ">> would ask for the install folder (default $defaultDir) and the projects root (default $defaultProjects)"
  } else {
    $InstallDir = Read-Host "Install folder [$defaultDir]"
    if (-not $InstallDir) { $InstallDir = $defaultDir }
    $ProjectsRoot = Read-Host "Projects root - where your project folders live [$defaultProjects]"
    if (-not $ProjectsRoot) { $ProjectsRoot = $defaultProjects }
  }
  if (Test-Path (Join-Path $InstallDir 'package.json')) {
    Write-Host "note: $InstallDir already holds files - they will be updated in place."
  }

  # -- download, extract, install --------------------------------------------
  Say 'downloading and extracting the release'
  $tgz = Join-Path $env:TEMP 'deckhand-release.tgz'
  Step "download $Base/release.tgz" {
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/release.tgz" -OutFile $tgz
  }
  Step "create $InstallDir and $ProjectsRoot" {
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    New-Item -ItemType Directory -Force $ProjectsRoot | Out-Null
  }
  Step "extract into $InstallDir" {
    & "$env:SystemRoot\System32\tar.exe" -xzf $tgz -C $InstallDir
    if ($LASTEXITCODE -ne 0) { throw 'tar extract failed' }
    Remove-Item $tgz -ErrorAction SilentlyContinue
  }
  Step 'let signed-in users write here later (the service will run as you, not as SYSTEM)' {
    icacls $InstallDir /grant '*S-1-5-11:(OI)(CI)M' | Out-Null
  }

  Say 'npm install (a few minutes on first run)'
  Step "npm install in $InstallDir" {
    Push-Location $InstallDir
    try {
      npm install --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    } finally { Pop-Location }
  }

  Step "write hub-env.cmd (HUB_PROJECTS_ROOT=$ProjectsRoot)" {
    Set-Content -Path (Join-Path $InstallDir 'hub-env.cmd') -Value "set HUB_PROJECTS_ROOT=$ProjectsRoot" -Encoding Ascii
  }

  Say 'firewall rules (TCP + UDP 5959-5969, so other fleet machines reach this hub)'
  Step "inbound rule 'Deckhand' (TCP 5959-5969)" {
    if (-not (Get-NetFirewallRule -DisplayName 'Deckhand' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'Deckhand' -Direction Inbound -Action Allow -Protocol TCP -LocalPort '5959-5969' | Out-Null
    }
  }
  Step "inbound rule 'Deckhand beacon' (UDP 5959-5969, LAN discovery)" {
    if (-not (Get-NetFirewallRule -DisplayName 'Deckhand beacon' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'Deckhand beacon' -Direction Inbound -Action Allow -Protocol UDP -LocalPort '5959-5969' | Out-Null
    }
  }

  Say 'installing the Windows service'
  Step 'scripts\install.ps1 -Mode service (installs the NSSM service wrapper if needed)' {
    & (Join-Path $InstallDir 'scripts\install.ps1') -Mode service
  }
  Step "start the service '$Name' (as LocalSystem for now - see below)" {
    Start-Service $Name
  }

  Say 'waiting for the hub to answer on http://127.0.0.1:5959'
  if ($DryRun) { Write-Host '>> would wait up to 90 s for /api/hub-info' }
  else {
    $deadline = (Get-Date).AddSeconds(90)
    $up = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $null = Invoke-RestMethod -Uri 'http://127.0.0.1:5959/api/hub-info' -TimeoutSec 3
        $up = $true
        break
      } catch { Start-Sleep -Seconds 3 }
    }
    if ($up) { Write-Host 'The hub is up: http://127.0.0.1:5959' }
    else { Write-Host "The hub is not answering yet - check $InstallDir\data\hub.log" }
  }

  # -- the one thing a fresh service install cannot do by itself ------------
  $you = $env:USERNAME
  Say 'one step left: make the service run as YOU'
  Write-Host @"

The dashboard works already, but the service runs as LocalSystem - an
account with no user profile. Claude Code's and Codex's sign-ins live in
YOUR profile, so agent sessions cannot start until the service runs as you.

Make it run as your user - pick one:

  A) Elevated PowerShell (asks for your password, restarts the service):

       powershell -ExecutionPolicy Bypass -File "$InstallDir\scripts\install.ps1" -Mode service -Account .\$you

  B) services.msc -> $Name -> Properties -> Log On tab ->
     "This account": .\$you + your password, then restart the service.

Caveat: a service logon needs a LOCAL account password. If you sign in with
a Microsoft account or a PIN, Windows usually refuses it - either add a
local password to your account, or skip the service and use the startup
task instead (runs at logon as you, no password needed):

       powershell -ExecutionPolicy Bypass -File "$InstallDir\scripts\install.ps1" -Uninstall
       powershell -ExecutionPolicy Bypass -File "$InstallDir\scripts\install.ps1" -Mode startup

Dashboard:     http://127.0.0.1:5959
Install page:  $Base/
"@
  Done 0
} catch {
  Write-Host ''
  Write-Host "INSTALL FAILED: $($_.Exception.Message)"
  Done 1
}
