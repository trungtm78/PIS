# MOB: the weekly report on the phone (ST-MOB-011, ST-MOB-012)

A reporting officer enters the weekly (or monthly) disbursement report on the phone step by step, with the draft kept on the device at every change, and hands it in with one command that the server runs exactly once. The code is `apps/mobile/lib/features/reporting`; the offline machinery it uses (queue, drafts, uploads) is `lib/core/offline` and is described in `docs/mobile-offline.md`. The server half is the DIS module (`docs/dis-report.md`, `docs/dis-report-submit.md`, `docs/dis-mobile-contract.md`) and the sync endpoints (`docs/mob-sync.md`). Behaviour is defined by `05_modules/MOB.md` (L2) and `05_modules/DIS.md` (F1, parity MOB-13..21).

## Screens

| screen | path | what it is | data |
|---|---|---|---|
| MOB-13 | `/projects/mob-13` (`?project=`, `?period=`) | the choice of the type of report (weekly / monthly), the period, the project and the way the cumulative is read | `get_resources_reporting_period`, `get_resources_project` through `DataView` (a copy with its `as_of` when the server cannot be reached) |
| MOB-14 | `/projects/mob-14/:draftId` | the four volumes and the percent, the basis, and under them what the cumulative disbursement comes to against the period before | the local draft |
| MOB-15 / 16 / 17 | `/projects/mob-15/:draftId` ... | the cumulative of the year plan / the carried-over plan / the other sources, central and local, with the CTMTQG inside the cell | the local draft |
| MOB-18 | `/projects/mob-18/:draftId` | next month, by cell, with the CTMTQG inside it | the local draft |
| MOB-55 | `/projects/mob-55/:draftId` | the notes (results, causes, solutions, proposals); the causes are required to send a monthly report | the local draft |
| MOB-19 | `attachments` feature | the files of the report (owner `report`, ref = the local UUID) | uploader of ST-MOB-009 |
| MOB-20 | `/projects/mob-20/:draftId` | the review (errors, warnings, the change of every cell, totals, notes, files) and the one command that sends | local draft, queue, `getReportRevision` |
| MOB-21 | `/projects/mob-21/:reportId` | the result: report code, revision, status, the time the server received it, late or not | `getReportRevision` through `DataView` |
| MOB-22 | `/projects/mob-22` | the drafts on the phone, last saved first, with their standing; open or discard | local drafts, queue |
| MOB-56 | `/projects/mob-56/:draftId` | the estimate of the end of a month (month, source, amount, assumption) | `registerDisbursementSchedule` (online) |

Every step is opened from its path parameter alone (the draft id), so a restart finds it again. Step order for the "Bước n/8" line and the Continue button: MOB-14, 15, 16, 17, 18, 55, 19, 20.

## The draft (MOB.md 3: "nháp là bản ghi cục bộ có UUID")

A draft is a `LocalDraft` of kind `report` in the encrypted store of the user and tenant. Its `fields` are the `ReportDraft` of the contract with the amounts **as typed** (`1.250.000`), plus `_ctx` (the project, the period, and, once the server was asked, what each cell was allocated and what the period before reached, with the moment they describe). The payload of a command is made from the form alone (`ReportForm.toPayload`): whole dong written out, texts trimmed, the four volumes only when all four are amounts. A draft is written at every change (a synchronous write to SQLite) and shows `Đã lưu nháp trên máy lúc <time> · mã nháp <first 8 of the UUID>` (AC-ST-MOB-011-1).

* **Starting (MOB-13).** The draft is made on the phone at once. When the phone is not known to be offline the server is asked to make the report with the UUID of the draft as `client_operation_id` (`POST /reports`, the same entries sent again are the same report). If the server refuses for good (locked period, no plan, stage) the draft is discarded and the refusal is shown; if the answer is lost the draft is kept and the same key is used again; if the project already has a draft on the server and the new draft has no entries, it takes that draft over (its figures, its version). A project and period already drafted on the phone open the existing draft.
* **Reference data.** When a step opens and a network exists, the report is read (`getReportRevision`) for the allocation of the six cells and the figures of the period before. They are kept in the draft with their moment and shown read only, with "Chỉ để tham khảo". The version the draft is based on and its status are not changed by that read: a report that moved on is found by the save (409), never by silently taking the newer version as the base.
* **Not applicable (AC-ST-MOB-011-4).** A carried-over cell that the plan allocated nothing to and that holds no figure is not an input: MOB-16 and MOB-18 write "Không áp dụng ..." instead of a zero box. The CTMTQG of the other sources is not an input either. A figure that was entered is never hidden.
* **Totals (AC-ST-MOB-011-2, -3).** The total is the sum of the six cumulative cells, exact on integers; the CTMTQG is shown apart ("không cộng vào tổng") and is never a term of any sum. MOB-14 shows the period before, the change (`cumulative - previous`) and the cumulative: previous 100 million and cumulative 150 million give a change of 50 million, never 250.
* **Money units.** Every amount box shows `đồng` beside it and the same amount in millions under it (`1,25 triệu đồng`); the keyboard takes digits and the separators of thousands only.
* **Validation (TK-MOB-011-4).** `reviewForm` mirrors `reviewReport` of the kernel: a cell that is blank or not an amount, a CTMTQG larger than its cell (also next month), the other sources with a CTMTQG, a fall below the period before without an explanation (10 to 2000 characters), the four volumes, the percent from 0 to 100, notes of at most 4000 characters, the causes of a monthly report. Findings carry the field names of the server, so the server's findings and the phone's read the same. Findings that make the draft impossible to save are marked; the others only stop the sending. The warnings that need only the allocation (volume above allocation, empty next month with capital left, an explained fall) are worked out too; the gap with the Treasury is the server's. The server stays the authority.

## Sending (ST-MOB-012)

The server judges a submit under the version of the last save, so the sending is two queue commands in order, made by `SubmitFlow.submit`:

1. if the report is not on the server yet, make it (needs a network once; `DraftExists` when it has entries and the project already has a draft there);
2. if the server does not hold the draft (`DraftStatus.synced`), `report.draft.save` with `If-Match` = the base version, `draftId` linked, and wait for the flush;
3. when that save is accepted, `report.submit` (`{report_id}`, `If-Match` = the version the save produced, `releaseDraft: true`): **one command with one idempotency key**.

* **Exactly once.** A second tap, a restart and a lost answer find the commands that exist (`submitStatusOf` reads the stage from the commands of the draft); a repeated call while one is pending is `alreadyPending`; an answer that was lost leaves the command `unknown`, MOB-20 says "Chưa xác định kết quả" and asks the server by the key (`GET /sync/commands/{key}`) - it never makes a second command (AC-ST-MOB-012-1, UAT-AC502). The same key and body sent twice get the same receipt (AC-ST-MOB-012-2, proven on the server by `apps/api/test/sync`).
* **A save found by its key** (the lookup does not give the version it made): before the submit the server is asked for the report and the version is taken only if the copy it holds has the same figures as the draft (`sameFigures`); another copy is somebody else's change, nothing is submitted (`SubmitOutcome.moved`).
* **Closed period (AC-ST-MOB-012-3, UAT-AC03).** The queue rejects the command with `PERIOD_LOCKED`; MOB-20 shows the refusal in words with its code and "Bản nháp vẫn được giữ trên máy"; the draft is `blocked`, every figure intact; "Gửi lại" sends the same command again under a new key after the period is reopened. "Gửi lại" does not rewrite the draft with the payload of the command (a submit names only the report): the draft keeps every figure, note and context whether the retry is accepted, refused again or waits offline. When the draft was edited after the refusal (editing a blocked draft makes it `editing` again), "Gửi lại" is the normal submit instead: the form is reviewed, saved under the version the server holds and then handed in, so the corrections are never dropped by a submit of the older server copy. A submit (or save) refused as unverifiable may have been carried out, so the main "Nộp báo cáo" is off while it stands (`SubmitOutcome.unverifiable` in the flow) and the command is never discarded by it; only the explicit decision in the queue frees the draft.
* **Conflict.** The report moved on: the command is `conflict`, MOB-20 leads to MOB-42, money is never merged.
* **Offline.** A phone known to be offline queues the command without sending; once the runner of the queue runs, a command that could not leave is `unknown` and is looked up when the network returns (`not_received` sends it again under the same key).
* **After acceptance (AC-ST-MOB-012-4, UAT-PLAN-35).** The draft is released (`releaseDraft`) and MOB-20 opens MOB-21 with the report id it remembered. MOB-21 reads the report from the server: revision, status, `submitted_at` as the server gave it (Vietnam time; the clock of the phone is never used), late or not as the server judged, and no field to edit. Correction is guidance only: a new revision, made online (`post_reports_id_corrections` is online only in the contract).

## The funnel of the submit (TK-MOB-012-4)

`SubmitFunnel` reports six counted events through the telemetry service of the release feature: `report.submit_started` (the tap), `report.submit_queued`, `report.submit_unknown`, `report.submit_accepted` (with `duration_ms` from a monotonic stopwatch, when the person watched it), `report.submit_rejected` and `report.submit_conflict` (with the stable `reason_code`). Each carries the tenant id, `screen_id` `MOB-20` and nothing else: the service drops any attribute that is not a count, a rate, a duration, a screen id or a stable code, so no project, amount, name or report id can leave the phone. The six names were added to `kTelemetryEvents` in `lib/features/release/telemetry.dart` (the closed list). Stages reached while MOB-20 is closed (the runner found the answer) are counted by the queue health events (`queue.unknown_rate`, `queue.conflict_rate`).

## MOB-56, the estimate

An estimate is a command of the capital plan (`registerDisbursementSchedule`, kind `FORECAST`, a month, a source, the amount and the assumption it rests on, `revision_reason` optional), not part of the report and not in the list of commands that travel through `POST /sync/batches`. It is made while online with a `CommandAttempt` kept for the entry (a lost answer is sent again with the same key); what is typed is kept on the phone (a draft of kind `estimate` whose `recordId` is the report draft) until the server accepted it.

## States and offline behaviour

The screens that show what is on the device (steps, MOB-20, MOB-22) draw the standard states for the device: loading, no such draft ("Chưa có dữ liệu"), a store that cannot be opened (`CLIENT_ERROR`), an ended session (`SESSION_EXPIRED`). What the server says while the reference figures are read (no connection, no right, expired licence) is told above the form, which stays: a person in the field must be able to go on with the draft they have (the same rule as MOB-41). MOB-13 and MOB-21 are reads and use the eight states of `DataView`. A draft waiting in the queue is read only, with the reason and a way to the queue; a read-only tenant cannot start or change a report.

## What only a device (or the real service) can prove

* the encrypted store surviving a real process kill (the tests close and reopen the SQLite file, which proves the draft is on disk, not that the OS keeps it);
* the number pad, text selection and the keyboard avoiding the boxes; TalkBack and VoiceOver reading the boxes with the unit, the notices as live regions, the order of focus;
* the real network cut at each stage of the sending (the tests cut the fake transport before and after the work); the idempotency of `POST /sync/batches` against the real API and database (`apps/api/test/sync` proves the server half);
* the golden fixture entered on a phone and compared with the same report entered on the web (TK-MOB-011-6): the model is proven to produce the payload the web produces for FX-DIS-001, not a side-by-side entry;
* the dropdown of 50 periods and 500 projects on a small screen; the cost of writing SQLite at every keystroke on a low-end phone.

## Decisions and gaps

* **Creating the report is online.** `post_reports` is not a command of `POST /sync/batches` (`SYNC_COMMAND_TYPES`), so a draft started with no network exists on the phone only; the server report is made, once, when a network is there (at the first step, or at the submit). Everything after that is queued.
* **Attachments are not linked.** The report links a file by `file_object_id` of the report upload door (`uploadReportFile`, resolved against the `document` store), but MOB-19 uploads to the sync store (`/sync/attachments`, `tenants/{t}/sync_attachment/{id}`); no DIS command takes a clean sync attachment. MOB-20 lists the uploads of the report and says they are not yet part of what is submitted. Gap for DIS/MOB: a way to link a clean sync attachment to a report revision (or the phone using `uploadReportFile`).
* **No session permission list.** The session has no list of permissions, so the buttons are gated by the read-only mode of the tenant and by the server's refusal (403 `SCOPE_DENIED`, 422 `LICENSE_EXPIRED`) shown in words; the server remains the authority.
* **The lists of MOB-13** (`get_resources_reporting_period`, `get_resources_project`) are kept only in the memory cache of `read_support` until the persistent read cache exists, so a new report cannot be started after a restart with no network.
* **The queue marks a command `unknown` when the batch cannot leave** (status 0), so a submit made with no network shows "Chưa xác định kết quả" until the lookup finds `not_received`; this is the queue's conservative rule (ST-MOB-005), not changed here.
* **The runner of the queue** is started by MOB-20 (as the conflict screen does); the application root should watch `queueRunnerProvider` so that a command is also sent when no screen of the report is open.
* **The submit has no `client_operation_id` in its body**: the sync endpoint runs `POST /reports/{id}/submit` with an empty body under the `Idempotency-Key` of the command, which is what makes it idempotent (`planOf` in `packages/kernel/src/sync-command.ts`).
