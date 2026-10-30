# What an agent says in a conversation (ST-OMNI-005, OMNI.md 3.3, BR-OMNI-01, BR-OMNI-02, BR-OMNI-03, BR-OMNI-07, OMNI-02)

An agent leaves a note for the colleagues, or answers the person on the channel the person used. The note never leaves the system; the answer is checked before anything is queued, queued, and sent later by the dispatcher, outside the command.

## The operations

| Operation | Permission | Rule |
|---|---|---|
| `sendConversationMessage` (`POST /conversations/{id}/messages`, 202, If-Match, Idempotency-Key) | `omni.conversation.reply`, in the scope of the conversation (404 outside it, 403 for a reader) | `kind: INTERNAL_NOTE`: a text and nothing else (a purpose, a template, an attachment or a link is 422, not ignored); it is a row `INTERNAL_NOTE` with no status and never a provider id (V002 checks it); allowed until the conversation is Closed. `kind: EXTERNAL`: the conversation must be Assigned, InProgress or PendingCustomer (409 `CONVERSATION_STATE_INVALID` else) and the contact neither blocked nor merged (409 `CONTACT_STATE_INVALID`); the checks below run in order; what passes is queued (`channel_message` OUTBOUND, status `Queued`), one audit row (`conversation.message_sent`: the kind, purpose, account, template and counts, **never the words**) and one `omni.message.queued.v1` |
| `resolveConversation` / `reopenConversation` (If-Match, a reason of 10 to 2000) | `omni.conversation.reply`, in scope | InProgress or PendingCustomer to Resolved; Resolved to InProgress; anything else is 409 `CONVERSATION_STATE_INVALID` (resolving a New or Assigned conversation too, OMNI.md 4); a stale version is 409 `VERSION_CONFLICT`; one audit row with the reason and one `omni.conversation.resolved.v1` / `omni.conversation.reopened.v1` |

The version of the conversation is asked **only when the message moves it** (Assigned or PendingCustomer to InProgress): two agents who answer at once both say something true, and both messages are kept.

## The checks of a message to the person, in order

All before any adapter is called, stopping at the first that fails (`judgeSend`, kernel):

1. the account named is the conversation's (422 `CHANNEL_ACCOUNT_MISMATCH`; the answer names nobody's account);
2. the account is Active and verified (422 `CHANNEL_UNVERIFIED`);
3. the consent of the contact for the channel and the purpose, found through the merge (`latestForContact`): a word that **withdrew** it stops the message (422 `CONSENT_DENIED`) however the conversation began; with none, an answer for **support** is grounded by the person's own message while the window is open (a channel without a window is always open), anything else needs a Granted consent (422 `CONSENT_DENIED`; on WhatsApp 422 `OPT_IN_REQUIRED`);
4. the window: a free text after `window_expires_at` is 422 `CHANNEL_WINDOW_CLOSED`; a template that is **Active, for the channel and approved by the provider** goes through (a template that is not Active or is for another channel is 422 on `template_version_id`);
5. the content: an attachment is a version of a document of the tenant that may leave (class PUBLIC or INTERNAL) and was scanned clean, else 422 `CONTENT_CLASSIFICATION_BLOCKED`; a link may name any version of a document, because it is **opaque** (`/d/{id}`) and asks the person to sign in (BR-NOT-11). The adapters carry text, so an attachment goes as the same kind of link after the words. Anything that is not a document of the tenant is 422 on its field.

A message made from a template is written here from the variables the agent gave (422 `TEMPLATE_INVALID` when one is missing).

## The sending

`ConversationSender` runs in the pass of the delivery dispatcher (`notification-dispatch`), for each tenant:

* it takes up the messages that are due (`FOR UPDATE SKIP LOCKED`, oldest first) and **asks again** what can change: a consent withdrawn, a window ended or an account closed since the message was queued ends it as `Failed` with the code of the check, and nothing is sent. What passes is leased for five minutes and counted as an attempt;
* an attempt whose result was never recorded (the process died, or the record failed) leaves the message with its claim on it; when its lease runs out the message is **asked about at the provider** (`adapter.lookup` with the message id as the key): a provider that holds it settles the message with the id and the status it gives; one that fails or cannot tell ends it as `Failed` `SEND_UNCERTAIN`; only one that says it has **no such request** has the message taken up again (checks, cap, budget, a new attempt). A failure that was recorded (worth another try) is not asked about;
* the adapter is that of the **channel of the conversation** and no other (a reply never changes channel); one that is missing or not allowed where the process runs ends the message as `Failed` `ADAPTER_MISSING`; a channel that is closed for the moment (the hours of a text) makes the message wait, with no attempt used. Each link is made a whole address with `WEB_BASE_URL` (the public origin of the web application) when it is sent; a message that carries a link when none is configured ends as `Failed` `WEB_BASE_URL_MISSING` instead of sending a path that opens nothing. The adapter is given the handle of the thread at the provider as the place to answer (`to` and `threadId`: the address of a person is never stored, only its hash and mask, so an adapter of a channel where the thread is not the sender must make a handle it can answer to), the message id as the idempotency key, and no transaction is open during the call;
* the cap and the budget of the account (BR-NOT-13) are those of the notifications: a message counts when it is taken up (`sending_at`, the estimated price in `cost`), the notifications count it too, and one that would go over waits for the next day or month (`CHANNEL_CAP`, `CHANNEL_BUDGET`);
* a credential the provider rejects (`CREDENTIAL_EXPIRED`) puts the account in `CredentialExpired` as for the notifications and raises the alert `OMNI_CHANNEL_CREDENTIAL_EXPIRED`; what waits for the account fails at its turn with `CHANNEL_UNVERIFIED`;
* the subject of a mail made from a template is kept with the message and given to the adapter;
* accepted: `ProviderAccepted` with the provider's id and the moment; a retryable failure waits 30 seconds, one minute, two, up to three attempts, then `Failed` with the code; a permanent failure is final; **an answer that was lost (timeout, an error the adapter did not classify) is never sent again on its own**.

Receipts of the provider (`channelCallbackHandler`) move a message of a conversation first, and a notification only when no message has that provider id; the status goes **forward only** (`Queued`, `ProviderAccepted`, `Delivered`, `Read`; a failure only before delivery, and final). The database guards it (V1289): the text, the purpose, the template, the links, the author and the direction never change; a status does not go back.

## The screen OMNI-02

`ConversationScreen` (`/omni/omni-02?id=`, opened from OMNI-01): the contact, the channel and the account, the state, the assignee and the queue, **the countdown of the window** (and that it is closed), the notice that a citizen's complaint or petition under the law on receiving citizens is not handled here (CXN-OMNI-01), the messages oldest first with where each stands (the text of a message is read **when asked**, one message at a time: it is personal data and the list carries none), the composer whose **switch of the internal note** changes how the form looks, what it says and what it sends, and the resolve or reopen with a reason. Nothing is offered to a reader or in a suspended tenant; a New or Resolved conversation takes notes only; a Closed one nothing.
