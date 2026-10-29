# DGV: quality incidents and exceptions (ST-DGV-003, slice DGV-1)

A failed quality rule opens an incident (ST-DGV-002, one per dataset and rule while it stays open). This story gives the incident a handler, an SLA and an independent verification, and gives the records that failed an
exception that can be resolved or waived for a while (DGV.md F4, BR-DGV-05, BR-DGV-06). The people are memberships, as everywhere in DGV, and the rights are held on the whole tenant (a dataset belongs to no unit).

## The chain of an incident

`OPEN -> ASSIGNED -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED_PENDING_VERIFICATION -> CLOSED`; `REOPENED` after a verifier sends it back or a waiver ended, and from there the handler acknowledges it again. The database says the same
(`guard_quality_incident`), keeps the history (`quality_incident_event` is append-only) and never erases an incident or an exception.

| command | right | rule |
|---|---|---|
| `assignQualityIncident` | `data.quality.triage` | from any state before resolved; the handler is an active member who holds `data.quality.remediate` (422 `ASSIGNEE_OUT_OF_SCOPE`), the due time is ahead (422 `due_at`); a new due time clears a mark of lateness |
| `transitionQualityIncident` | `data.quality.remediate` | the handler only (403 `NOT_ASSIGNEE`), one step at a time (409 `INCIDENT_STATE_INVALID`); resolving needs the cause and the measure, 10 characters each after trimming (422 `ROOT_CAUSE_REQUIRED`, naming the field) |
| `verifyQualityIncident` | `data.quality.triage` | `CLOSE` or `REOPEN` with a note of 10 characters; not by the handler (403 `SELF_APPROVAL_DENIED`); `CLOSE` only if a run of the dataset that finished after the resolution gave `PASS` for the rule (422 `RERUN_NOT_PASSED`; a warning, a failure, an error, a run from before, or no run is not a pass) |
| `post_quality_exceptions_id_decision` | `data.quality.review` | `RESOLVED` or `WAIVED` with a reason of 10 characters; a waiver needs an end after now and at most 180 days away; not by the owner of the exception (403 `SELF_APPROVAL_DENIED`); once (409 `EXCEPTION_STATE_INVALID`) |

All are sent under the version read (`If-Match`). Each step writes an event row, an audit row and an outbox event (`dgv.incident.assigned/status_changed/closed/reopened.v1`, `dgv.exception.decided.v1`; ids and facts only).
The body of the decision was the generic `Decision` (approve, return, reject) and is now `DgvExceptionDecision` (accepted in `compat-allow.json`).

## The sweep (`dgv-incident-sweep`, every 15 minutes)

* An incident not yet resolved (open, assigned, acknowledged, in progress, reopened) and past its due time is marked once (`sla_breached_at`, an event `SLA_BREACHED`, the audit row `dgv.quality_incident_sla_breached`) and
  `dgv.incident.sla_breached.v1` goes to its owner and its handler. A new due time (a reassignment, a reopening) can break the SLA again, with its own event key.
* A waiver that ended is followed by a **new OPEN exception** that points at the waived one (`reopened_from_id`; a unique index makes it once). The waived one stays as it was: the history of the waiver is not rewritten and the
  record it is about is not touched. The incident behind it, if closed, is REOPENED (counted) with the event note `waiver_expired`, and `dgv.exception.reopened.v1` tells its handler. Running the job again changes nothing.

## What a reader without the rights to the dataset sees

Incidents are those of the datasets the viewer may see (`DATASET_VISIBLE`); another one is 404. Exceptions are listed for every dataset, but where the viewer may not see the dataset the values of `record_reference`,
`evidence` and the reason are masked (a national id reads `***2345`, `masked: true`). There is no export of the exceptions yet; when there is one, the rows of such datasets are left out of it.

## DGV-08

`IncidentWorkspaceScreen` lists the incidents (filters: state, severity, overdue, assigned to me), opens one with its facts, its history and its exceptions (`?incident=`), and offers assign, acknowledge or start, resolve (cause and
measure), verify and decide only as the server's `actions` allow. The handler is chosen from the members, or typed by id where the members cannot be listed. A change made meanwhile is answered with the incident read again.
