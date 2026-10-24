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
  server web hooks mcp scripts cli gateway version.json `
  package.json package-lock.json tsconfig.json start-hub.cmd start-hub.sh README.md .gitignore
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

# $ErrorActionPreference does not cover native programs: a failed ssh/scp
# (vps-node unreachable, e.g. a VPN blocking the tailnet) used to fall through
# to "published". Check every exit code, and verify the origin at the end.
function Invoke-Checked([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "publish failed: $what (exit $LASTEXITCODE) - is vps-node reachable over the tailnet?" }
}

try {
  Write-Host '== upload to vps-node =='
  Invoke-Checked 'mkdir on vps-node' { ssh -o ConnectTimeout=15 root@vps-node 'mkdir -p /opt/deckhand/data/releases' }
  Invoke-Checked 'upload release' { scp -q -o ConnectTimeout=15 $tmp root@vps-node:/opt/deckhand/data/releases/deckhand-release.tgz }
  # transition: pre-rename hubs still fetch the old artifact name
  Invoke-Checked 'copy legacy artifact' { ssh -o ConnectTimeout=15 root@vps-node 'cp /opt/deckhand/data/releases/deckhand-release.tgz /opt/deckhand/data/releases/claudehub-release.tgz' }
  # version.json last: hubs only see the new build once the bundle is in place
  Invoke-Checked 'upload version.json' { scp -q -o ConnectTimeout=15 version.json root@vps-node:/opt/deckhand/data/releases/version.json }
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  # the stamp belongs to the release bundle only - a stamped dev tree would
  # make this machine's hub think it is updatable and clobber itself
  Remove-Item "$PWD\version.json" -ErrorAction SilentlyContinue
}

# what the fleet will actually see
try {
  $served = Invoke-RestMethod -Uri 'http://vps-node:5959/releases/version.json' -TimeoutSec 15
} catch {
  throw "publish uploaded but the release origin does not answer: $($_.Exception.Message)"
}
if ([int]$served.build -ne $build) { throw "publish failed: vps-node serves build $($served.build), expected $build" }

Write-Host "== published build $build (verified on vps-node) =="
