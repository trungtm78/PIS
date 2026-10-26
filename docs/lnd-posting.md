# LND-1: the posting of a plan, the opinions on it and its approval (ST-LND-006)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LND.md` (sections 3.1 steps 5-6, 4, BR-LND-01, BR-LND-02, UAT-AC377). Migration: `V1687__lnd1_plan_posting.sql`. Screen LND-06 (the detail of LND-05). CXN-12, so the story is DONE_UNCONFIRMED: the number of days is data, not code.

## What the story does

| Operation | Route | Permission | What it does |
|---|---|---|---|
| `postCompensationPlan` | `POST /compensation-plans/{id}/post` (If-Match) | `land.plan.write` over the project | DRAFT to POSTING: counts the days of the rule `PLAN_POSTING_30`, starts the timer, moves the parcels and the households of the plan on. |
| `recordPlanFeedback` | `POST /compensation-plans/{id}/feedback` | `land.plan.write` over the project and the unit of the household | An opinion of a household, or of nobody on the list, while the plan is posted. |
| `handlePlanFeedback` | `POST /compensation-plans/{id}/feedback/{feedback_id}/handle` | the same | The opinion is handled once, with a note; a handled opinion is final. Additive to the design (CR-LND-05): the design asks for opinions to be handled and has no command for it. |
| `closePlanPosting` | `POST /compensation-plans/{id}/close-posting` (If-Match) | `land.plan.write` | POSTING to POSTING_CLOSED, not before the day the timer falls due; satisfies the timer. |
| `approveCompensationPlan` | `POST /compensation-plans/{id}/approve` (If-Match) | `land.plan.approve` over the project | POSTING_CLOSED to APPROVED: no opinion open, a decision document, someone other than the drafter, and the payment is due 30 days later. |
| `listPlanFeedback` | `GET /compensation-plans/{id}/feedback` | `land.read` | The opinions inside the units of the reader. Additive. |
| `getCompensationPlanTimers` | `GET /compensation-plans/{id}/timers` | `land.read` over the project | The timers of the plan with what is left of each on the day of the answer, and the opinions counted (numbers, never words). |

## The days (AC-ST-LND-006-1, UAT-AC377, BR-LND-01, BR-LND-02)

- The days of the posting are those of the rule `PLAN_POSTING_30` of the master data in force on the day the posting starts (`422 TIMER_RULE_UNCONFIRMED` when there is none): the platform does not count a statutory period from a number it made up. `posting_ends_on` is the day the timer falls due (a posting that starts on 2026-08-01 for 30 days ends on 2026-08-31), the timer row of `land_deadline` (subject PLAN) keeps the days, the dates and the version of the rule, and it is satisfied on the day the posting is closed.
- A posting starts on a day that has come and not before the plan was drafted: a posting dated back would shorten what the households were given (`422 VALIDATION_FAILED posting_started_on`).
- `closePlanPosting` before `posting_ends_on` is `422 POSTING_PERIOD_NOT_ELAPSED` (on 2026-08-30 for the example above; on 2026-08-31 it is closed). The screen offers the button once the day has come and says the earliest day before.
- The approval is dated a day that has come and not before `posting_ends_on` (`422 POSTING_PERIOD_NOT_ELAPSED`), with no opinion open (`422 UNRESOLVED_FEEDBACK`, with the count), a decision document that exists (`422 DECISION_DOCUMENT_REQUIRED`) and was scanned clean (`422 DOCUMENT_NOT_CLEAN`), by someone other than the drafter (`403 SELF_APPROVAL_DENIED`; also the CHECK `compensation_plan_approver_chk` of the database). The payment is due `approved_on` plus the days of the rule `PAYMENT_30` of that day (`compensation_plan.payment_due_on`).
- A plan that is not a draft cannot be posted, one that is not posted takes no opinion, one that is not closed is not approved: `409 PLAN_STATE_INVALID` (the state machine of the module, section 4; UAT-AC377 step 5 writes 422 for the approval of a plan that was never posted, the table of the commands and the state machine write 409, and the registry lists both: 409 is used).
- A plan with no amount in it is not posted (`422 PLAN_HAS_NO_ITEMS`, additive to the registry) and one with a compensation on a record that is no longer confirmed is not posted or approved (`422 INVENTORY_NOT_CONFIRMED`), whatever units the caller sees: the check is a function of the database that reads all the items (see below).

## The opinions

- An opinion belongs to the unit it came from: the unit of its household, or the unit that executes the plan when it comes from nobody on the list. Row-level security shows it inside that unit only, like the household itself; a grant on a project reaches no household (the rule of ST-LND-002), so the officer who records or handles opinions needs a grant on the unit tree (`403 SCOPE_DENIED` for an opinion of nobody on the list from outside the executing unit, `404` for a household outside the units of the caller).
- Opinions are recorded while the plan is POSTING (`409 PLAN_STATE_INVALID` otherwise) and handled while it is POSTING or POSTING_CLOSED; what comes after the posting is a complaint (ST-LND-008). The words of an opinion are never in the audit row or the events (ids, channel, dates and counts only); the plan screens show the counts to whoever reads the project.

## What a caller who approves cannot see row by row

The approver holds a grant on the project, which reaches no household, and yet the approval has to know that every record is still confirmed and every opinion handled, and to move the parcels and households of the plan on. Three functions of the database answer it (`SECURITY DEFINER`, owned by the table owner, answering only for the tenant of the transaction, widening `app.scope_units` while they run and putting the caller's scope back before they return): `plan_unconfirmed_inventory(plan)` (the status of the first item whose record is not confirmed), `plan_feedback_counts(plan)` (open and handled opinions) and `advance_plan_subjects(plan, actor)` (the parcels and households that move with the status of the plan). They return a word or a count, never a row of a household. The guard of the plan repeats the checks as a backstop for any other writer.

## Where the parcels and the households go

A draft that has an item lists its inventoried parcels as PLAN_DRAFTED; posting posts the parcels (PLAN_POSTED) and lists the inventoried households (PLAN_LISTED); approval approves the parcels it posted (PLAN_APPROVED). A parcel or a household that is somewhere else (objected to, paid, enforced) stays where it is. A revision of a plan leaves the parcels where they are.

## Not in this story

Cancelling a plan before it is approved, payments and the move of the households to COMPENSATED (ST-LND-007), complaints on a posted plan (ST-LND-008), and the alerts at T-7 and T of the timers (the timer is stored with its alert level; the notice is sent by the alerting stories).
