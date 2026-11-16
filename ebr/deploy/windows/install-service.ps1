# Installs B-Pharma EBR as a Windows service on a server without Docker (E19#2). Run as administrator, from the folder
# that holds the built application (dist, migrations, node_modules, package.json) and WinSW (winsw.exe, the service
# wrapper: https://github.com/winsw/winsw, version 2.12, its SHA-256 checked against the value the site records).
#   .\install-service.ps1 -DatabaseUrl "postgres://ebr:...@127.0.0.1:5432/ebr" -Port 4101
# PostgreSQL 16 is installed separately (the site's standard installer). Run on a Windows Server runner by the CI job
# "windows" (deploy/windows/ci-check.ps1, E24): install, migrate, first administrator, restart keeps the data, uninstall.
param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [int]$Port = 4101,
  [string]$ServiceName = "bpharma-ebr-$Port",
  [string]$Node = (Get-Command node -ErrorAction Stop).Source,
  # SHA-256 of WinSW-x64.exe v2.12.0 as published on github.com/winsw/winsw/releases (recorded 2026-11-16)
  [string]$WinswSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Resolve-Path (Join-Path $here '..\..')
if (-not (Test-Path (Join-Path $app 'dist\server\main.js'))) { throw "dist\server\main.js not found under $app: build the application first (npm run build)." }
if (-not (Test-Path (Join-Path $here 'winsw.exe'))) { throw "winsw.exe not found next to this script." }
$sha = (Get-FileHash -Algorithm SHA256 (Join-Path $here 'winsw.exe')).Hash.ToLower()
if ($sha -ne $WinswSha256) { throw "winsw.exe has SHA-256 $sha, not the recorded $WinswSha256: not installed." }
$xml = @"
<service>
  <id>$ServiceName</id>
  <name>B-Pharma EBR ($Port)</name>
  <description>B-Pharma electronic batch record and logbook server</description>
  <executable>$Node</executable>
  <arguments>"$app\dist\server\main.js"</arguments>
  <workingdirectory>$app</workingdirectory>
  <env name="NODE_ENV" value="production"/>
  <env name="PORT" value="$Port"/>
  <env name="HOST" value="127.0.0.1"/>
  <env name="DATABASE_URL" value="$DatabaseUrl"/>
  <onfailure action="restart" delay="10 sec"/>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <startmode>Automatic</startmode>
</service>
"@
$svc = Join-Path $here "$ServiceName.exe"
Copy-Item (Join-Path $here 'winsw.exe') $svc -Force
Set-Content -Path (Join-Path $here "$ServiceName.xml") -Value $xml -Encoding UTF8
& $svc install
& $svc start
# the first start migrates the database: wait for the health answer (up to two minutes)
$health = $null
for ($i = 0; $i -lt 60 -and -not $health; $i++) { try { $health = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" } catch { Start-Sleep -Seconds 2 } }
if (-not $health -or $health.status -ne 'ok') { throw "the service was started but /api/health did not answer ok (see the logs next to $svc)" }
Write-Host "service $ServiceName running: $($health.migrations) migrations applied"
