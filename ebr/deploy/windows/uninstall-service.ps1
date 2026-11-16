# Removes the B-Pharma EBR Windows service installed by install-service.ps1. The database is NOT touched: its records stay
# in PostgreSQL (removing them is a decision of its own, with a backup first). Run as administrator.
#   .\uninstall-service.ps1 -Port 4101
param([int]$Port = 4101, [string]$ServiceName = "bpharma-ebr-$Port")
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$svc = Join-Path $here "$ServiceName.exe"
if (-not (Test-Path $svc)) { throw "$svc not found: was the service installed from this folder?" }
& $svc stop
& $svc uninstall
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { throw "the service $ServiceName is still registered" }
Write-Host "service $ServiceName removed; the database was left as it was"
