# BID_PETITION_OVERDUE

**Owner:** procurement-office · **Severity:** warning · **Rule:** `alerts/rules/BID_PETITION_OVERDUE.json`

## What it means

The job `petition-due` (every hour, `docs/runbooks/jobs.md`) looks at the petitions of contractors that wait for an answer (RECEIVED or PROCESSING). The gauge `bid_petition_overdue` is the number, over all tenants, of those whose last day to answer (`due_on`, counted by the rule data `BID_PETITION` in force on the day the petition was received) has passed. The first pass that finds a petition overdue sends one reminder (`bid.petition.overdue.v1`) to the people who handle the petitions of its package and writes the audit row `petition.overdue`.

An overdue petition is a legal exposure of the procuring entity: the deadline to answer is a statutory one (BR-BID-14, CXN-BID-02).

## What to do

1. Open BID-20 for the package: the petition is shown overdue with the days past its last day.
2. Answer it, or pass it on to the level above, with a document (`resolveProcurementPetition`). Whoever has a conflict of interest with the contractor or the package cannot answer it: a different person does.
3. If the reminder did not reach anyone, check the notification workflow of `bid.petition.overdue` and the roles that hold `procurement_package.read` over the project.
4. If the job is not running, see `docs/runbooks/jobs.md` and the alert `JOB_FAILED`; the next pass counts every overdue petition again. Do not edit `procurement_petition` in the database: the guard trigger refuses it.
