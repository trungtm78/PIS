# MOB: payment tracking and Treasury reconciliation on the phone (ST-MOB-025)

MOB-27 lets an accountant follow the payment requests of a project on a timeline; MOB-60 lets them review the Treasury reconciliation items, with the two amounts and their difference side by side. The code is in `apps/mobile/lib/features/payment_tracking`. The server half is `docs/pay-chain.md` (`getPaymentChain`), `docs/pay-treasury-match.md` and `docs/pay-payment-requests.md`; the web screens are PAY-17, PAY-05/06 and PAY-03, whose statuses and sentences the screen reuses.

## MOB-27 (`/projects/mob-27`)

| location | shows | reads |
|---|---|---|
| `/projects/mob-27` | the projects, to choose one | `get_resources_project` |
| `?project=<id>` | the chain of the project: the totals of the requests that count (count, gross, settled) and the payment requests in the order they were drawn up, each with kind, status, gross and net, filterable by contract | `getPaymentChain` |
| `?project=<id>&request=<id>` | one request: status, the amounts (gross, advance recovered, held back, tax adjustment, further advance, net), and what happened to it: drawn up, submitted, sent to the Treasury, the transactions the Treasury confirmed (voucher, time, amount), paid, reversed, the settlement it is part of | `get_resources_payment_request_id` and `getPaymentChain` |

- **AC-ST-MOB-025-1 (UAT-PLAN-40).** The status is the server's; amounts are strings of whole dong shown **in full** (`2.100.000.000 đồng`, never `2,1 tỷ`); times are the server's instants in Vietnam time. The clock of the phone is not used for anything on the screen (a test sets the phone to 2031 and reads every text). A step the server did not record a moment for is left out, never guessed, and "last update" is the latest instant the server gave.
- **AC-ST-MOB-025-3.** The phone does not draw up, change, submit or send a payment request (MOB.md 2: the accountant follows payments and reconciles; creating is forbidden on the phone). No view of the screen has a button, a floating action or the word of one, **whatever the server says the caller may do** (the detail answers `actions.revise`, `submit`, `send_treasury`... and the test gives them all true), so an accountant without the right to create is offered nothing, and so is one with it. A line on the screen says the phone is for following.
- A project, contract or request outside the scope is the not-found state with its code (the server answers 404 for a guest contractor as well); a chain the server cut short says so.

## MOB-60 (`/projects/mob-60`)

Without a parameter the screen lists the items (`listReconciliationItems`, pages followed), with the count of what waits, the number overdue and the sum of the differences that wait, **as the server gives them**; the late ones first, then by due time; a filter keeps those that wait (open and explained). With `?item=<id>` (`getReconciliationItem`) it shows one: project, contract, request number, Treasury voucher number, the statement file, the owner and the due time, then:

> Số nội bộ · Số Kho bạc xác nhận · Chênh lệch (xác nhận trừ nội bộ)

**AC-ST-MOB-025-2 (UAT-AC12).** Both amounts and the difference are shown, exact, with the sign (a negative difference is a shortfall at the Treasury, and the screen says "the Treasury confirmed less than the internal figure"), and **no figure is chosen**: the screen has no control that picks, nets, corrects or substitutes a figure, and a line says so. A figure the item does not have (a transaction not matched, a confirmation missing) is "no figure yet", and then there is no difference of the phone's own: the difference shown is the server's, and only when the server gave none and both figures are there is it worked out, on whole dong (`BigInt`), as the confirmed figure less the internal one.

**What the person may do** is write down what was found: *explain* the cause (`EXPLAINED`) or say it is dealt with (`RESOLVED`), each with a note (required, at most 2000 characters), through `resolveReconciliationItem` under the version of the item. It changes no figure. It is offered only where the item still waits and the server's `actions.explain`/`actions.resolve` allow it; it is **online only**, never from a copy kept on the device and never queued; a lost answer is sent again under the same key; and the refusals (`RECONCILIATION_STATE_INVALID`, `SELF_APPROVAL_DENIED`, `VERSION_CONFLICT`, a second factor, a licence, validation, denial, the ended session) each have their sentence and their code. Writing a difference off (`WRITTEN_OFF`) needs the document that approves it and somebody other than the owner: it stays on the web (PAY-06).

## Tests

`test/features/payment_tracking/payment_test.dart` names `UI-MOB-27`, `UI-MOB-60`, `AC-ST-MOB-025-1` to `-3`, `UAT-PLAN-40`, `UAT-AC12` and `TK-MOB-025-2`. The server is a scripted transport, so a command, a refusal, a lost answer and the headers (`Idempotency-Key`, `If-Match`) are real requests; every view is driven through the states of `expectEveryState` and the contract of `expectScreenContract`.

## What only a device can prove

The look of long exact amounts (`2.350.000.000 đồng`) and of the three figures on a 360 dp screen at 200 percent text; TalkBack/VoiceOver reading of the timeline and of the figures; the second-factor round trip when the server asks for it; a connection cut between the request and the answer; and `UAT-AC12` against a real statement import (`importTreasuryStatement`, `matchTreasuryTransaction`) rather than a fixture.

## Gaps

- The chain gives `created_at` for a request and the confirmed time of its transactions, but not the time of each status change (verified, sent to the Treasury is a day). The timeline therefore shows the moments the request detail and the chain record, and the "last update" is the latest of those; a status history read model would give the rest.
- `getTreasuryTracking` (PAY-09: per project, sent / settled / confirmed / unmatched / differences) is not shown on the phone; the board's own summary is.
