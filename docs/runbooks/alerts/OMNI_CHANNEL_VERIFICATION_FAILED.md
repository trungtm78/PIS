# OMNI_CHANNEL_VERIFICATION_FAILED

**Owner:** omni-supervisor · **Severity:** warning · **Rule:** `alerts/rules/OMNI_CHANNEL_VERIFICATION_FAILED.json`

## What it means

The consumer `omni.channel-verification` asked a provider about a channel account (`verifyChannelAccount`) and the answer was not "good". The account stays where it was (PendingVerification or CredentialExpired) and keeps the reason on its card (`verification_error`): `CREDENTIAL_INVALID` (the credential is wrong), `WEBHOOK_REJECTED` (the provider refused to register the webhook), `PROVIDER_UNREACHABLE` (no answer in time or an error) or `PROVIDER_NOT_CONFIGURED` (this environment has no real verifier, as in production before the provider is contracted: D06). The alert carries the tenant, the channel, the id of the account and the reason, never a secret.

## What to do

1. `CREDENTIAL_INVALID` or `WEBHOOK_REJECTED`: the supervisor corrects the credential or the webhook secret in the vault and asks again (OMNI-06, Verify). Nothing is done to the account itself; its references never change.
2. `PROVIDER_UNREACHABLE`: check the status of the provider and ask again when it is back.
3. `PROVIDER_NOT_CONFIGURED`: expected until a real verifier is bound (`CHANNEL_VERIFIER`, `TODOS.md` ST-OMNI-001). No account can become Active in production before that.
