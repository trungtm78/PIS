# The trigger of the evaluation after the investment (ST-AST-006, AST 3.4, UC-AST-04, AST-07, UAT-AC394)

A project is evaluated some time after the work is in operation. This story does not evaluate: it sets the day on which MNE is told to, tells MNE once when the day comes, and records the evaluation MNE did against the trigger.

## The commands

`scheduleEvaluationTrigger` `POST /projects/{id}/evaluation-triggers` and `acknowledgeEvaluationTrigger` `POST /evaluation-triggers/{id}/acknowledge`, both with `evaluation.trigger.manage` held over the project (the unit that owns it, the unit that invests in it, or the project itself). A project the caller cannot read is 404, one they can read (`project.read`) and may not act on is 403 `SCOPE_DENIED`.

| Rule of `scheduleEvaluationTrigger` | Answer |
|---|---|
| `trigger_kind` is one of `POST_HANDOVER_12M`, `POST_HANDOVER_24M`, `SETTLEMENT_CLOSED`, `MANUAL`; `due_on` is a real day | else 422 `VALIDATION_FAILED` on the field |
| the project is at `IMPLEMENTATION`, `SUSPENDED`, `COMPLETED`, `SETTLED` or `CLOSED`; `SETTLEMENT_CLOSED` needs `SETTLED` or `CLOSED` | else 422 `PROJECT_STAGE_INVALID` |
| a trigger after a handover names `source_handover_id`; the handover belongs to the project (a trigger by hand may name one too) | else 422 `VALIDATION_FAILED` (reason `NOT_A_HANDOVER_OF_THE_PROJECT` for a handover of another project) |
| that handover is `ACCEPTED` | else 422 `HANDOVER_NOT_ACCEPTED` |
| `due_on` is not before the day the handover was accepted (the day in Vietnam) plus 12 or 24 months, the last day of the month when that month is shorter | else 422 `VALIDATION_FAILED`, reason `BEFORE_EARLIEST`, with `earliest_due_on` |
| the other kinds are not set for a day that has gone | else 422 `VALIDATION_FAILED`, reason `IN_THE_PAST` |
| one trigger for a project, a kind and a handover (`evaluation_trigger_uq`, from V002) | else 409 `TRIGGER_DUPLICATE`, and the first trigger is left as it was |

The trigger is made `SCHEDULED`. The trail (`ast.evaluation_trigger_scheduled`) and the event (`ast.evaluation_trigger.scheduled.v1`) carry ids, the kind and the day.

`acknowledgeEvaluationTrigger` takes `mne_evaluation_id`. The trigger is locked, so two acknowledgements cannot both win. It has to be `FIRED` (else 409 `TRIGGER_STATE_INVALID`, with the status it is in); the evaluation has to exist in the tenant (422 `VALIDATION_FAILED`, reason `NOT_FOUND`) and be one of the project of the trigger (reason `NOT_AN_EVALUATION_OF_THE_PROJECT`). The trigger becomes `ACKNOWLEDGED` and keeps the evaluation. Trail `ast.evaluation_trigger_acknowledged`, event `ast.evaluation_trigger.acknowledged.v1`.

## The job

`ast-evaluation-due` (hourly, `AstEvaluationDueJob`): each `SCHEDULED` trigger whose `due_on` is not after today in Vietnam becomes `FIRED`, with the time it was fired, and `ast.evaluation.due.v1` is announced once (`evaluation_trigger:<id>:due`). The event is a reminder to the one who set the trigger: `notification.recipients` is that member, the resource carries the owner unit and the project so that the notification service lets only those who may read it see it (`evaluation_trigger` is read with `evaluation.trigger.manage`). A trigger the day before stays `SCHEDULED`; a second pass, or the next hour, finds nothing to fire. Triggers being fired by another pass are skipped (`for update skip locked`).

## The table (V1524)

`evaluation_trigger` (V002) gains: a trigger after a handover names the handover; `ACKNOWLEDGED` and a named evaluation go together; who set the trigger is a member. A guard keeps what a trigger says (project, kind, handover, day, creation) and lets the status only move `SCHEDULED` to `FIRED` to `ACKNOWLEDGED` (or to `CANCELLED`, which no command does yet); the time it was fired, the event that announced it and the evaluation it led to are written once. Nothing is deleted by the application. `updated_by` is not a foreign key: the job that fires a trigger is a worker, not a member. `ast.evaluation.due.v1` is registered with the notification service in the same migration.

## The read and the screen

`listEvaluationTriggers` `GET /evaluation-triggers?project_id&status&cursor&limit` (`evaluation.trigger.manage`, newest first, the projects in the scope of the caller only) was added because AST-07 has to show the triggers and the contract had no way to read them. **AST-07** `EvaluationScreen` (`/ast/ast-07?project=<id>`) shows the triggers of a project (kind, source handover, day, status, evaluation), a form to set one and a form to acknowledge a fired one. The form offers only the accepted handovers of the project (read through the handover list), proposes the earliest day for the kind and the handover and keeps a later day the person typed; the checks it makes before sending (kind, handover, real day, not before the earliest) are the server's again, and every refusal of the server is told in words. The screen has no way to evaluate and none to cancel.

## Gaps and decisions

- The text says the system proposes the trigger when a handover is accepted and when the settlement is closed. Nothing sets a trigger by itself: the person sets it, the screen proposes the day. A trigger on its own is a decision about when to remind MNE, not a fact of the handover.
- `CANCELLED` exists in the table and the guard, and no command in the contract reaches it.
- A kind is set once for a project and a handover (or once for a project when no handover is named), so a second manual trigger on the same project needs a handover to be named.
- There is no read of the evaluations of MNE yet, so the screen takes the code of the evaluation as typed; the server checks that it is one of the project.
