# Lane CLIPSCRIPT: production scripts of the two intro clips (Vietnamese only)

Owner decision (latest): the clips are in Vietnamese only: narration, subtitles and on-screen text; no English tracks.

## Goal

The scenario layer of the two clips already exists (`scripts/clips/`: scenarios, shared chapters, phonetics, numerals, subtitles, TTS, mix, verify).
It was written before the lanes of the last waves landed, so it still points at `planned:*` screens and operations, has no chapter for the
provincial steering committee, has no shot checklist, no music cue sheet, no link to the real seed layer (`docs/clip-data.md`), and nothing checks
that every screen of a scene has a route and an implementation. This lane closes that, as data plus tests:

- Scenarios follow the merged catalogue and contract (real ids instead of `planned:*`), a new chapter "Ban chi dao cap tinh" in the public clip
  (no simulation label anywhere), narration sentences short enough for TTS.
- A production layer per clip: shot checklist per scene (what must be visible; derived from the scene plus curated extras), music cue sheet
  (CC0 candidates only, to be approved by the owner), seed readiness (which groups of the clip seed make which scenes, and what is proven).
- `scripts/clip-scripts-check.mjs` (+ tests) checks the whole production script; `book` writes the readable shooting script
  `docs/clips/<clip>.script.md` (narration, respelled TTS text, subtitles, steps, routes, shot checklist, music).

## Decisions

1. Build on the existing tooling, do not fork it: the new check imports `scenario.mjs`, `text.mjs`, `subtitles.mjs`, `phonetics.mjs`.
2. Routes come from `apps/web/src/routes/routes.generated.json`; "implemented" comes from `apps/web/src/routes/screens/index.ts` (a registered
   screen module). A screen that has a route but no module is reported as pending (error under `--strict`, so the recording gate stays honest).
3. Shot items are derived (catalogue title and route, captions, figures, stamps, animatic description) so they cannot drift from the scenario;
   curated extras live in `scripts/clips/production/shots.json` (Vietnamese text in JSON only).
4. Figures are never written here: the checklist names the figure id and where it is read from at record time.
5. Wired into `npm run qa:check` (one `node` call, no stack needed).

## Steps

- [x] 1. Plan (this file) committed.
- [x] 2. Scenarios follow the merged catalogue and contract; `planned.json` shrinks to what is really missing. Test: `scenario.mjs check` stays ok.
- [x] 3. Chapter "province-committee" in the public clip (BAN-01..07, FEED-01..04), figures from the committee and feed reads; sentences over the TTS limit split; re-stamp.
- [x] 4. Production data: `scripts/clips/production/{rules,shots,music,readiness}.json` and the pure builder `scripts/clips/production.mjs`. Tests in `scripts/clips/production.test.mjs`.
- [x] 5. `scripts/clip-scripts-check.mjs` + `scripts/clip-scripts-check.test.mjs` (every check has a negative test), wired into `qa:check`.
- [x] 6. `docs/clips/<clip>.script.md` generated and kept in sync by the check; README of the clips updated.
- [ ] 7. Gates (scan, eslint, i18n, clips tests, qa:check), Codex review with gpt-6-astra, triage, fixes.

## Tests per step

- Step 2/3: `node scripts/clips/scenario.mjs check` (0 problems), `node --test scripts/clips/*.test.mjs`.
- Step 4/5: unit tests of every rule with a failing fixture: unknown screen, screen without route, durations that do not add up, an English-only sentence,
  a term missing from the phonetic table, a secret, a subtitle line over the limit, a sentence over the TTS limit, a scene without shots, a music cue gap,
  a seed group that is not in the dataset phases, a forbidden on-screen word in a caption.
- Step 6: the generated book equals the committed file.

## Risks

- No stack and no TTS are available: durations are estimates; the measured audio replaces them at record time. Stated in the book.
- Screens HPM-01, EBS-01 and their kin have routes but are not registered yet on this branch (another lane): reported as pending, not hidden.
- The seed groups `clip-public-alerts`, `clip-public-contracts`, `clip-public-feed`, `clip-public-directives`, `clip-ent-reports` were written but not run end to end
  (see `docs/clip-data.md`): the readiness file says so and the book marks the scenes that depend on them.
