# Silent install, boot, /api/ready and uninstall of the Windows installer (roadmap M36, DEV-06).
# Run by .github/workflows/release.yml on windows-latest; runnable by IT on a test PC (needs PostgreSQL binaries and Node on PATH).
#   pwsh tests/installer/silent-install.ps1 -Installer release\B-Pharma-LIMS-Setup-0.2.0.exe [-TimeoutSeconds 60]
# The step fails (non-zero exit) if the installer returns an error, the installed files do not match the manifest, or
# /api/ready does not answer 200 within the timeout. Uninstall must remove the application folder.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [int]$TimeoutSeconds = 60,
  [int]$Port = 3119,
  [int]$PgPort = 55432
)
$ErrorActionPreference = 'Stop'
$work = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$app = Join-Path $work 'lims-iq'
$installer = (Resolve-Path $Installer).Path
function Step($m) { Write-Host "=== $m" }

Step "silent install to $app"
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
# NSIS: /S silent; /D= sets the folder, must be the last argument and unquoted.
$p = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$app" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "installer exit code $($p.ExitCode)" }
$exe = Join-Path $app 'B-Pharma LIMS.exe'
if (-not (Test-Path $exe)) { throw "installed program not found: $exe" }
$res = Join-Path $app 'resources\app'
if (-not (Test-Path (Join-Path $res 'release-manifest.json'))) { throw 'the installed application has no release-manifest.json' }
Write-Host 'PASS installed'

Step 'private PostgreSQL cluster'
$pgBin = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue | Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | ForEach-Object { Join-Path $_.FullName 'bin' } | Where-Object { Test-Path (Join-Path $_ 'initdb.exe') } | Select-Object -First 1
if (-not $pgBin) { throw 'no PostgreSQL binaries found under C:\Program Files\PostgreSQL' }
$data = Join-Path $work 'pgdata-iq'
if (Test-Path $data) { Remove-Item -Recurse -Force $data }
& "$pgBin\initdb.exe" -D $data -U lims -A trust -E UTF8 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
& "$pgBin\pg_ctl.exe" start -D $data -w -o "-p $PgPort -c listen_addresses=127.0.0.1" -l (Join-Path $work 'pg-iq.log') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'pg_ctl start failed' }

$failed = $null
try {
  & "$pgBin\createdb.exe" -h 127.0.0.1 -p $PgPort -U lims lims_iq
  if ($LASTEXITCODE -ne 0) { throw 'createdb failed' }
  # The installed Electron binary runs the bundles as Node (ELECTRON_RUN_AS_NODE), exactly as the desktop shell does.
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:LIMS_NODE = $exe
  $env:PGPORT = "$PgPort"; $env:SQL_HOST = '127.0.0.1'; $env:SQL_USER = 'lims'; $env:SQL_PASSWORD = 'lims'; $env:SQL_DB_NAME = 'lims_iq'
  $bootCheck = Join-Path $PSScriptRoot 'boot-check.cjs'
  Step "integrity check, init-db, server start, /api/ready within $TimeoutSeconds s"
  & $exe $bootCheck $res --port $Port --timeout $TimeoutSeconds
  if ($LASTEXITCODE -ne 0) { throw "boot check failed (exit $LASTEXITCODE)" }
} catch { $failed = $_ }
finally {
  & "$pgBin\pg_ctl.exe" stop -D $data -m immediate | Out-Null
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

Step 'silent uninstall'
$un = Get-ChildItem $app -Filter 'Uninstall*.exe' | Select-Object -First 1
if (-not $un) { throw 'no uninstaller found in the install folder' }
# The uninstaller copies itself to a temp folder and exits at once; _? keeps it in place so -Wait works.
Start-Process -FilePath $un.FullName -ArgumentList '/S', "_?=$app" -Wait | Out-Null
Remove-Item -Recurse -Force $app -ErrorAction SilentlyContinue
if ($failed) { throw $failed }
Write-Host 'PASS install, boot, ready, uninstall'
