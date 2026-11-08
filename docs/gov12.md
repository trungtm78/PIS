# Lane GOV-12: transparency, monitoring and integrity records

Roadmap items G4-6, G4-8, G4-9, G4-10, G4-11 and the should-have part of G4-12 (`docs/governance-roadmap-10of10.md`). Plan: `docs/plans/gov12.md`. Migration block 2600-2619 (V2600-V2608 used). Every number below is a governance rule with formula, source, as-of and legal status UNVERIFIED (`packages/kernel/src/gov12-rule-types.ts`, registered by `registerGov12Rules`).

## Where things are

| Item | Kernel (pure) | Database | API | Screens |
|---|---|---|---|---|
| G4-6 period reports for the Ministry | `period-report.ts`, `mof-forms.ts` | `report_period_lock`, `report_signature_session`, `report_issue_signature` (V2608) | `reports/period-report.controller.ts`, edits in `report.controller.ts` (lock before generate, signature before delivery), `form-registry.ts` (`registerMofReportForms`) | RPT-05, RPT-06 |
| G4-8 community monitoring | `monitoring-file.ts` | `monitoring_file`, `monitoring_pack_item`, `monitoring_feedback`, `monitoring_feedback_event` (V2600-V2602) | `prj/monitoring.controller.ts` | PRJ-30, PRJ-31 |
| G4-9 public portal and OC4IDS | `portal-fields.ts` | `portal_setting`, `portal_record`, `portal_directory`, the two public functions (V2604) | `prj/portal.controller.ts` (publisher), `prj/portal-public.controller.ts` (public, control plane) | PRJ-32, PRJ-33 |
| G4-10 audit standing | `audit-standing.ts` | reads over `audit_recommendation`, `project`, `disbursement_ranking` | `aud/standing.controller.ts` | AUD-17 |
| G4-11 transmittal | `transmittal.ts` | `doc_container`, `doc_container_move`, `doc_transmittal`, `doc_transmittal_item`, `doc_transmittal_recipient` (V2603) | `doc/transmittal.controller.ts` | DOC-28, DOC-29 |
| G4-12 anonymous channel | `whistle.ts` | `whistle_report`, `whistle_message`, the four functions (V2605) | `aud/whistle.controller.ts` (handlers and public) | AUD-18 and the public page PRJ-33 |
| G4-12 gifts | `whistle.ts` | `gift_register` (V2606) | `aud/gift.controller.ts` | AUD-19 |
| G4-12 photo findings | `photo-findings.ts` | `photo_finding`, `photo_finding_event` (V2607) | `qms/photo-finding.controller.ts` | QMS-12 |

## Decisions

- **No new module code.** Controllers live in RPT, PRJ, AUD, DOC and QMS. The two public controllers are in the `controlPlane` part of PRJ and AUD, so a process without the control database mounts none of them.
- **A running deadline never moves.** The monitoring file keeps `notice_days` and the rule version at the moment the trigger day is set; a feedback keeps `response_days`; a transmittal keeps `review_days`; a gift keeps its flags; an anonymous report keeps both clocks. A later change of the rule affects new records only.
- **The public portal reads no source table.** `portal_record.fields` is cut by the allow-list when it is published (`projectPortalRecord`), and the controller cuts again on output with the allow-list of the settings (`cutToAllowed`): a field taken off the list disappears from the answer without a new publication, and a field added to the list appears only after the next publication. The public side reaches the data only through `portal_public_info` and `portal_public_records` (SECURITY DEFINER, they set the tenant of the transaction themselves and clear it again). The tenant role cannot read `portal_directory`; the control role cannot read any tenant table. A project is published only when its classification is PUBLIC and it is past the idea stage and not rejected or cancelled.
- **The allow-list is a closed catalogue.** `PORTAL_FIELDS` names no person, account, internal id, audit finding or red flag; a rule that names another field is refused. The catalogue has no money-that-moved and no progress field yet (a later lane adds them as new fields).
- **Rate limit without identity.** `public-client.ts` makes an opaque key from the address and a secret that exists only in the memory of the process; the key feeds an in-memory fixed-window limiter and is never stored or logged. The portal limit and page size are copied from the rule into the settings when they are saved.
- **OC4IDS** (`oc4idsPackage`, `validateOc4idsPackage`): a pure mapper and a validator of the required fields and the codelists. The lists are written from the standard as known offline and flagged UNVERIFIED (`OC4IDS_LISTS_STATUS`): diff them with the schema file when it is available; it is a change of one list. A field the allow-list took away is reported as missing, never invented.
- **Anonymous channel.** No column holds an address, an agent, an account or a contact; dates on the reporter's side have day precision; the reporter keeps a 160-bit access code that is shown once, only its SHA-256 is stored, and the code travels in the body of a POST. The report text is CONFIDENTIAL in the audit trail and appears in no event. A handler who belongs to the unit a report is about (or above it) is told the report does not exist.
- **Digital signature.** The approver of an issued copy signs the package digest through `DOC_SIGNING_PORT` with one of their own active personal certificates; the CMS is checked to cover that digest and stored with its hash. A MOCK signature is stored as a test signature (`counts_for_delivery` is false): delivery to a receiver listed in the rule `PERIOD_REPORT_RULE` is refused with `REPORT_SIGNATURE_REQUIRED`, and a test signature does not lock the period. The signing port in production is the unconfigured one until a certification authority is connected.
- **Period lock.** A real signature (or the acceptance by the receiver, by the rule) locks the period of the series; `generateReport` refuses a locked period with `PERIOD_LOCKED`; two different people release it, the second with a reason of the length the rule asks for.
- **MOF forms are PENDING_EXTERNAL.** `MOF-DIS-WEEKLY|MONTHLY|QUARTERLY|YEARLY` are built from the indicators of the register with live figures from the snapshot that stood at the end of the period (`DisHomeProvider` with `atPeriodEnd`), so a report of March is never made from the snapshot of June. They can be drafted and read, not issued (R18). To put the official form in place follow "To replace a demo form by the official one" in `docs/report-engine.md`.
- **Audit standing** ranks investor units by a weighted count of overdue, disputed and open recommendations and the money still owed; the position in the latest frozen disbursement ranking is read beside it. It never changes the disbursement ranking and never includes a red flag.
- **Documents are linked by id** (`document` and its current version, or `project_document` of DOC-2 when the table exists); the title and the hash are kept when linked. A transmittal refuses a document that changed since it was registered (`TRANSMITTAL_DOCUMENT_CHANGED`).
- **Photo findings** are pairs (same file in two projects, same place and moment in two projects, same file on two days of a project); the pair is written once; the person who uploaded either photo does not explain it; a finding is a signal and never a conclusion.

## Not done, on purpose

- Alert sources (`ALERT_TYPE` seeds) for the overdue lists (notice, feedback, transmittal, whistle clocks, gifts): the lists expose `overdue` and counts; wiring them to the alert centre is for its lane.
- Contractor portal, Monte Carlo, deep benefit measurement and direct national connections of G4-12 (NICE); G4-7 belongs to MR-1.
- The full signing round trip over HTTP with a real PKI (the store, the gates, the refusals and the MOCK path are tested; the CMS check uses `signedDigestOf`).
- Rebuilding the HTML pages of the design (`node src/build-cli.mjs --pages`): the `marked` package is not wired into this worktree.

## Tests

Kernel `packages/kernel/test/gov12-*.test.ts`; database `packages/db/test/gov12-stores.test.ts` (RLS, append-only guards, directory functions, no tenant table readable by the control role); API `apps/api/test/gov12/gov12.test.ts` (rights, versions, SoD, public surface, rate limit, anonymity, delivery gate); isolation fragment `apps/api/test/isolation/channels/gov/gov12*.ts` (foreign-id cases for every id-bearing operation, seeds and markers); web `apps/web/src/screens/gov12/*.test.tsx`.
