# Dumps the two databases (the product and Keycloak) to <root>\backups, outside every Docker volume, and removes the dumps that are older than the retention.
#
#   backup.ps1 [-Label daily] [-RetentionDays 14]
#
# pg_dump custom format (compressed, restorable table by table with pg_restore), plus the roles as SQL WITHOUT their passwords (the passwords are the secret files).
# The dump runs inside the db container; a dump that is empty or that pg_restore cannot list is deleted and the script fails.
# pgBackRest (continuous WAL archive, point-in-time recovery) has no Windows build: the recovery point of this deployment is the last dump.
# The backup directory is readable by administrators only. Copy it to another machine or site on a schedule of your own: a backup on the same disk is not a backup.
param([string]$Label = 'manual', [int]$RetentionDays = 14)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
if ($Label -notmatch '^[A-Za-z0-9._-]{1,40}$') { Fail 'the label may hold letters, digits, dot, dash and underscore' }

Protect-Directory $script:BackupDir
$db = Compose ps --quiet db | Select-Object -First 1
if (-not $db) { Fail 'the db service does not run' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $script:BackupDir "$stamp-$Label"
# The container writes into the spool directory of the host (mounted at C:\backup, writable by ContainerUser); the host then moves the files into the backup
# directory, which no container can read.
Protect-Directory $script:BackupSpool -ContainersModify
$spool = Join-Path $script:BackupSpool $stamp
New-Item -ItemType Directory $spool | Out-Null
$inside = "C:\backup\$stamp"
try {
  foreach ($database in @('machvon', 'keycloak')) {
    Invoke-Native "pg_dump of $database" { & docker exec $db 'C:\pgsql\bin\pg_dump.exe' --host 127.0.0.1 --username machvon_owner --format custom --compress 6 --file "$inside\$database.dump" $database }
    Invoke-Native "pg_restore --list of $database" { & docker exec $db 'C:\pgsql\bin\pg_restore.exe' --list --file NUL "$inside\$database.dump" }
  }
  Invoke-Native 'pg_dumpall of the roles' { & docker exec $db 'C:\pgsql\bin\pg_dumpall.exe' --host 127.0.0.1 --username machvon_owner --roles-only --no-role-passwords --file "$inside\roles.sql" }
  New-Item -ItemType Directory $target | Out-Null
  # Copied, not moved: a copy takes the access list of the backup directory (administrators only), a moved file would keep the one of the spool.
  Get-ChildItem $spool -File | Copy-Item -Destination $target
} finally {
  Remove-Item -Recurse -Force $spool -ErrorAction SilentlyContinue
}
$sums = @()
foreach ($file in Get-ChildItem $target -File) {
  if ($file.Length -eq 0) { Remove-Item -Recurse -Force $target; Fail "the dump file $($file.Name) is empty" }
  $sums += ((Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower() + '  ' + $file.Name)
}
if ($sums.Count -ne 3) { Remove-Item -Recurse -Force $target; Fail 'the dump is incomplete' }
Write-TextFile (Join-Path $target 'SHA256SUMS') (($sums -join "`n") + "`n")
Write-TextFile (Join-Path $target 'release.txt') ((Get-Setting 'MACHVON_VERSION') + "`n")
$size = [math]::Round((Get-ChildItem $target -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Log 'backup' "$target $size MB"
Say "backup written: $target ($size MB)"

$limit = (Get-Date).AddDays(-$RetentionDays)
foreach ($old in Get-ChildItem $script:BackupDir -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}-' -and $_.CreationTime -lt $limit }) {
  Remove-Item -Recurse -Force $old.FullName
  Say "removed the backup $($old.Name) (older than $RetentionDays days)"
}
