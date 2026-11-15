# Registers in the control plane the two things of THIS installation the first tenant cannot be provisioned without. Run by install.ps1 after the migrations;
# safe to run again (it adds nothing that is there already).
#
#   1 The placement: the one database cluster every tenant of this host lives on (kind POOL, region MACHVON_REGION). Without an Active placement of the region
#     and kind asked for, requestTenantProvisioning answers 422 PLACEMENT_UNAVAILABLE.
#   2 The public half of the license signing key (LICENSE_SIGNING_KEY_ID, secrets\api\license_signing_key), Active for three years. Without it the provisioning
#     step LICENSE_PILOT fails with SIGNING_KEY_UNAVAILABLE: a license is only signed with a key the table machvon.license_signing_key knows.
#
# Why a script: the product has neither a migration nor a command for either row (its own test suites insert them as the owner of the schema, as this does).
# Both rows describe the installation; neither holds data of a tenant, and no private key leaves its secret file (the api image derives the PUBLIC key from it).
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$region = Get-Setting 'MACHVON_REGION'
if ($region -notmatch '^[a-z]{2}-[a-z]{4,10}$') { Fail 'MACHVON_REGION is not set in the environment file (vn-north or vn-south)' }
$keyId = Get-Setting 'LICENSE_SIGNING_KEY_ID'
if ($keyId -notmatch '^[A-Za-z0-9._-]{1,64}$') { Fail 'LICENSE_SIGNING_KEY_ID is not set in the environment file' }
$db = Compose ps --quiet db | Select-Object -First 1
if (-not $db) { Fail 'the db service does not run' }

$derive = "const c=require('node:crypto');process.stdout.write(c.createPublicKey(c.createPrivateKey(require('node:fs').readFileSync('C:/run/secrets/license_signing_key','utf8'))).export({type:'spki',format:'pem'}))"
$lines = Get-Native { & docker run --rm --isolation process --network none --volume ((Join-Path $script:SecretsDir 'api') + ':C:\run\secrets:ro') --entrypoint 'C:\node\node.exe' "machvon/api-windows:$(Get-Setting 'MACHVON_VERSION')" -e $derive }
$publicKey = (($lines | Where-Object { $_ -ne '' }) -join "`n") + "`n"
if ($publicKey -notmatch '^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$') { Fail 'the public half of the license signing key could not be derived' }

$sql = @"
insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status)
select gen_random_uuid(), 'POOL', '$region', 'compose:db', 'secret:api/field_encryption_keys', 'Active'
 where not exists (select 1 from machvon.placement where kind = 'POOL' and region = '$region' and status = 'Active');
insert into machvon.license_signing_key (id, algorithm, public_key_pem, kms_key_ref, status, not_before, not_after)
values ('$keyId', 'EdDSA', `$pem`$$publicKey`$pem`$, 'secret:api/license_signing_key', 'Active', now(), now() + interval '3 years')
on conflict (id) do nothing;
select 'placements: ' || string_agg(kind || ' ' || region || ' ' || status, ', ') from machvon.placement;
select 'license signing keys: ' || string_agg(id || ' ' || status || ' until ' || to_char(not_after, 'YYYY-MM-DD'), ', ') from machvon.license_signing_key;
"@
Invoke-Native 'registering the placement and the license signing key' { $sql | & docker exec -i $db 'C:\pgsql\bin\psql.exe' --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 --host 127.0.0.1 --username machvon_owner --dbname machvon }
