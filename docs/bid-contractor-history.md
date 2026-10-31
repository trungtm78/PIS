# The history of a contractor for the evaluators (ST-BID-013)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/BID.md` (3.1 F2, F9, BR-BID-01, BID-14, BID-21, UAT-AC451, UAT-AC446). No migration. Operation: `getContractorHistory` (`GET /contractors/{id}/history`, `bid.contractor.read`).

## The rule

BID keeps **no scorecard of its own**. The history of a contractor is read from the tables of CTR:

- **Scorecards.** Only the evaluations (`contractor_performance`) with status `APPROVED` count: a draft, a submitted one (CP-8 in UAT-AC451) and one replaced by a newer revision (`SUPERSEDED`) are not history. They are those of the contracts the caller reads (the scope of `contractor.performance.read`, as on CTR-23); the latest approval comes first and the average is the one CTR computes over the approved evaluations that stand, two decimals, null when there is none.
- **Contracts.** The contracts of the contractor that the caller reads, with their status; BID-14 links each to its workspace on CTR.
- **Restrictions.** All the restrictions on the contractor (`contractor_restriction`), the latest start first, with their kind, source (`NATIONAL_E_PROCUREMENT_IMPORT` or `DECISION`), first day, last day (included) and `in_force`: the restriction applies today in Vietnamese time. `restriction_in_force` says whether one does. The decision and the note stay with the register of contractors (BID-02), which hides them from those who do not hold the full right.

A contractor that does not exist in the tenant is 404. A contractor the caller reads no contract of has a history with no scorecard and no contract, and its restrictions. A guest contractor reads none of it (403 `SCOPE_DENIED`); a caller without `bid.contractor.read` is 403. The read is one snapshot.

A restriction in force blocks a proposal and a result with 422 `CONTRACTOR_RESTRICTED` (ST-BID-004, ST-BID-006, BR-BID-01); BID-21 says so above the list.

## The screens

- **BID-21** `RestrictionsScreen`: the restrictions of a contractor with kind, source, validity in words (in force, ended, not yet in force; never colour alone), and a notice when one is in force.
- **BID-14** `ContractLinksScreen`: the contracts of the contractor (code linked to the workspace of the contract, status in words) and the approved scorecards (contract, period, kind, score, rating, approval day) with the average.

Both choose the contractor from the register or by its identifier (also `?contractor=` in the address): the register of contractors and the scorecards have scopes of their own, so the identifier is always offered.

## What is not done

- The evidence `SCORECARD` of a finding of the analysis of the criteria of experience (AC-ST-BID-013-1, second half) belongs to the pipeline of analysis (ST-BID-009), which is not built; the history read here is what it will use.
- The consumer of `ctr.contractor_evaluation.approved.v1` that refreshes a cache of the history: the read goes to CTR every time, so there is no cache to refresh.
- BID-14 shows the contracts and the scorecards; the value, the progress and the appendices of a contract are on CTR.
