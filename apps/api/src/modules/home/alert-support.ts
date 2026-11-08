import { scopePredicate } from '@machvon/db';
import type { AlertRuleReading, ScopeBuilder, TenantTx } from '@machvon/db';
import { DomainError, activeGrants, permissionMatches } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';

/** The permissions of the governance of the alert system: reading its health, the monitor of escalations and the coverage report; and managing the covers of other people. Everybody with `home.read` acts on their own alerts. */
export const ALERT_HEALTH_PERMISSION = 'home.alert.health.read';
export const ALERT_COVER_PERMISSION = 'home.alert.cover.manage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
export const notFound = (field = 'id'): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404, field);
export const denied = (): DomainError => new DomainError('SCOPE_DENIED', 403);

/** An id from the path or the query: a value that is not an id names nothing (404 for a path, 422 for a field of a body). */
export const pathId = (value: string): string => {
  if (!UUID.test(value)) throw notFound();
  return value.toLowerCase();
};

export const bodyId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

/** The units the reader may read under a permission, as the predicate the unit joins (alias `u`) are compiled over. */
export const unitScopeOf =
  (access: EffectiveAccess, permission: string, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, permission, now, { unitPath: 'u.path', unitId: 'u.id' }, first);

/** The reader holds a grant that carries the permission somewhere. */
export const holdsPermission = (access: EffectiveAccess, now: Date, permission: string): boolean => activeGrants(access, now).some((grant) => grant.permissions.some((held) => permissionMatches(held, permission)));

/** Whether the unit a person works in lies in what the reader may read under a permission. */
export async function reaches(tx: TenantTx, access: EffectiveAccess, now: Date, permission: string, membershipId: string): Promise<boolean> {
  const scope = unitScopeOf(access, permission, now)(2);
  const rows = await tx.query<{ found: boolean }>(
    `select exists (select 1 from machvon.membership m join machvon.organization_unit u on u.tenant_id = m.tenant_id and u.id = m.organization_id where m.id = $1::uuid and ${scope.sql}) as found`,
    [membershipId, ...scope.params],
  );
  return rows[0]?.found === true;
}

/** The names of some units and some people, for the tables the screens show. */
export async function unitNames(tx: TenantTx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.query<{ id: string; name: string }>('select id, name from machvon.organization_unit where id = any($1::uuid[])', [wanted]);
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function personNames(tx: TenantTx, ids: readonly (string | null)[]): Promise<Map<string, string | null>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.query<{ membership_id: string; display_name: string | null }>('select membership_id, display_name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [wanted]);
  return new Map(rows.map((row) => [row.membership_id, row.display_name]));
}

/** The rule as the contract says it (`AlertRuleInfo`). */
export const ruleView = (rule: AlertRuleReading): Record<string, unknown> => ({ code: rule.code, version: rule.version, unverified: rule.unverified, formula: rule.formula, source: rule.source, as_of: rule.asOf, params: rule.params });

export const person = (id: string | null, names: ReadonlyMap<string, string | null>): { id: string; name: string | null } | null => (id === null ? null : { id, name: names.get(id) ?? null });
