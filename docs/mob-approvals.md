# MOB: approval inbox, comparison, step-up confirmation and return (ST-MOB-013)

A leader or approver sees the approval tasks waiting for them (MOB-23), opens one to compare it with the version before it and read its evidence (MOB-24), confirms it (MOB-25) or returns it with reasons and the sections to fix (MOB-26). The decision is one request to `decideApprovalTask`, sent while the device is online, under the version of the task that was on the screen. The code is in `apps/mobile/lib/features/approval_inbox`.

## The four rules

1. **Online only, never queued.** `ApprovalCommands` has no way to reach the offline queue. Offline, or when the screen shows a copy kept on the device, the two buttons of MOB-24, the confirm button of MOB-25 and the send button of MOB-26 are disabled and the screen writes why ("A connection is needed to decide. An approval is never queued and never sent from a copy kept on the device"). The same gate says when the task is not assigned to the person (`actions.decide`), is no longer pending, or the organisation is read-only (`SessionSnapshot.isReadOnly`). `UAT-PLAN-36`: after tapping on the disabled button, `syncStatusProvider` holds 0 commands and the server has received no `POST`.
2. **No swipe and no one-tap path.** The inbox rows only open the detail; there is no `Dismissible`, no action on a row, no action in a notification. A push opens the notification (ST-MOB-015), not a decision. Deciding always takes two screens: the detail, then the confirmation.
3. **A second factor, then the decision.** `decideApprovalTask` needs `aal2`. A person without a recent second factor gets `403 MFA_REQUIRED`: nothing is recorded, the screen says "the decision was not recorded", the session (ST-MOB-002) takes the person through MOB-03, and the decision is sent again only when the person confirms again, under a **new** idempotency key (a final refusal ends the intention, as on the web). `UAT-AC121`: the first request is refused, the second succeeds, the keys differ, one decision is recorded.
4. **A lost answer is not a new decision.** When the answer is lost the screen says "result unknown" and offers to send the same decision again: it reuses the idempotency key and the version, so the server answers with the first result and records it once (`AttemptRegistry`, the port of the web `AttemptRegistry`). The retry is the person's act and is sent even if the failure marked the device offline: it is the probe. What is sent again is the decision as it was sent (its opinion, its reasons, its sections, its day and the version of the task), kept by the screen: the fields stay editable after a lost answer, but editing them changes nothing of the retry, and a changed text sent with the normal button is a new decision with a new key.

A refusal is shown outside the form and the form stays, with what the person wrote: `SELF_APPROVAL_DENIED` ("You cannot approve a record you submitted yourself"; when the server reassigned the task it says so), `APPROVER_NOT_AUTHORIZED`, `TASK_ALREADY_DECIDED`, `VERSION_CONFLICT`, `WORKFLOW_STATE_INVALID`, `PERIOD_LOCKED`, `LICENSE_EXPIRED`, `SCOPE_DENIED`, `RESOURCE_NOT_FOUND`, validation and the ended session each have their sentence, and the stable code is always shown. The task stays pending on the server in every case (`UAT-AC05`).

## The screens

| screen | reads | shows |
|---|---|---|
| MOB-23 | `get_resources_approval_task?mine=true&status=Pending`, `get_resources_organization_unit` | the pending tasks, late first then by deadline; kind, step, amount in millions, unit name, deadline in Vietnam time, "late", "escalated", "view only"; filters by kind and late only; the number waiting is the badge of the Approvals tab |
| MOB-24 | `get_resources_approval_task_id`, and for `report.accept` `getReportRevision` of the record and of the revision it corrects (`supersedes_id`) | the content, the comparison and the evidence |
| MOB-25 | the task, fresh | the opinion (optional), the note that a second factor is needed, the note that there is no digital signature in this release, the button |
| MOB-26 | the task, fresh | the reason, the sections to fix (one per line), the day the corrections are due; the form does not send until all three are given |

**Comparison** (report acceptance): the six cells of the funding form against the six of the revision before it, each as "previous, this version, change"; a fall is negative (`-10`), a rise has a plus, no change says so; the total of the cumulative amounts is compared too, and the part that is CTMTQG is shown as "of which", already inside the cells and added to nothing. The first revision says there is nothing before it; another kind of record says it has no comparison on the phone yet.

**Evidence**: the files attached to the report (name, type, size, the start of the SHA-256). The list is real; opening a file needs a download operation that the contract does not expose for report attachments yet.

**Return**: `decideApprovalTask` takes a reason and no list of sections or due day, so the form checks the three (reason 1 to 2000 characters including what is added, 1 to 20 sections of 3 to 2000 characters, a real calendar day; whether the day is ahead is the server's to judge, not the clock of the phone) and puts the sections and the day inside the reason, in the person's language. A structured `return_items` and `due_at` on the approval-task decision is a proposed contract change; `post_reports_id_decision` already has them.

## Tests

`test/features/approval_inbox/approval_test.dart` names `UI-MOB-23`, `UI-MOB-25`, `UI-MOB-26`, `UAT-AC05`, `UAT-AC121`, `UAT-PLAN-36` and the acceptance ids. The server is a scripted transport, so a decision, a refusal, a lost answer and the headers (`Idempotency-Key`, `If-Match`) are real requests.

## What only a device can prove

The second-factor round trip through the system browser (MOB-03) and the return to MOB-25, the real `MFA_REQUIRED` from a server with a fresh and a stale `aal2`, and a decision made on a real phone that loses its connection between the request and the answer. The self-approval negative test against the real server (`UAT-AC05`) is an API test; the phone only shows the refusal.
