import exec from 'k6/execution';
import { hit, operations, thresholdsOf } from './budget-lib.js';

// The budget check as k6 runs it: every operation of docs/qa/perf-budget.json is called SAMPLES times (default 20), one request
// at a time, and k6 fails the run when the p95 of an operation is over the budget of its class (5 s a function, 20 s a report).
//
//   k6 run -e BASE_URL=https://host/v1 -e TOKEN=<jwt> -e VARS="$(cat vars.json)" [-e ONLY=REPORT] [-e SAMPLES=20] tests/k6/budget.js
//
// scripts/perf-budget.mjs does the same without k6; use either one.
const samples = Number(__ENV.SAMPLES || 20);

export const options = {
  scenarios: {
    budget: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: Math.max(1, operations.length) * samples,
      maxDuration: '2h',
    },
  },
  thresholds: thresholdsOf(operations),
};

export default function () {
  if (operations.length === 0) exec.test.abort('no operation to measure: give the variables of the table in VARS');
  // Round robin: the first pass visits every operation once, so the operations share the warm up of the server fairly.
  hit(operations[exec.scenario.iterationInTest % operations.length]);
}
