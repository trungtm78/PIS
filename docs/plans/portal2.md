# Plan of lane PORTAL-2 (contractor portal follow-ups of VND-3)

Branch `lane/portal2`, worktree `D:\PIS-portal2`, migration block 2640-2659. Follow-ups that lane VND-3 left (`docs/plans/vnd3.md` "Portal access hook", `docs/vendor-investigation.md` sections 5, 8 and 13). Owner rule: decide by deepest governance and best extensibility, no scope cut.

## The four pieces and the decisions

### A. Portal access without a contract (contractor-registry-bound invitation)
ADM-17 ties a guest to contracts, so a contractor with no contract could not reach the portal and `createVendorPortalRequest` answered 422 `CONTRACTOR_PORTAL_NOT_BOUND`. Decision: a second, separate way in, bound to the **registry entry**, not to a contract.
- Table `contractor_portal_invitation` (V2640): contractor, contact e-mail, contact name, **contact basis** (`REGISTRY_EMAIL` = the address equals the e-mail on the registry entry, checked by the server; `REPRESENTATIVE_LETTER`, `TAX_AUTHORITY_RECORD`, `OTHER_EVIDENCE` = a reference of the paper that proves the contact is the contractor's, at least 6 characters), the tax id snapshot shown to the approver, status `PROPOSED / APPROVED / REJECTED / EXPIRED / REVOKED`, proposer, approver (**CHECK: approver is not the proposer**), proposal expiry, access end, membership id, revocation. Partial unique index: one live invitation per contractor and e-mail.
- Only a contractor whose registry entry is **VERIFIED** and not under a debarment or screening hold can be invited (the contact of an unverified entry proves nothing).
- Two-person approval: staff with `vnd.portal.invite` propose; a different person with `vnd.portal.invite.approve` approves or rejects (reason). Approval creates the invited guest membership bound to the contractor, a grant of the new system role **PORTAL_CONTRACTOR** (the five `vnd.portal.*` rights and the upload right, nothing else, so no `contract.read` leaks) on the unit of the proposer (`UNIT_ONLY`; the portal checks the right anywhere and the contractor from the membership, never from the grant), the MEMBER baseline, and sends the invitation through the ADM-17 mail path (token, expiry as for any invitation).
- Expiry: the proposal expires after `proposal_days` (rule `VENDOR_PORTAL_ACCESS`), the account after `access_days` (default 365, rule maximum 730; renewal = a new invitation, approved again). A nightly job sets EXPIRED and ends the membership; reads also derive the state.
- Revocation (`vnd.portal.invite.revoke`, reason, immediate): ends the membership, expires the grants, status REVOKED; allowed from PROPOSED (withdraws it) and APPROVED.
- Audit rows (CONFIDENTIAL) and outbox events carry ids and codes only, never the e-mail. `createVendorPortalRequest` keeps its rule; the error text now points to the invitation.
- Boundary: the invitation table is denied to the portal path (restrictive policy); the contractor of a call comes from the membership. Tests: contractor A (account made through an invitation, no contract) reads its own profile and requests and **never** B's (store level with raw SQL on the portal path, and API level).

### B. Petition outcomes (`procurement_petition_outcome`, V2641)
The petition module had no recorded decision; the folded "upheld %" treated every answered petition as rejected. Now: `recordProcurementPetitionOutcome` (outcome `UPHELD / REJECTED / WITHDRAWN`, decision reference, decision date, optional decision document) by `bid.petition.outcome.record`, **confirmed by a different person** (`bid.petition.outcome.confirm`) or returned with a reason; conflicts of interest of the contractor/package block both people like `resolveProcurementPetition`. Allowed: UPHELD/REJECTED when the petition is RESOLVED or ESCALATED; WITHDRAWN while it is open or answered (confirming a withdrawal sets the petition to WITHDRAWN). One live outcome per petition; a confirmed outcome is final. The dispute figures (`VendorDisputeStore`) fold the **confirmed** outcome; an answered petition without a confirmed outcome stays OPEN and is counted in a new `awaiting_outcome` figure, so the upheld percentage is over decisions only. Operations: record, confirm, return, list.

### C. Generic upload for portal attachments (V2642)
`uploadPortalAttachment` (multipart, `POST /portal/attachments`, permission `vnd.portal.upload`): judged by bytes (PDF, PNG, JPEG), size limit by the purpose (`document`: kernel limit, further capped by the rule `VENDOR_PORTAL_ACCESS.max_upload_bytes`), a **scan hook port** (`PortalUploadScanPort`) with a **fail-closed default** (verdict UNAVAILABLE is refused 409 `SCAN_PENDING`; infected is 422 `FILE_NOT_CLEAN`; an explicit opt-in adapter delegates to the pipeline scanner), stored through `FileService` under the tenant prefix, then registered as a document of the DOC framework (`document` kind ATTACHMENT + `document_version`, subject module `VND_PORTAL`, subject = the contractor) so the existing `document_id` fields keep working. Responses, certificates and remediation evidence now accept **only an attachment of the caller's own contractor** (today any document id of the tenant passed, an existence oracle and a way to attach another's file); the portal path policy limits `document` and `document_version` to the contractor's portal attachments. `listPortalAttachments` shows the contractor its own.

### D. Screens, design rows, shared-suite entries
VND-23 (staff: portal access invitations), BID petition outcomes screen, the upload control in the existing portal dialogs (VND-16 to VND-19), i18n part `portal2`, catalogue/navigation/routes, stories, backlog, traceability, test cases, VND.md and a section in `docs/vendor-investigation.md`. Contract only through `scripts/contract-patch.mjs`. Entries (not run) for the shared suites: isolation, reachability, command-conformance counts, outbox consumers, workers/jobs lists, negative authz matrix.

## Steps (tick when done)
| # | Step | Tests |
|---|---|---|
| 1 | [x] Plan, migration block registered | `npm run migrations:check` |
| 2 | [x] Kernel: pure rules (`vnd-portal-access.ts`: invitation states, contact basis, expiry; `bid-petition-outcome.ts`), rule `VENDOR_PORTAL_ACCESS`, role PORTAL_CONTRACTOR, texts | `packages/kernel/test/portal2*.test.ts` |
| 3 | [x] Migrations V2640-V2644 (invitation, outcome, attachment, portal boundary, role and permission) | rls-catalog, migrations check |
| 4 | [x] DB stores: invitation, outcome, dispute fold, attachment; portal store uses attachments | `packages/db/test/portal2-*.test.ts` through the db lane |
| 5 | [x] Contract (contract-patch), controllers, upload guard + scan port, jobs, authz | `apps/api/test/bid/portal2*.test.ts` |
| 6 | [x] Web: VND-23, petition outcomes, upload control, i18n part, routes, nav | vitest of the screens |
| 7 | [x] Design rows, docs, shared-suite entries | `check-cli`, `baseline-cli` |
| 8 | [ ] Lint, typecheck, scans, Codex review and triage | `npm run lint`, `npm run typecheck` |

## Risks
- Time (hard deadline 20:15) and memory: DB suites queue behind the pre-push gate lock; tests are batched.
- Shared files are edited with small anchored appends and the generators; regenerated generated files are committed in their own commit.
