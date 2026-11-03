# MOB: sign-in, permissions, tenant, account and release (ST-MOB-002, 003, 004, 008, 016)

Five stories of `apps/mobile` that share one piece of code, the session: the person signs in to the identity provider of the tenant in the system browser, chooses a unit and role, and from then on every request, every local store and the theme belong to that tenant and that membership. `Design/MACHVON_Design/01_Documents/05_modules/MOB.md` stays the authority on behaviour; `docs/mobile-foundation.md` describes the shell these screens plug into.

| story | screens | feature directory |
|---|---|---|
| ST-MOB-002 sign-in, second factor, unit and role, session expired | MOB-02, 03, 04, 44 | `lib/features/session/` |
| ST-MOB-003 permission rationale, no-permission and licence screens | MOB-05, 06, 45, 46 | `lib/features/permissions/` |
| ST-MOB-004 tenant discovery and published theme | MOB-01 | `lib/features/tenant_discovery/` |
| ST-MOB-008 account, tenant switch, devices, sign-out | MOB-47, 48, 49 | `lib/features/account/` |
| ST-MOB-016 maintenance, forced update, help, telemetry | MOB-54, 50 | `lib/features/release/` |

`lib/app/bootstrap.dart` is the one place that installs them over the foundation (`productionOverrides()`): the OIDC session, the theme that follows the session, the release state, and the transport of the API client. `main.dart` awaits the restore of the stored session before the first screen is chosen.

## The session (public shape)

`sessionProvider` (`lib/core/session/session.dart`) keeps its shape; fields were only added, each with a default, so a screen that reads `status`, `tenantId` and `userId` is unchanged.

| member | meaning |
|---|---|
| `status` | `signedOut`, `signedIn`, `expired` (the session ended on the server: MOB-44, the drafts stay on the phone) |
| `tenantId`, `userId`, `membershipId` | the active tenant, the person (`sub` of the identity token), and the unit and role chosen in MOB-04 |
| `mode` / `isReadOnly` | `readOnly` when the tenant is suspended (`READ_ONLY` of the session context) or after a 422 `LICENSE_EXPIRED` |
| `assurance` | `aal1` or `aal2` of the tenant token |
| `stepUpRequired` | the server answered 403 `MFA_REQUIRED`: the guard sends every location to MOB-03 |
| `locked` | the biometric unlock is on and the phone was away: the guard sends every location to MOB-02 with `unlock=1` |

`SessionController.accessToken()` is called for every request: it returns the tenant token, renewed before it lapses, or null; when the session cannot be renewed it fails like a request that did not get through (`NETWORK_ERROR`) or like the 401 that ended it. The flows that change the session are not on the notifier: they are `authServiceProvider` (`AuthService`, plain Dart, ports for the browser, the secure store, the biometric prompt, the pending commands and the purgers). Screens use `ref.read(authServiceProvider)`; `tenantApiClientProvider(tenantId)` (in `core/di/providers.dart`, token from `SessionController.accessTokenFor(tenantId)`) is the client for a command or an upload that belongs to one tenant and fails with `TenantMismatch` when another tenant is active; the offline queue and the uploader use it.

Core seams added for this (all backwards compatible): `GuardTargets.secondFactor` and `.releaseNotice`, `SessionDeepLinkGuard` (second factor, unlock, release block), `lib/core/release/release_notice.dart` (`releaseNoticeProvider`, default never blocks), `apiTransportProvider` (the transport of the API client, wrapped by `bootstrap.dart`).

## Sign-in (ST-MOB-002)

`OidcClient` runs Authorization Code with PKCE through the system browser (`flutter_web_auth_2`: ASWebAuthenticationSession on iOS, a Custom Tab on Android). `PkceSession` makes the verifier (43 to 128 unreserved characters), the S256 challenge, `state` and `nonce`; the verifier lives in memory only. Before a code is exchanged: the redirect has the scheme, host and path of `vn.machvon.app:/oauth2redirect`, `state` is equal (constant-time), no `error`, `iss` (RFC 9207) is this issuer when present. After: the identity token has this issuer, this client as audience, a future expiry, a subject and the nonce of the request (it is read, not verified, because it comes from the token endpoint over TLS; the API verifies the signature on every use). Every failure is an `OidcException` that carries a code only. The application never sees a password or a second-factor code.

| step | what happens |
|---|---|
| tenant | MOB-01 chooses the issuer and client id (or the build does: `--dart-define=MACHVON_OIDC_ISSUER`, `MACHVON_OIDC_CLIENT_ID`) |
| identity | the id token is the bearer of `listTenantSelectionCandidates` and `selectTenantContext`; the refresh token goes to the Keychain or Keystore at once |
| context | the membership last used is entered again when it is still allowed, the only one when there is one, otherwise MOB-04 lists them (organisation, role, validity; one the server will not let in is shown and cannot be chosen) |
| tenant token | `selectTenantContext` answers a five-minute tenant token bound to the membership; it is kept in memory only and renewed from the refresh token. Every selection is a new command (a replay of a stored answer carries no token), so its key is never reused |
| renewal | one shared refresh at a time (the provider rotates the refresh token: using it twice is a replay and the provider revokes the whole family); the new refresh token is stored before the new identity token is used; the provider refusing it ends the session (401 `SESSION_EXPIRED`, MOB-44); no connection leaves the session intact |
| second factor | selection answering 403 `MFA_REQUIRED` waits for MOB-03; a call answering it sets `stepUpRequired`. MOB-03 asks the provider for `acr_values=aal2` in the browser, refuses an answer that does not prove it or comes from another account, and selects the membership again |
| end | a 401 on a token issued a minute ago ends the session at once (MOB-44), on an older token renews it once; the tokens go, the local data and the context stay (the drafts are locked on the phone until the person signs in again) |

Secure storage keys (`SessionVault`): `session.v1` (provider, client, refresh token, context), `last_context.v1` (the hint of MOB-01 and the context MOB-44 returns to), `tenants.v1` (tenants that hold data here), `purge_pending.v1` (the purge journal), `local_data_policy.v1`, `biometric_unlock.v1`, `permissions.v1`, and everything of a tenant under `tenant.<id>.` (its published theme copy). The Android manifest declares the redirect scheme once, on the callback activity of the library, and disables backup and cleartext; iOS keeps App Transport Security at its default.

## Permissions and refusals (ST-MOB-003)

Nothing is requested at start. A feature that needs the camera, the position (while in use only) or push calls `requestPermissions(context, ref, [AppPermission.camera])`: when everything is granted it returns at once; otherwise it opens MOB-06 (MOB-05 for push) with a rationale and the system prompt only behind "Allow", and returns a `PermissionOutcome`: the state of each permission, whether the person put it off, and the alternative they chose (`attachFile` for the camera, `manualLocation` with a `ManualLocation` whose `source` is `manual` for the position). A permission the system blocks for good shows a link to the settings of the phone and is read again when the person comes back. MOB-05 states "blocked" with the link and says in-app notifications still work.

`errorScreenFor(ApiError)` and `errorScreenLocation(table, error)` send a refusal to MOB-45 (403 `SCOPE_DENIED`, any other 403 but `MFA_REQUIRED`, `ENTITLEMENT_DENIED`) or MOB-46 (`LICENSE_EXPIRED`). The location carries the stable code and the correlation id only (checked against a pattern when read back), never the `detail` of the problem; the screens show the reason in the words of the application, never the record. MOB-46 keeps reading possible and never reads the clock of the phone (a test greps for it).

## Tenant discovery and theme (ST-MOB-004)

MOB-01 normalises the input (`normalizeTenantInput`), looks the tenant up in `TenantDirectory` (`GET /tenant-discovery?q=`, no credential), chooses the identity provider, saves the hint, applies the published theme and goes to MOB-02. Every lookup that finds nothing (404, 403, 410, 422) is the same message; the phone stops after five lookups a minute and obeys the 429 of the server. `TenantThemeService` applies a theme only when it is a published version of the tenant it is applied for, the whole overlay passes the contrast rules (`overlayAccepted`), and its version is not older than the copy kept for that tenant; the copy is read back when the server cannot be asked. `PublishedTenantTheme` (the theme notifier of the application) follows the session: leaving a tenant drops its theme at once, entering one restores its copy and reads `getMyPublishedTheme`. Only `ThemeData` changes: the route, the scroll positions and the forms stay.

## Account, tenant switch, devices, sign-out (ST-MOB-008)

`AuthService.switchTenant` refuses while commands wait (`PendingCommandsBlock(count)`; the count comes from the offline queue, `PendingWork`), unless the person discards them. The new context is entered first; only then the old tenant is purged, under a journal written before: `TenantDataPurge` runs every `LocalDataPurger` (`localDataPurgersProvider`; by default `OfflineStoragePurger`, which deletes the encrypted database, its journals and its key) and the secure values of the tenant, and a purge that fails or is interrupted is finished when the application starts. The option "delete the local data of the old tenant" (default on) can be turned off: the store then stays encrypted under its key. `signOut` cancels the refresh token at the provider (revocation endpoint, else the end-session endpoint), clears the vault, and purges the active tenant (or every tenant with the "all tenants" scope); it never waits for the provider. A server that answers a call with 401 `DEVICE_REVOKED` makes the phone wipe every tenant on first contact; the wipe of every tenant is journaled (the entry `*` in `purge_pending.v1`) before the credentials are cleared and ended only after every purger and every secure value of every tenant is deleted, so a wipe that fails or is interrupted is finished when the application starts. A tenant token renewal that answers after the person switched tenant or signed out is dropped, success or failure: it never replaces the token of the active context, never purges or ends it, and a request queued for the other tenant is refused with `TenantMismatch`. The biometric unlock (MOB-47) is turned on only with a biometric enrolled and one successful prompt; on resume after 30 seconds away it locks the session, and the prompt only releases the refresh token already in the vault: no code path sends its result anywhere, and it does not clear `stepUpRequired`.

## Release channel (ST-MOB-016)

`PolicyReleaseNotice` reads the version policy at start (`GET /mobile/version-policy?platform=&app_version=`): the application is stopped at MOB-54 only when the server declares the version unsafe (`status: upgrade_required`, or the version in `unsafe_versions`); an application one release behind keeps working. A maintenance window stops everything except the offline screens (MOB-41 to 43). The same happens when a call answers 426 `APP_VERSION_UNSAFE` or 503 `MAINTENANCE_WINDOW`. A policy that cannot be read blocks nothing. MOB-50 sends `createSupportTicket` with the topic, subject and description plus one line `app 1.4.0+27, android 14`; the command attempt is kept while the content does not change. `TelemetryService` accepts only the events and the attribute shapes of `telemetry.dart`, adds `tenant_id` to every event (`none` before a tenant), and reports a crash as the type of the error. No vendor is wired: the default sink keeps the last events in memory.

## What only a device or the real services can prove

Listed in the report of the story; in short: the system browser and the redirect on both platforms (including that no other application can take `vn.machvon.app`), the Keychain and Keystore behaviour across OS versions and after a restore, the biometric prompt, the system permission prompts and the settings link, the real identity provider (rotation and family revocation, `acr_values=aal2`, the end-session call), the three server contracts that do not exist yet (tenant discovery, version policy, 426/503 codes), the revocation of a device on the server (its push token), the OS version string on Android and iOS, and the store and MDM release itself.
