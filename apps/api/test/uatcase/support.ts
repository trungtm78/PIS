import { TENANT_A, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { MAX_SLOWDOWN, budgetFor, median, p95Of } from '../../../../packages/db/test/support/perf-budget';
import { callerOf } from '../uat/uat-kit';
import type { CallOptions, Reply } from '../uat/uat-kit';
import { ROOT_UNIT } from '../uat/uat-world';
import type { UatWorld } from '../uat/uat-world';

/**
 * What the suites of `apps/api/test/uatcase` add to the UAT harness (`../uat/uat-world.ts`): a member whose role is granted on one unit only, which the persona table of the world (one role over the whole tenant)
 * cannot make. The member is written in the seed step of the world, before the application starts, and is called through the same caller the world uses.
 */
export interface ScopedMember {
  /** The membership number of the member in tenant A (above the numbers of the persona table). */
  n: number;
  permissions: readonly string[];
  kind: 'UNIT_ONLY' | 'UNIT_SUBTREE';
  /** The unit numbers the grant is on. */
  units: readonly number[];
}

/** Writes the members (membership, role and one grant each) of tenant A. Call it inside the `seed` step of `UatWorld.start`. */
export async function seedScopedMembers(world: UatWorld, members: readonly ScopedMember[]): Promise<void> {
  for (const member of members) {
    await world.harness.seedMembership(TENANT_A, member.n, ROOT_UNIT);
    await world.harness.seedRole(TENANT_A, member.n, `SCOPED_${member.n}`, member.permissions, 10 + (member.n % 80));
    await world.harness.seedGrants(TENANT_A, [{ n: member.n, member: member.n, role: member.n, kind: member.kind, refs: member.units.map((unit) => unitId(unit)) }]);
  }
}

/**
 * How long the calibration workload of `machineMs` takes on the reference machine, in milliseconds (the median of five runs on an idle development machine, 359 ms on 2026-11-12, the constant of
 * `apps/api/test/dis/snapshot.test.ts`). The budget of a measured read is stated for that machine and stretched by how much slower this one measured (`packages/db/test/support/perf-budget.ts`).
 */
export const REFERENCE_MACHINE_MS = 360;

/** The speed of this machine now: the median of five runs of a count over generated rows, which touches nothing of what is under test, so a slower read is not excused by it. */
export async function machineMs(world: UatWorld): Promise<number> {
  const timings: number[] = [];
  for (let run = 0; run <= 5; run += 1) {
    const started = performance.now();
    await world.rows('select count(*)::int as n from generate_series(1, 3000000)');
    if (run > 0) timings.push(performance.now() - started);
  }
  return median(timings);
}

export interface Measured {
  /** The p95 of the samples, in milliseconds. */
  p95Ms: number;
  /** The budget the p95 is held to: the reference budget stretched by the measured speed of the machine. */
  budgetMs: number;
  /** How many calls were answered with something other than 200. */
  failures: number;
}

/**
 * Calls `call` `warmups` times without counting it and `samples` times counting it, and says the p95 against the budget of the reference machine stretched by the speed measured before and after the samples (the slower of the
 * two). A machine more than five times slower than the reference is not judged: the run fails and says so, because the result would say more about the machine than about the code.
 */
export async function measureP95(world: UatWorld, call: () => Promise<Reply>, referenceBudgetMs: number, warmups = 3, samples = 20): Promise<Measured> {
  const before = await machineMs(world);
  for (let run = 0; run < warmups; run += 1) await call();
  const durations: number[] = [];
  let failures = 0;
  for (let run = 0; run < samples; run += 1) {
    const started = performance.now();
    const reply = await call();
    durations.push(performance.now() - started);
    if (reply.status !== 200) failures += 1;
  }
  const decision = budgetFor(Math.max(before, await machineMs(world)), REFERENCE_MACHINE_MS, referenceBudgetMs);
  if (decision.tooSlow) throw new Error(`this machine is more than ${MAX_SLOWDOWN} times slower than the reference machine: the p95 is not judged`);
  return { p95Ms: p95Of(durations), budgetMs: decision.budgetMs, failures };
}

/** The verdict of a measurement: no failed call and a p95 within the budget. Throws on anything else, so a negative control can feed it a measurement that is over. */
export function assertWithinBudget(measured: Measured): void {
  if (measured.failures > 0) throw new Error(`${measured.failures} calls did not answer 200`);
  if (measured.p95Ms > measured.budgetMs) throw new Error(`the p95 of ${Math.round(measured.p95Ms)} ms is over the budget of ${Math.round(measured.budgetMs)} ms`);
}

/** A request as a scoped member of tenant A makes it. */
export function scopedCaller(world: UatWorld): (member: number, method: string, url: string, options?: Omit<CallOptions, 'member'>) => Promise<Reply> {
  const call = callerOf(() => world.app.baseUrl, world.signingKey);
  return (member, method, url, options = {}) => call(method, url, { ...options, member });
}
