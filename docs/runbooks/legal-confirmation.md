# Legal confirmation: how a CXN item is confirmed and what it unlocks

A `[CXN-n]` marker in a specification is a legal basis that nobody has verified. The ledger
(`Design/MACHVON_Design/03_Engineering/legal_confirmation_ledger.json`) lists every marker with its owner and its state, and the
gate `npm run cxn:check` (`scripts/cxn-gate.mjs`, part of `npm run lint`) joins it with the stories of the implementation plan and
`docs/story-status.json`.

## The rule the gate holds

| A story whose status is | and that cites CXN items | the gate |
| --- | --- | --- |
| `DONE` or `DONE_PENDING_ENV` | any of them unconfirmed | fails, listing the ids: the story must say `DONE_UNCONFIRMED` |
| `DONE_UNCONFIRMED` | at least one unconfirmed | passes, and the story is listed in the release notes with the items it waits for |
| `DONE_UNCONFIRMED` | all confirmed, or none | fails: the label is stale, the story is `DONE` |
| anything | an id the ledger does not have | fails |

An item counts as confirmed only when its ledger row says `CONFIRMED` **and** names who confirmed it, when, and the evidence. A status
edited by hand without the rest is `INVALID_CONFIRMATION` in the ledger and a failure of the gate.

A confirmation changes data, never code: the rules and templates of the product are versioned data with a `legal_basis` and an
effective range (`resolveRule` in the kernel, `MasterRules` for master data, the template tables of DOC), and a rule that rests on an
unconfirmed item is a working assumption that the screens and the documents it produces mark as such (the template watermark, "chờ ký").

## Confirming an item

1. The legal reviewer reads the source named by the item (the statement and the files that cite it are in the ledger) and obtains the
   evidence: the text of the law or the letter of the competent authority, with its number and date.
2. They add the item to `Design/MACHVON_Design/03_Engineering/legal_confirmation_register.json` (create it when it does not exist yet):

   ```json
   {
     "CXN-03": {
       "owner": "Pháp chế",
       "status": "CONFIRMED",
       "confirmed_by": "Name and role of the reviewer",
       "confirmed_at": "2026-11-03T09:00:00+07:00",
       "evidence": "Công văn 16437/BTC-ĐTPT ngày 25/09/2026, mục 2 (hai mẫu số tỷ lệ giải ngân)"
     }
   }
   ```

3. Regenerate the ledger: `node Design/MACHVON_Design/work/tools/src/legal-ledger-cli.mjs`.
4. Run `npm run cxn:check`. Every story whose last unconfirmed item this was is now reported as stale: change it from
   `DONE_UNCONFIRMED` to `DONE` in `docs/story-status.json`, then `npm run uat:trace` and commit the register, the ledger and the
   status file together.
5. The data that the item governs is confirmed by its own command (for example the legal confirmation of a document template by a person
   with `doc.template.confirm_legal`), which is what removes the watermark from what the product produces.

A story that cites an item that is later found wrong goes back to `DONE_UNCONFIRMED` (or `PARTIAL`) in the same change that corrects the item.

## Dated rules, in short

- A law change is a new version with its own range `[valid_from, valid_until)`; the old version is never edited, so a record made
  under it is read with it for good (`resolveRule(rules, code, asOf)` finds the version of a date, `ruleOfRevision` the version a record
  was bound to).
- Two published versions of one rule never cover one day. The tables that hold rules say so with an exclusion constraint on the
  daterange of the key; `packages/db/src/effective-range-registry.ts` declares how every table with a start and an end of validity is
  judged and `packages/db/test/effective-range-lint.test.ts` fails when a table with such a range is not declared, has no guard it names,
  or has no check that the range ends after it starts. A table with a rule-like range and no guard yet is listed there as PENDING
  with the reason (today: `metric_definition`).

## Waiving an item and closing the window (ST-KERNEL-110)

An item that cannot be confirmed in time can be **waived** by its own named owner: the register entry says `"status": "WAIVED"` with `waived_by` (the owner of the item, not somebody
else), `waived_at` and `waiver_reason`. Without all three it is not a waiver and `npm run cxn:check` reports it (`WAIVER_INCOMPLETE`). A waived item no longer makes a story that cites it
`DONE_UNCONFIRMED`.

`npm run cxn:report` prints every item with its owner, its evidence (the confirmation evidence or the reason of the waiver), its status and the stories of R1 and R2 that rest on it, and
the verdict on the legal confirmation window: it can close only when every item that gates an R1 or R2 story is confirmed or waived by its owner (exit 0), otherwise it stays open and the
items that hold it are named (exit 1). An item that only R3 and later stories cite does not hold the window.
