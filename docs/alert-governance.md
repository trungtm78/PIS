# Governance of the alert system: escalation, notification profile, absence cover, health

Roadmap items G2-3 (functional and hierarchical escalation), G2-5 (notification profile of each person), G2-7 (absence, deputies, coverage, orphaned alerts) and G2-10 (health page with fourteen indicators), lane GOV-9a. They build on the alert centre (`HomeWorkStore`, `work_action`, the work clocks of `docs/work-clocks.md`, the registry `ALERT_TYPE`), and the research in the alert section of `docs/governance-roadmap-10of10.md`.

The idea in one sentence: every alert has somebody who is there to receive it, an alert nobody acts on goes up a chain whose waiting times are counted in working hours, a person is reached by the channel their profile and the hour allow while the bell of the application always tells the truth, and the alert system measures itself with fourteen indicators that each have one formula and one source.

## The rules are data

Four governance rule types (`packages/kernel/src/governance-rules.ts`, `registerAlertGovernanceRules`), code `DEFAULT`, read through `GovernancePolicyPort`, flagged **unverified** (starting values of the research: PagerDuty, ITIL, Grafana IRM, Opsgenie, ISA-18.2 and EEMUA 191 through vendor summaries, which are for continuous plants and are a method here, not legal numbers). A decision that used one stores its version (`builtin` for the default).

| Rule type | Says | Built-in default |
|---|---|---|
| `ESCALATION_POLICY` | levels for each severity (kind FUNCTIONAL with a role, or HIERARCHICAL with tiers up; working hours after the level before), triggers, hold after an acknowledgement, the orphan step, raising of items to be watched, rank of leadership | Urgent: leadership tier 1 at once, function AUDITOR after 4 working hours, tier 2 after 8 more; Action: tier 1, tier 2 after 16; Watch: no level, raised to Action after 20 untouched working days; hold after acknowledgement 8 / 24 / 40 hours |
| `ABSENCE_POLICY` | longest absence and cover, depth of the chain, working hours before an uncovered absence is a gap, rank rule of the deputy, holders that back a position up | 180 and 90 days, depth 2, 8 working hours, deputy at least a peer, 2 holders, positions from rank 60 |
| `ALERT_NOTIFY_POLICY` | quiet hours and weekends, digest hour, cap of pushes a day, grouping of urgent notices, lowest severity pushed, default channels by severity, lines of the digest | 21:00 to 06:30 and weekends in Vietnam time, 07:30, cap 5, group after 3 urgent in an hour, floor Action, 20 lines |
| `ALERT_HEALTH_TARGETS` | the target of each indicator and the minimum sample | see the table of indicators |

`ALERT_TYPE` gains an optional `quiet_bypass` (an urgent alert of this type may break the quiet hours once nobody took it up in time; off unless the tenant approves a rule that sets it). Two alert types are new: `ESCALATED_ITEM` (owner ESCALATION_RECIPIENT, 24 hours) and `COVERAGE_GAP` (owner ALERT_COVER_MANAGER, 8 hours), each with expected action, consequence and reason to exist.

## Escalation (G2-3)

`packages/kernel/src/alert-escalation.ts`, job `alert-escalation`, table `alert_escalation`.

- **Triggers**: nobody took the item up in time (the claim clock of the engine is breached and the item is still new), somebody took it up and showed no sign of work (needs re-claim), it ran past its time (the resolve clock is breached). The earliest trigger is the anchor. A paused item and a put-off one do not climb. An orphaned item (its owner left, or is away with nobody to cover) climbs at once by the orphan step.
- **Levels**: level n is reached `after_working_hours` after level n-1, counted by `addWorkingTime` on the published calendar. A year without a published calendar leaves the levels that wait absent (`basis: CALENDAR_UNAVAILABLE`); nothing is guessed. A level whose recipient acknowledged the item holds the later levels for the hold of the severity.
- **Recipients**: FUNCTIONAL goes to everybody who holds the role at the place of the owner (a team); HIERARCHICAL goes to the leadership tier `levels_up` above the owner (tiers are ordered by how near their unit is, then by rank; only ranks from `leader_min_rank` up to the administrative floor count, and for an approval at least the rank of the band of the matrix of authority, found with `DoaMatrixStore.resolve`). A function nobody holds falls to the first leadership tier and records the gap `FUNCTION_VACANT`; a place without leadership falls to the administrators and records `NO_LEADER`; with nobody at all the level is not recorded and is tried again (the chain is never silently empty). A recipient who is away is replaced by the deputy whose cover is in force.
- **Raising**: an item to be watched that stayed untouched (new, not put off, not paused) for `after_working_days` becomes Action with the reason `WATCH_AGED` (a `PROMOTION` row; the alert centre shows it as Action with `promoted_from`).
- Every level is one row for one person (`series_key`: item, level, person) plus the event `home.alert_escalated.v1` in the same transaction. Nothing carries a word of the item: the row snapshots the title the owner saw, for the person who receives it, and the event holds ids and codes.
- The card of an item shows the chain (`escalation.chain`: the owner, then each level named functional or hierarchical), the level it stands at and when the next comes. The recipient sees the item as an item of their alert centre (source `ESCALATION`), opened where the original is opened, and acknowledges it (`acknowledgeAlertEscalation`).

## Notification profile (G2-5)

`packages/kernel/src/alert-notify.ts`, `alert_notification_profile`, `alert_notification_log`.

- The **bell is the list**; nothing here can hide an item from it (the plan always has `inApp: true`, tested over every combination). Push, SMS and Zalo are the channels that interrupt: they keep the quiet hours, the cap of the day and the threshold of the person, SMS and Zalo need the consent of NOT-17, e-mail is read when the person chooses and keeps neither. An item to be watched is never pushed, only digested.
- Quiet hours: the alert profile, else the ones the person set in NOT-03, else the policy; an urgent alert of a type that may break them breaks them only when its claim time is past, and then carries `bypass: URGENT_UNCLAIMED` (the table refuses an in-quiet notice without it). A held notice is released once when the quiet hours end (`RELEASE:` series) if its item is still open.
- Cap: beyond the cap an urgent notice is sent grouped ("N urgent items"), anything else goes to the digest; the fourth urgent notice of an hour is grouped as well.
- **A push carries no amounts and no names (R7)**: `buildPushPayload` chooses a fixed sentence by kind and severity, a count and a path (`/home/my-work`); `assertPushPayloadSafe` refuses anything else. The event is `home.alert_notice.v1`; delivery (G2-6) consumes it.
- **Digest**: once a day when the person's own hour comes, the card of what is overdue, due within the lookahead days, new since the last digest, and what waits for them as a deputy; each line has the consequence and where to act; `getMyAlertDigest` previews it. A digest push is not held over the quiet hours (the card is there to be read).

## Absence and cover (G2-7)

`packages/kernel/src/alert-coverage.ts`, `alert_absence`, `alert_absence_cover`, `alert_routing_gap`, jobs `alert-escalation` (routing) and `alert-coverage` (gaps).

- A person declares an absence (or a manager does, in the units they may read); a cover names a deputy for all sources or some, inside the absence, within `max_cover_days`, never the person themselves, never a deputy who left, never of lower rank (rule `AT_LEAST_PEER`), never a loop and never deeper than `max_chain_depth` (the pure checks return every defect with its field: 422 `ALERT_COVER_INVALID`). A cover waits until a **third person** allows it: not the proposer, the absent person or the deputy (403 `SELF_APPROVAL_DENIED`; the table says it as well). **A cover routes attention, never authority**: what a deputy may decide in a module stays what the module grants (approvals need a delegation of ADM-14).
- The deputy sees the work of the absent person on their own list (read in the scope of the deputy, never in the scope of the absent person), marked `on_behalf_of`, and may take it up, assign it or put it off.
- **Gaps** (`alert_routing_gap`, opened once for a cause and closed when the cause is gone, so the time to reroute is measured): `ABSENT_NO_COVER` (away longer than the allowance with no cover for all sources in force), `ABSENCE_STARTING_UNCOVERED`, `OWNER_INACTIVE` (the owner left and items are open: they climb at once to the leadership of their place), `NO_LEADER`, `FUNCTION_VACANT`, `POSITION_UNCOVERED`. The managers see a gap as an alert of the alert centre (source `COVERAGE`) and in the coverage report.
- **Coverage of positions**: a position is a role of leadership in a unit; it is backed up when enough people are present or its holders are covered, a single point when only one is, uncovered when nobody is present and nothing covers. The percent is null when there are no positions.

## Health of the alert system (G2-10)

`packages/kernel/src/alert-health.ts`, `alert_item_trace` (the job writes every item it sees: first seen, claimed, closed as RESOLVED or CLEARED, highest level, puts off), page HOME-13.

Fourteen indicators, each with one formula, one source and a status (OK, WATCH within a fifth beyond the target, BREACH, NO_DATA, NO_SOURCE); a figure that cannot be computed says why and is never 0; time is in working hours less the pauses; the reader sees the units they may read under `home.alert.health.read`; the page says when the recording job is older than two passes.

| Indicator | Target (unverified) |
|---|---|
| MTTA, by severity | Urgent 4, Action 8, Watch 40 working hours |
| MTTR | no target (per type) |
| On time | at least 90 percent |
| Escalated, escalated to the last level | at most 20 and 2 percent |
| New alerts per person per day (p90, by days with at least one) | Urgent 1, all 10 |
| Interrupting notices per person per day (p90) | at most the cap, 5 |
| Notices in quiet hours without the allowance | 0 |
| Stale (not changed for 7 and 30 days) | at most 10 percent over 7 days |
| Weight of the ten largest types | at most 50 percent |
| Put-off rate, by type with enough sample | at most 30 percent (the "not useful" feedback is G2-9) |
| Orphaned alerts, time to reroute | 0, at most 1 hour |
| Delivery of urgent notices | no source until the delivery receipts of G2-6 exist |
| Coverage of deputies | 100 percent |

## What is left to other lanes

- G2-6: delivery receipts, channel ladder and consent management consume `home.alert_notice.v1` and feed the delivery indicator.
- G2-9: the "this alert is wrong" feedback feeds the put-off indicator.
- Mobile: the profile and the coverage on the phone (MOB) are not in this lane.
- Items opened through a module of an owner who left are reassigned in the module; the gap closes when the item shows on another list.
