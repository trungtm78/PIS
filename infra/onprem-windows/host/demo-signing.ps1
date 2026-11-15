# Switches the DEMONSTRATION signing of this installation: a stand-in of the certification authority, so that a leader can sign and the organisation can seal at a
# demonstration (the product has no adapter of a real authority yet; without one no document is ever issued). Documents are signed with the identities of a
# throw-away authority that only this installation trusts: a signature made here proves nothing.
#
#   demo-signing.ps1 -Mode on -PkiFile C:\pis-setup\demo_pki -IAcceptThisIsADemonstration
#   demo-signing.ps1 -Mode off
#
# -PkiFile is made on the machine of the operator (apps/api/scripts/demo-pki.ts); it is MOVED to secrets\api\demo_pki (administrators and the api container only).
# The mode is accepted only where the installation declares itself a demonstration (MACHVON_DEPLOYMENT_PURPOSE=demo): the API refuses to start otherwise.
# In order: the file, the setting of the environment file (MACHVON_DEMO_SIGNING), the api and workers containers created again. The certificates of the signers are
# then registered through the product (scripts/demo-signing-register.mjs, the command registerSigningCertificate).
# Switching it off keeps the documents that were issued; the file stays until it is deleted by hand.
param(
  [Parameter(Mandatory)][ValidateSet('on', 'off')][string]$Mode,
  [string]$PkiFile = '',
  [switch]$IAcceptThisIsADemonstration
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
$target = Join-Path $script:SecretsDir 'api\demo_pki'
if ($Mode -eq 'on') {
  if (-not $IAcceptThisIsADemonstration) { Fail 'the demonstration signing signs documents with an authority nobody else trusts: confirm with -IAcceptThisIsADemonstration that this installation holds no real data' }
  if ((Get-Setting 'MACHVON_DEPLOYMENT_PURPOSE') -ne 'demo') { Fail 'MACHVON_DEPLOYMENT_PURPOSE is not demo in the environment file: this installation does not declare itself a demonstration' }
  if ($PkiFile -ne '') {
    if (-not (Test-Path $PkiFile)) { Fail "the authority file $PkiFile does not exist" }
    Move-Item (Resolve-Path $PkiFile).Path $target -Force
  }
  if (-not (Test-Path $target)) { Fail 'there is no authority file yet: give -PkiFile <file made by apps/api/scripts/demo-pki.ts>' }
  Set-Setting 'MACHVON_DEMO_SIGNING' 'true'
} else {
  Set-Setting 'MACHVON_DEMO_SIGNING' 'false'
}
Compose config --quiet
Assert-Compose 'docker compose config (the compose file of this release does not know the demonstration signing: install a release that does)'
Compose up --detach --no-deps api workers
Assert-Compose 'starting api and workers with the new setting'
Wait-Healthy -Services @('api', 'workers') -Seconds 600
Write-Log 'demo-signing' $Mode
if ($Mode -eq 'on') { Say 'DEMONSTRATION SIGNING is on: documents are signed by an authority only this installation trusts. Register the certificates of the signers (scripts/demo-signing-register.mjs).' } else { Say 'the demonstration signing is off: signing answers PROVIDER_UNAVAILABLE until an adapter of a certification authority is bound' }
