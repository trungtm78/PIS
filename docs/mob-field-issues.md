# MOB: reporting an obstacle in the field (ST-MOB-014, screens MOB-28 to MOB-31)

A field officer writes an obstacle down on the phone with a photograph and a place, with or without a network, and follows it until it is handled. The behaviour is the design of `MOB.md` (L4, BR-MOB-06) and `07_Smartphone_iOS_Android.md` ("Luồng hiện trường"); the operations are the ones of the web (`createIssue`, `commentIssue`, `get_resources_issue_id`), so the web (ISS-02, ISS-03) and the phone agree on the fields, the limits and the words. The code is `apps/mobile/lib/features/field_issues` (the screens) and `lib/features/field_evidence` (the tools the other field screens of ST-MOB-020 and ST-MOB-021 share: the photograph pipeline, the marks, the place with its consent, the camera and position ports).

## The four screens

| screen | what it does | offline |
|---|---|---|
| MOB-28 capture form | project, responsible unit, category and severity from the lists the server offers (kept on the device with their `as_of`, so the form can be filled in without a network), title and description. Every change is written to the encrypted draft store at once. Lists the reports of this phone that are not finished (waiting, refused, half-written drafts) | the whole form |
| MOB-29 photographs | take a photograph (after the rationale of MOB-06) or choose one from the gallery, mark it with a finger (colour, pen width, undo, redo, clear, a note under it), see what happens to its place and time, remove it | everything |
| MOB-30 place and check | consent to keep the position, read the position of the phone, or type a place; the checklist; **Send** | the send is a queued command |
| MOB-31 follow-up | the status, the handler, the deadlines the server counted, the position the reader may see, the timeline, a comment | reads show a labelled copy; a comment needs a network |

All four use the standard states of `StateBoundary`. MOB-28 and MOB-31 read the server (the seven states are driven through it in `capture_screen_test.dart` and `follow_up_screen_test.dart` with `expectEveryState`); MOB-29 and MOB-30 work on a draft that lives on the device, so their states are: the draft is being read, the local store cannot be opened (`SESSION_EXPIRED` when nobody is signed in), and the draft is not on this phone (`DRAFT_NOT_FOUND`). Every screen is checked at 360x800, 390x844 and 430x932, at 100 and 200 percent text, for the tap targets of both platforms, labels and contrast.

## The report is one command with a key the phone made

A draft is created with a `client_operation_id` (a UUID) from the first word typed. **Send** hands the photographs to the `AttachmentUploader` and queues one `issue.create` command (`docs/mob-sync.md`) whose idempotency key *is* that identity and whose body is the body of `createIssue`, built by the generated request class (`IssCreateIssue`), so it can only say what the contract allows. Consequences, all tested:

* a second tap, a send after a restart and a retry of the queue give the same command (`CommandQueue.enqueue` returns the one that exists); the photographs are added to the uploader once each, and the draft remembers each upload at once, so a send cut between two photographs is resumed, not repeated;
* when the network returns and the first answer is lost, the command is `UNKNOWN`, is looked up by its key (`GET /sync/commands/{key}`) and becomes `ACCEPTED`: the server holds one issue for the key (`apps/api/test/iss`, `issue.client_operation_id`) and the id is the same on every answer (UAT-PLAN-37, `place_screen_test.dart`);
* a batch answer carries no id of the record, so MOB-31 asks for it with the key of the command (`result_ref`) once the command is accepted, and then reads the issue; the status and the response and resolution deadlines it shows are the ones the server counted on its working calendar, never the clock of the phone;
* a report that is refused (`SCOPE_DENIED`, `LICENSE_EXPIRED`, ...) shows the reason and the code in MOB-31 with **Send again** (a new decision, a new key, the same issue identity) and **Drop this report**.

A comment (`commentIssue`) is **online only**: the queue carries no comment command (`SYNC_COMMAND_TYPES`). Offline, the words stay in the field and the screen says a comment needs a network; a comment whose answer was lost is sent again under the same `CommandAttempt`, so the issue holds it once. Closing, extending and escalating are not on the phone (ISS 3: online only, on the web).

## Place, position and consent (BR-MOB-06, NFR-PRIVACY-01/02)

A position of the phone is a `FieldPlace` with `source` `device` and exists **only together with the consent** of the person: asking for one without it is a `StateError`, and withdrawing the consent drops it. The position is read only after the person consented, the rationale screen MOB-06 was shown and the phone allowed it, while the application is in use (never in the background), with a time limit; a reading that arrives after the consent was taken back is dropped. A place typed by hand has the source `manual`, is shown as "Nơi xảy ra (nhập tay)" and travels in the description under the label "Vị trí nhập tay" (the issue has no field for a place that was not measured); coordinates typed by hand are never sent as `geo_*`, because they would pass for a measurement.

`geo_consent` of the command is true exactly when a position of the phone is sent. A report made with the location permission refused, with the consent withheld or with a typed place has `geo_consent: false` and no `geo_lat`, `geo_lng` or `geo_accuracy_m` (UAT-AC355; `issue_draft_test.dart`, `place_screen_test.dart`). An accuracy above 50 m is flagged as a poor position (BR-ISS-06), a note and not a block.

## Photographs: type, size, metadata, marks (`photo_pipeline.dart`)

Each photograph goes through one function before anything is kept for upload:

1. the type is judged by the first bytes: only JPEG and PNG are photographs. A script renamed to `.jpg`, a PDF, an empty file and anything else is refused with `FILE_TYPE_NOT_ALLOWED`, a file over 50 MiB with `FILE_TOO_LARGE`, a file that is gone with `FILE_NOT_FOUND`, a picture that cannot be read with `IMAGE_UNREADABLE`. The reason and the code are shown **before** the person spends time marking it, and no upload request is made (UAT-PLAN-38);
2. **the place and the time the photograph says it was taken at are removed unless the person consented** (AC-ST-MOB-014-2, UAT-AC367). `stripJpegMetadata` drops every block that can carry them (Exif, XMP, Photoshop/IPTC, maker notes, comments) and writes back a block that holds only the orientation, so a sideways photograph still shows upright; the picture itself is not recompressed. `stripPngMetadata` drops `eXIf`, `tEXt`, `zTXt`, `iTXt` and `tIME`. With the consent the file is kept as it is. The screen says which of the two happened. Taking the consent back on MOB-30 rewrites the prepared files, and the originals kept beside them, without them; `send` does it again as a backstop and the checklist refuses a send while a photograph still carries them without the consent;
3. the marks are drawn into the picture after the orientation is applied, in the coordinates of the picture (0 to 1), so what the person drew lands where they drew it. Marking is optional, and the stroke list, colour, width and the note under the photograph are kept in the draft;
4. a JPEG over 1 MiB or wider than 2048 px is scaled and compressed (quality 85 down to 45, then smaller) until it fits the transport size of the uploader, so the uploader does not recompress it a second time and nothing is lost between the two steps; a PNG over the policy size (10 MiB) becomes a JPEG that fits;
5. when the retention policy asks for evidence (`EvidenceLimits.retainOriginals`, on by default) the photograph as it was taken is kept beside the marked one in the private folder of the person (with the same metadata rule: without the consent it does not say where or when either) until the draft is discarded or the store is purged.

## What only a device (or the service) can prove

Listed so they become external checks (`TK-MOB-014-5`, `TK-MOB-014-6`): that `image_picker` opens the camera and the gallery on both platforms and returns the file; that `geolocator` returns a position (and its accuracy) with the permission states of iOS and Android, while the application is in use; the real camera files of both platforms, which write the Exif block in their own ways (the tests use synthetic blocks in both byte orders); the time and memory of compressing a 12 MP photograph in pure Dart on a mid-range phone; drawing with a finger (the tests drive the pointer events, not a real touch); TalkBack and VoiceOver on the four screens (the tests check labels, tap targets, contrast and 200 percent text on the host); UAT-AC355 and UAT-AC367 end to end with the real server and the real antivirus; the tenant switch with two photographs in the queue.

## Gaps and decisions (for the lead)

* **The photographs are uploaded but not linked to the issue.** `createIssue` takes no attachment, `commentIssue` takes `document_version_id` (a document version scanned clean) and `registerSitePhoto` takes an `object_key` of the file service; nothing consumes the id of a clean `sync_attachment` (`SyncAttachmentStore.linkableKey` has no caller). Until a server operation links a clean attachment to an issue (or the mobile upload targets the file service), the photographs of MOB-29 reach the server as clean attachments of the device with the owner `issue:<client_operation_id>` kept on the phone only.
* **No comment command in the queue**: `SYNC_COMMAND_TYPES` has no `issue.comment`; adding it is a change of `packages/kernel/src/sync-command.ts`, the sync contract and the generated clients.
* **Retention of originals**: the design says "giữ bản gốc theo retention nếu cần chứng cứ" without a period or a place; the original stays on the phone (not uploaded: the uploader recompresses a JPEG over 1 MiB, which would not be the original) until the draft is discarded or the store is purged.
* The queue marks a command `UNKNOWN` when the network was cut while it was sent (it may have reached the server); a report created in a tunnel shows "Chưa xác định kết quả" until the next lookup finds `not_received` and sends it again. That is the behaviour of ST-MOB-005 and is safe; the wording is the one of MOB-41.
* `image_picker` and `geolocator` were added to `pubspec.yaml` (the camera, gallery and position plugins are the only ones the permissions of ST-MOB-003 and the attachment seam of ST-MOB-009 were waiting for); the Android manifest and the iOS `Info.plist` already carry the camera and location permissions and usage texts.

## Tests

`apps/mobile/test/features/field_evidence` (metadata reading and stripping, the pipeline, the marks), `apps/mobile/test/features/field_issues` (the draft and its rules, the service, and the four screens). Every test title names its acceptance id (`AC-ST-MOB-014-n`, `UAT-AC355`, `UAT-AC367`, `UAT-PLAN-37`, `UAT-PLAN-38`, `UI-MOB-28` to `UI-MOB-31`).
