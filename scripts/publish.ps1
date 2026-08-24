# Publish a Deckhand release to the fleet's release origin (vps-node).
# Run from the repo root:  powershell -File scripts\publish.ps1
# Every hub with build > 0 sees the new build and can self-update from the
# ADMIN panel (or auto-notifies via its periodic check).
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host '== build web =='
npm run build | Out-Null

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
# +40 epoch offset: history was flattened to one commit at build 33 —
# keeps build numbers monotonic so deployed hubs still see new releases
$build = 40 + [int](git rev-list --count HEAD)
$version = "$($pkg.version)+$build"
$stamp = @{ version = $version; build = $build; builtAt = (Get-Date -Format o) } | ConvertTo-Json
[IO.File]::WriteAllText("$PWD\version.json", $stamp)  # no BOM
Write-Host "== version $version =="

$tmp = Join-Path $env:TEMP "deckhand-release-$build.tgz"
# explicit Windows tar - a unix tar earlier on PATH mis-parses C:\ as a hostname
& "$env:SystemRoot\System32\tar.exe" -czf $tmp --exclude 'server/public/claudehub.zip' `
  server web hooks scripts cli version.json `
  package.json package-lock.json tsconfig.json start-hub.cmd README.md .gitignore
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

Write-Host '== upload to vps-node =='
ssh root@vps-node 'mkdir -p /opt/deckhand/data/releases'
scp -q $tmp root@vps-node:/opt/deckhand/data/releases/deckhand-release.tgz
# transition: pre-rename hubs still fetch the old artifact name
ssh root@vps-node 'cp /opt/deckhand/data/releases/deckhand-release.tgz /opt/deckhand/data/releases/claudehub-release.tgz'
scp -q version.json root@vps-node:/opt/deckhand/data/releases/version.json
Remove-Item $tmp
# the stamp belongs to the release bundle only - a stamped dev tree would
# make this machine's hub think it is updatable and clobber itself
Remove-Item "$PWD\version.json"

Write-Host "== published build $build =="
