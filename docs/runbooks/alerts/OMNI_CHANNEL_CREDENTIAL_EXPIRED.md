# OMNI_CHANNEL_CREDENTIAL_EXPIRED

**Owner:** omni-supervisor · **Severity:** warning · **Rule:** `alerts/rules/OMNI_CHANNEL_CREDENTIAL_EXPIRED.json`

## What it means

A send through a channel account came back from the provider with the code `CREDENTIAL_EXPIRED` (the token or key of the account is no longer accepted). The delivery engine moved the account from Active to `CredentialExpired` (ST-OMNI-001, OMNI 3.7). From then on an attempt that is taken up for the account is Suppressed with `CHANNEL_UNVERIFIED`, so nothing more is sent through it until it is verified again; the messages already Suppressed are not sent by themselves afterwards. The alert carries the tenant, the channel and the id of the account, never a secret.

## What to do

1. Open the account on OMNI-06 (`/omni/omni-06?id=...`) and read its state.
2. Put a new credential in the vault under the same reference (the reference of the account never changes; if the vault cannot take it, connect a new account on OMNI-05 and disable this one).
3. Choose Verify (`verifyChannelAccount`, with a reason). When the provider accepts, the account is Active again and new messages go out. Replay the notifications that matter from NOT-12 (`replay`), one by one: nothing is replayed automatically.
