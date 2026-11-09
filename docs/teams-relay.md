# Microsoft Teams and e-mail reminders (QT.02, YCK.01, lane ENT-4c)

Reminders and overdue alerts of the reporting calendar (job `calendar-reminder`, events `dis.calendar_step.reminded.v1` and `dis.calendar_step.escalated.v1`) reach people through the notification workflow of the tenant: the inbox, e-mail and Teams. This page says how the two external channels are wired, what each is allowed to do, and the options for the customer's network.

## E-mail: a real SMTP relay

Adapter `apps/api/src/notifications/delivery/smtp-adapter.ts` (provider `smtp`, channel `EMAIL`). It uses `node:net` and `node:tls` only. The delivery engine owns the queue, the retries (30 seconds, 2, 10 and 30 minutes, five sends a channel), the fallback and the log of every attempt (screens NOT-11 to NOT-13, table `delivery_attempt`); the adapter only makes the call.

| Variable | Meaning |
|---|---|
| `MACHVON_SMTP_HOST`, `MACHVON_SMTP_FROM` | required: the relay and the sender address |
| `MACHVON_SMTP_SECURITY` | `STARTTLS` (default, port 587), `TLS` (port 465) or `NONE` (port 25) |
| `MACHVON_SMTP_PORT`, `MACHVON_SMTP_TIMEOUT_MS`, `MACHVON_SMTP_HELO`, `MACHVON_SMTP_FROM_NAME` | optional |
| `MACHVON_SMTP_USER` with `MACHVON_SMTP_PASSWORD_REF` | user and the vault reference of the password (read as `MACHVON_SECRET_<REFERENCE>`); `MACHVON_SMTP_PASSWORD` only for a development setup; a user without a password is refused |
| `MACHVON_SMTP_CA_FILE` | PEM bundle of an internal certificate authority |
| `MACHVON_SMTP_ALLOWED_HOSTS` | comma list of host suffixes; a host outside it is refused |
| `MACHVON_SMTP_ALLOW_PLAINTEXT`, `MACHVON_SMTP_ALLOW_INSECURE_AUTH` | `true` to allow clear text where real data lives, or a password over a connection that is not encrypted; both off by default |
| `MACHVON_SMTP_VERIFIED` | `true` once the operator verified the relay (below) |

Rules: TLS 1.2 or later with the certificate verified; with STARTTLS nothing secret is sent before the upgrade, and the capabilities are asked again after it; AUTH PLAIN or LOGIN; addresses are checked (no CR/LF, no angle brackets) before any connection; the body is base64 (no line starts with a dot, the dot-stuffing is kept for safety) and a subject with Vietnamese letters is sent as RFC 2047 words. Replies: 4xx and a refused or timed-out connection are retryable, a 5xx at the recipient or after the data is permanent, a wrong password is permanent, and a connection lost after the end of the data is `UNKNOWN` (never sent again on its own). SMTP keeps no idempotency key, so a lookup answers "cannot tell"; receipts and bounces are not read (they reach the mailbox of the sender).

Status is honest: outside production the adapter is `MOCK`; in production it is `PROPOSED` and the registry will not let it send until the operator sets `MACHVON_SMTP_VERIFIED=true` after a test send through the customer's relay (D06). Without the variables the in-memory stand-in (`smtp-relay`, `MOCK`) serves non-production and production has no e-mail (`MISSING`, sends are suppressed with `ADAPTER_MISSING`). Tests: `apps/api/test/notifications/smtp-adapter.test.ts` against a fake SMTP server (`test/notifications/support/fake-smtp.ts`: implicit TLS, STARTTLS, AUTH, 4xx, 5xx, lost answer, timeout).

## Teams: an incoming webhook, or a relay of the operator

Two adapters serve the `TEAMS` channel; when both are configured the webhook wins.

1. `teams-webhook` (`teams-webhook-adapter.ts`) posts the Adaptive Card to an incoming-webhook URL (Workflows / Power Automate, or a Teams connector). The URL is a secret: `MACHVON_TEAMS_WEBHOOK_URL_REF` (vault reference) or, for development, `MACHVON_TEAMS_WEBHOOK_URL`. The host must end with `webhook.office.com`, `logic.azure.com` or `powerplatform.com`, or with a suffix in `MACHVON_TEAMS_WEBHOOK_ALLOWED_HOSTS`; https on the default port only, no credentials in the URL, no address literal, no redirect, 10 second limit, card at most 28,000 bytes. 429 (with `Retry-After`), 408 and 5xx are retryable; other 4xx and a redirect are permanent; a request that was sent and not answered is `UNKNOWN`. `MACHVON_TEAMS_WEBHOOK_VERIFIED=true` lifts it from `PROPOSED` to `VERIFIED` in production. Tests: `teams-webhook-adapter.test.ts` against a fake HTTP server.
2. `teams-outbox` (`teams-adapter.ts`): writes the card as a file in `MACHVON_TEAMS_OUTBOX_DIR` for a relay of the operator to pick up. The platform makes no network call.

### Customer relay option

When the Tổng công ty network does not let the platform reach Microsoft, give the customer a small relay inside their network: either (a) a Power Automate flow or an Azure Logic App with an HTTP trigger, whose URL ends with `logic.azure.com` and is stored in the vault, or (b) the outbox directory read by a script that posts to Teams from a host that is allowed to. For a relay under the customer's own domain, add its suffix to `MACHVON_TEAMS_WEBHOOK_ALLOWED_HOSTS` and add the host to the egress exception list of the Integration Hub; no code change is needed. Webhook URLs rotate: change the vault entry, not the environment.

## Who receives what

The reminder job writes the events with the unit of the input point as the resource; the notification workflow of the tenant (event types above, channels in the order they are tried) names the roles and the channels. A tenant with no workflow for the event type gets no notification, and the board (DIS-32) still shows every reminder that was recorded in `reporting_reminder`. Alert types with owner, expected action and consequence: `REPORTING_STEP_DUE_SOON`, `REPORTING_STEP_OVERDUE`, `REPORTING_STEP_ESCALATED` (ADM-23).
