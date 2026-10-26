# Installs the Windows installer silently and starts the REAL application (B-Pharma LIMS.exe), then reads the release-event log
# the shell writes at start (desktop/main.cjs checkIntegrity): SERVER_START means the installed files matched the release manifest,
# SYSTEM_INTEGRITY_FAIL means the application refused to start (the failure seen on the first installed build).
# Run by .github/workflows/build.yml on windows-latest after the installer is built; runnable by IT on a test PC:
#   pwsh tests/installer/gui-smoke.ps1 -Installer release\B-Pharma-LIMS-Setup-0.2.0.exe [-TimeoutSeconds 60]
# It does not need a database: the integrity check runs before the setup screen. Exit code is non-zero on any failure.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [int]$TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$work = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$app = Join-Path $work 'lims-gui'
$ud = Join-Path $work 'lims-gui-userdata'
$installer = (Resolve-Path $Installer).Path
function Step($m) { Write-Host "=== $m" }

foreach ($d in @($app, $ud)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
Step "silent install to $app"
$p = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$app" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "installer exit code $($p.ExitCode)" }
$exe = Join-Path $app 'B-Pharma LIMS.exe'
if (-not (Test-Path $exe)) { throw "installed program not found: $exe" }
$res = Join-Path $app 'resources\app'
$manifest = Join-Path $res 'release-manifest.json'
if (-not (Test-Path $manifest)) { throw "the installed application has no release-manifest.json ($manifest)" }
$m = Get-Content $manifest -Raw | ConvertFrom-Json
Write-Host ("manifest: version {0}, git {1}, {2} files" -f $m.version, $m.gitSha, @($m.files.PSObject.Properties).Count)

Step "start the installed application (user data in $ud)"
$proc = Start-Process -FilePath $exe -ArgumentList "--user-data-dir=`"$ud`"" -PassThru
$log = Join-Path $ud 'logs\release-events.jsonl'
$result = $null; $text = ''
try {
  $end = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $end -and -not $result) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $log) {
      $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
      if ($text -match 'SYSTEM_INTEGRITY_FAIL') { $result = 'fail' }
      elseif ($text -match 'SERVER_START') { $result = 'ok' }
    }
    if ($proc.HasExited -and -not $result) { Start-Sleep -Seconds 1; if (Test-Path $log) { $text = Get-Content $log -Raw }; $result = if ($text -match 'SERVER_START') { 'ok' } else { 'exited' } }
  }
} finally {
  if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F | Out-Null }
}

Write-Host '--- release-events.jsonl'
if (Test-Path $log) { Get-Content $log } else { Write-Host '(no log written)' }
$srvLog = Join-Path $ud 'logs\server.log'
if (Test-Path $srvLog) { Write-Host '--- server.log (tail)'; Get-Content $srvLog -Tail 20 }

Step 'silent uninstall'
$un = Get-ChildItem $app -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($un) { Start-Process -FilePath $un.FullName -ArgumentList '/S', "_?=$app" -Wait | Out-Null }
Remove-Item -Recurse -Force $app -ErrorAction SilentlyContinue

switch ($result) {
  'ok'     { Write-Host 'PASS the installed application passed its integrity check and started'; exit 0 }
  'fail'   { throw 'FAIL the installed application refused to start: SYSTEM_INTEGRITY_FAIL (see the log above)' }
  'exited' { throw 'FAIL the application exited before it wrote SERVER_START (see the log above)' }
  default  { throw "FAIL no SERVER_START or SYSTEM_INTEGRITY_FAIL within $TimeoutSeconds s" }
}
