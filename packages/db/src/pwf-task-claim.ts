import type { pwfTable } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * Who may take a task for a unit that receives it, and what the reads say of such a task (PWF-5, docs PWF 22.3 R71). One rule serves the command "Nhận việc", the button `can_claim` of the detail of a task and the people the
 * alert `PWF_TASK_UNCLAIMED` is for, and it is judged by the database on the rows as they are when it is asked (a grant that was revoked a moment ago no longer counts, whatever a cache still says):
 *
 *  - a person is of a unit when they hold a grant in force whose scope is that very unit (`UNIT_ONLY`) or a subtree that contains it (`UNIT_SUBTREE`). A grant over the whole tenant makes nobody a member of a unit: every
 *    person of the staff holds one (`STAFF_MEMBER`), so it would make everyone a member of every unit;
 *  - a person holds the role of a line of the task when such a grant is a grant of the role whose code the line names (the roles of a template are codes of the roles of the tenant, `role_definition.code`). The role must be held
 *    AT the unit: the same grant gives the unit and the role, so a role held somewhere else, or over the whole tenant, takes no task of this unit.
 */

export const CLAIM_LEAD_REASON = 'Claimed for the unit that receives the task';
export const CLAIM_SUPPORT_REASON = 'Claimed for a unit that supports the task';

export interface UnitGrantSql {
  /** The membership asked about (a typed parameter or a column). */
  me: string;
  /** The instant the grant must be in force at (a typed parameter). */
  at: string;
  /** The tenant, the id and the path of the unit (columns of its row). */
  tenant: string;
  unitId: string;
  unitPath: string;
  /** The code of the role the grant must be of; absent: any role (being of the unit). */
  role?: string;
}

/** A grant in force of the person, of a member in force, whose scope is the unit or a subtree that contains it (never the whole tenant), and of the role when one is asked for. */
export const unitGrantSql = (one: UnitGrantSql): string => `exists (select 1 from machvon.role_grant g
      join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id and r.status = 'Active'
      join machvon.membership m on m.tenant_id = g.tenant_id and m.id = g.membership_id
     where g.tenant_id = ${one.tenant} and g.membership_id = ${one.me} and g.status = 'Active' and g.effective_from <= ${one.at} and (g.effective_until is null or g.effective_until > ${one.at})
       and m.status = 'Active' and m.valid_from <= ${one.at} and (m.valid_until is null or m.valid_until > ${one.at})
       and ((g.scope_kind = 'UNIT_ONLY' and ${one.unitId} = any(g.scope_ref_ids))
            or (g.scope_kind = 'UNIT_SUBTREE' and exists (select 1 from machvon.organization_unit root where root.tenant_id = g.tenant_id and root.id = any(g.scope_ref_ids) and starts_with(${one.unitPath}, root.path))))
       ${one.role === undefined ? '' : `and r.code = ${one.role}`})`;

/** Somebody is responsible for the task of the alias today, by the ledger of assignments. */
export const responsibleHeldSql = (alias: string, today: string): string =>
  `exists (select 1 from machvon.project_task_assignment ra where ra.tenant_id = ${alias}.tenant_id and ra.task_id = ${alias}.id and ra.role = 'RESPONSIBLE' and ra.valid_from <= ${today}::date and (ra.valid_to is null or ra.valid_to >= ${today}::date))`;

/** A unit receives the task of the alias, the task is still open and in the project, and nobody is responsible for it today: "Chưa có người nhận". */
export const unclaimedSql = (alias: string, today: string): string =>
  `(${alias}.receiving_unit_id is not null and not ${alias}.excluded and ${alias}.status not in ('DONE', 'CANCELLED') and not ${responsibleHeldSql(alias, today)})`;

/** The columns of `project_task` that say which units receive it (R61). */
export interface TaskReceivingColumns {
  receiving_unit_id: string | null;
  receiving_units: pwfTable.ReceivingUnit[] | null;
}
export const receivingColumnsOf = (alias: string): string => `${alias}.receiving_unit_id, ${alias}.receiving_units`;

export interface ReceivingUnitView {
  unit_ref: string;
  unit_id: string;
  unit_name: string | null;
  role: string;
  part: 'LEAD' | 'SUPPORT';
}

/** The contract fields of a task a unit receives; a task no unit receives has none of them. */
export interface ReceivingView {
  receiving_unit_id?: string;
  receiving_unit_name?: string | null;
  receiving_units?: ReceivingUnitView[];
  unclaimed?: boolean;
}

/** The names of units by id, for the reads that show which unit receives a task. */
export async function unitNamesOf(tx: TenantTx, unitIds: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const ids = [...new Set([...unitIds].filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0) return new Map();
  const rows = await tx.query<{ id: string; name: string }>('select id, name from machvon.organization_unit where id = any($1::uuid[])', [ids]);
  return new Map(rows.map((row) => [row.id, row.name] as const));
}

/** Every unit the rows name, the leading ones and the others. */
export const receivingUnitIdsOf = (rows: readonly TaskReceivingColumns[]): string[] => rows.flatMap((row) => [...(row.receiving_unit_id === null ? [] : [row.receiving_unit_id]), ...(row.receiving_units ?? []).map((unit) => unit.unit_id)]);

/**
 * What a read says of a task a unit receives: the unit, every unit of the task with its name, and whether nobody has taken it (`unclaimed`: a unit receives it, it is not done, cancelled or left out, and the ledger names nobody
 * responsible today). Nothing at all for a task no unit receives.
 */
export function receivingViewOf(row: TaskReceivingColumns & { status: string; excluded: boolean }, names: ReadonlyMap<string, string>, responsibleHeld: boolean): ReceivingView {
  if (row.receiving_unit_id === null) return {};
  return {
    receiving_unit_id: row.receiving_unit_id,
    receiving_unit_name: names.get(row.receiving_unit_id) ?? null,
    receiving_units: (row.receiving_units ?? []).map((unit) => ({ unit_ref: unit.unit_ref, unit_id: unit.unit_id, unit_name: names.get(unit.unit_id) ?? null, role: unit.role, part: unit.part })),
    unclaimed: !row.excluded && row.status !== 'DONE' && row.status !== 'CANCELLED' && !responsibleHeld,
  };
}

/** A line of the units of a task as a person stands to it. */
export interface ClaimLine extends pwfTable.ReceivingUnit {
  /** The person is of the unit. */
  member: boolean;
  /** The person holds the role of the line at the unit: they may take the line. */
  eligible: boolean;
}

export interface ClaimOffer {
  lines: ClaimLine[];
  /** The line the person would take: the first one they may take (the leading unit first), of the part asked for when one is. Null: none. */
  line: ClaimLine | null;
  /** The role of the ledger the line gives, and the share. */
  role: 'RESPONSIBLE' | 'CONSULTED' | null;
  sharePct: number;
  /** The line is taken: somebody is (or is about to be) responsible for the task, or the people consulted already hold all of it, or the person already holds the line. */
  taken: boolean;
  /** Why the person may take no line: they are of none of the units, or of one without the role its line names. */
  refusal: 'NOT_MEMBER' | 'ROLE_NOT_HELD' | null;
}

/**
 * What "Nhận việc" would do for a person on a task today (R71), by the one rule of this module: the line they may take and whether it is still free. The leading line gives RESPONSIBLE with the whole task and is free while
 * the ledger names nobody responsible from today on; a supporting line gives CONSULTED with an equal part of the consultation (100 divided by the supporting lines of the task) and is free while the parts held from today on
 * leave room for it and the person holds none. The command asks under the lock of the task; the read asks without one and only offers the button.
 */
export async function claimOffer(tx: TenantTx, input: { taskId: string; membershipId: string; today: string; at: Date; part?: 'LEAD' | 'SUPPORT' | undefined }): Promise<ClaimOffer> {
  const grant = { me: '$2::uuid', at: '$3::timestamptz', tenant: 't.tenant_id', unitId: 'lu.id', unitPath: 'lu.path' };
  const lines = await tx.query<ClaimLine>(
    `select e.line ->> 'unit_ref' as unit_ref, lu.id as unit_id, e.line ->> 'role' as role, e.line ->> 'part' as part,
            ${unitGrantSql(grant)} as member, ${unitGrantSql({ ...grant, role: `(e.line ->> 'role')` })} as eligible
       from machvon.project_task t
       cross join lateral jsonb_array_elements(coalesce(t.receiving_units, '[]'::jsonb)) with ordinality as e(line, position)
       join machvon.organization_unit lu on lu.tenant_id = t.tenant_id and lu.id = (e.line ->> 'unit_id')::uuid
      where t.id = $1::uuid order by e.position`,
    [input.taskId, input.membershipId, input.at.toISOString()],
  );
  const wanted = lines.filter((one) => input.part === undefined || one.part === input.part);
  const line = wanted.find((one) => one.eligible) ?? null;
  if (line === null) return { lines, line: null, role: null, sharePct: 0, taken: false, refusal: wanted.some((one) => one.member) ? 'ROLE_NOT_HELD' : 'NOT_MEMBER' };
  const role = line.part === 'LEAD' ? 'RESPONSIBLE' : 'CONSULTED';
  const sharePct = line.part === 'LEAD' ? 100 : Math.floor(100 / Math.max(1, lines.filter((one) => one.part === 'SUPPORT').length));
  const held = await tx.query<{ membership_id: string; share_pct: number }>(
    `select membership_id, share_pct from machvon.project_task_assignment where task_id = $1::uuid and role = $2 and (valid_to is null or valid_to >= $3::date)`,
    [input.taskId, role, input.today],
  );
  const taken = role === 'RESPONSIBLE' ? held.length > 0 : held.some((one) => one.membership_id === input.membershipId) || held.reduce((sum, one) => sum + Number(one.share_pct), 0) + sharePct > 100;
  return { lines, line, role, sharePct, taken, refusal: null };
}

/** Whether the person is of one of the units that receive the task (R71): what the ledger notes when an administrator gives the task to somebody from outside them. */
export async function isOfReceivingUnits(tx: TenantTx, taskId: string, membershipId: string, at: Date): Promise<boolean> {
  const rows = await tx.query<{ member: boolean }>(
    `select exists (select 1 from machvon.project_task t
        cross join lateral jsonb_array_elements(coalesce(t.receiving_units, '[]'::jsonb)) as e(line)
        join machvon.organization_unit lu on lu.tenant_id = t.tenant_id and lu.id = (e.line ->> 'unit_id')::uuid
       where t.id = $1::uuid and ${unitGrantSql({ me: '$2::uuid', at: '$3::timestamptz', tenant: 't.tenant_id', unitId: 'lu.id', unitPath: 'lu.path' })}) as member`,
    [taskId, membershipId, at.toISOString()],
  );
  return rows[0]?.member === true;
}
