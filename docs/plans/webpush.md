# Plan of lane WEBPUSH: the real web-push channel, its receipts and the settings page (YCK.01)

Branch `lane/webpush`, worktree `D:\PIS-webpush`, migration block `WEBPUSH-1` 2860-2879. Customer spec YCK.01 (push notifications, reminders and alerts through the application, e-mail and Microsoft Teams). Lane ENT-4c owns the SMTP and Teams adapters (not touched here); this lane owns the web-push channel and the receipt path.

## What already exists (read before planning)

`apps/api/src/notifications/push/web-push.ts` already holds the RFC 8291 encryption, the RFC 8292 VAPID signature, the subscription parser, the host allowlist, the payload rule (generic title and a link only) and `VapidWebPushSender`. What is missing is the operation around it: key management from a secret file, a per-tenant rate limit, the retry pause the push service asks for, an honest channel state, a probe against a real subscription, a receipt path, the settings page.

## Decisions (owner rule 2026-11-08: deepest governance, extensibility, no scope cut)

- D1. No new dependency: the sender stays on `node:crypto` and the platform `fetch` (RFC 8291/8292 are already tested against the RFC test vectors in `web-push.test.ts`).
- D2. State of the channel: `MOCK` (no VAPID keys) -> `PENDING_SPIKE` (keys configured, real sender, no live check yet) -> `VERIFIED` (the operator sets `MACHVON_WEBPUSH_SPIKE_VERIFIED=true` after running `docs/runbooks/web-push-spike.md`). `AdapterStatus` of the kernel keeps its four words (a database CHECK uses them): `PENDING_SPIKE` is reported as `MOCK` outside production (the registry lets it run for the spike) and as `PROPOSED` in production (the registry refuses it), `VERIFIED` as `VERIFIED`. In production the web provider is registered only when `VERIFIED`; native tokens are then refused for good without revoking the device (no real FCM or APNs exists).
- D3. Keys: public key in `MACHVON_WEBPUSH_VAPID_PUBLIC_KEY`; the private key from `MACHVON_WEBPUSH_VAPID_PRIVATE_KEY_FILE` (a path, trailing newline trimmed, file never read by the web build), else the existing vault reference, else the plain variable. The receipt key (D5) the same way (`MACHVON_WEBPUSH_RECEIPT_KEY_FILE`). A key file is read once at start.
- D4. Sender hardening: a bounded in-process token bucket per tenant (default 600 messages/minute, `MACHVON_WEBPUSH_TENANT_PER_MINUTE`) answers `QUOTA_EXCEEDED` with a pause when empty; `Retry-After` of the push service reaches the delivery engine as the pause of the retry (the engine owns the retry schedule and the five-send limit, so the sender does not retry behind its back); `TTL` and `Urgency` come from the message (urgent alerts `high`, default `normal`); 404/410 purge the device (existing path), counted in a metric.
- D5. Receipts: the push carries an opaque receipt token (`rcpt`, an HMAC capability bound to tenant, notification and device, valid 48 hours; 84 bytes, no name or amount). A service worker has no session, so the token is the authority; `acknowledgePush` (`POST /push/receipts`, public, plane edge, like the channel webhook) verifies it, runs in the tenant of the token as the worker membership and moves the push attempt `ProviderAccepted -> Delivered` (event `SHOWN`) or `-> Read` (event `CLICKED`) through the monotonic status reducer, so a repeat or a late event changes nothing (idempotent). Rate limited per client address.
- D6. The ladder (NOT-30) already reads the attempt statuses as receipts (`receiptStateOf`), so an unacknowledged push is a rung still `SENT` after its `wait_minutes` (the configurable time, rule `ALERT_CHANNEL_LADDER`) and the next rung is sent. `TEAMS` becomes a ladder channel next to `EMAIL` (event type and engine channel mapping, database CHECK); the rungs are port calls through the delivery engine (the adapters of ENT-4c answer them).
- D7. Page: PWA notification settings at `/m/notifications` (permission state, subscribe, test notification to myself, unsubscribe); the test notification is the existing `sendTestNotification`-style path if one exists, else a self-addressed test through the device record. Words in `webpush.{vi,en}.json`.

## Steps

- [ ] 0. Plan, migration block registered.
- [ ] 1. Sender: key files, state of the channel, per-tenant limiter, retry-after, urgency; tests against a fake push service server (HTTP over a local TLS-less allowlisted host in the test), unit tests.
- [ ] 2. Probe and runbook: `scripts/web-push-probe.mjs`, `docs/runbooks/web-push-spike.md`, docs `pwa.md` and `not-push.md`.
- [ ] 3. Receipt token (pure, kernel-free module in the API), `DeliveryEngine.acknowledgePush`, controller `acknowledgePush`, contract by `contract-patch`, authz matrix, error codes; payload carries `rcpt`.
- [ ] 4. Service worker posts the acknowledgement on show and on click; web tests.
- [ ] 5. Ladder: `TEAMS` rung channel (kernel, migration, engine mapping), tests.
- [ ] 6. Settings page, i18n part, route, tests.
- [ ] 7. Shared suite lists (isolation, conformance counts, authz matrix, workers/jobs) added, not run; lint/typecheck of what is touched; independent review of `git diff main...HEAD` (Codex is rate limited until 2026-11-10 23:17); `git merge main`.

## Tests per step

1: key file read and trimmed, malformed key refused, state table, limiter refills and is per tenant, fake push service gets the headers (`TTL`, `Urgency`, `Topic`, `Authorization: vapid`, `Content-Encoding`), 201/404/410/429 with Retry-After/500/timeout map to the engine codes, a redirect is refused, a host off the allowlist is never called. 3: token round trip, tampering, expiry, wrong tenant; engine moves attempts once, repeat is a no-op, other recipient untouched. 4: worker posts exactly the token and the event, never the payload text; a failing post never blocks the notification. 5: kernel ladder with TEAMS. 6: states of the page (unsupported, unconfigured, blocked, off, on, busy, failed).

## Risks

- Database and API suites cannot run while the shared gate is active: they are written and typechecked, and run when the machine allows; the report says what ran.
- A live check against real push services needs a real browser subscription: the probe and the runbook are written, the channel stays `PENDING_SPIKE`.
