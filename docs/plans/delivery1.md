# Plan of lane DELIVERY-1 (HSKT traceability matrix and the Waterfall delivery document set)

Branch `lane/delivery1`, worktree `D:\PIS-delivery1`. Source: plan "ENT-3" gap G19 (customer dossier HSKT v0.3 of 2026-11-03, requirements TK.01 to TK.04, sections II.2.3 and II.5) and the eng review of ENT-3 (R18: nothing built on a customer file that has not arrived counts as acceptance). The lane writes data, one generator and documents only: no product code, no migration, no contract change.

## Decisions (owner rule 2026-11-08: deepest governance, best extensibility, no scope cut)
- One source of truth: `docs/hskt/requirements.json` holds every requirement code of the dossier (MD, DL, QT, CN, BC, TH, HT, YCK, TK), the 7 phases (GD.1 to GD.7) and the 11 deliverables (SP.01 to SP.11). `docs/hskt/TRACEABILITY.md` is generated from it and never edited by hand.
- The checker is closed: a code of the dossier without a row, a row naming a screen, operation, story, document or test that does not exist, a DONE row without evidence, a PARTIAL or MISSING row without a gap and an owning lane, a PENDING-EXTERNAL row without a register item, a register item missing from the register document, or a stale generated file, each fail `node scripts/hskt-trace.mjs check`, which is part of `npm run qa:check`.
- The 11 delivery documents are skeletons written from what the repository already has (design documents, workflow code, UAT ledgers, runbooks, help chapters). A field only the customer knows is written as `[khách điền: ...]`; nothing else is invented.

## Steps
- [x] 1. This plan, committed first.
- [x] 2. `docs/hskt/requirements.json` (all codes, status, evidence, gap, owner), `scripts/hskt-trace.mjs` (generate, check), `scripts/hskt-trace.test.mjs`, wiring into `qa:check`, generated `docs/hskt/TRACEABILITY.md`. Tests: valid repository passes; each failure class above is reproduced on a mutated copy and must fail (the checker can go red).
- [x] 3. Documents 01 and 02 (As-Is and URD; To-Be process with flows).
- [x] 4. Documents 03 and 04 (SRS mapping; system and integration design index).
- [x] 5. Documents 05 and 06 (SIT/UAT scripts by requirement code; data conversion plan and the mapping of the 05 Excel forms).
- [x] 6. Documents 07 and 08 (training; parallel run for two periods).
- [x] 7. Documents 09, 10, 11 and `docs/delivery/README.md` (acceptance minutes, handover checklist, PENDING-EXTERNAL register, index with the 7 phases and approvals).
- [ ] 8. Independent review of `git diff main...HEAD` (Codex if the limit is lifted, else a fresh read-only subagent), triage, fixes, `git merge main`, final report.

## Tests per step
Step 2: `node --test scripts/hskt-trace.test.mjs`, `node scripts/hskt-trace.mjs check`. Steps 3 to 7: the same checker (documents named by the matrix must exist and the register must list every external item); markdown only.

## Risks
- Heavy gate running elsewhere: no DB jest, no whole-suite runs until no `verify-cli` process exists; single-file node tests only.
- Evidence ids drift when other lanes rename a screen or story: the checker names the broken row, the owning lane fixes the row.
- Statuses are the lane's reading of the repository on 2026-11-09; ENT-3a to ENT-4e must update their rows when they land (the checker does not know code, only references).
