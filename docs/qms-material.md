# The testing of materials and the non-conformance a failed test raises (ST-QMS-007, QMS 3.3, UC-QMS-03, QMS-06, UAT-AC362)

A supervisor registers the samples taken on a contract being performed. The laboratory's result is recorded once, with its day, its values and its report. A result that failed raises a non-conformance by itself, from the test, and the test keeps it; a result that passed raises none.

## The commands

| Command | Route | Right (over the contract) | Body |
|---|---|---|---|
| `registerMaterialTest` | `POST /material-tests` | `material.manage` | contract, bill item (optional), sample code, material, laboratory, standard, day sampled |
| `recordMaterialTestResult` | `POST /material-tests/{id}/result` (If-Match) | `material.record` | `PASS` or `FAIL`, day tested, values (an object), the report (a version of a file) |

A test is read in the scope of the permission: 404 if it cannot be read at all, 403 `SCOPE_DENIED` if it is read but not served. The right to read the tests is `material.manage`, so a member who holds only the right to record sees the tests it is shown through the contract it holds.

| Rule | Answer |
|---|---|
| the contract is being performed (`ACTIVE`) | else 409 `CONTRACT_STATE_INVALID`, for registering and for recording |
| the bill item, when given, is one of the contract | else 422 `VALIDATION_FAILED` (reason `NOT_IN_CONTRACT`) |
| the sample code is new in the contract (`material_test_sample_uq`) | else 409 `SAMPLE_CODE_DUPLICATE`, and nothing is written |
| the words of the sample are 1 to 200 characters; the day sampled is a real day, not in the future | else 422 `VALIDATION_FAILED` (reason `IN_THE_FUTURE` for the day) |
| the version the caller saw is the version of the test | else 409 `VERSION_CONFLICT` |
| the test is only registered: the result is written once | else 409 `MATERIAL_TEST_STATE_INVALID` with the status |
| the day tested is not before the day sampled and not in the future | else 422 `VALIDATION_FAILED` (reasons `BEFORE_SAMPLE`, `IN_THE_FUTURE`) |
| the values are an object of at most 64 KB; the report is a clean version of a file of the tenant | else 422 `VALIDATION_FAILED` or `DOCUMENT_NOT_CLEAN` |
| a result with no report is not recorded: the report is required by the shape of the request, and by `material_test_result_chk` in the database | else 400/422 (`INVALID_REQUEST`), the test is unchanged and no non-conformance is raised |

A failed result raises, in the same transaction, one non-conformance of the test (`QmsNonconformanceStore.raiseFromMaterialTest`): source `MATERIAL_TEST`, number after the ones of the contract, **major** (it does not hold back the acceptance), answered for by the person who took the sample (the person who records the result if the first has left), due fourteen days after it is raised. The seriousness and the term are [ASSUMPTIONS]: the specification says only that the seriousness follows a rule and states none, so they are two constants of the kernel (`FAILED_TEST_SEVERITY`, `FAILED_TEST_ACTION_DAYS`). The trail of the test (`material_test.registered`, `.result_recorded`) and its events (`qms.material_test.registered.v1`, `.result_recorded.v1`) carry ids, the sample code, the result and the days, never the values of the laboratory; the non-conformance has its own trail (`nonconformance.raised`, reason `material_test_failed`) and `qms.ncr.raised.v1`, which ISS and CTR watch for.

## The table (V1466)

`material_test` (V002) gains the words of the sample, the order of the days, that the values are an object, that a failed result names the non-conformance it raised and a passed one names none, and who took the sample; a guard keeps what a test says, lets the status move `REGISTERED` to `RESULT_RECORDED` to `ACCEPTED` or `REJECTED` only, and writes the result once. Nothing is deleted by the application.

## The read and the screen

`listMaterialTests` `GET /material-tests?contract_id&status&result` (`material.manage`, newest first, with the result, the report, the non-conformance and `allowed.record`) was added because QMS-06 has to show the tests and the contract had no way to read them; `listMaterialContracts` `GET /material-tests/contracts` (`material.manage`) lists the contracts being performed that the caller can register a sample on, so that the form does not depend on the right to read contracts. **QMS-06** `MaterialScreen` (`/qms/qms-06?contract=<id>`) is a table of the samples with a form to register one (the contracts being performed) and a form to record a result: the dialog says that a failed result raises a non-conformance. The forms check what the server will check; every refusal of the server is told in words; a tenant that is read-only is offered neither a sample nor a result; the table is read again after a refusal as well as after a success, and a dialog names the test, not a copy of it, so a retry after a conflict sends the version the table shows now and the dialog goes once the test has its result.

## Gaps and decisions

- `ACCEPTED` and `REJECTED` are statuses of the table and its guard; no command in the contract reaches them.
- The report and the file are typed as a code; there is no picker of files, and no list of the bill items in the screen (a sample is registered against the contract).
- A result is recorded only while the contract is being performed.
