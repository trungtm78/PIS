# Installs or upgrades MACHVON on this Windows Server host from a build pack (scripts/onprem-windows-pack.mjs), with Windows containers.
#
#   powershell -ExecutionPolicy Bypass -File <pack>\infra\onprem-windows\host\install.ps1 -Pack <pack> [-KeepPack] [-SkipBackup] [-KeepDirectory]
#
# The same command installs the first release and every later one. In order, stopping at the first step that fails; it can be run again:
#   1 the pack is checked against its manifest and the images of the release are built on this host;
#   2 the host files (compose file, scripts) are copied to <root> (C:\ProgramData\MACHVON), the environment file is created once from the template;
#   3 the secret files that do not exist are created; without a certificate a private one is made so that the edge can start (certificate.ps1 replaces it);
#   4 upgrade only: a dump of the databases (backup.ps1), and the release that runs is remembered for rollback.ps1;
#   5 the database starts, the migrations run, the passwords of the three application roles are set from the secret files, the placement of this
#     installation is registered (control-plane.ps1 says why);
#   6 every service starts and must become healthy;
#   7 unless -KeepDirectory: the directory federation of the realm is switched off when no directory is configured (LDAP_URL still names directory.invalid);
#   8 the firewall rule of the HTTPS port and the daily task (backup, certificate renewal, signatures, log rotation) are registered;
#   9 the pack is deleted (unless -KeepPack): the host keeps images, volumes, configuration and secrets, never sources.
param(
  [Parameter(Mandatory)][string]$Pack,
  [switch]$KeepPack,
  [switch]$SkipBackup,
  [switch]$KeepDirectory,
  [int]$WaitSeconds = 900
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

$Pack = (Resolve-Path $Pack).Path
$manifest = Get-Content (Join-Path $Pack 'manifest.json') -Raw | ConvertFrom-Json
$version = (Get-Content (Join-Path $Pack 'VERSION') -Raw).Trim()
$source = Join-Path $Pack 'infra\onprem-windows'
Invoke-Native 'docker version (is the Docker service running?)' { & docker version --format '{{.Server.Version}}' }

Say "1/9 building the images of $version"
& (Join-Path $source 'host\build-images.ps1') -Pack $Pack

Say '2/9 host files'
Protect-Directory $script:MachvonRoot
foreach ($directory in @($script:ComposeDir, $script:BackupDir, $script:StateDir, $script:LogDir, (Join-Path $script:MachvonRoot 'host'), (Join-Path $script:MachvonRoot "releases\$version"))) { New-Item -ItemType Directory -Force $directory | Out-Null }
Copy-Item (Join-Path $source 'host\*') (Join-Path $script:MachvonRoot 'host') -Force
Copy-Item (Join-Path $source 'images.json') $script:MachvonRoot -Force
Copy-Item (Join-Path $source 'secrets.json') $script:MachvonRoot -Force
# Each release keeps its compose file: rollback.ps1 starts the earlier release with the file it was installed with.
Copy-Item (Join-Path $source 'compose\compose.yaml') (Join-Path $script:MachvonRoot "releases\$version\compose.yaml") -Force
Write-TextFile (Join-Path $script:MachvonRoot "releases\$version\release.json") ((@{ version = $version; edition = $manifest.edition; publicHost = $manifest.publicHost; installed = (Get-Date -Format s) } | ConvertTo-Json) + "`n")
$hostScripts = Join-Path $script:MachvonRoot 'host'

$hostName = ($manifest.publicHost -split ':')[0]
$port = if ($manifest.publicHost -match ':(\d+)$') { $Matches[1] } else { '443' }
if (-not (Test-Path $script:EnvFile)) {
  $text = (Get-Content (Join-Path $source 'compose\env.template') -Raw).Replace("`r`n", "`n")
  $values = @{ MACHVON_EDITION = $manifest.edition; WINDOWS_TAG = (Get-Content (Join-Path $source 'images.json') -Raw | ConvertFrom-Json).windowsTag; PUBLIC_HOST = $manifest.publicHost; PUBLIC_HOSTNAME = $hostName; WEB_HTTPS_PORT = $port; CONTROL_HOST = $manifest.publicHost; MACHVON_SECRETS_DIR = $script:SecretsDir }
  foreach ($name in $values.Keys) { $text = [regex]::Replace($text, "(?m)^$name=.*$", ("$name=" + $values[$name]).Replace('$', '$$')) }
  Write-TextFile $script:EnvFile $text
  Say "the environment file was created: $script:EnvFile"
} elseif ((Get-Setting 'PUBLIC_HOST') -ne $manifest.publicHost -or (Get-Setting 'MACHVON_EDITION') -ne $manifest.edition) {
  Fail ("the pack was built for " + $manifest.publicHost + " (" + $manifest.edition + ") but this installation is " + (Get-Setting 'PUBLIC_HOST') + " (" + (Get-Setting 'MACHVON_EDITION') + ")")
}

Say '3/9 secret files and certificate'
& (Join-Path $hostScripts 'secrets.ps1') -Version $version
if (-not (Test-Path (Join-Path $script:SecretsDir 'web\tls_cert'))) { & (Join-Path $hostScripts 'certificate.ps1') -Mode private -HostName $hostName }

$running = ''
if (Test-Path $script:ComposeFile) {
  $api = Compose ps --all --quiet api | Select-Object -First 1
  if ($api) { $running = ((Get-Native { & docker inspect --format '{{.Config.Image}}' $api }) -split ':')[-1] }
}
if ($running -ne '') {
  Say "4/9 upgrade from $running to $version"
  if (-not $SkipBackup) { & (Join-Path $hostScripts 'backup.ps1') -Label "before-$version" } else { Say 'backup skipped (-SkipBackup): the operator answers for it' }
  if ($running -ne $version) { Write-TextFile (Join-Path $script:StateDir 'previous-version') "$running`n" }
} else {
  Say '4/9 first installation: nothing to back up'
}
Copy-Item (Join-Path $script:MachvonRoot "releases\$version\compose.yaml") $script:ComposeFile -Force
Set-Setting 'MACHVON_VERSION' $version
Compose config --quiet
Assert-Compose 'docker compose config (the compose file does not accept this environment)'

Say '5/9 database, migrations, passwords of the application roles'
Compose up --detach db
Assert-Compose 'starting the database'
Wait-Healthy -Services @('db') -Seconds $WaitSeconds
Compose --profile tools run --rm migrate
Assert-Compose 'the migrations'
$db = Compose ps --quiet db | Select-Object -First 1
foreach ($role in @('app', 'control', 'outbox_relay')) {
  $url = (Get-Content (Join-Path $script:SecretsDir "api\database_url_$role") -Raw).Trim()
  if ($url -notmatch "^postgres://machvon_${role}:([A-Za-z0-9_.~-]+)@") { Fail "database_url_$role is not a postgres URL for machvon_$role with a password of letters, digits and _ . ~ -" }
  "ALTER ROLE machvon_$role PASSWORD '$($Matches[1])';" | & docker exec -i $db 'C:\pgsql\bin\psql.exe' --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 --username machvon_owner --dbname machvon | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "cannot set the password of machvon_$role" }
}

& (Join-Path $hostScripts 'control-plane.ps1')

Say '6/9 every service'
Compose up --detach --remove-orphans
Assert-Compose 'starting the services'
Wait-Healthy -Services @('db', 'keycloak', 'api', 'workers', 'web') -Seconds $WaitSeconds
# nginx resolved the api and Keycloak when it started; after an upgrade it is started again so that it reads the certificate and the addresses as they are now.
if ($running -ne '') { Compose restart web; Wait-Healthy -Services @('web') -Seconds 120 }

if (-not $KeepDirectory -and (Get-Setting 'LDAP_URL') -match 'directory\.invalid') {
  Say '7/9 no directory is configured: the directory federation of the realm is switched off'
  & (Join-Path $hostScripts 'keycloak-admin.ps1') disable-directory
} else {
  Say '7/9 the directory federation of the realm is left as it is'
}

Say '8/9 firewall rule and daily task'
& (Join-Path $hostScripts 'register.ps1')

if (-not $KeepPack) {
  Say '9/9 deleting the pack'
  Set-Location $script:MachvonRoot
  Remove-Item -Recurse -Force $Pack
} else {
  Say '9/9 the pack is kept (-KeepPack): delete it when it is no longer needed, it holds the compiled application'
}
Compose ps
Say "done: MACHVON $version runs at https://$($manifest.publicHost)/ . clamd fetches its signatures at the first start and becomes healthy some minutes later."
