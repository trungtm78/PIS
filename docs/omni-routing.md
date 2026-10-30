# The routing, the SLA in working time and the canned replies (ST-OMNI-006, OMNI.md 3.1 step 5, BR-OMNI-06, BR-OMNI-08, OMNI-07, OMNI-08)

A supervisor writes the rules that put a new conversation in the queue of a unit and give it a deadline for the first answer, publishes a version of them, and keeps the answers that agents reuse. Both belong to the tenant, not to a unit: who reads or changes them holds `omni.policy.manage` on the whole tenant (a supervisor of one unit and an agent are 403).

## The routing policy

A **version**: written as a Draft (`createRoutingPolicyVersion`, 201), published once (`publishRoutingPolicy`, If-Match, a reason of 10 to 2000), replaced by a later one. One is Published at a time (a unique index); what a version says never changes and it is never deleted (V1290 guards it); the conversations keep the version they were routed by (`conversation.routing_policy_id`, a foreign key).

| Part | Rule |
|---|---|
| `rules` (up to 50, tried in order) | each names `queue_unit_id` (a unit of the tenant: 422 `POLICY_INVALID` on `rules` else) and may narrow by `channels` (e-mail, SMS, Zalo OA, WhatsApp) and by `keywords` (up to 20 words, any case and accents, found anywhere in the first message); the first rule that fits gives the queue and the priority (`HIGH`, `NORMAL` by default, `LOW`); none that fits leaves the queue of the whole tenant |
| `calendar_code` | the working calendar the deadlines are counted on; it must be **published for the year of today** when the version is published (422 `POLICY_INVALID` on `calendar_code`), so a version never routes conversations it cannot give a deadline |
| `first_response_minutes` (1 to 10080), `resolution_hours` (1 to 2400) | working time: `addWorkingTime` of KERNEL on the published calendar (weekends, holidays and make-up days skipped), window 08:00 to 12:00 and 13:00 to 17:00 (BR-ADM-08) |

Publishing a Draft that is not one is 409 `POLICY_STATE_INVALID`; a stale version 409 `VERSION_CONFLICT`. Each creation and publication writes one audit row (`omni.routing_policy_created`, `omni.routing_policy_published` with the reason and the revision that was superseded).

### What it does to a conversation that begins

`ConversationStore.receiveInbound` (ST-OMNI-004) asks the version in force when it **creates** a conversation (also the new one that follows a closed one): the first rule that fits the channel and the first message sets `queue_unit_id` and `priority`, and the deadlines are counted from the moment the message came: `sla_first_response_due_at` and `sla_resolution_due_at`. The worked example (UAT-AC199): a message on Friday 16:50 (+07) with 30 minutes is due on Monday 08:20. A message in a conversation that is open does not route it again. No version in force, or no published calendar for the year of the message, leaves the conversation without a queue or without deadlines; it is taken in all the same.

## The canned replies

`createCannedReply` (201), `updateCannedReply` (If-Match; the code is the name of the reply and does not change). A reply has a code (3 to 60 of lower case, digits, dot, dash), a title, a text of up to 2000 characters with **no variable** (`{{x}}`, `{x}`, `${x}`, `%x%` are refused: 422 on `body_text`), the channels it is for, and a class that is **PUBLIC or INTERNAL** (anything else is 422 on `classification`, and the reply is not stored). A code that is taken is 409 `CANNED_CODE_TAKEN`, also when two supervisors take it at once. A reply is kept and never deleted (V1290). What has a place to fill is a template, made in NOT and approved by the provider, and it is what a message outside the 24-hour window has to use (BR-OMNI-08, OMNI.md 3.3).

## The screens

**OMNI-07** `RoutingPolicyScreen`: the versions (state, rules by unit name, minutes, hours, calendar, since when), the form of a new Draft (calendar, minutes, hours and rules with a channel, words, unit and priority; what the server would refuse is told before sending) and the publication with a reason at the version read. **OMNI-08** `CannedReplyScreen`: the replies, the notice about the window, and the form: **the reason a field is refused is written next to it** (a variable in the text, a class that may not be sent, a code that is taken), both before sending and when the server refuses.
