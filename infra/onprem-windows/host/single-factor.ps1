# Switches the DEMONSTRATION mode with one factor of this installation on or off (docs/runbooks/deploy-windows-containers.md, "Chế độ demo một yếu tố").
#
#   single-factor.ps1 -Mode on  -IAcceptThisIsADemonstration
#   single-factor.ps1 -Mode off
#
# on : people sign in with the password alone, and that session is enough for the commands that ask for a second factor (step-up) and for the roles the security
#      policy of a tenant holds to a second factor. For an installation that only SHOWS the product: never where real data lives.
# off: the product as it ships: a second factor at every sign-in (the one-time passwords and keys of the people were kept while the mode was on).
#
# In order: the two settings of the environment file (MACHVON_DEMO_SINGLE_FACTOR, MACHVON_DEPLOYMENT_PURPOSE), the api and workers containers are created again
# with them (the API refuses to start with the mode on unless the installation declares itself a demonstration), then the browser flow of the RUNNING realm.
# Restarting workers starts the periods of the scheduled jobs again.
param(
  [Parameter(Mandatory)][ValidateSet('on', 'off')][string]$Mode,
  [switch]$IAcceptThisIsADemonstration
)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-Administrator
if ($Mode -eq 'on' -and -not $IAcceptThisIsADemonstration) { Fail 'the mode with one factor weakens the product: confirm with -IAcceptThisIsADemonstration that this installation holds no real data' }

if ($Mode -eq 'on') {
  Set-Setting 'MACHVON_DEPLOYMENT_PURPOSE' 'demo'
  Set-Setting 'MACHVON_DEMO_SINGLE_FACTOR' 'true'
} else {
  Set-Setting 'MACHVON_DEMO_SINGLE_FACTOR' 'false'
}
Compose config --quiet
Assert-Compose 'docker compose config (the compose file of this release does not know the demonstration mode: install a release that does)'
Compose up --detach --no-deps api workers
Assert-Compose 'starting api and workers with the new setting'
Wait-Healthy -Services @('api', 'workers') -Seconds 600
& (Join-Path $PSScriptRoot 'keycloak-admin.ps1') single-factor $Mode
Write-Log 'single-factor' $Mode
if ($Mode -eq 'on') { Say 'DEMONSTRATION MODE: one factor. Switch it off with single-factor.ps1 -Mode off before any real data is entered.' } else { Say 'the second factor is asked for at every sign-in again' }
