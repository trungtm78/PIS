# Records the LEGAL CONFIRMATION of a published layout profile of documents on a DEMONSTRATION installation.
#
#   demo-layout-confirm.ps1 -ProfileCode <code> -Reference <text> -IAcceptThisIsADemonstration
#
# Why a script, and why only for a demonstration: the confirmation of a layout (CXN-DOC-01) is an act of the legal officer of the organisation, made OUTSIDE the product; the
# product has no command for it and guards the row against a change. Until it is confirmed, the forms drawn on that layout are refused (TEMPLATE_UNCONFIRMED): on a
# demonstration this stops the payment forms of the Treasury, and with them every payment request. This script writes the confirmation into the database as the owner of
# the schema, lifting the guard of the table for that one statement, exactly as the test stack of the product does for the demo forms of its clips
# (apps/api/test/e2e-stack/serve.stack.ts, layout-confirmation). It is NOT an operation of a real installation: there the legal officer confirms, and the product records it.
# It refuses to run where the installation does not declare itself a demonstration (MACHVON_DEPLOYMENT_PURPOSE=demo). It changes nothing but the two columns of the
# profiles of that code that are PUBLISHED, and it is written to the log.
param(
  [Parameter(Mandatory)][string]$ProfileCode,
  [Parameter(Mandatory)][string]$Reference,
  [switch]$IAcceptThisIsADemonstration
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
if (-not $IAcceptThisIsADemonstration) { Fail 'this writes a legal confirmation nobody gave: confirm with -IAcceptThisIsADemonstration that this installation holds no real data' }
if ((Get-Setting 'MACHVON_DEPLOYMENT_PURPOSE') -ne 'demo') { Fail 'MACHVON_DEPLOYMENT_PURPOSE is not demo in the environment file: this installation does not declare itself a demonstration' }
if ($ProfileCode -notmatch '^[A-Za-z0-9_.-]{1,80}$') { Fail 'the profile code may hold letters, digits, dot, dash and underscore' }
if ($Reference -notmatch '^[\p{L}\p{N} _./:-]{3,200}$') { Fail 'the reference may hold letters, digits, spaces and . / : - _ (3 to 200 characters)' }
$db = Compose ps --quiet db | Select-Object -First 1
if (-not $db) { Fail 'the db service does not run' }
$sql = @"
begin;
alter table machvon.document_layout_profile disable trigger user;
update machvon.document_layout_profile set confirmation_status = 'CONFIRMED', legal_confirmation_ref = '$Reference' where profile_code = '$ProfileCode' and status = 'PUBLISHED';
alter table machvon.document_layout_profile enable trigger user;
commit;
select 'confirmed: ' || count(*) from machvon.document_layout_profile where profile_code = '$ProfileCode' and status = 'PUBLISHED' and confirmation_status = 'CONFIRMED';
"@
$lines = Get-Native { $sql | & docker exec -i $db 'C:\pgsql\bin\psql.exe' --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 --host 127.0.0.1 --username machvon_owner --dbname machvon }
$answer = ($lines | Where-Object { $_ -match '^confirmed: ' } | Select-Object -Last 1)
if ($answer -notmatch '^confirmed: [1-9]') { Fail "no published layout profile $ProfileCode was confirmed (is it published yet?)" }
Write-Log 'demo-layout-confirm' "$ProfileCode $Reference"
Say "DEMONSTRATION: the layout profile $ProfileCode is recorded as legally confirmed ($Reference); $answer"
