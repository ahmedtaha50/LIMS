# E24: the Windows service installation, exercised end to end on a Windows Server (the CI job "windows" runs it as
# administrator, after npm ci and npm run build, with PostgreSQL 16 listening and winsw.exe next to install-service.ps1).
#   .\ci-check.ps1 -DatabaseUrl postgres://postgres:...@127.0.0.1:5433/ebr -Psql "C:\Program Files\PostgreSQL\16\bin\psql.exe"
# Each check prints "PASS <id> <what>" or stops the script with the reason.
param([Parameter(Mandatory = $true)][string]$DatabaseUrl, [Parameter(Mandatory = $true)][string]$Psql, [int]$Port = 4101)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Resolve-Path (Join-Path $here '..\..')
$name = "bpharma-ebr-$Port"
$base = "http://127.0.0.1:$Port"
function Pass($id, $what) { Write-Host "PASS $id $what" }
function Health { for ($i = 0; $i -lt 60; $i++) { try { return Invoke-RestMethod "$base/api/health" } catch { Start-Sleep -Seconds 2 } }; throw "no health answer at $base" }
function SignIn($user, $pw) { Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -ContentType 'application/json' -Body (@{ username = $user; password = $pw } | ConvertTo-Json) }
# options before the address: psql on Windows ignores options that follow it
function Sql($q) { $r = & $Psql -v ON_ERROR_STOP=1 -Atc $q $DatabaseUrl; if ($LASTEXITCODE -ne 0) { throw "psql failed: $q" }; "$r".Trim() }

# 1. install as a service: it starts, migrates and answers
& (Join-Path $here 'install-service.ps1') -DatabaseUrl $DatabaseUrl -Port $Port
$svc = Get-Service -Name $name
if ($svc.Status -ne 'Running' -or $svc.StartType -ne 'Automatic') { throw "service $name is $($svc.Status), $($svc.StartType)" }
$h = Health
if ($h.status -ne 'ok' -or $h.migrations -lt 1) { throw "health: $($h | ConvertTo-Json -Compress)" }
Pass 'E24#1-installed' "service $name running (Automatic), $($h.migrations) migrations applied"

# 2. the first administrator (the command an installation uses), then the sign-in
$env:DATABASE_URL = $DatabaseUrl; $env:EBR_ADMIN_PASSWORD = 'windows ci first password 2026'
& node (Join-Path $app 'dist\server\identity\cli.js') siteadmin 'Site administrator'
if ($LASTEXITCODE -ne 0) { throw "create-admin failed" }
Remove-Item Env:EBR_ADMIN_PASSWORD
$login = SignIn 'siteadmin' 'windows ci first password 2026'
if (-not $login.mustChangePassword) { throw "sign-in: $($login | ConvertTo-Json -Compress)" }
Pass 'E24#1-signin' 'the first administrator signs in and must change the password'

# 3. stop and start: the data is kept
$before = Sql 'select count(*) from audit_log'
Stop-Service -Name $name; (Get-Service -Name $name).WaitForStatus('Stopped', '00:01:00')
try { Invoke-RestMethod "$base/api/health" -TimeoutSec 3 | Out-Null; throw 'the server still answers after the service stopped' } catch { if ($_.Exception.Message -like '*still answers*') { throw } }
Start-Service -Name $name; (Get-Service -Name $name).WaitForStatus('Running', '00:01:00')
$h2 = Health
$login2 = SignIn 'siteadmin' 'windows ci first password 2026'
if (-not $login2.mustChangePassword -or $h2.migrations -ne $h.migrations) { throw 'after the restart the account or the migrations changed' }
if ([int](Sql 'select count(*) from audit_log') -lt [int]$before) { throw 'audit entries were lost across the restart' }
Pass 'E24#2-restart' "after stop and start: same $($h2.migrations) migrations, the administrator still signs in, $before+ audit entries kept"

# 4. uninstall: the service goes, the database stays
& (Join-Path $here 'uninstall-service.ps1') -Port $Port
if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'the service is still registered' }
if ((Sql "select count(*) from users where username = 'siteadmin'") -ne '1') { throw 'the database lost the administrator' }
Pass 'E24#2-uninstall' 'the service is removed; the database still holds its records'
