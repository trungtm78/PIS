# Wipes the DEMO data of this installation: EVERY tenant, every project, document and member of the product database is removed, and the installation is left as
# install.ps1 leaves a new one (migrated, empty, placement and license key registered). For a demo installation only: there is no way back but the backup it takes.
#
#   demo-reset.ps1 -Confirm RESET-DEMO-DATA [-KeepPeople]
#
# What it does, in order (it stops at the first step that fails):
#   1 a backup of both databases (backup.ps1, label before-demo-reset): restore.ps1 brings the present state back;
#   2 the files of the people of the demo (secrets\admin\first-accounts.json, demo-account.json, demo-credentials.json) are MOVED next to that backup, and the
#     people they name are removed from the realm (unless -KeepPeople), so that first-accounts.ps1 and demo-tenant.ps1 start from nothing;
#   3 web, workers and api are stopped; the database `machvon` is dropped and created again, empty (the database of Keycloak, its realm and clients are kept);
#   4 the migrations run, the placement and the license signing key are registered (control-plane.ps1);
#   5 every service starts.
# Afterwards: first-accounts.ps1 (the tenant and its owner), demo-tenant.ps1 (units, roles, people), then `clip-seed apply` from the development machine
# (docs/runbooks/demo-data-camau.md). The shared catalogues reach the new tenant when the worker job master-baseline-sync has run: up to six hours after this script.
#
# Not touched: the volume of uploaded files (machvon_objects: the old files stay on disk, no row names them any more), the certificate, the secrets of the services.
param([Parameter(Mandatory)][string]$Confirm, [switch]$KeepPeople)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
if ($Confirm -cne 'RESET-DEMO-DATA') { Fail 'pass -Confirm RESET-DEMO-DATA: every tenant and all its data are removed from this installation' }
$db = Compose ps --quiet db | Select-Object -First 1
if (-not $db) { Fail 'the db service does not run' }

Say '1/5 backup of the present state'
$before = @(Get-ChildItem $script:BackupDir -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
& (Join-Path $PSScriptRoot 'backup.ps1') -Label 'before-demo-reset'
$backup = Get-ChildItem $script:BackupDir -Directory | Where-Object { $_.Name -like '*-before-demo-reset' -and ($before -notcontains $_.FullName) } | Sort-Object Name | Select-Object -Last 1
if (-not $backup) { Fail 'the backup before the reset was not made: nothing was changed' }
foreach ($name in @('machvon.dump', 'keycloak.dump', 'SHA256SUMS')) { if (-not (Test-Path (Join-Path $backup.FullName $name))) { Fail "the backup has no $name : nothing was changed" } }

Say '2/5 the people of the demo'
$admin = Join-Path $script:SecretsDir 'admin'
$kept = Join-Path $backup.FullName 'admin-files'
$names = @()
foreach ($file in @('first-accounts.json', 'demo-account.json', 'demo-credentials.json')) {
  $path = Join-Path $admin $file
  if (-not (Test-Path $path)) { continue }
  $json = Get-Content $path -Raw | ConvertFrom-Json
  # Strict mode: a property is asked for only where it exists.
  if ($json.PSObject.Properties['username']) { $names += [string]$json.username }
  if ($json.PSObject.Properties['people']) {
    foreach ($entry in $json.people.PSObject.Properties) { if ($entry.Value.PSObject.Properties['username']) { $names += [string]$entry.Value.username } }
  }
  New-Item -ItemType Directory $kept -Force | Out-Null
  Move-Item $path (Join-Path $kept $file) -Force
}
$names = @($names | Where-Object { $_ -match '^[a-z][a-z0-9._-]{2,40}$' } | Sort-Object -Unique)
if ($KeepPeople) {
  Say "  -KeepPeople: $($names.Count) people stay in the realm (their files are in $kept)"
} else {
  foreach ($name in $names) {
    & (Join-Path $PSScriptRoot 'keycloak-admin.ps1') delete-user --username $name
  }
  Say "  $($names.Count) people removed from the realm; their files are in $kept"
}

Say '3/5 the product database is dropped and created again, empty'
Compose stop web workers api
Assert-Compose 'stopping the services'
$sql = 'DROP DATABASE IF EXISTS machvon WITH (FORCE); CREATE DATABASE machvon OWNER machvon_owner;'
Invoke-Native 'creating the database again' { $sql | & docker exec -i $db 'C:\pgsql\bin\psql.exe' --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 --username machvon_owner --dbname postgres }

Say '4/5 migrations, placement and license signing key'
Compose --profile tools run --rm migrate
Assert-Compose 'the migrations'
& (Join-Path $PSScriptRoot 'control-plane.ps1')

Say '5/5 every service'
Compose up --detach
Assert-Compose 'starting the services'
Wait-Healthy -Services @('db', 'keycloak', 'api', 'workers', 'web') -Seconds 900
Write-Log 'demo-reset' $backup.FullName
Say "the installation is empty; the state before is in $($backup.FullName) (restore.ps1 -Backup ... -Confirm RESTORE brings it back)"
Say 'next: first-accounts.ps1, demo-tenant.ps1, then clip-seed apply (docs/runbooks/demo-data-camau.md)'
