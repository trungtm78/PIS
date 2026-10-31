# Layout profile governance and the comparison of template revisions (ST-DOC-016)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DOC.md` (F12, BR-DOC-13, DOC-15, DOC-16, UAT-AC415, UAT-AC416, UAT-AC423). Migration `V1228__doc1_layout_profile_governance.sql`. Operations: `createDocumentLayoutProfileRevision` (`POST /document-layout-profiles`, `doc.layout.manage`), `publishDocumentLayoutProfile` (`POST /document-layout-profiles/{id}/publish`, `doc.layout.approve`, `If-Match`), and two reads added to the contract, `listDocumentLayoutProfiles` and `getDocumentLayoutProfile` (`doc.template.read`). The pure rules are in `packages/kernel/src/pdf-layout.ts`, the store is `packages/db/src/document-layout-profile-store.ts`.

## The rule

The formatting of Appendix I of Decree 30/2020 is data. A revision of a profile is **drafted** by one person and **published** by another (403 `SELF_APPROVAL_DENIED`); a value outside the legal range cannot be written.

- **The ranges (BR-DOC-13).** Margins: top and bottom 20–25 mm, left 30–35 mm, right 15–20 mm. Sizes of the thirteen elements (national title 12–13 pt, motto 13–14, agency 12–13, number 13–14, place and date 13–14, name of the type 13–14, summary 13–14, body 13–14, title and name of the signer 13–14, "recipients" label 12, list of recipients 11, page number 13–14). A value outside is 422 `LAYOUT_OUT_OF_LEGAL_RANGE` naming it (`marginsMm.top`, `elementStyles.body.sizePt`...) and **no revision is created** (AC-ST-DOC-016-1: a margin of 18 mm). A body that is not the shape of a profile is 422 `VALIDATION_FAILED` naming the member; a blank legal basis is 422 `LEGAL_BASIS_REQUIRED`.
- **The seal over the signature (AC-ST-DOC-016-2).** The seal box starts to the left of the box of the signature of the leader and covers a third of its width, give or take 0.03 (`signatureLayout.sealBox` otherwise). The widgets of the signature fields of a rendered PDF are placed from these boxes, so the measure on the PDF is the measure of the profile (test on the rendered file).
- **The moment of signing (AC-ST-DOC-016-2).** The signature field now has an appearance: the line under the signature is the moment of signing as ISO 8601 in the zone of Vietnam (`2026-10-22T09:15:30+07:00`), drawn in the incremental update that carries the signature, so it is inside the bytes the signature covers.
- **Numbering and publication.** Revisions of a code are numbered one after the other. Publishing takes over from the open-ended revision before it (which ends on the day the new one starts); any other overlap is 409 `TEMPLATE_RANGE_OVERLAP`; a revision that is not a draft is 409 `LAYOUT_STATE_INVALID`; a version that moved is 409 `VERSION_CONFLICT`. The caller needs the right over the whole tenant (403 `SCOPE_DENIED` for a branch).
- **The trail.** Audit rows `document_layout_profile.draft|publish` (the publish row names the revisions it closed) and the events `doc.layout_drafted.v1` / `doc.layout_published.v1`.
- **The database.** The same ranges are a constraint (`document_layout_profile_legal_range_chk`, NOT VALID: it judges every row written from now on); the content of a revision never changes; it moves DRAFT to PUBLISHED once with its approver; a published period is only ever shortened; nothing is deleted.

## The comparison (DOC-15, AC-ST-DOC-016-3)

`getDocumentTemplate` now carries the names of the people behind a revision (`created_by_name`, `approved_by_name`, `legal_confirmed_by_name`, from the directory of the tenant). The screen reads two revisions (`?id=` and `?other=`; without `other` the revision before) and shows, side by side, the status, the period, the legal basis, the confirmation and the three names of each; the content line by line (kept, removed, added); and the placeholders each requires (added, dropped, kept). The library (DOC-14) links each revision to it.

## The screen (DOC-16)

`LayoutProfilesScreen`: the table of the ranges, the revisions with their period, state and confirmation, a button to publish a draft (for an approver other than the drafter), and a form that starts from a revision (its values are filled in) and edits the margins, the sizes, the dates, the legal basis and the two boxes, telling a value outside the range, and the share of the signature that the seal covers, before it sends. A reader and the read-only mode see the tables only.

## What is not done

- The images of the signature of the leader and of the seal (PNG, transparent, red) are not drawn: the platform has no image assets; the boxes and the line of the moment of signing are.
- The legal confirmation of a profile (CXN-DOC-01, which removes the watermark) is not a command; `confirmation_status` stays `PENDING_CONFIRMATION` until the legal officers confirm the original text, and the database refuses to change it through the application role.
- The form edits sizes, margins and the two boxes; the flags of the letters (bold, italic, capitals), the boxes of the number fields, the font and the watermark are copied from the revision it starts from.
