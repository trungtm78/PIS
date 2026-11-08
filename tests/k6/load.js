import exec from 'k6/execution';
import { sleep as think } from 'k6';
import { hit, operations, thresholdsOf } from './budget-lib.js';

// The budget under concurrent users: VUS virtual users (default 20) call the operations of docs/qa/perf-budget.json in a
// random mix for DURATION (default 5m) after a one minute ramp. The thresholds are the same as for the single user run.
//
//   k6 run -e BASE_URL=https://host/v1 -e TOKEN=<jwt> -e VARS="$(cat vars.json)" -e VUS=50 -e DURATION=10m tests/k6/load.js
const vus = Number(__ENV.VUS || 20);

export const options = {
  scenarios: {
    mix: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '1m', target: vus },
        { duration: __ENV.DURATION || '5m', target: vus },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: thresholdsOf(operations),
};

export default function () {
  if (operations.length === 0) exec.test.abort('no operation to measure: give the variables of the table in VARS');
  hit(operations[Math.floor(Math.random() * operations.length)]);
  // Think time of a person between two screens.
  think(1 + Math.random() * 2);
}
