# The ranking of the units of a comparison group (ST-DIS-013)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/DIS.md` (F8, BR-DIS-10, FX-DIS-007). Migration: `V1050__dis1_ranking.sql`. No screen and no operation: the read (`getDisbursementRankings`, `GET /home/rankings`) and the screens belong to the HOME stories; this story computes and keeps the ranking.

## What it does

When a close snapshot is frozen (`snapshot.frozen.v1`) the job `dis.ranking-compute` (`RankingComputeConsumer`, once per event through the inbox) calls `DisRankingStore.compute`:

- The units are the units of the lines of the snapshot (the unit captured when it was built); a comparison group is the type of the unit (`organization_unit.unit_type`: a department, a project management board, a commune), so a department is not ranked against a commune. Each group has two tables, one for each denominator: `PM_ASSIGNED` (the plan the Prime Minister gave) and `TOTAL_INCL_LOCAL` (that plan with the local addition). The numerator is what the Treasury paid, the same for both.
- The order is that of the kernel (`rankUnits`, BR-DIS-10): by rate from the highest, compared as fractions of whole dong and not as rounded percents; a tie goes to the larger disbursement, then to the code of the unit, so the order never depends on how the units were read. Positions are 1, 2, 3 without gaps.
- A unit that is left out has no position and no rate, and says why: `ZERO_DENOMINATOR` (no plan on that denominator, named first), `PLAN_BELOW_MINIMUM` (a plan below 1 billion dong, an assumption of the design), `NO_DATA` (the Treasury booked nothing for it, or its net is below zero: a rate is not a guess, and it is not negative). The units left out are kept in the table with their plan and disbursement.
- A ranking is computed once for a snapshot (`ALREADY_COMPUTED` otherwise), only for a frozen close snapshot, and is never changed or deleted (`disbursement_ranking_guard`): a correction is a newer snapshot with its own ranking. The audit row `dis.ranking_computed` has the counts and no amount.

## Assumptions

- The minimum plan of 1 billion dong, the comparison group as the unit type, and the Treasury figure as the numerator of both tables are proposals until D03 is signed; the first release ranks every group that has units, not one chosen group.
- A superseded snapshot keeps the ranking it had; the HOME read opens the ranking of the latest frozen close snapshot.
