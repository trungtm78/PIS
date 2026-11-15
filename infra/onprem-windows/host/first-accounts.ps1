# The first accounts of the installation, through the official paths of the product (tools\first-accounts.mjs of the api image says what it does):
# the people in the realm, the first tenant, the owner and the members.
#
#   first-accounts.ps1 -InputFile C:\path\first-accounts.input.json
#
# The input file (no secret in it; an example is host\first-accounts.example.json):
#   { "systemAdmin": { "username", "email", "firstName", "lastName" },
#     "tenant": { "code", "name", "rootUnitName", "subdomain" },
#     "owner": { "username", "email", "firstName", "lastName" },
#     "members": [ { "username", "email", "firstName", "lastName", "role": "<code of a role of the tenant>" } ] }
# The result is secrets\admin\first-accounts.json (administrators of this host only): user name, password and one-time password secret of each person.
#
# The tool runs in a one-shot container on the compose network, as the container administrator (secrets\admin is for administrators only). It reaches the product
# the way a browser does, through the edge: the public name is pointed at the web container in the hosts file of that container, so nothing leaves the host.
param([Parameter(Mandatory)][string]$InputFile)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$admin = Join-Path $script:SecretsDir 'admin'
Protect-Directory $admin
Copy-Item (Resolve-Path $InputFile).Path (Join-Path $admin 'first-accounts.input.json') -Force
$version = Get-Setting 'MACHVON_VERSION'
$web = Compose ps --quiet web | Select-Object -First 1
if (-not $web) { Fail 'the web service does not run' }
$address = (Get-Native { & docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $web }) | Select-Object -First 1
if ($address -notmatch '^\d+\.\d+\.\d+\.\d+$') { Fail 'the address of the web container is unknown' }
$tool = 'C:\app\tools\infra\onprem-windows\tools\first-accounts.mjs'
$command = "echo $address $(Get-Setting 'PUBLIC_HOSTNAME')>> C:\Windows\System32\drivers\etc\hosts && C:\node\node.exe $tool --input C:\run\admin\first-accounts.input.json --output C:\run\admin\first-accounts.json --invitations C:\data\invitations"
$arguments = @(
  'run', '--rm', '--isolation', 'process', '--user', 'ContainerAdministrator', '--network', 'machvon_machvon',
  '--volume', ((Join-Path $script:SecretsDir 'keycloak') + ':C:\run\secrets:ro'),
  '--volume', ((Join-Path $script:SecretsDir 'web') + ':C:\run\web:ro'),
  '--volume', ($admin + ':C:\run\admin'),
  '--volume', 'machvon_invitations:C:\data\invitations:ro',
  '--env', ('KEYCLOAK_ADMIN_USER=' + (Get-Setting 'KEYCLOAK_ADMIN_USER')), '--env', ('OIDC_REALM=' + (Get-Setting 'OIDC_REALM')),
  '--env', ('PUBLIC_HOST=' + (Get-Setting 'PUBLIC_HOST')), '--env', ('CONTROL_HOST=' + (Get-Setting 'CONTROL_HOST')),
  # The certificate of the edge may be one of a private authority: its chain is trusted by this one process, in addition to the public authorities.
  '--env', 'NODE_EXTRA_CA_CERTS=C:\run\web\tls_cert',
  '--entrypoint', 'C:\Windows\System32\cmd.exe', "machvon/api-windows:$version", '/S', '/C', $command
)
Invoke-Native 'first-accounts' { & docker @arguments }
Remove-Item (Join-Path $admin 'first-accounts.input.json') -Force
Say ("the accounts are in " + (Join-Path $admin 'first-accounts.json') + ' (administrators only). Hand each person their entry, then delete the file.')
