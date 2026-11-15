# Restores the two databases and the uploaded objects from one backup directory of backup.ps1. EVERYTHING written after that backup is lost.
#
#   restore.ps1 -Backup C:\ProgramData\MACHVON\backups\<stamp>-<label> -Confirm RESTORE
#
# The services that use the databases are stopped, the checksums of the backup are checked, each database is dropped, created again and restored with pg_restore,
# then every service starts. The roles and their passwords are those of the running cluster (the secret files); a restore into a NEW host first needs install.ps1.
# Before it starts it takes a backup of the present state (label before-restore), so that a wrong restore can be undone.
param([Parameter(Mandatory)][string]$Backup, [Parameter(Mandatory)][string]$Confirm)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
if ($Confirm -cne 'RESTORE') { Fail 'pass -Confirm RESTORE: the present content of the databases is replaced' }
$Backup = (Resolve-Path $Backup).Path
foreach ($line in Get-Content (Join-Path $Backup 'SHA256SUMS')) {
  $sum, $name = $line -split '\s+', 2
  if ((Get-FileHash (Join-Path $Backup $name) -Algorithm SHA256).Hash.ToLower() -ne $sum) { Fail "the backup file $name does not have the SHA-256 of SHA256SUMS" }
}
& (Join-Path $PSScriptRoot 'backup.ps1') -Label 'before-restore'

$db = Compose ps --quiet db | Select-Object -First 1
if (-not $db) { Fail 'the db service does not run' }
Say 'stopping the services that use the databases'
Compose stop web workers api keycloak
Assert-Compose 'stopping the services'
# The backup is copied into the spool directory the db container sees at C:\backup, restored from there, and removed from it.
Protect-Directory $script:BackupSpool -ContainersModify
$spool = Join-Path $script:BackupSpool 'restore-in'
Remove-Item -Recurse -Force $spool -ErrorAction SilentlyContinue
New-Item -ItemType Directory $spool | Out-Null
$inside = 'C:\backup\restore-in'
try {
  Copy-Item (Join-Path $Backup '*.dump') $spool
  foreach ($entry in @(@{ name = 'machvon'; owner = 'machvon_owner' }, @{ name = 'keycloak'; owner = 'keycloak' })) {
    Say "restoring $($entry.name)"
    $sql = "DROP DATABASE IF EXISTS $($entry.name) WITH (FORCE); CREATE DATABASE $($entry.name) OWNER $($entry.owner);"
    Invoke-Native "creating $($entry.name) again" { $sql | & docker exec -i $db 'C:\pgsql\bin\psql.exe' --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 --username machvon_owner --dbname postgres }
    Invoke-Native "pg_restore of $($entry.name)" { & docker exec $db 'C:\pgsql\bin\pg_restore.exe' --host 127.0.0.1 --username machvon_owner --dbname $entry.name --exit-on-error "$inside\$($entry.name).dump" }
  }
} finally {
  Remove-Item -Recurse -Force $spool -ErrorAction SilentlyContinue
}
# The uploaded objects of the backup replace the present ones (the api and the workers are stopped). A backup taken before objects.zip existed holds none:
# the objects of the host are then left as they are, and the restored rows may point at files that are no longer there.
$archive = Join-Path $Backup 'objects.zip'
if (Test-Path -LiteralPath $archive) {
  Say 'restoring the uploaded objects'
  $objects = Get-ObjectsDirectory
  $unpacked = Join-Path $script:StateDir 'restore-objects'
  Remove-Item -Recurse -Force $unpacked -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $unpacked | Out-Null
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $unpacked)
    # /MIR removes what the backup does not hold; the files take the access list of the volume (the service user may modify). Robocopy: below 8 is success.
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & robocopy $unpacked $objects /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ge 8) { Fail "copying the uploaded objects ended with robocopy status $LASTEXITCODE" }
  } finally {
    Remove-Item -Recurse -Force $unpacked -ErrorAction SilentlyContinue
  }
} else {
  Say 'this backup holds no objects.zip: the uploaded objects are left as they are'
}
Say 'starting every service'
Compose up --detach
Assert-Compose 'starting the services'
Wait-Healthy -Services @('db', 'keycloak', 'api', 'workers', 'web') -Seconds 900
Write-Log 'restore' $Backup
Say "restored from $Backup"
