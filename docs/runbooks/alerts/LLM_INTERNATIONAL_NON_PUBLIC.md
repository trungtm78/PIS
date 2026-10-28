# LLM_INTERNATIONAL_NON_PUBLIC

**Owner:** security-oncall · **Severity:** critical · **Rule:** `alerts/rules/LLM_INTERNATIONAL_NON_PUBLIC.json`

## What it means

The AI gateway reached the step that calls a model over the international route with a request whose class is above public. The route is never called (the gateway skips it and the database refuses the attempt), so no data left; the counter says the route plan or the policy let such a route through, which must not happen.

## What to do

1. Read `llm_international_non_public_total{tenant_id}` and find the requests of the tenant in LLM-05 (`/ai/requests`, `route_class` empty or `INTERNATIONAL`, class above public) around the time of the alert.
2. Open the route decision of the request (LLM-05): the class, the sources it came from and the policy version in force.
3. Check the policy in force (LLM-19) and the profile (LLM-04): the international route must be on only for public data, with the approval of D07. Fix the policy or the profile; the plan of the route (`planRoute`) holds the same rule and a failing case there is a defect to report.
4. Nothing was sent: no notification to the data owner is needed unless an attempt row on the international route exists for the request (it cannot, the database refuses it).
