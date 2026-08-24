# Deckhand - Windows installer: run at boot as a service, or at logon as a
# startup program. Pick whichever fits how you sign in:
#
#   startup  (recommended for Microsoft-account / PIN sign-ins)
#            Scheduled task at logon, hidden, auto-restarts on crash.
#            No password needed. Starts when you log in.
#
#   service  (best on local accounts / always-on machines)
#            NSSM Windows service. Starts at boot before login, but needs a
#            local account password - Microsoft-account sign-ins usually
#            reject service logon.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1                     # asks which
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Mode startup
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Mode service -Account .\you   # elevated
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall          # removes either
param(
  [ValidateSet('service', 'startup', '')]
  [string]$Mode = '',
  [string]$Name = 'Deckhand',
  [string]$Account = '',
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $root 'start-hub.cmd'

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Nssm {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
    Where-Object FullName -like '*win64*' | Select-Object -First 1 -ExpandProperty FullName
  if ($found) { return $found }
  Write-Host '== installing NSSM (service wrapper) =='
  winget install --id NSSM.NSSM --accept-source-agreements --accept-package-agreements | Out-Null
  Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
    Where-Object FullName -like '*win64*' | Select-Object -First 1 -ExpandProperty FullName
}

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Host "== startup task '$Name' removed =="
  }
  if (Get-Service $Name -ErrorAction SilentlyContinue) {
    if (-not (Test-Admin)) { throw "Removing the service needs an elevated PowerShell." }
    $nssm = Find-Nssm
    & $nssm stop $Name 2>$null
    & $nssm remove $Name confirm
    Write-Host "== service '$Name' removed =="
  }
  if (-not $task -and -not (Get-Service $Name -ErrorAction SilentlyContinue)) {
    Write-Host 'nothing installed under that name'
  }
  exit 0
}

if (-not $Mode) {
  Write-Host 'How should Deckhand start?'
  Write-Host '  1) Startup program - at logon, no password needed (recommended for Microsoft-account sign-ins)'
  Write-Host '  2) Windows service - at boot before login, needs a local account password'
  $pick = Read-Host 'Choose 1 or 2'
  $Mode = if ($pick -eq '2') { 'service' } else { 'startup' }
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '== npm install =='
  Push-Location $root
  npm install --no-audit --no-fund
  Pop-Location
}

if ($Mode -eq 'startup') {
  # clean up a competing service so two supervisors never fight over the port
  if (Get-Service $Name -ErrorAction SilentlyContinue) {
    Write-Host "NOTE: a service named '$Name' exists - remove it (elevated, -Uninstall) to avoid double-starts."
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-WindowStyle Hidden -NonInteractive -Command `"& '$launcher'`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $Name
  Write-Host "== startup task '$Name' installed and started - runs at every logon =="
  exit 0
}

# ---- service mode ----
if (-not (Test-Admin)) { throw 'Service mode needs an elevated (Administrator) PowerShell.' }
$nssm = Find-Nssm
if (-not $nssm) { throw 'NSSM not found and winget install failed - install NSSM manually.' }

if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Host "== removed startup task '$Name' (service replaces it) =="
}
if (Get-Service $Name -ErrorAction SilentlyContinue) {
  Write-Host "== replacing existing service '$Name' =="
  & $nssm stop $Name 2>$null
  & $nssm remove $Name confirm
}

& $nssm install $Name 'C:\Windows\System32\cmd.exe' "/c $launcher"
& $nssm set $Name AppDirectory $root
& $nssm set $Name AppEnvironmentExtra 'DECKHAND_SERVICE=1'
& $nssm set $Name AppExit Default Restart
& $nssm set $Name AppRestartDelay 60000
& $nssm set $Name Start SERVICE_AUTO_START
& $nssm set $Name Description 'Deckhand fleet node'

if ($Account) {
  $pw = Read-Host "Password for $Account" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
  & $nssm set $Name ObjectName $Account $plain
  $plain = $null
  Write-Host '== starting =='
  Start-Service $Name
  Get-Service $Name | Format-List Name, Status
} else {
  Write-Host ''
  Write-Host "Service '$Name' created (not started)."
  Write-Host 'IMPORTANT: set the logon account before starting, or the hub'
  Write-Host 'runs as SYSTEM and cannot see your projects or Claude login:'
  Write-Host "  services.msc -> $Name -> Log On -> This account -> .\<you> + password"
  Write-Host "  then: Start-Service $Name"
}
