import { DoaMatrixStore, GovernanceRuleStore, MasterStore, RoleStore, createUnit } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DomainError, ORG_PACK_ENTITY, ORG_PACK_MAPPING_VERSION, doaRuleContent, judgeOrgPack, orgPackDigest, orgPackOfRows, planOrgPack, verifyOrgPack, workflowRuleParams } from '@machvon/kernel';
import type { DoaRuleContent, OrgPack, OrgPackState, PackEntry, PackRole, PackRow, PackUnit, PlanItem, PlanSection, OrgPackVerification } from '@machvon/kernel';

/**
 * The tenant side of the organisation pack (ENT-3d): reads what the tenant has, turns an applied batch of the pack file into the objects of the tenant, and answers whether the tenant stands as the pack says.
 *
 * Nothing here activates a policy on its own. Units and roles are structure and take effect with the batch that two people approved (register and dry run by one, apply by another). The staged approval, the
 * absence policy, the matrix rule and the catalogue entries are only proposed: a governance rule version is written and submitted, the matrix is a submitted draft, a catalogue entry is submitted for review; each is
 * decided by somebody other than who proposed it, through the framework that owns it. A second run changes nothing; what differs from the pack is reported as drift and never overwritten.
 */
export const ORG_PACK_RESOURCE = 'ent_org_pack';
const WORKFLOW_RULE = { type: 'APPROVAL_WORKFLOW_DEFINITION', code: 'REPORT_ACCEPT' } as const;
const ABSENCE_RULE = { type: 'ABSENCE_POLICY', code: 'DEFAULT' } as const;
const PACK_LOCK = "select pg_advisory_xact_lock(hashtextextended('ent_org_pack:' || current_setting('app.tenant_id'), 0))";
/** Types of the catalogue in the order a type can refer to the one before it: a report type names a period kind, an agency names report types. */
const TYPE_ORDER = ['REPORTING_PERIOD_KIND', 'REPORT_TYPE', 'RECEIVING_AGENCY', 'CAPITAL_SOURCE', 'REPORT_UNIT', 'ISSUE_CATEGORY'];
const UNIT_TYPE_OF_FUNCTION: Readonly<Record<PackUnit['function'], string>> = { ROOT: 'DEPARTMENT', INPUT_POINT: 'DEPARTMENT', AGGREGATOR: 'DEPARTMENT', LEADERSHIP: 'GOVERNING_BODY', ADMINISTRATION: 'DEPARTMENT' };

export type MaterialiseResult = 'CREATED' | 'UNCHANGED' | 'PENDING' | 'DRIFT' | 'BLOCKED';
export interface MaterialisedItem {
  section: PlanSection;
  key: string;
  result: MaterialiseResult;
  detail: string;
  /** The id of what was written (a unit, a role, a rule version, a matrix draft, a change request). */
  id?: string;
}
export interface MaterialiseReport {
  label: string;
  digest: string;
  items: MaterialisedItem[];
  counts: Record<MaterialiseResult, number>;
  /** The tenant after the run, as `verify` reports it. */
  verification: OrgPackVerification;
}

export interface BatchPack {
  batchId: string;
  rows: PackRow[];
  pack: OrgPack;
  /** The defects of the rows themselves (a pack that was applied is clean; a batch of another kind or an older rule set may not be). */
  defects: ReturnType<typeof judgeOrgPack>;
}

interface UnitSql {
  id: string;
  code: string;
  name: string;
  parent_code: string | null;
  status: string;
  is_root: boolean;
}
interface RoleSql {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  rank: number;
  status: string;
}
interface RuleSql {
  status: string;
  params: unknown;
  effective_to: string | null;
}
interface EntrySql {
  master_type: string;
  business_key: string;
  status: string;
  label: string;
  parent_key: string | null;
}
interface GrantSql {
  role_code: string;
  scope_kind: string;
  scope_ref_ids: string[] | null;
  home_unit_code: string | null;
}

const fail = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export class OrgPackStore {
  private readonly roles = new RoleStore();
  private readonly rules = new GovernanceRuleStore();
  private readonly matrices = new DoaMatrixStore();
  private readonly masters = new MasterStore();

  /** The rows of an applied batch of the pack file, as a pack: only a batch of the pack entity and mapping that reached `Applied` is read (409 `MIGRATION_STATE_INVALID` otherwise). */
  async packOfBatch(tx: TenantTx, batchId: string): Promise<BatchPack> {
    const batches = await tx.query<{ id: string; status: string; target_entity: string; mapping_version: string }>('select id, status, target_entity, mapping_version from machvon.migration_batch where id = $1::uuid', [batchId]);
    const batch = batches[0];
    if (batch === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (batch.target_entity !== ORG_PACK_ENTITY || batch.mapping_version !== ORG_PACK_MAPPING_VERSION) throw fail('batch_id');
    if (batch.status !== 'Applied') throw new DomainError('MIGRATION_STATE_INVALID', 409, batch.status);
    const stored = await tx.query<{ business_key: string; payload: Record<string, string> }>(
      "select business_key, payload from machvon.migration_row where migrated_batch_id = $1::uuid and target_entity = $2 and state = 'VALID' order by business_key",
      [batchId, ORG_PACK_ENTITY],
    );
    const rows: PackRow[] = stored.map((row, index) => ({ rowNumber: index + 1, businessKey: row.business_key, payload: row.payload }));
    const { pack, defects } = orgPackOfRows(rows);
    return { batchId, rows, pack, defects: [...defects, ...judgeOrgPack(pack)] };
  }

  /** What the tenant has now, for the objects the pack names. */
  async readState(tx: TenantTx, pack: OrgPack): Promise<OrgPackState> {
    const rootCode = pack.units.find((unit) => unit.parentCode === null)?.code;
    const unitRows = await tx.query<UnitSql>(
      `select u.id, u.code, u.name, p.code as parent_code, u.status, (u.parent_id is null) as is_root
         from machvon.organization_unit u left join machvon.organization_unit p on p.id = u.parent_id
        where u.code = any($1::text[]) or u.parent_id is null`,
      [pack.units.map((unit) => unit.code)],
    );
    const units = new Map<string, { id: string; name: string; parentCode: string | null; active: boolean }>();
    // The root is adopted under the code of the pack, so a child of the root has the parent the pack names whatever the root is called in the tenant.
    const actualRoot = unitRows.find((row) => row.is_root)?.code;
    for (const row of unitRows) {
      const code = row.is_root && rootCode !== undefined ? rootCode : row.code;
      if (!row.is_root && !pack.units.some((unit) => unit.code === row.code)) continue;
      const parentCode = row.parent_code !== null && row.parent_code === actualRoot && rootCode !== undefined ? rootCode : row.parent_code;
      units.set(code, { id: row.id, name: row.name, parentCode, active: ['Active', 'Planned'].includes(row.status) });
    }
    const roleRows = await tx.query<RoleSql>('select id, code, name, permissions, rank, status from machvon.role_definition where code = any($1::text[])', [pack.roles.map((role) => role.code)]);
    const roles = new Map(roleRows.map((row) => [row.code, { id: row.id, name: row.name, rank: row.rank, permissions: row.permissions, active: row.status === 'Active' }]));
    const today = await this.rules.today(tx);
    const versionsOf = async (rule: { type: string; code: string }): Promise<Array<{ status: string; params: unknown }>> => {
      const rows = await tx.query<RuleSql>(
        'select status, params, effective_to::text as effective_to from machvon.governance_rule where rule_type = $1 and code = $2 and unit_id is null order by version desc',
        [rule.type, rule.code],
      );
      return rows.filter((row) => row.status !== 'RETIRED' && !(row.status === 'APPROVED' && row.effective_to !== null && row.effective_to <= today)).map((row) => ({ status: row.status, params: row.params }));
    };
    const [workflowVersions, absenceVersions] = [await versionsOf(WORKFLOW_RULE), await versionsOf(ABSENCE_RULE)];

    const types = [...new Set(pack.entries.map((entry) => entry.masterType))];
    const entryRows = await tx.query<EntrySql>(
      `select r.master_type, r.business_key, r.status, v.label, pr.business_key as parent_key
         from machvon.master_record r
         join lateral (select x.label, x.parent_id from machvon.master_record_version x where x.master_record_id = r.id order by x.revision desc limit 1) v on true
         left join machvon.master_record pr on pr.id = v.parent_id
        where r.namespace = 'TENANT' and r.master_type = any($1::text[]) and r.business_key = any($2::text[])`,
      [types, pack.entries.map((entry) => entry.key)],
    );
    const entries = new Map(entryRows.map((row) => [`${row.master_type}:${row.business_key}`, { label: row.label, parentKey: row.parent_key, status: row.status }]));

    const grants = await tx.query<GrantSql>(
      `select r.code as role_code, g.scope_kind, g.scope_ref_ids, hu.code as home_unit_code
         from machvon.role_grant g
         join machvon.role_definition r on r.id = g.role_id
         join machvon.membership m on m.id = g.membership_id
         left join machvon.organization_unit hu on hu.id = m.organization_id
        where r.code = any($1::text[]) and g.status = 'Active' and g.effective_from <= now() and (g.effective_until is null or g.effective_until > now())
          and m.status = 'Active' and (m.valid_until is null or m.valid_until > now())`,
      [pack.roles.map((role) => role.code)],
    );
    const holders = new Map<string, number>();
    let strayGrants = 0;
    for (const grant of grants) {
      const seat = pack.seats.find((candidate) => {
        if (candidate.roleCode !== grant.role_code || candidate.scope !== grant.scope_kind) return false;
        if (candidate.scope === 'TENANT') return grant.home_unit_code === candidate.unitCode;
        const unitId = units.get(candidate.unitCode)?.id;
        return unitId !== undefined && (grant.scope_ref_ids ?? []).length === 1 && grant.scope_ref_ids?.[0] === unitId;
      });
      if (seat === undefined) strayGrants += 1;
      else holders.set(`${seat.roleCode}@${seat.unitCode}`, (holders.get(`${seat.roleCode}@${seat.unitCode}`) ?? 0) + 1);
    }

    return { units, roles, workflowVersions, absenceVersions, doa: await this.doaState(tx, pack, units, roles), entries, holders, strayGrants };
  }

  private async doaState(tx: TenantTx, pack: OrgPack, units: OrgPackState['units'], roles: OrgPackState['roles']): Promise<OrgPackState['doa']> {
    const unitId = units.get(pack.doa.unitCode)?.id;
    const roleId = roles.get(pack.doa.roleCode)?.id;
    const rows = await tx.query<{ status: string; unit_id: string; approver_role_id: string }>(
      `select m.status, r.unit_id, r.approver_role_id
         from machvon.doa_matrix_version m join machvon.doa_rule r on r.matrix_version_id = m.id
        where r.document_type = $1 and m.status in ('Published', 'PendingApproval', 'Draft')`,
      [pack.doa.documentType],
    );
    const ours = (row: { unit_id: string; approver_role_id: string }): boolean => unitId !== undefined && roleId !== undefined && row.unit_id === unitId && row.approver_role_id === roleId;
    if (rows.some((row) => row.status === 'Published' && ours(row))) return 'PRESENT';
    if (rows.some((row) => row.status !== 'Published' && ours(row))) return 'PENDING';
    return rows.some((row) => row.status === 'Published') ? 'OTHER_APPROVER' : 'NONE';
  }

  /** The verification report of the tenant against the pack: the plan (what stands, what is pending, what differs) and the seats against the people who hold them. */
  async verify(tx: TenantTx, pack: OrgPack): Promise<OrgPackVerification> {
    return verifyOrgPack(pack, await this.readState(tx, pack));
  }

  /** The units of the pack with their parents first. */
  private static unitsParentsFirst(pack: OrgPack): PackUnit[] {
    const sorted: PackUnit[] = [];
    const placed = new Set<string>();
    let pending = [...pack.units];
    while (pending.length > 0) {
      const ready = pending.filter((unit) => unit.parentCode === null || placed.has(unit.parentCode));
      if (ready.length === 0) throw fail('units');
      for (const unit of ready) {
        sorted.push(unit);
        placed.add(unit.code);
      }
      pending = pending.filter((unit) => !placed.has(unit.code));
    }
    return sorted;
  }

  private static entriesInOrder(pack: OrgPack): PackEntry[] {
    const rank = (type: string): number => {
      const at = TYPE_ORDER.indexOf(type);
      return at < 0 ? TYPE_ORDER.length : at;
    };
    const depth = (entry: PackEntry): number => (entry.parentKey === null ? 0 : 1 + depth(pack.entries.find((candidate) => candidate.masterType === entry.masterType && candidate.key === entry.parentKey) ?? { ...entry, parentKey: null }));
    return [...pack.entries].sort((a, b) => rank(a.masterType) - rank(b.masterType) || depth(a) - depth(b));
  }

  /**
   * Turns a pack into the objects of the tenant. `guardRole` is the check of the caller against the role it would create (anti-escalation: nobody creates a role with more than they hold); it throws to refuse.
   * The run is one transaction under a lock of the tenant: it either leaves everything it wrote or nothing.
   */
  async materialise(tx: TenantTx, pack: OrgPack, input: { actor: string; batchId: string; guardRole: (role: PackRole) => void }): Promise<MaterialiseReport> {
    const defects = judgeOrgPack(pack);
    if (defects.length > 0) throw new DomainError('VALIDATION_FAILED', 422, defects[0]?.key ?? 'pack');
    await tx.query(PACK_LOCK);
    const today = await this.rules.today(tx);
    const result = new Map<string, MaterialisedItem>();
    const note = (item: PlanItem, outcome: MaterialiseResult, id?: string): void => void result.set(item.key, { section: item.section, key: item.key, result: outcome, detail: item.detail, ...(id === undefined ? {} : { id }) });
    const settled = (item: PlanItem): void => note(item, item.action === 'CREATE' ? 'CREATED' : (item.action as MaterialiseResult));

    // Structure first: units, then roles.
    let state = await this.readState(tx, pack);
    let plan = planOrgPack(pack, state);
    const unitIds = new Map([...state.units].map(([code, unit]) => [code, unit.id]));
    for (const unit of OrgPackStore.unitsParentsFirst(pack)) {
      const item = plan.find((candidate) => candidate.key === `UNIT:${unit.code}`) as PlanItem;
      if (item.action !== 'CREATE') {
        settled(item);
        continue;
      }
      const parentId = unitIds.get(unit.parentCode ?? '');
      if (parentId === undefined) {
        note({ ...item, detail: 'the parent unit does not exist' }, 'BLOCKED');
        continue;
      }
      const parent = (await tx.query<{ valid_from: string }>('select valid_from::text as valid_from from machvon.organization_unit where id = $1::uuid', [parentId]))[0];
      const created = await createUnit(tx, {
        code: unit.code,
        name: unit.name,
        parentId,
        unitType: UNIT_TYPE_OF_FUNCTION[unit.function],
        validFrom: parent !== undefined && parent.valid_from > today ? parent.valid_from : today,
        legalBasisRef: pack.label,
      });
      unitIds.set(unit.code, created.id);
      note(item, 'CREATED', created.id);
    }
    for (const role of pack.roles) {
      const item = plan.find((candidate) => candidate.key === `ROLE:${role.code}`) as PlanItem;
      if (item.action !== 'CREATE') {
        settled(item);
        continue;
      }
      input.guardRole(role);
      const created = await this.roles.createCustomRole(tx, { code: role.code, name: role.name, permissions: role.permissions, rank: role.rank, guestAllowed: false, createdBy: input.actor });
      note(item, 'CREATED', created.id);
    }

    // The policies, which only the structure above makes possible: proposed, never activated here.
    state = await this.readState(tx, pack);
    plan = planOrgPack(pack, state);
    const reason = `${pack.label}: proposed by the load of batch ${input.batchId}, to be approved by somebody other than who proposed it`;
    const workflow = plan.find((item) => item.section === 'WORKFLOW') as PlanItem;
    if (workflow.action === 'CREATE') {
      const draft = await this.rules.create(tx, { ...WORKFLOW_RULE, unitId: null, params: workflowRuleParams(pack, new Map([...state.units].map(([code, unit]) => [code, unit.id]))), effectiveFrom: today, effectiveTo: null, reason }, input.actor);
      await this.rules.submit(tx, draft.id, draft.rowVersion, input.actor);
      note(workflow, 'CREATED', draft.id);
    } else settled(workflow);
    const absence = plan.find((item) => item.section === 'ABSENCE') as PlanItem;
    if (absence.action === 'CREATE') {
      const draft = await this.rules.create(tx, { ...ABSENCE_RULE, unitId: null, params: pack.absence, effectiveFrom: today, effectiveTo: null, reason }, input.actor);
      await this.rules.submit(tx, draft.id, draft.rowVersion, input.actor);
      note(absence, 'CREATED', draft.id);
    } else settled(absence);
    const doa = plan.find((item) => item.section === 'DOA') as PlanItem;
    if (doa.action === 'CREATE') note(doa, 'CREATED', await this.proposeMatrix(tx, pack, state, today, input.actor));
    else settled(doa);

    // The shared catalogues: each entry is proposed and submitted for review through the master data framework.
    const recordIds = new Map<string, string>();
    for (const entry of OrgPackStore.entriesInOrder(pack)) {
      const item = plan.find((candidate) => candidate.key === `ENTRY:${entry.masterType}:${entry.key}`) as PlanItem;
      if (item.action !== 'CREATE') {
        settled(item);
        continue;
      }
      const parentRecordId = entry.parentKey === null ? null : await this.recordIdOf(tx, entry.masterType, entry.parentKey, recordIds);
      if (entry.parentKey !== null && parentRecordId === null) {
        note({ ...item, detail: 'the parent entry does not exist' }, 'BLOCKED');
        continue;
      }
      const proposed = await this.masters.propose(
        tx,
        { masterType: entry.masterType, businessKey: entry.key, content: { label: entry.label, attributes: entry.attributes, parentRecordId, validFrom: today, validUntil: null, legalBasis: null }, reason },
        input.actor,
      );
      await this.masters.submit(tx, proposed.changeRequestId, proposed.version, input.actor);
      recordIds.set(`${entry.masterType}:${entry.key}`, proposed.recordId);
      note(item, 'CREATED', proposed.changeRequestId);
    }

    const verification = await this.verify(tx, pack);
    const items = plan.map((item) => result.get(item.key) as MaterialisedItem);
    const counts: Record<MaterialiseResult, number> = { CREATED: 0, UNCHANGED: 0, PENDING: 0, DRIFT: 0, BLOCKED: 0 };
    for (const item of items) counts[item.result] += 1;
    return { label: pack.label, digest: orgPackDigest(pack), items, counts, verification };
  }

  private async recordIdOf(tx: TenantTx, masterType: string, key: string, created: ReadonlyMap<string, string>): Promise<string | null> {
    const known = created.get(`${masterType}:${key}`);
    if (known !== undefined) return known;
    const rows = await tx.query<{ id: string }>("select id from machvon.master_record where namespace = 'TENANT' and master_type = $1 and business_key = $2", [masterType, key]);
    return rows[0]?.id ?? null;
  }

  /**
   * The matrix of authority is one document for the whole tenant: a new version replaces the one in force. The proposal therefore carries every rule of the matrix in force and adds the one of the pack, so that
   * approving it takes nothing away from the documents that already have an approver; it starts the day after the version in force at the earliest, as an approval needs.
   */
  private async proposeMatrix(tx: TenantTx, pack: OrgPack, state: OrgPackState, today: string, actor: string): Promise<string> {
    const unitId = state.units.get(pack.doa.unitCode)?.id;
    const roleId = state.roles.get(pack.doa.roleCode)?.id;
    if (unitId === undefined || roleId === undefined) throw fail('doa');
    const published = (await tx.query<{ id: string; effective_from: string }>("select id, effective_from::text as effective_from from machvon.doa_matrix_version where status = 'Published'"))[0];
    const current = published === undefined ? undefined : await this.matrices.find(tx, published.id);
    const carried: DoaRuleContent[] = (current?.rules ?? []).map((rule) => ({
      document_type: rule.document_type,
      unit_id: rule.unit_id,
      include_subtree: rule.include_subtree ?? true,
      amount_min_vnd: rule.amount_min_vnd,
      amount_max_vnd: rule.amount_max_vnd ?? null,
      approver_role_id: rule.approver_role_id,
      approval_levels: rule.approval_levels ?? 1,
      requires_distinct_approvers: rule.requires_distinct_approvers ?? true,
    }));
    const from = published === undefined ? today : (await tx.query<{ day: string }>('select greatest($1::date, $2::date + 1)::text as day', [today, published.effective_from]))[0]?.day ?? today;
    const draft = await this.matrices.createDraft(
      tx,
      { effective_from: from, legal_basis_ref: pack.label, rules: [...carried, doaRuleContent(pack, unitId, roleId)] },
      actor,
    );
    await this.matrices.submit(tx, draft.id, draft.version, actor);
    return draft.id;
  }
}
