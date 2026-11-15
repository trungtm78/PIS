# The tenant of a DEMO installation through the official paths of the product (tools\demo-tenant.mjs says what it does): the units, the unit roles and the people
# the demo data is loaded as. Run it after the first accounts exist (first-accounts.ps1: the tenant and its owner) and before `clip-seed apply`.
#
#   demo-tenant.ps1 -InputFile C:\pis-setup\demo-tenant.input.json [-OwnerAccount C:\ProgramData\MACHVON\secrets\admin\demo-account.json] [-Tools C:\pis-setup\demo-tools]
#
# -InputFile     written on the development machine by `node scripts/demo-tenant-input.mjs --dataset camau --out demo-tenant.input.json` (no secret in it).
# -OwnerAccount  the account of the tenant owner: { origin, username, password, totpSecret, tenantId, membershipId } (default: secrets\admin\demo-account.json).
# -Tools         a directory with the tools of the repository (`node scripts/demo-tools-pack.mjs --out <dir>`), for an image that was built before this tool existed;
#                without it the tool of the api image is used.
# -DemoPassword  ONE password for every account of the demonstration (the owner included), set again at every run; without it each account gets a drawn
#                password of thirteen letters and digits. A shared password is for a demonstration only.
# The result is secrets\admin\demo-credentials.json (administrators of this host only): the credentials `clip-seed --credentials -` reads, and the user name,
# password and one-time password secret of each person. It can be run again: what is done is not done twice.
#
# Like first-accounts.ps1 the tool runs in a one-shot container on the compose network and reaches the product through the edge (the public name is pointed at
# the web container in the hosts file of that container, so nothing leaves the host).
param([Parameter(Mandatory)][string]$InputFile, [string]$OwnerAccount = '', [string]$Tools = '', [string]$DemoPassword = '')
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$admin = Join-Path $script:SecretsDir 'admin'
Protect-Directory $admin
if ($OwnerAccount -eq '') {
  # The account of the owner alone when there is one, else the output of first-accounts.ps1 (the tool finds the owner of the input among its people).
  $OwnerAccount = Join-Path $admin 'demo-account.json'
  if (-not (Test-Path $OwnerAccount)) { $OwnerAccount = Join-Path $admin 'first-accounts.json' }
}
if (-not (Test-Path $OwnerAccount)) { Fail "the owner account $OwnerAccount does not exist" }
Copy-Item (Resolve-Path $InputFile).Path (Join-Path $admin 'demo-tenant.input.json') -Force
$ownerInside = 'C:\run\admin\' + (Split-Path -Leaf $OwnerAccount)
if ((Split-Path -Parent (Resolve-Path $OwnerAccount).Path) -ne (Resolve-Path $admin).Path) {
  Copy-Item (Resolve-Path $OwnerAccount).Path (Join-Path $admin 'demo-owner.json') -Force
  $ownerInside = 'C:\run\admin\demo-owner.json'
}
$version = Get-Setting 'MACHVON_VERSION'
$web = Compose ps --quiet web | Select-Object -First 1
if (-not $web) { Fail 'the web service does not run' }
$address = (Get-Native { & docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $web }) | Select-Object -First 1
if ($address -notmatch '^\d+\.\d+\.\d+\.\d+$') { Fail 'the address of the web container is unknown' }
$toolRoot = 'C:\app\tools'
$mounts = @()
if ($Tools -ne '') {
  $Tools = (Resolve-Path $Tools).Path
  if (-not (Test-Path (Join-Path $Tools 'infra\onprem-windows\tools\demo-tenant.mjs'))) { Fail "$Tools does not hold infra\onprem-windows\tools\demo-tenant.mjs (make it with scripts/demo-tools-pack.mjs)" }
  $toolRoot = 'C:\demo-tools'
  $mounts = @('--volume', ($Tools + ':C:\demo-tools:ro'))
}
$tool = "$toolRoot\infra\onprem-windows\tools\demo-tenant.mjs"
$command = "echo $address $(Get-Setting 'PUBLIC_HOSTNAME')>> C:\Windows\System32\drivers\etc\hosts && C:\node\node.exe $tool --input C:\run\admin\demo-tenant.input.json --owner $ownerInside --output C:\run\admin\demo-credentials.json --invitations C:\data\invitations"
$arguments = @(
  'run', '--rm', '--isolation', 'process', '--user', 'ContainerAdministrator', '--network', 'machvon_machvon',
  '--volume', ((Join-Path $script:SecretsDir 'keycloak') + ':C:\run\secrets:ro'),
  '--volume', ((Join-Path $script:SecretsDir 'web') + ':C:\run\web:ro'),
  '--volume', ($admin + ':C:\run\admin'),
  '--volume', 'machvon_invitations:C:\data\invitations:ro'
) + $mounts + @(
  '--env', ('KEYCLOAK_ADMIN_USER=' + (Get-Setting 'KEYCLOAK_ADMIN_USER')), '--env', ('OIDC_REALM=' + (Get-Setting 'OIDC_REALM')),
  '--env', ('PUBLIC_HOST=' + (Get-Setting 'PUBLIC_HOST')),
  # One password for every account of the demonstration (empty: each account gets a drawn one). It reaches the tool in its environment.
  '--env', ('DEMO_PASSWORD=' + $DemoPassword),
  # The certificate of the edge may be one of a private authority: its chain is trusted by this one process, in addition to the public authorities.
  '--env', 'NODE_EXTRA_CA_CERTS=C:\run\web\tls_cert',
  '--entrypoint', 'C:\Windows\System32\cmd.exe', "machvon/api-windows:$version", '/S', '/C', $command
)
try {
  Invoke-Native 'demo-tenant' { & docker @arguments }
} finally {
  Remove-Item (Join-Path $admin 'demo-tenant.input.json') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $admin 'demo-owner.json') -Force -ErrorAction SilentlyContinue
}
Write-Log 'demo-tenant' 'units, roles and people of the demo tenant'
Say ("the credentials of the demo are in " + (Join-Path $admin 'demo-credentials.json') + ' (administrators only)')
