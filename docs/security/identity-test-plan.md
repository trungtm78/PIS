# Identity test plan: Keycloak, Active Directory federation and mandatory MFA

Artefacts: `infra/keycloak/onprem/machvon-realm.json` (realm import, `${VAR}` placeholders substituted by Keycloak from the environment), `infra/keycloak/onprem/ad-group-role-map.json` (the AD group to role mapping), `infra/keycloak/realm-template.json` (the declarative policy `infra:check` reads), `infra/onprem/compose/compose.yaml` (service `keycloak`).

Status: the structure is checked by `npm run infra:check` and `scripts/infra-check.test.mjs` (policy values, the mapping, the flow shape). The realm was **not imported into a running Keycloak** by the lane that wrote it (no daemon was started). This plan is what a person does on a throwaway Keycloak 26.5 with a test directory before the first customer installation; the first section is the import itself.

## Policy under test

| Rule | Value | Where |
|---|---|---|
| Lockout | 5 failed passwords within 15 minutes lock the account for 15 minutes; the lock is temporary (never permanent) | realm `failureFactor` 5, `maxDeltaTimeSeconds` 900, `waitIncrementSeconds` 900, `maxFailureWaitSeconds` 900, `permanentLockout` false (AC-ST-IAM-002-1) |
| Second factor | mandatory for every person: TOTP or WebAuthn; control-plane roles: WebAuthn only | authentication flow `machvon browser`, default required action `CONFIGURE_TOTP`, marker role `mfa-webauthn-required` |
| Assurance | the token says `acr` 2 (aal2) after the second factor; the API treats `acr` `aal2` or `2` with a recent `auth_time` as aal2 | `acr.loa.map`, flow levels 1 and 2, client attributes `default.acr.values` and `minimum.acr.value` |
| Passwords | owned by the directory: read-only federation, no local password reset, no registration | `editMode` READ_ONLY, `resetPasswordAllowed` false, `registrationAllowed` false |
| Sessions | idle 30 minutes, at most 10 hours, access token 5 minutes, refresh tokens rotate and a reused one is refused | `ssoSessionIdleTimeout` 1800, `ssoSessionMaxLifespan` 36000, `accessTokenLifespan` 300, `revokeRefreshToken` true, `refreshTokenMaxReuse` 0 |
| Roles | only through directory groups named `MACHVON-*`; no other directory group is imported | `ad-group-role-map.json`, group mapper filter `(cn=MACHVON-*)` |
| Clients | public clients with PKCE S256, no implicit flow, no direct password grant, exact redirect URIs | `machvon-web`, `machvon-control`, `machvon-mobile` |

## Preparation

1. A throwaway Keycloak 26.5 (the compose service started alone against a scratch PostgreSQL is enough), and a test directory (OpenLDAP with the `memberOf` overlay, or a lab Active Directory) with: users `alice` (member of no MACHVON group), `bob` (`MACHVON-SYSTEM-ADMINS`), `carol` (`MACHVON-SUPPORT-OPERATORS`), `dave` (member of both `MACHVON-SUPPORT-OPERATORS` and `MACHVON-BILLING-OPERATORS`), `erin` (a disabled account), and a group `OTHER-GROUP` that must never appear.
2. Environment for the import: `REALM_NAME`, `TENANT_HOST`, `CONTROL_HOST`, `WEBAUTHN_RP_ID`, `LDAP_URL`, `LDAP_BIND_DN`, `LDAP_BIND_CREDENTIAL`, `LDAP_USERS_DN`, `LDAP_GROUPS_DN` (test values), the directory CA in `KC_TRUSTSTORE_PATHS`.
3. A browser with a virtual authenticator (Chromium DevTools WebAuthn panel) and an authenticator app or `oathtool` for TOTP.

## Cases

Each case: steps, expected result. Record the date, Keycloak version and the person in the evidence file (`docs/runbooks/infra/evidence/keycloak.md`, template in the infra README). A failed case blocks the entry gate of the `keycloak` component.

### I. Import and federation

| Id | Steps | Expected |
|---|---|---|
| I-1 | Start Keycloak with `--import-realm` and the realm file | The import succeeds; the realm exists; `kc.sh export --realm <name>` shows the built-in flows next to the `machvon *` flows (if the import refuses a realm without the built-in flows on this version, apply the flows with the admin console and record it) |
| I-2 | Open the user federation page, test the connection and authentication | Both succeed over LDAPS with the CA trusted; a wrong CA fails the test (the trust store is not bypassed) |
| I-3 | Run a full sync | `alice`, `bob`, `carol`, `dave` are imported; `erin` (disabled) is not; `OTHER-GROUP` does not appear under Groups |
| I-4 | Read the realm after import | No secret appears in the exported JSON (`kc.sh export` shows the bind credential as masked) |

### II. Roles from directory groups

| Id | Steps | Expected |
|---|---|---|
| II-1 | Look at the role mapping of `bob` | `SystemAdmin` and `mfa-webauthn-required` through the group |
| II-2 | Look at `carol` and `dave` | `SupportOperator` (and `BillingOperator` for `dave`), each with the marker role; `alice` has only the default role |
| II-3 | Remove `bob` from the directory group, sync (changed users), sign in again | The role is gone from the next token; a token already issued lasts at most five minutes |
| II-4 | Add a user to `OTHER-GROUP` | Nothing changes in Keycloak |

### III. Lockout (AC-ST-IAM-002-1, UAT-AC124)

| Id | Steps | Expected |
|---|---|---|
| III-1 | Five wrong passwords for `alice` within 15 minutes | The account is locked; the sixth attempt shows the same neutral message as any wrong password (no user enumeration); the correct password is refused during the lock |
| III-2 | Wait 15 minutes (or move the lock time in the admin console for the test) | The correct password works again; the lock was not permanent |
| III-3 | Four wrong passwords, a correct one, then one wrong | Not locked: the failure counter resets on success |
| III-4 | Check the brute-force log of the realm | One event per failure with the client and the address; the alert `keycloak-login-failures` fires on the pattern of the runbook |

### IV. Mandatory second factor

| Id | Steps | Expected |
|---|---|---|
| IV-1 | First sign-in of `alice` (no factor enrolled) | After the password, the page to configure TOTP; the application is not reached before it is done |
| IV-2 | Sign in again with the TOTP code | Succeeds; the token carries `acr` 2 and `auth_time`; `amr` is not relied on |
| IV-3 | Reuse the same TOTP code within its period | Refused (`otpPolicyCodeReusable` false) |
| IV-4 | `alice` enrols a security key as a second option | Both work; a person with only WebAuthn can sign in with it |
| IV-5 | First sign-in of `bob` (platform role) | The page asks for a security key (WebAuthn registration), not for TOTP-only; a TOTP code is not accepted as the second factor for `bob` afterwards |
| IV-6 | `bob` signs in to `machvon-control` and `machvon-web` | Security key required for both; `acr` 2 |
| IV-7 | Try to reach a client page with `acr_values=aal1` | The minimum ACR of the client still forces level 2 |
| IV-8 | Disable all of a person's factors in the admin console and sign in | The person must enrol again; there is no path to the application without a second factor |

### V. Tokens and the API

| Id | Steps | Expected |
|---|---|---|
| V-1 | Decode an access token of `machvon-web` | Issuer is `https://<host>/idp/realms/<realm>`, audience contains `machvon-api`, `realm_access.roles` lists the roles, lifetime 300 s |
| V-2 | Decode a token of `machvon-control` | Audience `machvon-control` only; a `machvon-web` token is refused by the control-plane operations (403 or 401 as the API contract says) |
| V-3 | Use a refresh token twice | The second use is refused and the whole refresh family is revoked (the phone documents this: `docs/mob-session.md`) |
| V-4 | A command with step-up (`x-step-up`) after 16 minutes | 403 `MFA_REQUIRED`; after signing in again with the second factor it passes (`apps/api/test/policy-guard.test.ts` covers the API side) |
| V-5 | Sign out in the web application, then call the API with the old access token | Refused within the revocation lag (60 s at most, BR-IAM-13) |

### VI. Sessions and hardening

| Id | Steps | Expected |
|---|---|---|
| VI-1 | Leave a session idle for 30 minutes | The next request needs a new sign-in |
| VI-2 | Keep a session active for 10 hours | It ends at the maximum lifespan |
| VI-3 | Open `https://<host>/idp/admin/` and `/idp/metrics` from outside | 404 at the edge |
| VI-4 | Redirect URI with another host or path | Refused by Keycloak (exact match) |
| VI-5 | Try the direct password grant and the implicit flow | Disabled for every client |
| VI-6 | Response headers of the login page | Frame ancestors none, `X-Content-Type-Options`, no `X-Powered-By` |

### VII. Availability and recovery

| Id | Steps | Expected |
|---|---|---|
| VII-1 | Stop the directory | People already in a session keep working until the tokens lapse; new sign-ins fail with the neutral message; the alert fires |
| VII-2 | Restore: import the last realm export and the Keycloak database from the PostgreSQL backup into a clean host | One login per client works; evidence is written for the `keycloak` entry gate |

## Reporting

The result of each case (pass, fail, not run) goes into the evidence file with the Keycloak version, the date and the performers. A realm import that needed manual correction is a finding: fix `machvon-realm.json` and its test in the same change, then repeat the plan from I-1.
