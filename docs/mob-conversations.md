# MOB: conversations tied to records (ST-MOB-026)

Two screens of the Flutter application read and answer the conversations the web already has in OMNI: the inbox (MOB-35) and one conversation with its messages, the records it points to and the answer (MOB-36). The code is in `apps/mobile/lib/features/conversations`; the foundation is `docs/mobile-foundation.md`, the module is `Design/MACHVON_Design/01_Documents/05_modules/OMNI.md`, the web screens are OMNI-01 and OMNI-02. The phone calls the same operations as the web and the server decides everything; the phone adds the words that say, on every row and every thread, whether the conversation is with someone outside or among colleagues.

## What is shown

| screen | operations | rules kept |
|---|---|---|
| MOB-35 inbox | `get_resources_conversation` (pages followed, `status` and `mine` filters) | the list is the server's: the conversations in the queues of the units of the reader and those assigned to them (OMNI-01); the phone adds no queue and no filter of its own. Each row carries the contact, a kind pill (`Nội bộ` or `Bên ngoài · Zalo`), the state, who has it and the unit, until when the window lasts as the server gave it, and the number of messages. |
| MOB-36 conversation | `get_resources_conversation_id`, `get_resources_channel_message` (all pages, oldest first), `get_resources_channel_message_id`, `sendConversationMessage`, `resolveConversation`, `reopenConversation`, `listConversationAssignees`, `assignConversation` | see below |

At the top of a thread a banner says in words whether the conversation is internal (`Hội thoại nội bộ: chỉ đồng nghiệp trong hệ thống thấy, không có gì được gửi ra ngoài`) or with someone outside (`... qua Zalo: tin trả lời được gửi cho {contact}`). Every message says where it came from (from the contact, sent to the contact, internal note) and where it stands (queued, taken by the provider, delivered, read, failed); a note is set apart by its colour and by its words, so it is never taken for a message that went out. The records a conversation points to (`resource_links`) are listed; a project opens MOB-10, an issue or a contract is named and says it cannot be opened on the phone yet.

## Internal and external (AC-ST-MOB-026-3, UI-MOB-35)

A conversation is **external** when its channel is one of the outside messaging channels (`EMAIL`, `SMS`, `ZALO_OA`, `ZALO_ZNS`, `WHATSAPP`); on any other channel it is **internal**: there is nobody outside to answer. What the form offers (`externalGateOf`):

| state of the conversation | form |
|---|---|
| closed | nothing; "Hội thoại đã đóng" |
| internal, whatever its state | a note only; the reason is written beside the form; no switch, no purpose, no "send to a person" button |
| external, but the build does not enable external channels | a note only, with the reason |
| external, enabled, `New` or `Resolved` (nobody has it) | a note only, with the reason |
| external, enabled, `Assigned`, `InProgress` or `PendingCustomer` | a switch "Ghi chú nội bộ (không gửi ra ngoài)"; off, the form is a message to the person on the channel they used with a purpose (`SUPPORT_CONVERSATION`, `OPERATIONAL`, `REMINDER`) and a button that names the person and the channel (`Gửi cho Nguyễn Văn An qua Zalo`); on, it has another colour and other words and is a note |

**External channels are enabled by the build, not by the phone** (CR-SMP-06: Zalo, WhatsApp and SMS in MOB-35/36 only after D06, R2 at the earliest). `externalReplyEnabledProvider` reads `--dart-define=MACHVON_EXTERNAL_REPLY=true` and is false otherwise, so a build before D06 reads every conversation and writes notes, and offers no message to a person. The server judges consent, window and account whatever the build says; the flag decides only whether the phone offers the send.

## Consent and window (AC-ST-MOB-026-1, AC-ST-MOB-026-2, UAT-AC183, UAT-AC195)

The send is one online command with the `Idempotency-Key` of the intention and `If-Match` with the version of the conversation the screen saw. The server refuses, in this order of its own checks, and the screen tells each in the words of the web with the stable code under the sentence:

| code | meaning on the screen |
|---|---|
| `CONSENT_DENIED` | the contact withdrew or never gave the consent; "Chưa có gì được gửi" |
| `OPT_IN_REQUIRED` | a WhatsApp contact who has not opted in to a message the tenant starts |
| `CHANNEL_WINDOW_CLOSED` | the answer window is closed: only a template the provider approved can be sent |
| `CHANNEL_ACCOUNT_MISMATCH`, `CHANNEL_UNVERIFIED`, `CONTENT_CLASSIFICATION_BLOCKED`, `TEMPLATE_INVALID` | as OMNI-02 |
| `CONVERSATION_STATE_INVALID`, `CONTACT_STATE_INVALID` | the state does not allow it; the thread is read again |
| `VERSION_CONFLICT` | someone else moved the conversation; the thread is read again |
| `SCOPE_DENIED`, `LICENSE_EXPIRED`, `MFA_REQUIRED`, `SESSION_EXPIRED` | the standard words |

A refusal is told in a card beside the form and the form never disappears: what was written is still there. The window is shown as the server gave it (`window_expires_at`, in Vietnam time) with the sentence that the server decides whether it is open when the person sends; **the phone never judges the window, a consent or a deadline with its own clock**, so a window in the past does not disable the send.

## Sending once (BR-MOB-02)

`ConversationCommands` keeps, for each of the send, the resolve/reopen and the assignment, the `CommandAttempt` of the intention (`AttemptRegistry`) and **the version the intention was first sent at**. A send whose answer was lost may have committed: the thread is read again, its version has moved, and the retry must still be the same request (the server judges it by the key, the body and the version), or the message would go twice. So the retry ("Gửi lại" in the card "Chưa xác định kết quả") repeats the first key and the first version even when the words on the screen were edited meanwhile; only the words that were sent are cleared from the form. A recorded command, a final refusal, or a send that never left the device ends the intention; the same words sent after a refusal are a new decision with a new key. Nothing is queued: offline the send is disabled with the reason beside it, and a read-only tenant says so.

## Personal data (NFR-PRIVACY-01, CXN-PDP-01)

- The list of messages never carries the text. The text of one message is read (`get_resources_channel_message_id`) when the person taps "Xem nội dung", is held in that tile only and is let go when the tile is hidden or the screen is left; a message the server masks says so.
- The conversations are **not kept on the device**: MOB.md lets only drafts be offline for these screens. `DataView` gained `keepCopy` (default true, the other screens are unchanged); the two screens pass false, so nothing is written to the copy store and a lost connection is the offline state, never a stale list of contact names. A copy planted under the key is not read either (tests).
- A conversation outside the scope of the reader is `404 RESOURCE_NOT_FOUND`: the screen shows the code and nothing else.
- The text of a draft message is not stored (see the gaps).

## What was not built

- **Templates for a closed window.** The web composer sends free text only (`template_version_id` is in the contract); a closed window is therefore only told. Choosing an approved template is a later slice.
- **Persisting a draft reply** (MOB.md: offline data is for drafts) through `DraftStore`: the words stay on the screen through every refusal, an error and a retry, but are lost when the screen is left.
- **Refresh by timer.** The web reads the thread every 15 seconds; the phone reads on opening, after each command and on the refresh button of the freshness bar.
- **Convert to issue, link a record, attachments, canned replies**: not in the story.
- **Permission gating by the session.** The session of the phone carries no permission list; the server's refusal (403) is the gate, and the assignment form shows the refusal of `listConversationAssignees` instead of a list. The entry point (a button in the bar of the notification inbox) is shown to everyone.

## Tests

`apps/mobile/test/features/conversations`: `conversation_rules_test.dart` (internal/external, gates, text and reason limits, the codes, parsing), `conversation_commands_test.dart` (bodies, headers, key and version across a lost answer, refusals), `conversation_screens_test.dart` (the two screens and every state at the three sizes and at 200 percent text, AC-ST-MOB-026-1..4), `conversation_labels_test.dart` (every word in both languages). The entry point is covered by `test/features/phone_search/entry_points_test.dart`. Every rule above was broken once and the tests went red (mutation list in the report of the story).

## What only a device can prove

Typing and the keyboard on the composer at 200 percent text and with the soft keyboard open (the layout is tested on the host at three widths); TalkBack and VoiceOver reading of the kind banner, the notes and the outcome card; the look and the contrast of the note colour on real screens; that nothing of a thread is in the screenshot of the task switcher or in a backup (the application has no screen-capture protection in this slice); consent and window cases against the real channel stubs (UAT-AC183, UAT-AC195 are server tests, and the stubs of D06 are not available here); a lost connection in the middle of a send on a real network.
