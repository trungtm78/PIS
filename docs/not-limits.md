# Channel limits, cost and the operations overview (ST-NOT-010, NOT 3.1, BR-NOT-13, BR-NOT-14, NOT-04, NOT-15)

## The limits (`setChannelLimits`, `PUT /channel-accounts/{id}/limits`, `notification.channel.manage` on the whole tenant, If-Match)

A channel account has an optional **daily cap** (messages sent per day, 1 to 10,000,000) and an optional **monthly budget** (whole VND, 0 or more). The body carries the limits to change; a limit is taken off with its own flag (`clear_daily_send_cap`, `clear_monthly_budget`: a generated client cannot write null), and a value beside the flag of the same limit is `VALIDATION_FAILED`. A reason (10 to 2000 characters) goes to the audit row `notification.channel_limits_set` (the channel and the two figures). A closed account has no limits to change (409 `CHANNEL_ACCOUNT_STATE_INVALID`). The attempts held by the old limits (`CHANNEL_CAP`, `CHANNEL_BUDGET`) are released in the same transaction (no retry time, no hold code) and judged again at the next round under the new limits, so raising or removing a limit does not leave them waiting for the next day or month; one still over a limit is held again. The day and the month are those of Vietnam (UTC+7).

## Enforcement (`DeliveryEngine.claim`, step "cap and budget")

When a send is taken up, after the account is checked to be Active and before the preference/consent/quiet-hours gate:

- **CRITICAL is never held back by money.**
- An ordinary message that would take the account over its **daily cap** (`sent today + 1 > cap`) is held until the start of the next day: the attempt stays Queued with `error_code` `CHANNEL_CAP` and `next_retry_at`.
- One that would take it over its **monthly budget** (`spent this month + price of the message > budget`) is held until the start of next month: `CHANNEL_BUDGET`. A channel priced 0 (e-mail, push, Zalo OA) is held by the cap only.
- "Sent" counts the attempts of the account taken up since the start of the day (`sending_at`); "spent" is the sum of the estimated price written on each attempt when it is taken up (`delivery_attempt.cost`). The prices are `CHANNEL_UNIT_COST_VND` (SMS 800, Zalo ZNS 300, WhatsApp 1,000) — **estimates** until the price lists of the providers are in the SAS plan.
- The check runs under an advisory lock on the account, taken only for an account that has a limit, so two sends claimed at once cannot both slip under the same cap; the account row is also locked FOR SHARE, so `setChannelLimits` waits for a claim in flight.
- A message the provider accepts is counted once in SAS under its meter (`notification.email|sms|zns`), keyed by the attempt (BR-SAS-15).

## The overview (`getDeliveryOverview`, `GET /delivery-overview?from&to`, `delivery_attempt.read` on the whole tenant)

For each channel, the attempts made in the period that have ended — delivered, read, failed, suppressed, unknown — and the delivery rate by BR-NOT-14: `(delivered + read) / (ended − suppressed)` in percent with two decimals, the unknown kept in the denominator and shown apart (100 attempts, 5 suppressed, 11 unknown, 80 delivered give 84.21 % over 95). No rate (null) when nothing was sent. The period is judged by when the attempt was made; the cutoff is the end of the period; at most 90 days, the last 7 by default. For each account that is not closed: sent today against the cap, spent this month against the budget, and the messages held by the limits.

`NOTIFICATION_ADMIN` holds `delivery_attempt.read` and `channel_account.read` (V1446 brings the tenants seeded before this up to date; before, the role could not read the delivery screens).

## Screens

- **NOT-04** (`OverviewScreen`): the period (24 hours, 7 or 30 days), the formula, the cutoff and the time of computation, the table per channel with the unknown apart and a link to reconcile it (NOT-11), and the use of the limits of each account. Read again every minute.
- **NOT-15** (`ChannelLimitsScreen`): the same use figures, and for each account the form of the limits (cap, budget, the flags that take them off, a reason), judged before sending the way the server does and saved at the version the form was opened on.

## The SMS adapter

`SmsHoursAdapter` (provider `mock-sms`, MOCK, registered outside production): records the messages like the in-memory adapter and sends only between 07:00 and 21:00 in Vietnam [working assumption, CXN-SPAM-01]; outside them it answers a failure that can be tried again with the wait until the hours open. The real brandname provider waits for D06.
