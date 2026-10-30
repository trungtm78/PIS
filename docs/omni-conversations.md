# The conversations of the omnichannel center (ST-OMNI-004, OMNI.md 3.1, 3.2, 4, BR-OMNI-03, OMNI-01, OMNI-11)

A person who writes to a channel account of the tenant opens a conversation with a contact; a supervisor gives it to an agent who may answer it. What comes in is put into its conversation by the processing of the integration inbox, in the transaction of the inbox processor, so an event that fails leaves nothing and is tried again.

## What comes in

`receiveChannelWebhook` (ST-NOT-002) stores the signed event once and the processor of the provider reads it: the adapter of the provider tells a delivery receipt (`parseCallback`) from a message (`parseInbound`, optional on the port); a body that is neither stays failed for an operator. The tenant and the account are the ones of the inbox row, never the payload's. `ConversationStore.receiveInbound`:

1. The account must be **Active** (an unknown one is 404 `CHANNEL_ACCOUNT_UNKNOWN`, a disabled one 409 `CHANNEL_ACCOUNT_STATE_INVALID`, so the event waits); a channel that carries no message (a push) is 422.
2. The sender is a **contact**: found by the hash of the normalised identity, through the merge to the contact that is alive, or made (class `OTHER`, the name the provider gives, else the masked identity) with the identity Pending. Two messages of one person at once make one contact (an advisory lock per identity). A **Blocked** contact's message is not taken in.
3. On a channel that authenticates the sender (Zalo OA, WhatsApp) the identity is marked **Verified** by `PROVIDER_VERIFIED` (the worker's membership); a mail and a text message prove nothing, so the identity stays Pending.
4. The conversation is the one of the thread (`channel_account_id`, `external_thread_id`) that is **not Closed**; none makes a New one, which points to the last closed conversation of the thread (`previous_conversation_id`). A message that comes again (the unique provider message id in a conversation) is `DUPLICATE`: nothing changes.
5. The conversation takes the message: the time of the last message that came in (a late message never moves it back), the **window** (`window_expires_at`: 24 hours after it for WhatsApp and Zalo OA, none for the others) and the state (`conversationAfter(status, 'inbound')`: a conversation that waited for the customer, or was resolved, goes to `InProgress`; New and Assigned stay).
6. A message that is **only** `STOP`, `HUY` or `DUNG` (any case, accents and punctuation ignored; a sentence with the word in it is not one) **withdraws every live consent of the contact on that channel** (BR-OMNI-03), with a reason, in the same transaction. The message itself is kept.

The trail: `conversation.opened` (a new conversation, with whether the contact is new), `conversation.reopened`, and `contact_consent.withdrawn` (`by: stop_keyword`) for each consent a stop word ended.

## The state

`New -assign-> Assigned -open-> InProgress <-> PendingCustomer`, `InProgress | PendingCustomer -resolve-> Resolved -(a message | reopen)-> InProgress`, `Resolved -close-> Closed`. **Closed is final**; resolving a New or an Assigned conversation is 409 `CONVERSATION_STATE_INVALID`. The database guards it (V1287): the account, the thread, the beginning and the conversation before never change; the state moves only the ways above; a conversation and a message are never deleted; the text of a message never changes. The thread is unique among the conversations that are not Closed. Only the assignment and the incoming message are made here; resolve, reopen and close are ST-OMNI-005/007.

## The operations

| Operation | Permission | Rule |
|---|---|---|
| `get_resources_conversation` (`?status=&mine=&queue_unit_id=`) | `conversation.read` | newest first; a reader sees the conversations of the queues in their scope and those **assigned to them**; a holder on the whole tenant sees all; the queue of the whole tenant (no unit) is seen by the holders of the whole tenant only |
| `get_resources_conversation/{id}` | `conversation.read` | the same scope; outside it, 404 |
| `get_resources_channel_message` (`?conversation_id=`) | `channel_message.read` | oldest first, **without the text** (the text is personal data) |
| `get_resources_channel_message/{id}` | `channel_message.read` | one message **with** its text, in the same scope |
| `listConversationAssignees` (`GET /conversations/{id}/assignees`) | `omni.conversation.assign` | the members who may be given it, by name; 403 for one who reads the conversation but may not assign it |
| `assignConversation` (If-Match) | `omni.conversation.assign` | New to Assigned, a reassignment keeps the state; the conversation must be in the scope of the assigner (404 else); the member must be **eligible**: a staff membership, active, with a grant of `omni.conversation.reply` whose scope contains the unit of the queue (anyone who holds it anywhere for the queue of the whole tenant): else 422 `ASSIGNEE_NOT_ELIGIBLE`; Resolved or Closed is 409 `CONVERSATION_STATE_INVALID`; two supervisors at once: the second is 409 `VERSION_CONFLICT`. One audit row (from and to) and one `omni.conversation.assigned.v1` |

## The screens

**OMNI-01** `ConversationInboxScreen`: the channel and the account, the contact, the state, the assignee and the queue, the deadline of the first answer (none until the routing policy, ST-OMNI-006, sets one) and the window (marked closed when over), filters by state and "mine", paging, and the assignment: the list of eligible members is read when the form opens and the assignment goes with the version read. **OMNI-11** `WebhookEventsScreen`: the integration inbox of ADM-10 narrowed to the events of a channel account (the read now carries `channel_account_id`): provider, event key, signature (always good: an event is stored only after it is checked), time, state, attempts, error; a failed or dead event is replayed with a reason.

## Roles

V1288: `OMNI_AGENT` holds `omni.conversation.reply` and `omni.conversation.convert` in place of `omni.conversation.*` (the wildcard carried the assignment, which is the supervisor's, OMNI.md 3.2), and `conversation.read`, `channel_message.read`; `OMNI_SUPERVISOR` gets the same reads and `adm.integration.read`/`adm.integration.operate` for OMNI-11. Tenants seeded before are updated, once.
