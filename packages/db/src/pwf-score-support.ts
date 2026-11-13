import { createHash } from 'node:crypto';
import { DomainError, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { scopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the stores of the scores of staff share (PWF-3, R33). The score of a person is shown by the database itself only to the person, to the units whose manager asks and to the whole tenant when the human
 * resources ask (the policy `scope_units_guard` of V3032 reads `app.scope_units` and `app.score_subject`): `enterScoreScope` puts those two into the transaction, and until it does the tables show nothing and refuse
 * every write. The application judges the permission and the unit first; the policy is the second wall.
 */

export const STAFF_SCORE_PERIOD_RESOURCE = 'staff_score_period';
export const STAFF_SCORE_LINE_RESOURCE = 'staff_score_line';
export const STAFF_SCORE_ADJUSTMENT_RESOURCE = 'staff_score_adjustment';
export const STAFF_SCORE_RESPONSE_RESOURCE = 'staff_score_response';

/** `*` is the whole tenant; otherwise the ids of the units, comma separated; empty reads nothing through the units. */
export type ScoreUnits = string;

export interface ScoreScope {
  units: ScoreUnits;
  /** The membership the caller is, for the rows about themselves; empty reads nothing through the subject. */
  subject: string;
}

/** The caller with no reach at all: every table of scores answers nothing. */
export const NO_SCORE_SCOPE: ScoreScope = { units: '', subject: '' };
/** The system itself (the computation of a period, the job of the retention): the whole tenant, nobody in particular. */
export const SYSTEM_SCORE_SCOPE: ScoreScope = { units: '*', subject: '' };

/** Puts the reach of the caller into the transaction for the policy of the tables of scores; it holds until the transaction ends or the next call. */
export async function enterScoreScope(tx: TenantTx, scope: ScoreScope): Promise<void> {
  await tx.query("select set_config('app.scope_units', $1, true), set_config('app.score_subject', $2, true)", [scope.units, scope.subject]);
}

/** Runs `work` with `scope`, then puts back the reach the transaction had: a read for one purpose never widens the next. */
export async function withScoreScope<T>(tx: TenantTx, scope: ScoreScope, work: () => Promise<T>): Promise<T> {
  const previous = (await tx.query<{ units: string | null; subject: string | null }>("select current_setting('app.scope_units', true) as units, current_setting('app.score_subject', true) as subject"))[0];
  await enterScoreScope(tx, scope);
  // A failure leaves the transaction to roll back (its settings go with it): the reach is put back only after work that succeeded, so that the failure is the one the caller sees.
  const done = await work();
  await enterScoreScope(tx, { units: previous?.units ?? '', subject: previous?.subject ?? '' });
  return done;
}

/**
 * The units a caller may reach through the permissions given: `*` when a grant that carries one of them covers the whole tenant, otherwise the ids of every unit its grants reach (a unit tree or a single unit; a
 * grant on a project or a contract reaches no unit), and nothing when it has none. The same value goes into `app.scope_units`.
 */
export async function scoreUnitsOf(tx: TenantTx, access: EffectiveAccess, permissions: readonly string[], now: Date): Promise<ScoreUnits> {
  const ids = new Set<string>();
  for (const permission of permissions) {
    const predicate = scopePredicate(access, permission, now, { unitPath: 'u.path', unitId: 'u.id' }, 1);
    if (predicate.sql === 'true') return '*';
    if (predicate.sql === 'false') continue;
    const rows = await tx.query<{ id: string }>(`select u.id from machvon.organization_unit u where ${predicate.sql} order by u.id`, predicate.params);
    for (const row of rows) ids.add(row.id);
  }
  return [...ids].sort().join(',');
}

/** Whether the unit is among the units. */
export const unitReached = (units: ScoreUnits, unitId: string): boolean => units === '*' || units.split(',').includes(unitId);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const scoreIdOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.toLowerCase();
};

export const notFound = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

/** The lock of one period: a lock of the period, a draft computed again, an adjustment and an official turn of the period wait for each other, so that none of them reads what another half did (R34). */
export async function lockPeriod(tx: TenantTx, periodId: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('staff-score:' || coalesce(current_setting('app.tenant_id', true), '') || ':' || $1, 0))", [periodId]);
}

/** The lock of a unit and the days of a period that is not made yet: two computations of the same period wait for each other. */
export async function lockPeriodKey(tx: TenantTx, unitId: string, from: string, to: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('staff-score-key:' || coalesce(current_setting('app.tenant_id', true), '') || ':' || $1 || ':' || $2 || ':' || $3, 0))", [unitId, from, to]);
}

export const checkVersion = (held: number, expected: number): void => {
  if (held !== expected) throw versionConflict(held);
};

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** `numeric` columns come back as text: the figures of a score have at most two decimals, read as numbers. */
export const numberOf = (value: string | null): number | null => (value === null ? null : Number(value));
