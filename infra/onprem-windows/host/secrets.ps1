# Creates the secret files of the installation that do not exist yet (it never replaces one) and sets their access lists.
#
#   powershell -ExecutionPolicy Bypass -File secrets.ps1 -Version 1.0.0
#
# One sub-directory per service under <root>\secrets, mounted read-only into that service only (infra/onprem-windows/secrets.json names every file):
# Administrators and SYSTEM have full control, ContainerUser reads, nobody else has access. Every value is random and made on this host; none is printed.
# The two private keys are made by the Node of the api image of the release (-Version), which must be built already.
param([Parameter(Mandatory)][string]$Version)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator

Protect-Directory $script:MachvonRoot
Protect-Directory $script:SecretsDir
foreach ($service in @('db', 'keycloak', 'api', 'migrate', 'web')) { Protect-Directory (Join-Path $script:SecretsDir $service) -Containers }
# What only a person reads (the first accounts): no container mounts it.
Protect-Directory (Join-Path $script:SecretsDir 'admin')

$created = @()
function New-Secret([string]$Service, [string]$Name, [scriptblock]$Make) {
  $path = Join-Path (Join-Path $script:SecretsDir $Service) $Name
  if (Test-Path $path) { return }
  Write-TextFile $path ((& $Make) + "`n")
  $script:created += "$Service\$Name"
}
function Get-Secret([string]$Service, [string]$Name) { return (Get-Content (Join-Path (Join-Path $script:SecretsDir $Service) $Name) -Raw).Trim() }

New-Secret db db_owner_password { New-RandomHex 32 }
New-Secret db keycloak_db_password { New-RandomHex 32 }
New-Secret keycloak keycloak_db_password { Get-Secret db keycloak_db_password }
New-Secret keycloak keycloak_admin_password { New-RandomHex 24 }
# No directory yet: a random value nobody uses, so that the variable of the realm import resolves. Replace it with the bind password when a directory is connected.
New-Secret keycloak ldap_bind_credential { New-RandomHex 16 }
New-Secret migrate database_url_owner { 'postgres://machvon_owner:' + (Get-Secret db db_owner_password) + '@db:5432/machvon' }
foreach ($role in @('app', 'control', 'outbox_relay')) {
  New-Secret api "database_url_$role" { 'postgres://machvon_' + $role + ':' + (New-RandomHex 32) + '@db:5432/machvon' }
}
New-Secret api outbox_signing_key { New-RandomBase64 48 }
New-Secret api field_encryption_keys { '1:' + (New-RandomBase64 32) }

function New-PrivateKey([string]$Script) {
  $lines = & docker run --rm --isolation process --network none --entrypoint 'C:\node\node.exe' "machvon/api-windows:$Version" -e $Script
  if ($LASTEXITCODE -ne 0 -or -not ($lines -join '').Contains('PRIVATE KEY')) { Fail 'the api image did not make a private key (is the image of this version built?)' }
  return (($lines | Where-Object { $_ -ne '' }) -join "`n")
}
New-Secret api tenant_token_signing_key { New-PrivateKey "process.stdout.write(require('node:crypto').generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'sec1',format:'pem'}))" }
New-Secret api license_signing_key { New-PrivateKey "process.stdout.write(require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))" }

if ($created.Count -eq 0) { Say 'every secret file exists already: nothing was created' } else { Say ('created: ' + ($created -join ', ')) }
