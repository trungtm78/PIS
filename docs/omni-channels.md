# Channel accounts (ST-OMNI-001, OMNI 3.7, OMNI-05, OMNI-06)

A channel account is the account of the tenant at a provider (e-mail relay, SMS gateway, Zalo OA/ZNS, WhatsApp, FCM, APNs) through which messages go out and webhooks come in. NOT-1 created the table for the delivery engine; this story gives it its life.

```
PendingVerification -verify-> Active -disable-> Disabled          Active -(provider: credential gone)-> CredentialExpired -verify-> Active
```

The database keeps the rules (migration **V1280**, trigger `guard_channel_account`): what an account is (tenant, channel, external id, the references of its secrets) never changes, the moves above are the only ones, Disabled is final, and Active needs `verified_at`.

## Commands (`omni.channel.manage`, on the whole tenant)

| Operation | Does |
|---|---|
| `connectChannelAccount` `POST /channel-accounts` (201) | Creates an account as PendingVerification. The body has **references** into the vault (`secret://...`), never a secret: a pasted token is 422. A channel with webhooks (e-mail, SMS, Zalo, WhatsApp) needs `webhook_secret_ref`, a push channel must not have one, and the two references differ. The same channel and external id in the tenant is 409 `CHANNEL_ACCOUNT_EXISTS` while one of them is open; once the first is Disabled the provider account can be connected again as a new account (V1282: the unique index leaves the closed rows out). |
| `verifyChannelAccount` `POST /channel-accounts/{id}/verify` (202, If-Match) | For a PendingVerification or CredentialExpired account: sets `verify_requested_at` and writes `omni.channel_account.verification_requested.v1`. Otherwise 409 `CHANNEL_ACCOUNT_STATE_INVALID`. |
| `updateChannelAccount` `PUT /channel-accounts/{id}` (If-Match) | Display name, the auto reply outside working hours (≤ 500 characters; an empty text clears), the calendar (a Published `work_calendar_version.calendar_code`; an empty code clears). A closed account is 409. |
| `disableChannelAccount` `POST /channel-accounts/{id}/disable` (If-Match) | Closes the account for good and writes `omni.channel_account.disabled.v1`. A new account is connected instead. |

Reads (`channel_account.read`, whole tenant): `get_resources_channel_account` (filters `status`, `channel`; keyset paging) and `get_resources_channel_account_id`. The answer has `credential_configured` and `webhook_configured` and **no reference to a secret**; the audit rows carry the channel and the changed fields only, never the external id, a reference or the text of the auto reply. `OMNI_SUPERVISOR` holds `channel_account.read` (V1281 brings the tenants seeded before this up to date).

## Verification

`ChannelVerificationConsumer` (inbox name `omni.channel-verification`) answers the request: it reads the account, asks the provider **outside any transaction** through `ChannelVerifierPort` (the port reads the secrets from the vault by the references; the application never holds them), and records the answer against the request it answers (`verify_requested_at` must still match).

- Accepted: Active, `verified_at`, audit `omni.channel_account_verified`, event `omni.channel_account.verified.v1`.
- Refused or unreachable or no answer in 15 s: the account stays as it was, `verification_error` keeps the reason (`CREDENTIAL_INVALID`, `WEBHOOK_REJECTED`, `PROVIDER_UNREACHABLE`, `PROVIDER_NOT_CONFIGURED`), audit `omni.channel_account_verification_failed`, alert `OMNI_CHANNEL_VERIFICATION_FAILED`.
- A request renewed, answered or withdrawn since (the account was disabled) is not answered twice (`STALE`).
- Delivered again, the provider is not asked again (the inbox row). If the process stops between the question and the record, the account stays pending and verification is asked for again (OMNI-06 offers Verify again once a request has waited more than a minute).

The only implementations of the port are `MockChannelVerifier` (outside production) and `UnconfiguredChannelVerifier` (production: every account is refused with `PROVIDER_NOT_CONFIGURED` until a real one is provided as `CHANNEL_VERIFIER`).

## Only a verified account sends or receives (BR-OMNI-02, BR-OMNI-04)

- **Webhooks**: the tenant is the one of the account named by the receipt, and only an Active account answers (`channel_accounts_by_external_id`, NOT-1): a disabled, pending or expired account is 404 `CHANNEL_ACCOUNT_UNKNOWN`. The signature, the 5-minute window and the dedupe are ST-NOT-002 (UAT-AC196 is tested again here with a byte changed after signing).
- **Sending**: `DeliveryEngine.claim` looks at the account before anything else: an attempt whose account is not Active is Suppressed with `CHANNEL_ACCOUNT_DISABLED` (closed) or `CHANNEL_UNVERIFIED` (anything else), whatever its plan said when it was made, and nothing is sent.
- **Credential expired**: an adapter answering `CREDENTIAL_EXPIRED` (permanent) moves the Active account to CredentialExpired in the same transaction as the failed attempt, and the alert `OMNI_CHANNEL_CREDENTIAL_EXPIRED` is raised (tenant, channel, account id). What waits for the account is Suppressed at its turn; nothing is replayed by itself after the account is verified again.

## Screens

- **OMNI-05** (`ChannelConnectScreen`): one card per account (name, channel, status, verified at, the secrets as "configured" or "not used"), filters by status and channel, "load more", and the connect form (the references only; the form refuses a pasted token before sending; no webhook field for a push channel). The seven states come from `StateBoundary`; the form is not offered to a reader or a read-only tenant.
- **OMNI-06** (`ChannelConfigScreen`, `?id=`): the facts, the last verification error, a note while a verification waits for the provider (the account is read again every 3 s), the notes for a closed account (channel-disabled) and for an expired credential, the form of name/auto reply/calendar with a reason, and the Verify and Disable actions with a reason (Disable warns that it cannot be undone). A closed account has no action.

Operations of the story are in `docs/runbooks/alerts/OMNI_CHANNEL_*.md`. Not here: the real providers behind the verifier, the conversations that use the accounts (ST-OMNI-002+), the daily cap and the budget of an account (`setChannelLimits`, ST-NOT-008/010).
