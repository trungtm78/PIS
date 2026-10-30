# Event catalogue and notification workflows (ST-NOT-004, NOT 3.1, BR-NOT-02, BR-NOT-15)

A module emits an event; the notification core turns it into notifications by the **workflow in force** for its event type. The workflow says who is told, by which channels and when, and a tenant administrator writes it without code (screens NOT-05 and NOT-06).

## The catalogue (NOT-05)

`GET /notification-event-types` (`listNotificationEventTypes`, `notification.publish`) gives, for every registered type: the module that owns it, the schema version, the purposes a notification of the type may have, how its data is classified and whether it is `Active` or `Deprecated`. The table `notification_event_type` belongs to the platform (no tenant, no right for the application role); the function `notification_event_catalogue()` (migration **V1442**, SECURITY DEFINER) gives a tenant that much and **never the payload schema**. Modules register their types in their own migrations (`docs/notification-event-types.md`).

## The workflows (NOT-06)

A notification workflow is a `workflow_version` of kind `NOTIFICATION` whose business type **is** its event type: one line of revisions and one `Published` revision for each event type of the tenant.

| Operation | What happens |
| --- | --- |
| `createNotificationWorkflowDraft` (`POST /notification-workflows`, 201, `notification.publish` on the whole tenant) | `{event_type, definition}` (`business_type`, if given, must be the event type). An event type that is not registered, or not `Active`, is **422 `EVENT_TYPE_UNKNOWN`** and nothing is written. The definition is judged against the entry of the catalogue: **422 `WORKFLOW_DEFINITION_INVALID`** naming the first field (never a value). A draft is Revision n+1 of its event type. |
| `post_notification_workflows_id_publish` (`POST …/{id}/publish`, If-Match the version of the draft, body `Decision` with `decision: approve`) | Judges the definition again with the draft locked, refuses the person who wrote the draft (**403 `SELF_APPROVAL_DENIED`**, judged on the person, not the membership), makes the revision in force `Published` and the one before it `Superseded`, audits `notification.workflow_published` with the reason and emits `not.workflow.published.v1`. A draft that is no longer a draft is 409 `WORKFLOW_NOT_DRAFT`. |
| `listNotificationWorkflows` (`GET /notification-workflows?event_type=&status=`) | The revisions of the tenant, newest first, a page at a time. |

### The definition

`channels` (the channels in the order they are tried: **the fallback**; the inbox is always there for CRITICAL and HIGH; every channel but the inbox names a template code), `resolver` (`explicit`, named by the event, or `role-in-scope` with `roles`), `priority` (CRITICAL, HIGH, NORMAL, LOW), `ackRequired`, `expiresAfterMinutes`, `purpose` (one the event type allows, BR-NOT-02), `quietHoursOverride` and `quietHoursOverrideReason`. Any other key is refused. The quiet hours (NOT 3.4) may be overridden **only by a CRITICAL message, and only with a reason** (ten characters or more); a reason without an override is refused as well. The code that reads it at run time is `apps/api/src/notifications/definition.ts`; the check at write time is `workflow-definition.ts`.

## What follows a publication

`NotificationStore.workflowFor` takes the `Published` revision of the event type when a notification is made, and the notification keeps its `workflow_version_id`: **new notifications follow the new revision, the ones made before keep theirs, and a duplicate is still blocked** by the key of the notification (`dedupe_key`), which leaves out the workflow and the channel (UAT-AC26).

## Screens

NOT-05 `EventCatalogueScreen`: the table of the catalogue. NOT-06 `WorkflowDesignerScreen`: the event type to work on (only the types still accepted), the form of the definition (purpose among the allowed ones, priority, recipients, channels with their order, acknowledgement, expiry, override of the quiet hours with its reason), the revisions of the type and the publication with a reason. A tenant that is suspended (read-only) cannot write. The seven states come from `StateBoundary`.
