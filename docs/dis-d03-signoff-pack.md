# D03 sign-off pack: the definitions of the disbursement metrics and their golden numbers (ST-DIS-011)

For: the capital business owner (CXN-03, CXN-11). What is asked: to read the definitions and the seven cases below, say which numbers are right, and publish the five definitions in the business glossary (screen MDM-34); until then every snapshot, rate and export of DIS says that its definitions await the sign-off ("CHỜ KÝ D03").

The screen DIS-25 (`/dis/dis-25`) shows the same definitions and cases, read only. The cases live in `packages/contracts/src/dis-golden.ts`; the suite `apps/api/test/dis/golden.test.ts` computes each one with the formulas of the product and compares it with the numbers in that file, so this pack, the screen and the suite cannot drift apart (the suite checks this pack too).

## What signing means

- The five terms of the domain DISBURSEMENT (`GIAI_NGAN_PERIOD`, `GIAI_NGAN_YTD`, `GIAI_NGAN_PTD`, `MAU_SO_KH_TTG_GIAO`, `MAU_SO_KH_TONG`) are seeded IN_REVIEW and owned by the tenant owner. Approving and publishing them is done on the glossary by the owner of the domain (a person who is not the owner gets 403 `SCOPE_DENIED`; the person who proposed a term never approves it).
- A snapshot reads the glossary when it is built: `definition_status` is `SIGNED` only when all five are PUBLISHED, otherwise `PROPOSED_PENDING_SIGNOFF`. A snapshot already frozen keeps the status it was made with; a correction is a newer snapshot.
- The suite of the golden cases is labelled "[CHỜ KÝ D03]". It does not gate the sign-off, and it still fails the build when a proposed number moves.

## The formulas that are proposed

- Cumulative of a period (BR-DIS-02): the value of the current ACCEPTED report of the period, never the periods added. Change of the period (BR-DIS-03): that cumulative less the cumulative of the period before, same type and year; a fall is kept, not turned into zero.
- Year to date (BR-DIS-12): from the first day of the planning year to the end of the period; capital carried over from the first day of the extension; project to date: from the start of the works to the end of the period, every year.
- Disbursed (BR-DIS-06): what the Treasury paid on or before the cutoff, by the Vietnam day of payment; a refund takes off on the day of the refund. The Treasury is counted from 1 January of the fiscal year.
- Two rates (BR-DIS-05): the same numerator over the plan the Prime Minister gave (`PM_ASSIGNED`, with the capital carried over from it) and over that plan plus what the province, a ministry or a revenue increase added. The rate of a group is the sum of the numerators over the sum of the denominators (BR-DIS-04). With nothing to divide by the rate is null with its reason (BR-DIS-08).
- Ranking (BR-DIS-10): by rate from the highest, a tie to the larger disbursement, then the code; a unit with a plan below 1 billion dong or with none is left out with its reason.

## The cases

### FX-DIS-001: Six source cells add up to 420 million; the CTMTQG of 40 million is part of a cell and is not added

- Rule: BR-DIS-01. Test of the plan: UAT-AC240.
- Given: `{"cells":[{"bucket":"CURRENT_YEAR","budget_level":"CENTRAL","cumulative_vnd":"100000000","ctmtqg_subset_vnd":"40000000"},{"bucket":"CURRENT_YEAR","budget_level":"LOCAL","cumulative_vnd":"200000000"},{"bucket":"CARRYOVER","budget_level":"CENTRAL","cumulative_vnd":"30000000"},{"bucket":"CARRYOVER","budget_level":"LOCAL","cumulative_vnd":"70000000"},{"bucket":"OTHER","budget_level":"CENTRAL","cumulative_vnd":"0"},{"bucket":"OTHER","budget_level":"LOCAL","cumulative_vnd":"20000000"}]}`
- Expected: `{"total_vnd":"420000000","ctmtqg_vnd":"40000000"}`

### FX-DIS-002: The cumulative of week 40 is 150 million, not the 250 million of the two weeks added; the change of the period is 50 million

- Rule: BR-DIS-02, BR-DIS-03. Test of the plan: UAT-AC241.
- Given: `{"earlier_cumulative_vnd":"100000000","later_cumulative_vnd":"150000000"}`
- Expected: `{"cumulative_vnd":"150000000","delta_vnd":"50000000","not_the_sum_vnd":"250000000"}`

### FX-DIS-003: The rate of a unit is the sum of the numerators over the sum of the denominators: 50/100 and 90/900 million are 14%, not the mean of 50% and 10%

- Rule: BR-DIS-04. Test of the plan: UAT-AC242.
- Given: `{"projects":[{"numerator_vnd":"50000000","plan_pm_vnd":"100000000"},{"numerator_vnd":"90000000","plan_pm_vnd":"900000000"}]}`
- Expected: `{"unit_rate_pm_pct":"14.0000","project_rates_pm_pct":["50.0000","10.0000"]}`

### FX-DIS-004: One numerator of 600 million is 60% of the plan of 1 billion given by the Prime Minister and 48% of the plan of 1.25 billion with the local addition

- Rule: BR-DIS-05. Test of the plan: UAT-AC243.
- Given: `{"plan_pm_vnd":"1000000000","plan_local_vnd":"250000000","numerator_vnd":"600000000"}`
- Expected: `{"rate_pm_pct":"60.0000","rate_total_pct":"48.0000"}`

### FX-DIS-005: With the cutoff on 30 September the 500 million paid that day counts and the 300 million paid on 1 October does not

- Rule: BR-DIS-06. Test of the plan: UAT-AC244.
- Given: `{"cutoff":"2026-09-30","transactions":[{"id":"T1","amount_vnd":"500000000","paid_on":"2026-09-30"},{"id":"T2","amount_vnd":"300000000","paid_on":"2026-10-01"}]}`
- Expected: `{"disbursed_vnd":"500000000","excluded":["T2"]}`

### FX-DIS-006: A CTMTQG of 120 million inside a cell of 100 million is refused: the subset cannot pass its parent

- Rule: BR-DIS-07. Test of the plan: UAT-AC240.
- Given: `{"cell":{"bucket":"CURRENT_YEAR","budget_level":"CENTRAL","cumulative_vnd":"100000000","ctmtqg_subset_vnd":"120000000"}}`
- Expected: `{"code":"SUBSET_EXCEEDS_PARENT","status":422,"field":"funding_lines[0].ctmtqg_subset_vnd"}`

### FX-DIS-007: Three units are ranked by rate, a tie goes to the larger disbursement, and the unit with a plan below the minimum is left out with its reason

- Rule: BR-DIS-10. Test of the plan: UAT-AC254.
- Given: `{"minimum_plan_vnd":"1000000000","units":[{"code":"U-A","plan_vnd":"2000000000","disbursed_vnd":"1200000000"},{"code":"U-B","plan_vnd":"1000000000","disbursed_vnd":"600000000"},{"code":"U-C","plan_vnd":"500000000","disbursed_vnd":"400000000"}]}`
- Expected: `{"ranked":[{"rank":1,"code":"U-A","rate_pct":"60.0000"},{"rank":2,"code":"U-B","rate_pct":"60.0000"}],"excluded":[{"code":"U-C","reason":"PLAN_BELOW_MINIMUM"}]}`

## Questions that are open

1. Which origins enter the plan of the Prime Minister and which the local addition (`CENTRAL_SUPPORT`, `REVENUE_INCREASE` are counted as local here).
2. The tolerance between the Treasury and the report that makes the coverage PARTIAL (5% here).
3. Whether the Treasury is counted from 1 January of the fiscal year for the year plan, and from when for the capital carried over.
4. The minimum plan of a ranked unit (1 billion dong here) and the groups that are compared.
5. Whether DIS-12 groups by the unit that owns the project (as the snapshot captured it) or by the investor.
