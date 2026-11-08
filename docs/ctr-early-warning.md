# Early-warning register of a contract (GOV-8, roadmap G1-15)

CTR section 14.2, screens CTR-35 (register) and CTR-36 (record), story ST-CTR-022. Migrations `V1983`, `V1984` and `V1985`. Kernel: `packages/kernel/src/ctr-early-warning.ts`. Database: `ctr-early-warning-store.ts`, alert source `home-contract-register-sources.ts`.

In the FIDIC and NEC family of contracts a party that sees something that may delay the work, raise its price or lower its quality warns the other at once, and the parties review the open warnings together: the register is first issued shortly after the contract starts, is reviewed in meetings at a fixed rhythm and is issued again shortly after each meeting. This register belongs to one contract and its parties. It is not the disbursement warning of DIS (`early_warning`, HOME-06), which watches money against a plan; the operations carry `Contract` in their names (`listContractEarlyWarnings`) for that reason.

## A warning (`contract_early_warning`)

Numbered `EW-nnn` per contract. Raised by any party (`raised_by_party`: `OWNER`, `CONTRACTOR`, `SUPERVISOR`, `DESIGNER`, `OTHER`; the member who entered it is kept) on a day not in the future; category `TIME`, `COST`, `QUALITY`, `SAFETY`, `SCOPE`, `LEGAL`, `ENVIRONMENT`, `OTHER`. The contract must be past `DRAFT`, `IN_REVIEW` and `CANCELLED`.

```
RAISED -assess-> ASSESSED -first action-> MITIGATING -close-> CLOSED_RESOLVED | CLOSED_MATERIALISED | CLOSED_WITHDRAWN
```

- **Assessment.** The person who answers for it (a member), the likelihood (`LOW`, `MEDIUM`, `HIGH`) and the expected impact: days of time, an amount in whole VND, or the statement "no impact expected". A blank impact is refused (422 on `expected_time_days`). It can be repeated while the warning is open (the figures change, the state stays).
- **Actions** (`contract_early_warning_action`). Only on an assessed warning (409 `EARLY_WARNING_STATE_INVALID` on a raised one). Each has words, a person and a due day not in the past. An action ends `DONE` or `CANCELLED` with words; it keeps its words, owner and day (trigger).
- **Closing.** `RESOLVED` needs no open action (409 `EARLY_WARNING_ACTIONS_OPEN`) and somebody other than the person who answers for it (403 `SELF_APPROVAL_DENIED`; CHECK `contract_early_warning_resolved_checker_chk`): the owner of the mitigation cannot also certify the risk gone. `MATERIALISED` names the change order or the claim of the same contract it became, exactly one (CHECK, and 422 `materialised_id` for another contract's). `WITHDRAWN` is the only way out of a warning that was never assessed. Every closure has a reason of at least ten characters. A closed warning is not reopened (trigger): raise a new one.

## Meetings and issues

- **Meeting** (`contract_early_warning_meeting`, `contract_early_warning_review`). Held on a day not in the future, after the previous meeting and not before the contract began; the attendees in words; minutes may be a filed document. The meeting concludes on every warning open that day, each once, with `NO_CHANGE`, `UPDATED`, `ACTION_AGREED`, `CLOSURE_PROPOSED` or `ESCALATED` (422 on `reviews` when one is missed or named twice). The state of each warning at the meeting is kept.
- **Issue** (`contract_early_warning_issue`). `INITIAL` (the first), `AFTER_MEETING` (names the meeting; one per meeting, 409 for a second) or `PERIODIC`. It keeps a snapshot of the warnings (a JSON array) and the SHA-256 of their canonical text, so what was issued on a day can be read back as it was. The day is not in the future, not before the contract began, not before the meeting it follows.
- Meetings, reviews and issues are append-only for every role.

## The rhythm (rule `EARLY_WARNING_POLICY`, unverified)

| Clock | Starts | Due |
|---|---|---|
| `INITIAL_ISSUE` | the day the contract came into force (`effective_from`) | 7 days later |
| `MEETING` | the latest meeting, or the start when none was held | 14 days later |
| `REISSUE` | each meeting | 7 days after it, one clock per meeting without an issue |

Plus `approach_days` 3 (a clock is `APPROACHING` that many days before its day) and `basis` (`CALENDAR_DAYS` by default or `WORKING_DAYS`; no calendar published means `CALENDAR_UNAVAILABLE`, never a guessed day). The numbers are the starting values of the roadmap research for NEC-style contracts, flagged unverified until the tenant approves its own. A contract that is not `ACTIVE` keeps no rhythm (`NOT_STARTED`). The states are those of the claim deadlines (`RUNNING`, `APPROACHING`, `MET`, `MET_LATE`, `MISSED`, ...).

## Alerts (ALERT_TYPE, source `CONTRACT_EARLY_WARNING`)

Computed when the list is read, no job. Each late clock of a contract is an item of its own (the first issue, the meeting, and the re-issue of each meeting).

| Code | Owner | Expected action | Consequence | Response | Severity |
|---|---|---|---|---|---|
| `EW_REGISTER_OVERDUE` | contract manager | issue the register (first, or after a meeting) and record the day | parties work with an old register; no proof of timely warning | 72 h | WATCH approaching, ACTION past |
| `EW_MEETING_OVERDUE` | contract manager | hold the review meeting with the parties and record it | open warnings are not discussed | 72 h | WATCH approaching, ACTION past |
| `EW_ACTION_OVERDUE` | action owner (`EARLY_WARNING_ACTION_OWNER`) | finish the action, or tell the keeper and agree a new day with a reason | the risk grows and the warning loses its use | 72 h | ACTION |

## Interfaces

Permissions: `early_warning.read`, `early_warning.raise` (grantable to a supervisor or a contractor's representative without the rest), `early_warning.manage`, `early_warning.close`. Operations: `raiseContractEarlyWarning` (`POST /contracts/{id}/early-warnings`), `listContractEarlyWarnings` (`GET /contract-early-warnings`), `getContractEarlyWarning`, `assessContractEarlyWarning` (If-Match), `addContractEarlyWarningAction`, `completeContractEarlyWarningAction` (If-Match), `closeContractEarlyWarning` (If-Match), `recordContractEarlyWarningMeeting`, `issueContractEarlyWarningRegister`, `getContractEarlyWarningRegister` (`GET /contracts/{id}/early-warning-register`: the three clocks, the meetings with what they concluded, the issues, the summary, the policy with its source). Events: `ctr.early_warning.raised.v1`, `.updated.v1`, `.closed.v1`, `ctr.early_warning_register.meeting_recorded.v1`, `.issued.v1`. Error codes: `EARLY_WARNING_STATE_INVALID`, `EARLY_WARNING_ACTIONS_OPEN`, plus the common ones.

## Report hook

`earlyWarningSummary` (kernel): counts by state, category and party, open warnings without an owner or never assessed, the impact the open warnings expect together (exact decimal VND and days; a warning with no figure and no "no impact" is counted in `impactUnknown`, never as zero), overdue actions. `CtrEarlyWarningStore.list` returns it with each page, over every warning that matches the filter.
