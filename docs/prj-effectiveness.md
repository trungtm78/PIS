# Post-investment effectiveness (MR.03 merged with G4-7, screen MNE-11)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/MNE.md`. Migrations `V2481__mr1_effect_target.sql` and `V2482__mr1_effect_measurement.sql`. Story ST-MNE-014. Operations: `getProjectEffectiveness` (`project.read`), `saveEffectTargetDraft` (`effect.target.manage`), `fixEffectTargets` (`effect.target.approve`), `recordEffectMeasurement` (`effect.measure`), `generateEffectCalendar` (`effect.calendar.manage`), `submitEffectAssessment` (`effect.assess`), `decideEffectAssessment` (`effect.assess.decide`). Error codes 409 `EFFECT_TARGET_STATE_INVALID`, `EFFECT_TARGETS_NOT_FIXED`, `EFFECT_MEASUREMENT_DUPLICATE`, `EFFECT_ASSESSMENT_STATE_INVALID`.

## Targets fixed at approval

The target indicators of a project are one set. A person drafts it (code, name, unit, direction HIGHER_IS_BETTER or LOWER_IS_BETTER, baseline with its day, target, months after commissioning, where the actual comes from, how it is computed); only its author rewrites the draft. Someone else fixes it (403 `SELF_APPROVAL_DENIED` for the author) in a status the rule `EFFECT_POLICY` names (the investment is approved). Once FIXED the set and its indicators never change in the database; a change is a new draft that names the set it replaces and why, and fixing it marks the old set SUPERSEDED, so the numbers the project was approved on stay on record.

## Actuals

After the commissioning (statuses COMPLETED, SETTLED, CLOSED by the rule) a person records the actual value of an indicator on a day, with how it was taken and optionally an evidence document. The table is append-only: the same indicator on the same day is 409 `EFFECT_MEASUREMENT_DUPLICATE`; a wrong value is corrected by a later row that names it and gives a reason (10 to 2000 characters). The latest uncorrected measurement of an indicator is the actual.

## Variance (kernel `computeVariance`, exact decimals, no float)

Variance = actual minus target; variance percent = variance over the absolute target; achievement = (actual - baseline) / (target - baseline) x 100 when there is a baseline (it reads the same for both directions), else actual / target (target / actual when lower is better). Band: MET from `met_at_pct`, PARTIAL from `partly_at_pct`, else MISSED, NOT_MEASURED without an actual. When baseline equals target the direction alone decides. The thresholds are the rule `EFFECT_POLICY`, flagged not verified (source, as-of day); every figure has its "i" on the screen.

## The calendar (Articles 76 and 77, flagged not verified)

The rule `EFFECT_EVALUATION_CALENDAR`, one code for each project group (`GROUP_QTQG`, `GROUP_A`, `GROUP_B`, `GROUP_C`), lists the evaluations (INITIAL, MIDTERM, FINAL, IMPACT) with an anchor (IMPLEMENTATION_START, COMPLETION, HANDOVER) and the months from it. The starting values (national important and group A four evaluations, groups B and C the final and the impact) are marked unverified against Law 58/2024/QH15 Articles 76 and 77 and need the business owner. `generateEffectCalendar` makes the entries once from the stage history and the earliest accepted handover (calling it again makes none that exist; an entry whose anchor day is not known is returned as waiting) and records the rule code and version on each entry. The state of an entry (done, overdue, due soon within 30 days, upcoming) is computed on the day.

## The assessment record

`submitEffectAssessment` freezes the variance of every indicator on the day with a conclusion (SATISFACTORY, PARTIALLY_SATISFACTORY, UNSATISFACTORY) and a summary; FINAL and IMPACT need at least one measured indicator; a kind with an assessment waiting or an approved one is not submitted again (409 `EFFECT_ASSESSMENT_STATE_INVALID`). `decideEffectAssessment` approves or returns it (a return needs a reason) by someone other than the submitter; an approval closes the calendar entry of its kind.

## Hooks left

- No alert is raised for an overdue evaluation yet (state is computed for the screen); an `ALERT_TYPE` and a source for the alert centre can be added when GOV-12 builds the evaluation calendar of the report lane.
- A link from an approved assessment to an `mne_evaluation` record is not made: the two records answer different questions (indicator variance against the MNE-09 narrative evaluation).
