# Runs tools\keycloak-admin.mjs of the api image in a one-shot container on the compose network (the administration of Keycloak is not on the public edge).
#
#   keycloak-admin.ps1 disable-directory | enable-directory
#   keycloak-admin.ps1 apply-presentation        (name, login theme and languages of the realm, as the release carries them for its edition)
#   keycloak-admin.ps1 single-factor on | off    (the demonstration mode with one factor: use host\single-factor.ps1, which also sets the API)
#   keycloak-admin.ps1 create-user --username <name> --email <address> --first-name <text> --last-name <text> --password-file C:\run\admin\<file> [--realm-role SystemAdmin]
#
# The container mounts secrets\keycloak (read-only) and secrets\admin at C:\run\admin (where a password file of a person is put before `create-user`).
# It runs as the container administrator, because secrets\admin is readable by administrators only.
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$version = Get-Setting 'MACHVON_VERSION'
$arguments = @(
  'run', '--rm', '--isolation', 'process', '--user', 'ContainerAdministrator', '--network', 'machvon_machvon',
  '--volume', ((Join-Path $script:SecretsDir 'keycloak') + ':C:\run\secrets:ro'),
  '--volume', ((Join-Path $script:SecretsDir 'admin') + ':C:\run\admin:ro'),
  '--env', ('KEYCLOAK_ADMIN_USER=' + (Get-Setting 'KEYCLOAK_ADMIN_USER')), '--env', ('OIDC_REALM=' + (Get-Setting 'OIDC_REALM')),
  '--entrypoint', 'C:\node\node.exe', "machvon/api-windows:$version", 'C:\app\tools\infra\onprem-windows\tools\keycloak-admin.mjs'
) + $args
Invoke-Native 'keycloak-admin' { & docker @arguments }
