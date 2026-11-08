# Runbook: Keycloak

Story: ST-IAM-002. Declaration: `infra/components/keycloak.json`, `infra/keycloak/realm-template.json`; alert rules
`infra/alerts/keycloak.json`.

One realm per environment (`machvon-<env>`). The `machvon-control` client has its own audience and requires WebAuthn
for SystemAdmin, PlatformOperator, BillingOperator and SupportOperator.

## Entering use

The component stays `PLANNED` until `npm run infra:check -- --require-entered keycloak` passes: this runbook, the
alert rules and a restore test (import the last realm export into an empty instance and log in). See [README](README.md).

## Failed logins

Alert `keycloak-login-failures`: 10 failed logins came from one source within 5 minutes.

1. Separate a credential-stuffing pattern (many users, few attempts each, one source) from a broken client (one client,
   every user): check the event log by client and by IP.
2. For an attack, tighten the brute-force detection settings and block the source at the edge; notify security administration.
3. For a broken client, check the redirect URIs and the secret reference after the last rotation.

## Export

Alert `keycloak-realm-export-age`: the last realm export is older than 24 hours.

1. Run the export job by hand and check the file lands in the second site.
2. Exports contain no user passwords or secrets (secrets are `secret://` references); store them with the same
   retention as the database backups.

## Restore

Import the realm export into a new instance, restore the Keycloak database from the PostgreSQL backup, verify one login
per client, then switch the address.

## On-prem realm: directory federation and mandatory MFA

The on-prem installation imports `infra/keycloak/onprem/machvon-realm.json` (placeholders `${VAR}` are replaced by Keycloak from the environment at import; the compose file passes them from the `.env` and from secret files). It holds:

- **Federation** with Active Directory over LDAPS (read-only; passwords stay in the directory; only groups named `MACHVON-*` are imported), `infra/keycloak/onprem/ad-group-role-map.json` maps each directory group to a system role (`SystemAdmin`, `PlatformOperator`, `BillingOperator`, `SupportOperator`); every control-plane role also carries the marker role `mfa-webauthn-required`.
- **Mandatory second factor**: every person enrols TOTP at the first sign-in (default required action) and may add a security key; platform roles must use WebAuthn. The authentication flow `machvon browser` runs level 1 (password) then level 2 (second factor), so the token says `acr` 2 (aal2), which is what the API reads for step-up commands.
- **Lockout**: five failures within 15 minutes lock the account for 15 minutes, never permanently (the rule of AC-ST-IAM-002-1, also stated in `realm-template.json`).
- **Sessions**: idle 30 minutes, at most 10 hours, access token 5 minutes, refresh token rotation with no reuse.
- **Clients**: `machvon-web`, `machvon-control` (own audience) and `machvon-mobile`, all public with PKCE S256.

Test plan: `docs/security/identity-test-plan.md`. The Keycloak served at `/idp/` of the edge; its admin console is not exposed on the edge.
