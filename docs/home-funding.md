# Funding structure (ST-HOME-005)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/HOME.md` (F6). **No table, no migration, no new operation**: HOME keeps nothing of the capital. The two screens (HOME-07 the cards, HOME-08 the detail) read the register of CAP, `listAppropriations` (`capital.read`), and, for the part that is CTMTQG, the allocation lines, `get_resources_allocation_line` (`allocation_line.read`). The grouping is in `apps/web/src/screens/home/funding-model.ts`.

## What is counted

Only an appropriation that is **published**, of the year on the screen. A draft, one that waits for approval, a rejected one and one that a revision replaced are not capital yet (or any more). The total is the sum of the appropriations that are not a part of another source; the cards of the sources (NSTW, NSĐP, ODA, and the others when there is any) add up to it, and so do the cards of the origins (assigned by the Prime Minister, added by the province, carried over, support, the NSTW revenue increase), because each appropriation is in exactly one card of each group.

## CTMTQG is a part, never an addition

CTMTQG is inside NSTW. The register refuses to register it as an appropriation of its own (`SUBSET_SOURCE_NOT_ADDITIVE`): the part is kept on the **allocation lines** of the capital plan (`ctmtqg_subset_vnd`, already inside the amount of the line). So:

- the NSTW card says "of which CTMTQG x", the sum of that column over the allocation lines of the **published** plans that draw on its appropriations (the lines are grouped by the appropriation they name, so several plans, and the revisions of a plan, are all counted once, and the optional `capital_plan_id` of the register is not used); the figure is in no total;
- HOME-08 shows it as a row under the appropriation it is inside, with the inclusion relation **"Tập con của NSTW"** and the same cut-off, and the total row adds only the rows that are not subsets;
- a fund source that the register would mark as a subset of another (`relation = SUBSET_OF`, or the category CTMTQG) is shown the same way and is added to nothing.

## "No data" is not zero

A card with nothing published says **"Chưa có dữ liệu"**. The part that is CTMTQG is known when the allocation lines were read; when they could not be read (a reader who may not read them, a failed read) it has no figure, and the card says so (when a CTMTQG source is registered as a part its amount is shown and the figure says it holds only what was read, `partial`). Lines that were read and none of which draws on the appropriation are a known zero. A failure to read the lines never fails the screen, which still has the capital that was published.

## The screens

- **HOME-07**: the year (the years that have capital published, the newest first, kept in the address as `?year=`), the total, the cards by source and by origin, each with the amount in billions of dong (to two decimals, **never rounded up**, so a card never says more than was published) and the exact dong beside it, and the link to HOME-08 on the same year. Seven states.
- **HOME-08**: the table of the appropriations of the year with the columns *Nguồn vốn*, *Nhóm nguồn*, *Nguồn gốc giao*, *Số tiền*, *Quan hệ bao hàm* and *Thời điểm chốt*, the total of what is added, and the words that say what was counted (the scope of the calculation). Seven states.

## Assumptions and limits

- The story has no operation of its own in the contract (`Read-only over v_home_funding_structure`, and the view is not in the schema): the screens read CAP through the web, so the reader needs `capital.read` (and `allocation_line.read` for the CTMTQG part) as well as the right to open HOME; without it the screen says *denied*. A HOME operation with the figures already grouped (and the scope of the reader applied) is a later change of the contract.
- The cut-off (*Thời điểm chốt*) is the day the decision that gave the capital was issued, the only date the register exposes; the register does not say when a revision was published.
- The lines a reader may read are the ones the plan scope of their `allocation_line.read` allows: the part is the part of the lines they see.
- The register and the lines are read in full (every page), once for all the years.
