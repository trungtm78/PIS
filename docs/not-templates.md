# Message templates, their review and the test sends (ST-NOT-005, NOT 3.4, BR-NOT-10, BR-NOT-11)

A message that goes out is written from a **template revision**: a `notification_template_version` of a code × channel × locale. It is written as a Draft, sent to review, approved by another person, and tested with a short list of people. What it says cannot change after it leaves Draft.

## The rules of a template (`packages/kernel/src/notification-template.ts`)

Judged at the write, at the submission and again at the test, by the same function, so the screen and the server agree:

| Rule | Refusal |
| --- | --- |
| `content_ast` is `{ subject?, body }`; the subject only for e-mail; every `{{name}}` placeholder is declared in `variable_schema`; the code is `[a-z0-9_.-]{3,80}`, the locale `vi-VN` or `en-US`, the purpose a known one | 422 `TEMPLATE_INVALID` naming the field (never a value) |
| Each variable has a `type` (string, number, integer, boolean, money) and a `classification` (PUBLIC, INTERNAL, CONFIDENTIAL, PERSONAL) | 422 `TEMPLATE_INVALID` |
| Push, SMS, Zalo (ZNS, OA) and WhatsApp use only variables that are PUBLIC or INTERNAL and not money (BR-NOT-11) | 422 `TEMPLATE_VARIABLE_CLASSIFIED` naming the variable |
| A push template is `lockscreen_safe`; no other channel is (the database refuses a push template that is not: `notification_template_push_ck`) | 422 `TEMPLATE_INVALID` `lockscreen_safe` |

The judgement looks at the variables the text **uses**: a variable that is declared and not used reaches nobody.

## Operations (tenant plane, `notification.template.manage` / `.approve` on the whole tenant)

| Operation | What happens |
| --- | --- |
| `createTemplateRevision` (`POST /notification-templates`, 201) | A Draft, one revision after the latest of its code × channel × locale; `supersedes_id`, if given, must be a revision of the same line. Provider channels (ZNS, WhatsApp) can be written as Drafts. |
| `submitTemplateRevision` (`POST …/{templateId}/submit`, 202, If-Match) | Draft → `InReview` (inbox, e-mail, SMS, push) or `PendingProvider` (ZNS, WhatsApp). Judged again with the revision locked. Anything that is not a Draft is 409 `TEMPLATE_IMMUTABLE`. |
| `decideTemplateRevision` (`POST …/{templateId}/decision`, If-Match, body `Decision`) | Not by the author (403 `SELF_APPROVAL_DENIED`, judged on the person). `approve` → Active and the Active revision of the same line becomes Retired in the same transaction; `return` → Draft; `reject` → Rejected. A provider template whose provider has not approved it is 409 `TEMPLATE_PROVIDER_PENDING`. |
| `get_resources_notification_template_version` / `_id` | The revisions, newest first, filtered by `code`, `channel`, `locale`, `status`; one revision with its content and variables. |
| `listNotificationTestRecipients` / `setNotificationTestRecipients` | The people a test may go to: at most ten Active members of the tenant (422 `TEST_RECIPIENT_NOT_ALLOWED`). |
| `sendTestNotification` (`POST …/{templateId}/test-sends`, 202) | Every recipient must be on the list (else 422 `TEST_RECIPIENT_NOT_ALLOWED`); the sample values must be declared variables of their type, and every variable the text uses needs one. The message is rendered with the prefix `[TEST] ` (also on the subject). E-mail and SMS go out **after the commit** through the adapter of the channel and an Active channel account (404 `CHANNEL_ACCOUNT_UNKNOWN`, 503 `PROVIDER_UNAVAILABLE`). |

The table guards (**V1443**): a revision only moves forward (Draft → InReview/PendingProvider → Active/Rejected, Active → Retired, a returned one back to Draft); what it says never changes once it has left Draft and no revision is deleted (`TEMPLATE_IMMUTABLE`); `notification_test_recipient` holds the list, with row-level security.

## A test is not a notification

A test send creates no `notification_instance`, no delivery attempt and no counter of the center: there is nothing to count. The audit row `notification.test_sent` carries numbers only (the code, the channel, how many were asked and how many sent), never an address or the text. The inbox and push templates are rendered and judged but not delivered (the inbox has no row for a test, and a device is registered by ST-NOT-006).

## Screens

NOT-07 `TemplateEditorScreen`: the form of a revision (code, channel, locale, purpose, subject, body, variables with type and classification), the notes that a push is lock-screen safe and that a phone channel carries no money or confidential text, the problems found before sending, the revisions with their state, and the actions the right and the state allow (view, new revision from this one, send to review, approve, return, reject, each with a reason). A revision that is not a Draft is shown locked. NOT-08 `TemplatePreviewScreen`: the sample values, the message as it will be written with `[TEST]`, what is still missing, the list of the people a test may go to and the test send. Both use `StateBoundary` for the seven states.
