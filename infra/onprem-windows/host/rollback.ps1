# Starts the images of an earlier release again (target: 15 minutes). The schema of the database is NOT taken back: migrations are expand-contract, so the earlier
# release runs with the newer schema (docs/runbooks/infra/onprem-upgrade-rollback.md). If data is damaged, do not roll back: restore (restore.ps1).
#
#   rollback.ps1 [-Version 1.0.0]
#
# Without -Version the release that ran before the last upgrade is used (state\previous-version, written by install.ps1). The images of that release must still be
# on this host (docker image ls machvon/*): they are kept until someone removes them.
param([string]$Version = '')
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
if ($Version -eq '') {
  $file = Join-Path $script:StateDir 'previous-version'
  if (-not (Test-Path $file)) { Fail 'no earlier release is recorded: name one with -Version' }
  $Version = (Get-Content $file -Raw).Trim()
}
$current = Get-Setting 'MACHVON_VERSION'
if ($Version -eq $current) { Fail "release $Version is the one that runs" }
$release = Join-Path $script:MachvonRoot "releases\$Version\compose.yaml"
if (-not (Test-Path $release)) { Fail "release $Version was never installed on this host" }
foreach ($name in @('db', 'keycloak', 'clamav', 'api', 'web')) {
  Invoke-Quiet { & docker image inspect "machvon/$name-windows:$Version" }
  if ($LASTEXITCODE -ne 0) { Fail "the image machvon/$name-windows:$Version is not on this host any more" }
}
Say "rolling back from $current to $Version"
Copy-Item $release $script:ComposeFile -Force
Set-Setting 'MACHVON_VERSION' $Version
Compose up --detach --remove-orphans
Assert-Compose 'starting the earlier release'
Wait-Healthy -Services @('db', 'keycloak', 'api', 'workers', 'web') -Seconds 900
Compose restart web
Wait-Healthy -Services @('web') -Seconds 120
Write-TextFile (Join-Path $script:StateDir 'previous-version') "$current`n"
Write-Log 'rollback' "$current -> $Version"
Compose ps
Say "done: release $Version runs. The database keeps the schema of $current."
