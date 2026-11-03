# MOB: quality acceptance approval, handover and warranty on the phone (ST-MOB-022)

MOB-65 lets the person who signs or approves quality acceptance minutes (QMS 3.2) do it from the phone, and MOB-66 shows the works handed over and the warranty they carry (AST 3.1, AST-04). The code is in `apps/mobile/lib/features/acceptance_handover`; what the online-only screens share (the outcome of a command, the gate note) is in `apps/mobile/lib/features/command_support`. The server half is `docs/qms-acceptance.md`, `docs/ast-handover.md` and `docs/ast-warranty.md`; the web screens are QMS-05, AST-01/02 and AST-04, and the sentences of the refusals are the ones of QMS-05 so that the two agree.

## MOB-65: the minutes (`/approval/mob-65`)

Without a parameter the screen lists the minutes that still wait (`DRAFT`, `SIGNING`) from `listQualityAcceptances`, those the person can act on first (`actions.sign`, `approve`, `reject`), then by number. With `?acceptance=<id>` it opens one set of minutes (`getQualityAcceptance`): the four fields of the design.

| field of the design | shown |
|---|---|
| Biên bản | number, status, contract, the inspection it follows, who drafted it, the warning while the regime waits for its confirmation (CXN) |
| Khối lượng | the scope (work item, stage, part, completion) and the bill-of-quantities item, or that the minutes are not tied to one |
| Bằng chứng | for each required role who signed, when, by which method and **what the signature is worth** ("internal confirmation, not a digital signature" for an in-app method, "valid digital signature" for a certificate); a signature over other content is "void"; the roles still missing; the serious non-conformances still open; the code of the paper |
| Ý kiến | the opinion on record, and the opinion of the person for the decision (required, 1 to 2000 characters, for approving and for rejecting, as on the web) |

### The rules

1. **Online only, never queued.** `AcceptanceCommands` has no way to reach the offline queue. Offline, or when the screen shows a copy kept on the device, the sign, approve and reject buttons are disabled and the screen writes why ("A connection is needed to sign or approve. Signing and approving are never queued and never sent from a copy kept on the device"). The same gate says when the organisation is read-only, when the minutes no longer wait, and when the person has nothing to do on them (`AcceptanceGate`). Offline wins over everything. `UAT-PLAN-36`: after tapping a disabled button `syncStatusProvider` holds 0 commands and the server received no `POST`.
2. **The server decides.** A button is offered only for what the minutes say the person may do (`actions`, `signable_roles`); the server judges the right, the scope, the version (`If-Match`), the licence and the rules again on every command. The screen words each refusal and shows its stable code: `SIGNATURES_INCOMPLETE` names the roles still missing from `missing_roles` (`UAT-AC360`), `SIGNATURE_METHOD_NOT_ACCEPTED` says a certificate needs a serial and the other methods carry none (`UAT-AC357`), `SELF_APPROVAL_DENIED`, `OPEN_CRITICAL_NCR`, `VERSION_CONFLICT`, `CONTRACT_STATE_INVALID`, `QUALITY_ACCEPTANCE_STATE_INVALID` (with `CONTENT_CHANGED`), `ROLE_NOT_REQUIRED`, `ALREADY_SIGNED`, `SCOPE_DENIED` with `detail: signer_role` ("not your role"), `PERIOD_LOCKED`, `LICENSE_EXPIRED`, validation and the ended session. A refusal is shown outside the form and the form stays with what the person wrote.
3. **Signing.** The form takes a role (the ones the person may sign as; chosen for them when there is one), a method and, for a certificate only, its serial; the form stops a certificate without a serial before sending (the server refuses it as well). `client_operation_id` is the idempotency key of the attempt: one signature, one identifier, however often it is sent. This release signs with the in-app confirmations and with the serial of a certificate as the web does; the vendor signature SDK is ST-MOB-032.
4. **A second factor** the server asks for (403 `MFA_REQUIRED`) is handled by the session (ST-MOB-002 sends the person through MOB-03); the screen says the command was not recorded and a new confirmation is a new command with a new key.
5. **A lost answer is not a new command.** The screen says "result not known" and offers to send the same action again: it reuses the idempotency key and the version (`AttemptRegistry`), so the server records it once; the person's act is sent even when the failure left the device marked offline, because it is the probe. A final refusal ends the intention, so the same request after the cause is removed gets a new key.

## MOB-66: handover and warranty (`/projects/mob-66`)

Read only. The list (`get_resources_handover`, `listWarrantyObligations`, pages followed) shows, for each handover: number, contract, kind, status, the **receiving unit**, the punch list ("n items, m critical not verified") and the warranty ("n obligations, until dd/mm/yyyy"); the handovers with open critical defects come first and the decided ones last. A filter keeps those with defects left. `?handover=<id>` opens one handover (`getHandoverTrace` and the warranties of the handover): its facts, each punch item (severity, state, place, contractor, day to put it right, "past the day" only for a defect still open) and each obligation (scope, asset, term, status, claims).

- **The warranty is a separate right** (`warranty.read`). A reader who gets 403 on it sees the handovers and is told the warranty is not shown to them; it is never shown as "none". An expired licence is the licence state of the whole screen.
- **No clock of the phone.** The status of a warranty (`ACTIVE`, `EXPIRED`, `CLOSED`), "late" and the deadlines are the words of the server; the days are only formatted. A copy kept on the device says the moment it describes (`as_of`).
- Nothing on the screen creates or changes anything; handover decisions stay on the web (AST-02).

## Tests

`test/features/acceptance_handover/acceptance_test.dart` names `UI-MOB-65`, `AC-ST-MOB-022-1`, `AC-ST-MOB-022-2`, `AC-ST-MOB-022-3`, `UAT-PLAN-36`, `UAT-AC360` and `UAT-AC357`; `handover_test.dart` names `AC-ST-MOB-022-4` and `UI-MOB-66`. The server is a scripted transport, so a signature, a decision, a refusal, a lost answer and the headers (`Idempotency-Key`, `If-Match`) are real requests. Every screen runs through the states of `expectEveryState` and the contract of `expectScreenContract` (three devices, 200 percent text, tap targets, labels, contrast).

## What only a device can prove

The second-factor round trip through the system browser between a refused command and the confirmation; a command whose connection is cut between the request and the answer on a real phone; TalkBack and VoiceOver reading of the signature lines and of the gate notes; the look of the two-column facts at 200 percent text on a 360 dp phone. `UAT-PLAN-36` on a real device (airplane mode, then reconnect, then look at the server) is the external check.

## Gaps

- `signQualityAcceptance` accepts `IN_APP_OTP` and `IN_APP_WEBAUTHN` without a code or an assertion in the request, so the phone has nothing to collect for them; the contract (and QMS) should say how an in-app confirmation is proved. The phone sends what the web sends.
- There is no operation that lists the minutes assigned to a person: the list is the minutes in the scope of the person (`listQualityAcceptances`) filtered to the open ones. Reaching MOB-65 from a notification needs the deep link of ST-MOB-015 to name `?acceptance=<id>`.
- The paper of the minutes is shown by its code; opening the PDF needs a download operation open to the readers of QMS (today `getDocumentVersionDownload` needs `doc.outgoing.read`).
