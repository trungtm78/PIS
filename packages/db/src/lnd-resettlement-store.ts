import { randomUUID } from 'node:crypto';
import { DomainError, asUuid } from '@machvon/kernel';
import { enterScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import { AREA_INTEGER_DIGITS, fixedTwo, textOf } from './lnd-values.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

/**
 * The resettlement of the households whose land is recovered (ST-LND-012, LND 3.1, UC-LND-01, LND-12, UAT-PLAN-31). A plot, a flat or a house is allocated to one household at a time, on the item of an approved
 * compensation plan that gives the household resettlement (land for a plot, a house for a house or a flat). The household is shown in its masked form only (the code and the masked name of the head), the allocation belongs to the
 * unit that answers for the household and is seen only from inside it, by the policy of the database as well as by the application.
 */
export const RESETTLEMENT_RESOURCE = 'resettlement_allocation';
export const RESETTLEMENT_ALLOCATED_EVENT = 'lnd.resettlement.allocated.v1';
export const UNIT_KINDS = ['PLOT', 'APARTMENT', 'HOUSE'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];
export const ALLOCATION_STATUSES = ['ELIGIBLE', 'ALLOCATED', 'HANDED_OVER', 'DECLINED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

/** The plans an allocation may rest on: approved, or already being paid or paid (the approval stands). */
const STANDING_PLAN_STATUSES: readonly string[] = ['APPROVED', 'PAYING', 'COMPLETED'];
/** The unit each kind of item of a plan gives. */
const UNITS_OF_ITEM: Readonly<Record<string, readonly UnitKind[]>> = { RESETTLEMENT_LAND: ['PLOT'], RESETTLEMENT_HOUSE: ['HOUSE', 'APARTMENT'] };
const UNIT_CLAIM = 'resettlement_unit_uq';
const MAX_PAGE = 200;
/**
 * The plans of a project by the plan they all descend from: a revision of a plan copies its items under new ids, so what a household was given is followed through the whole line of revisions (`supersedes_id`), not through
 * the id of an item. $1 is the project.
 */
const PLAN_LINES_SQL = `roots(id, root_id) as (
  select id, id from machvon.compensation_plan where project_id = $1::uuid and supersedes_id is null
  union all select p.id, r.root_id from machvon.compensation_plan p join roots r on p.supersedes_id = r.id
)`;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const notEligible = (field: string, reason: string): DomainError => new DomainError('HOUSEHOLD_NOT_ELIGIBLE', 422, field, { extensions: { reason } });
const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value.trim()) : undefined;
  if (id === undefined) throw invalid(field);
  return id.toLowerCase();
};

export interface AllocationInput {
  householdId: string;
  planItemId: string | undefined;
  ownerUnitId: string;
  unitKind: string;
  unitCode: string;
  siteText: string;
  areaM2: string | undefined;
  priorityRank: number | undefined;
}

export interface Allocated {
  id: string;
  projectId: string;
  householdId: string;
  planItemId: string;
  ownerUnitId: string;
  unitKind: UnitKind;
  unitCode: string;
  allocatedOn: string;
  version: number;
}

export interface AllocationLine {
  id: string;
  projectId: string;
  household: { id: string; code: string; headName: string };
  planItemId: string | null;
  ownerUnitId: string;
  unitKind: UnitKind;
  unitCode: string;
  siteText: string;
  areaM2: string | null;
  priorityRank: number | null;
  allocatedOn: string | null;
  handedOn: string | null;
  status: AllocationStatus;
  version: number;
  createdAtKey: string;
}

export interface Candidate {
  planItemId: string;
  planId: string;
  household: { id: string; code: string; headName: string };
  ownerUnitId: string;
  itemKind: string;
  unitKinds: readonly UnitKind[];
}

interface LineSql {
  id: string;
  project_id: string;
  household_id: string;
  household_code: string;
  head_name: string;
  plan_item_id: string | null;
  owner_unit_id: string;
  unit_kind: UnitKind;
  unit_code: string;
  site_text: string;
  area_m2: string | null;
  priority_rank: number | null;
  allocated_on: string | null;
  handed_on: string | null;
  status: AllocationStatus;
  version: string;
  created_at_key: string;
}

export class LndResettlementStore {
  /** The project and the unit of a household inside the units of the caller; nothing for one outside them. The command asks it to know which project the right has to hold over. */
  async householdPlace(tx: TenantTx, householdId: string, units: ScopeUnits): Promise<{ projectId: string; ownerUnitId: string } | undefined> {
    await enterScope(tx, units);
    const [row] = await tx.query<{ project_id: string; owner_unit_id: string }>('select project_id, owner_unit_id from machvon.affected_household where id = $1::uuid', [idOf(householdId, 'household_id')]);
    return row === undefined ? undefined : { projectId: row.project_id, ownerUnitId: row.owner_unit_id };
  }

  /**
   * Allocates a unit to a household on an item of its approved plan. Refusals in order: the fields (422), the household (404 outside the units of the caller), the unit that answers (422 `owner_unit_id`: the unit of the
   * household), then 422 `HOUSEHOLD_NOT_ELIGIBLE` with a `reason` for a request with no plan item (`NO_PLAN_ITEM`), an item that is not found, of another household or of another project, a plan that is not approved, an item that is not
   * resettlement, a kind of unit the item does not give, and an item that already has its unit (`ALREADY_ALLOCATED`); and 409 `UNIT_ALREADY_ALLOCATED` for a unit that another household holds. Nothing is written by a refusal.
   */
  async allocate(tx: TenantTx, input: AllocationInput, actor: string, units: ScopeUnits, today: string): Promise<Allocated> {
    const householdId = idOf(input.householdId, 'household_id');
    const ownerUnitId = idOf(input.ownerUnitId, 'owner_unit_id');
    const unitKind = UNIT_KINDS.find((candidate) => candidate === input.unitKind);
    if (unitKind === undefined) throw invalid('unit_kind');
    const unitCode = textOf(input.unitCode, 'unit_code', 1, 60);
    const siteText = textOf(input.siteText, 'site_text', 1, 300);
    const area = input.areaM2 === undefined ? null : fixedTwo(input.areaM2, AREA_INTEGER_DIGITS, 'area_m2');
    if (area !== null && Number(area) <= 0) throw invalid('area_m2');
    if (input.priorityRank !== undefined && (!Number.isInteger(input.priorityRank) || input.priorityRank < 1 || input.priorityRank > 100_000)) throw invalid('priority_rank');
    await enterScope(tx, units);
    const [household] = await tx.query<{ project_id: string; owner_unit_id: string }>('select project_id, owner_unit_id from machvon.affected_household where id = $1::uuid', [householdId]);
    if (household === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The unit that answers for the allocation is the unit of the household: its words are read inside it and nowhere else.
    if (household.owner_unit_id !== ownerUnitId) throw invalid('owner_unit_id');
    if (input.planItemId === undefined) throw notEligible('plan_item_id', 'NO_PLAN_ITEM');
    const planItemId = idOf(input.planItemId, 'plan_item_id');
    // The plan is locked first and the item after it, as the revision of a plan does: an allocation and a revision asked for at once are made one after the other, so the plan that is read as approved is still approved
    // when the allocation is written, and two allocations on one item are made one after the other too.
    const [peek] = await tx.query<{ plan_id: string }>('select plan_id from machvon.compensation_plan_item where id = $1::uuid', [planItemId]);
    if (peek === undefined) throw notEligible('plan_item_id', 'PLAN_ITEM_NOT_FOUND');
    await tx.query('select 1 from machvon.compensation_plan where id = $1::uuid for update', [peek.plan_id]);
    const [item] = await tx.query<{ household_id: string; item_kind: string; plan_id: string; plan_status: string; plan_project_id: string }>(
      `select i.household_id, i.item_kind, i.plan_id, p.status as plan_status, p.project_id as plan_project_id
         from machvon.compensation_plan_item i join machvon.compensation_plan p on p.tenant_id = i.tenant_id and p.id = i.plan_id
        where i.id = $1::uuid for update of i`,
      [planItemId],
    );
    if (item === undefined) throw notEligible('plan_item_id', 'PLAN_ITEM_NOT_FOUND');
    if (item.household_id !== householdId || item.plan_project_id !== household.project_id) throw notEligible('plan_item_id', 'PLAN_ITEM_OF_ANOTHER_HOUSEHOLD');
    if (!STANDING_PLAN_STATUSES.includes(item.plan_status)) throw notEligible('plan_item_id', 'PLAN_NOT_APPROVED');
    const gives = UNITS_OF_ITEM[item.item_kind];
    if (gives === undefined) throw notEligible('plan_item_id', 'NOT_A_RESETTLEMENT_ITEM');
    if (!gives.includes(unitKind)) throw notEligible('unit_kind', 'UNIT_KIND_MISMATCH');
    const [held] = await tx.query<{ id: string }>("select id from machvon.resettlement_allocation where plan_item_id = $1::uuid and status in ('ALLOCATED', 'HANDED_OVER')", [planItemId]);
    if (held !== undefined) throw notEligible('plan_item_id', 'ALREADY_ALLOCATED');
    // What the household is given by the plan, less what it was allocated under the plan or any revision of it: the copy of an item that was allocated before the revision is not given twice.
    const [counts] = await tx.query<{ entitled: string; allocated: string }>(
      `with recursive ${PLAN_LINES_SQL}
       select (select count(*) from machvon.compensation_plan_item where plan_id = $2::uuid and household_id = $3::uuid and item_kind = $4)::text as entitled,
              (select count(*) from machvon.resettlement_allocation a join machvon.compensation_plan_item ai on ai.tenant_id = a.tenant_id and ai.id = a.plan_item_id join roots rr on rr.id = ai.plan_id
                where a.household_id = $3::uuid and ai.item_kind = $4 and a.status in ('ALLOCATED', 'HANDED_OVER') and rr.root_id = (select root_id from roots where id = $2::uuid))::text as allocated`,
      [household.project_id, item.plan_id, householdId, item.item_kind],
    );
    if (Number(counts?.allocated ?? 0) >= Number(counts?.entitled ?? 0)) throw notEligible('plan_item_id', 'ALREADY_ALLOCATED');
    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: UNIT_CLAIM, code: 'UNIT_ALREADY_ALLOCATED' }, () =>
      tx.query(
        `insert into machvon.resettlement_allocation
           (tenant_id, id, household_id, plan_item_id, owner_unit_id, unit_kind, unit_code, site_text, area_m2, priority_rank, allocated_on, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::numeric, $9::integer, $10::date, 'ALLOCATED', $11::uuid, $11::uuid, 1)`,
        [id, householdId, planItemId, ownerUnitId, unitKind, unitCode, siteText, area, input.priorityRank ?? null, today, actor],
      ),
    );
    return { id, projectId: household.project_id, householdId, planItemId, ownerUnitId, unitKind, unitCode, allocatedOn: today, version: 1 };
  }

  /** The allocations of a project inside the units of the reader, newest first, with the household in its masked form only. */
  async list(tx: TenantTx, filter: { projectId: string; status?: string | undefined }, units: ScopeUnits, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<AllocationLine[]> {
    if (filter.status !== undefined && !(ALLOCATION_STATUSES as readonly string[]).includes(filter.status)) throw invalid('status');
    assertTimestampCursor(request.after?.code);
    if (request.after !== undefined && asUuid(request.after.id) === undefined) throw invalid('cursor');
    await enterScope(tx, units);
    const rows = await tx.query<LineSql>(
      `select a.id, h.project_id, a.household_id, h.household_code, h.head_name, a.plan_item_id, a.owner_unit_id, a.unit_kind, a.unit_code, a.site_text, a.area_m2::text as area_m2, a.priority_rank,
              a.allocated_on::text as allocated_on, a.handed_on::text as handed_on, a.status, a.version::text as version, ${timestampKey('a.created_at')} as created_at_key
         from machvon.resettlement_allocation a join machvon.affected_household h on h.tenant_id = a.tenant_id and h.id = a.household_id
        where h.project_id = $1::uuid and ($2::text is null or a.status = $2) and ($3::text is null or (${timestampKey('a.created_at')}, a.id) < ($3::text, $4::uuid))
        order by a.created_at desc, a.id desc limit $5`,
      [idOf(filter.projectId, 'project_id'), filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, Math.min(request.limit, MAX_PAGE + 1)],
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      household: { id: row.household_id, code: row.household_code, headName: row.head_name },
      planItemId: row.plan_item_id,
      ownerUnitId: row.owner_unit_id,
      unitKind: row.unit_kind,
      unitCode: row.unit_code,
      siteText: row.site_text,
      areaM2: row.area_m2,
      priorityRank: row.priority_rank,
      allocatedOn: row.allocated_on,
      handedOn: row.handed_on,
      status: row.status,
      version: Number(row.version),
      createdAtKey: row.created_at_key,
    }));
  }

  /** The items of approved plans that give a household resettlement and have no unit yet, inside the units of the reader: what LND-12 offers to allocate. */
  async candidates(tx: TenantTx, projectId: string, units: ScopeUnits, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<Candidate[]> {
    if (request.after !== undefined && (asUuid(request.after.id) === undefined || request.after.code.length > 100)) throw invalid('cursor');
    await enterScope(tx, units);
    const rows = await tx.query<{ plan_item_id: string; plan_id: string; household_id: string; household_code: string; head_name: string; owner_unit_id: string; item_kind: string }>(
      `with recursive ${PLAN_LINES_SQL}
       select i.id as plan_item_id, i.plan_id, i.household_id, h.household_code, h.head_name, h.owner_unit_id, i.item_kind
         from machvon.compensation_plan_item i
         join machvon.compensation_plan p on p.tenant_id = i.tenant_id and p.id = i.plan_id
         join machvon.affected_household h on h.tenant_id = i.tenant_id and h.id = i.household_id
        where p.project_id = $1::uuid and p.status = any($2::text[]) and i.item_kind = any($3::text[])
          and not exists (select 1 from machvon.resettlement_allocation a where a.tenant_id = i.tenant_id and a.plan_item_id = i.id and a.status in ('ALLOCATED', 'HANDED_OVER'))
          and (select count(*) from machvon.resettlement_allocation a join machvon.compensation_plan_item ai on ai.tenant_id = a.tenant_id and ai.id = a.plan_item_id join roots rr on rr.id = ai.plan_id
                where a.household_id = i.household_id and ai.item_kind = i.item_kind and a.status in ('ALLOCATED', 'HANDED_OVER') and rr.root_id = (select root_id from roots where id = i.plan_id))
              < (select count(*) from machvon.compensation_plan_item i2 where i2.plan_id = i.plan_id and i2.household_id = i.household_id and i2.item_kind = i.item_kind)
          and ($4::text is null or (h.household_code, i.id) > ($4::text, $5::uuid))
        order by h.household_code, i.id limit $6`,
      [idOf(projectId, 'project_id'), STANDING_PLAN_STATUSES, Object.keys(UNITS_OF_ITEM), request.after?.code ?? null, request.after?.id ?? null, Math.min(request.limit, MAX_PAGE + 1)],
    );
    return rows.map((row) => ({
      planItemId: row.plan_item_id,
      planId: row.plan_id,
      household: { id: row.household_id, code: row.household_code, headName: row.head_name },
      ownerUnitId: row.owner_unit_id,
      itemKind: row.item_kind,
      unitKinds: UNITS_OF_ITEM[row.item_kind] ?? [],
    }));
  }
}
