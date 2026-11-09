import { DoaMatrixStore, GovernanceRuleStore, MasterStore, RoleStore, createUnit } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { ORG_PACK_ENTITY, ORG_PACK_MAPPING_VERSION, orgPackRows, workflowRuleParams } from '@machvon/kernel';
import type { OrgPack } from '@machvon/kernel';
import { OrgPackStore } from './org-pack-store.ts';
import { PLANNING_UNIT, ROLE_APPROVER, ROOT_UNIT, pvfccoTemplatePack } from './pvfcco-template.ts';

jest.mock('@machvon/db', () => ({ ...jest.requireActual('@machvon/db'), createUnit: jest.fn() }));

const TODAY = '2026-11-09';
const BATCH = '11111111-1111-4111-8111-111111111111';

interface UnitRow {
  id: string;
  code: string;
  name: string;
  parent_code: string | null;
  status: string;
  is_root: boolean;
}
interface RoleRow {
  id: string;
  code: string;
  name: string;
  permissions: string[];
  rank: number;
  status: string;
}

/** What the fake database holds; the tests change it between runs the way the stores would. */
interface FakeDb {
  batches: Array<{ id: string; status: string; target_entity: string; mapping_version: string }>;
  rows: Array<{ business_key: string; payload: Record<string, string> }>;
  units: UnitRow[];
  roles: RoleRow[];
  rules: Record<string, Array<{ status: string; params: unknown; effective_to: string | null }>>;
  entries: Array<{ master_type: string; business_key: string; status: string; label: string; parent_key: string | null }>;
  records: Record<string, string>;
  grants: Array<{ role_code: string; scope_kind: string; scope_ref_ids: string[] | null; home_unit_code: string | null }>;
  doa: Array<{ status: string; unit_id: string; approver_role_id: string }>;
  published: { id: string; effective_from: string } | undefined;
  sqls: string[];
}

const emptyDb = (): FakeDb => ({
  batches: [],
  rows: [],
  units: [{ id: 'unit-root', code: 'TENANT_ROOT', name: 'Tenant', parent_code: null, status: 'Active', is_root: true }],
  roles: [],
  rules: {},
  entries: [],
  records: {},
  grants: [],
  doa: [],
  published: undefined,
  sqls: [],
});

function connect(db: FakeDb): TenantTx {
  return {
    query: async <R>(sql: string, params: unknown[] = []): Promise<R[]> => {
      db.sqls.push(sql);
      const answer = (rows: unknown[]): R[] => rows as R[];
      if (sql.includes('machvon.migration_batch')) return answer(db.batches.filter((batch) => batch.id === params[0]));
      if (sql.includes('machvon.migration_row')) return answer(db.rows);
      if (sql.includes('from machvon.organization_unit u left join')) return answer(db.units);
      if (sql.includes('select valid_from::text as valid_from')) return answer([{ valid_from: '2026-01-01' }]);
      if (sql.includes('from machvon.role_definition')) return answer(db.roles);
      if (sql.includes('from machvon.governance_rule')) return answer(db.rules[`${String(params[0])}/${String(params[1])}`] ?? []);
      if (sql.includes('join lateral')) return answer(db.entries);
      if (sql.includes('select id from machvon.master_record where')) return answer(db.records[`${String(params[0])}:${String(params[1])}`] === undefined ? [] : [{ id: db.records[`${String(params[0])}:${String(params[1])}`] }]);
      if (sql.includes('from machvon.role_grant')) return answer(db.grants);
      if (sql.includes('from machvon.doa_matrix_version m join')) return answer(db.doa);
      if (sql.includes("from machvon.doa_matrix_version where status = 'Published'")) return answer(db.published === undefined ? [] : [db.published]);
      if (sql.includes('greatest(')) return answer([{ day: '2026-12-01' }]);
      if (sql.includes('pg_advisory_xact_lock')) return answer([]);
      throw new Error(`the fake database does not know this query: ${sql.slice(0, 80)}`);
    },
  };
}

const pack = pvfccoTemplatePack();
const WORKFLOW = 'APPROVAL_WORKFLOW_DEFINITION/REPORT_ACCEPT';
const ABSENCE = 'ABSENCE_POLICY/DEFAULT';
const idOfUnit = (code: string): string => `unit-${code}`;
const idOfRole = (code: string): string => `role-${code}`;

/** The tenant as it stands after a complete load of the pack. */
function completeDb(): FakeDb {
  const db = emptyDb();
  db.units = pack.units.map((unit) => ({ id: idOfUnit(unit.code), code: unit.code, name: unit.name, parent_code: unit.parentCode, status: 'Active', is_root: unit.parentCode === null }));
  db.roles = pack.roles.map((role) => ({ id: idOfRole(role.code), code: role.code, name: role.name, permissions: [...role.permissions], rank: role.rank, status: 'Active' }));
  const unitIds = new Map(pack.units.map((unit) => [unit.code, idOfUnit(unit.code)]));
  db.rules[WORKFLOW] = [{ status: 'APPROVED', params: workflowRuleParams(pack, unitIds), effective_to: null }];
  db.rules[ABSENCE] = [{ status: 'APPROVED', params: pack.absence, effective_to: null }];
  db.entries = pack.entries.map((entry) => ({ master_type: entry.masterType, business_key: entry.key, status: 'PUBLISHED', label: entry.label, parent_key: entry.parentKey }));
  db.doa = [{ status: 'Published', unit_id: idOfUnit(pack.doa.unitCode), approver_role_id: idOfRole(pack.doa.roleCode) }];
  return db;
}

beforeEach(() => {
  jest.spyOn(GovernanceRuleStore.prototype, 'today').mockResolvedValue(TODAY);
});
afterEach(() => {
  jest.restoreAllMocks();
  (createUnit as jest.Mock).mockReset();
});

describe('OrgPackStore.packOfBatch', () => {
  const batch = (patch: Partial<FakeDb['batches'][number]> = {}): FakeDb['batches'][number] => ({ id: BATCH, status: 'Applied', target_entity: ORG_PACK_ENTITY, mapping_version: ORG_PACK_MAPPING_VERSION, ...patch });

  it('is not found for a batch that does not exist', async () => {
    await expect(new OrgPackStore().packOfBatch(connect(emptyDb()), BATCH)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
  });

  it('refuses a batch of another entity or of another mapping, naming the field', async () => {
    const db = emptyDb();
    db.batches = [batch({ target_entity: 'PROJECT' })];
    await expect(new OrgPackStore().packOfBatch(connect(db), BATCH)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'batch_id' });
    db.batches = [batch({ mapping_version: 'other-1' })];
    await expect(new OrgPackStore().packOfBatch(connect(db), BATCH)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'batch_id' });
  });

  it.each(['Draft', 'Validated', 'Approved', 'Failed'])('refuses a batch that is %s: only an applied batch is a pack', async (status) => {
    const db = emptyDb();
    db.batches = [batch({ status })];
    const failure = await new OrgPackStore().packOfBatch(connect(db), BATCH).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'MIGRATION_STATE_INVALID', status: 409, detail: status });
    expect(db.sqls.some((sql) => sql.includes('machvon.migration_row'))).toBe(false);
  });

  it('turns the rows of an applied batch back into the pack, with no defect', async () => {
    const db = emptyDb();
    db.batches = [batch()];
    db.rows = orgPackRows(pack).map((row) => ({ business_key: row.business_key, payload: row }));
    const read = await new OrgPackStore().packOfBatch(connect(db), BATCH);
    expect(read.batchId).toBe(BATCH);
    expect(read.pack).toEqual(pack);
    expect(read.defects).toEqual([]);
    expect(read.rows).toHaveLength(db.rows.length);
    expect(read.rows[0]?.rowNumber).toBe(1);
  });

  it('reports the defects of rows that are not a whole pack instead of hiding them', async () => {
    const db = emptyDb();
    db.batches = [batch()];
    db.rows = orgPackRows(pack)
      .filter((row) => row.kind !== 'ROLE')
      .map((row) => ({ business_key: row.business_key, payload: row }));
    const read = await new OrgPackStore().packOfBatch(connect(db), BATCH);
    expect(read.defects.length).toBeGreaterThan(0);
  });
});

describe('OrgPackStore.readState', () => {
  it('adopts the root of the tenant under the code of the pack, whatever it is called there', async () => {
    const state = await new OrgPackStore().readState(connect(emptyDb()), pack);
    expect(state.units.get(ROOT_UNIT)).toEqual({ id: 'unit-root', name: 'Tenant', parentCode: null, active: true });
    expect(state.units.has('TENANT_ROOT')).toBe(false);
    expect(state.doa).toBe('NONE');
    expect(state.workflowVersions).toEqual([]);
  });

  it('gives a child of the root the parent the pack names, marks a closed unit inactive and skips a unit the pack does not name', async () => {
    const db = emptyDb();
    db.units.push({ id: 'u-1', code: PLANNING_UNIT, name: 'Planning', parent_code: 'TENANT_ROOT', status: 'Planned', is_root: false });
    db.units.push({ id: 'u-2', code: 'NM_DPM', name: 'Plant', parent_code: 'TENANT_ROOT', status: 'Closed', is_root: false });
    db.units.push({ id: 'u-3', code: 'NOT_IN_THE_PACK', name: 'Elsewhere', parent_code: 'TENANT_ROOT', status: 'Active', is_root: false });
    const { units } = await new OrgPackStore().readState(connect(db), pack);
    expect(units.get(PLANNING_UNIT)).toMatchObject({ parentCode: ROOT_UNIT, active: true });
    expect(units.get('NM_DPM')).toMatchObject({ parentCode: ROOT_UNIT, active: false });
    expect(units.has('NOT_IN_THE_PACK')).toBe(false);
  });

  it('keeps the parent as it is when the pack has no root to adopt the tenant root into', async () => {
    const db = emptyDb();
    db.units.push({ id: 'u-1', code: PLANNING_UNIT, name: 'Planning', parent_code: 'TENANT_ROOT', status: 'Active', is_root: false });
    const rootless: OrgPack = { ...pack, units: pack.units.filter((unit) => unit.parentCode !== null) };
    const { units } = await new OrgPackStore().readState(connect(db), rootless);
    expect(units.get(PLANNING_UNIT)?.parentCode).toBe('TENANT_ROOT');
    expect(units.get('TENANT_ROOT')?.id).toBe('unit-root');
  });

  it('reads the roles with their activity', async () => {
    const db = emptyDb();
    db.roles = [{ id: 'r-1', code: ROLE_APPROVER, name: 'Approver', permissions: ['a'], rank: 45, status: 'Active' }, { id: 'r-2', code: 'OTHER', name: 'Other', permissions: [], rank: 1, status: 'Retired' }];
    const { roles } = await new OrgPackStore().readState(connect(db), pack);
    expect(roles.get(ROLE_APPROVER)).toEqual({ id: 'r-1', name: 'Approver', rank: 45, permissions: ['a'], active: true });
    expect(roles.get('OTHER')?.active).toBe(false);
  });

  it('leaves out the versions of a rule that are retired or that ended on or before today, and keeps drafts, live and future ones', async () => {
    const db = emptyDb();
    db.rules[WORKFLOW] = [
      { status: 'DRAFT', params: { v: 'draft' }, effective_to: null },
      { status: 'RETIRED', params: { v: 'retired' }, effective_to: null },
      { status: 'APPROVED', params: { v: 'ended-today' }, effective_to: TODAY },
      { status: 'APPROVED', params: { v: 'ended-before' }, effective_to: '2026-01-01' },
      { status: 'APPROVED', params: { v: 'ends-tomorrow' }, effective_to: '2026-11-10' },
      { status: 'APPROVED', params: { v: 'open' }, effective_to: null },
    ];
    db.rules[ABSENCE] = [{ status: 'SUBMITTED', params: { v: 'absence' }, effective_to: null }];
    const state = await new OrgPackStore().readState(connect(db), pack);
    expect(state.workflowVersions.map((version) => (version.params as { v: string }).v)).toEqual(['draft', 'ends-tomorrow', 'open']);
    expect(state.absenceVersions).toEqual([{ status: 'SUBMITTED', params: { v: 'absence' } }]);
  });

  it('reads the entries by type and key, with their parent', async () => {
    const db = emptyDb();
    db.entries = [{ master_type: 'ISSUE_CATEGORY', business_key: 'DC_FUNDING', status: 'PUBLISHED', label: 'Funding', parent_key: 'DELAY_CAUSE' }];
    const { entries } = await new OrgPackStore().readState(connect(db), pack);
    expect(entries.get('ISSUE_CATEGORY:DC_FUNDING')).toEqual({ label: 'Funding', parentKey: 'DELAY_CAUSE', status: 'PUBLISHED' });
  });

  it('counts the holders of a seat by the scope of the grant and the unit it names, and the grants that sit in no seat as stray', async () => {
    const tenantSeat = pack.seats.find((seat) => seat.scope === 'TENANT');
    const unitSeat = pack.seats.find((seat) => seat.scope !== 'TENANT');
    expect(tenantSeat).toBeDefined();
    expect(unitSeat).toBeDefined();
    const db = completeDb();
    db.grants = [
      // a tenant-wide grant held from the unit of the seat
      { role_code: tenantSeat!.roleCode, scope_kind: tenantSeat!.scope, scope_ref_ids: null, home_unit_code: tenantSeat!.unitCode },
      // a grant to one unit, naming exactly the unit of the seat
      { role_code: unitSeat!.roleCode, scope_kind: unitSeat!.scope, scope_ref_ids: [idOfUnit(unitSeat!.unitCode)], home_unit_code: null },
      // the same role and scope on two units: wider than the seat allows
      { role_code: unitSeat!.roleCode, scope_kind: unitSeat!.scope, scope_ref_ids: [idOfUnit(unitSeat!.unitCode), 'another-unit'], home_unit_code: null },
      // a tenant-wide grant held from a unit that is not the seat's
      { role_code: tenantSeat!.roleCode, scope_kind: tenantSeat!.scope, scope_ref_ids: null, home_unit_code: 'ELSEWHERE' },
      // a unit-scoped grant that names no unit at all
      { role_code: unitSeat!.roleCode, scope_kind: unitSeat!.scope, scope_ref_ids: null, home_unit_code: null },
    ];
    const state = await new OrgPackStore().readState(connect(db), pack);
    expect(state.holders.get(`${tenantSeat!.roleCode}@${tenantSeat!.unitCode}`)).toBe(1);
    expect(state.holders.get(`${unitSeat!.roleCode}@${unitSeat!.unitCode}`)).toBe(1);
    expect(state.strayGrants).toBe(3);
  });

  describe('the matrix of authority for the document type', () => {
    const ours = { unit_id: idOfUnit(pack.doa.unitCode), approver_role_id: idOfRole(pack.doa.roleCode) };
    const doaOf = async (rows: FakeDb['doa']): Promise<string> => {
      const db = completeDb();
      db.doa = rows;
      return (await new OrgPackStore().readState(connect(db), pack)).doa;
    };

    it('is PRESENT when the published matrix has the rule with the approver of the pack', async () => {
      expect(await doaOf([{ status: 'Published', ...ours }])).toBe('PRESENT');
    });
    it('is PENDING when only a draft or a matrix waiting for approval has it', async () => {
      expect(await doaOf([{ status: 'Draft', ...ours }])).toBe('PENDING');
      expect(await doaOf([{ status: 'PendingApproval', ...ours }, { status: 'Published', unit_id: 'x', approver_role_id: 'y' }])).toBe('PENDING');
    });
    it('is OTHER_APPROVER when the published matrix names another approver or another unit for it', async () => {
      expect(await doaOf([{ status: 'Published', unit_id: ours.unit_id, approver_role_id: 'another-role' }])).toBe('OTHER_APPROVER');
      expect(await doaOf([{ status: 'Published', unit_id: 'another-unit', approver_role_id: ours.approver_role_id }])).toBe('OTHER_APPROVER');
    });
    it('is NONE when no matrix has a rule for the document type, and is never PRESENT while the unit or the role of the pack is missing from the tenant', async () => {
      expect(await doaOf([])).toBe('NONE');
      const db = emptyDb();
      db.doa = [{ status: 'Published', ...ours }];
      expect((await new OrgPackStore().readState(connect(db), pack)).doa).toBe('OTHER_APPROVER');
    });
  });
});

describe('OrgPackStore.verify', () => {
  it('says that a tenant with nothing of the pack is not complete, and counts what is missing', async () => {
    const report = await new OrgPackStore().verify(connect(emptyDb()), pack);
    expect(report.label).toBe(pack.label);
    expect(report.structureComplete).toBe(false);
    expect(report.counts.CREATE).toBeGreaterThan(0);
  });

  it('says that a tenant loaded completely is complete, with every object unchanged', async () => {
    const report = await new OrgPackStore().verify(connect(completeDb()), pack);
    expect(report.counts.CREATE).toBe(0);
    expect(report.counts.DRIFT).toBe(0);
    expect(report.counts.BLOCKED).toBe(0);
    expect(report.structureComplete).toBe(true);
  });
});

describe('OrgPackStore.materialise', () => {
  const guardNothing = (): void => undefined;

  /** The stores of the platform, with the writes landing in the fake database as they would in the real one. */
  function stores(db: FakeDb) {
    (createUnit as jest.Mock).mockImplementation(async (_tx: TenantTx, input: { code: string; name: string; parentId: string }) => {
      const id = idOfUnit(input.code);
      const parent = db.units.find((unit) => unit.id === input.parentId);
      db.units.push({ id, code: input.code, name: input.name, parent_code: parent?.code ?? null, status: 'Active', is_root: false });
      return { id, path: '', depth: 1, version: 1 };
    });
    return {
      createRole: jest.spyOn(RoleStore.prototype, 'createCustomRole').mockImplementation(async (_tx, input) => {
        db.roles.push({ id: idOfRole(input.code), code: input.code, name: input.name, permissions: [...input.permissions], rank: input.rank, status: 'Active' });
        return { id: idOfRole(input.code), version: 1 };
      }),
      createRule: jest.spyOn(GovernanceRuleStore.prototype, 'create').mockImplementation(async () => ({ id: 'rule-draft', rowVersion: 1 }) as never),
      submitRule: jest.spyOn(GovernanceRuleStore.prototype, 'submit').mockResolvedValue({} as never),
      findMatrix: jest.spyOn(DoaMatrixStore.prototype, 'find').mockResolvedValue(undefined),
      createDraft: jest.spyOn(DoaMatrixStore.prototype, 'createDraft').mockResolvedValue({ id: 'matrix-draft', revision: 1, version: 1 }),
      submitMatrix: jest.spyOn(DoaMatrixStore.prototype, 'submit').mockResolvedValue({ version: 2 }),
      propose: jest.spyOn(MasterStore.prototype, 'propose').mockImplementation(async (_tx, input) => ({ changeRequestId: `cr-${input.businessKey}`, version: 1, recordId: `rec-${input.businessKey}` }) as never),
      submitEntry: jest.spyOn(MasterStore.prototype, 'submit').mockResolvedValue({} as never),
    };
  }

  it('refuses a pack that is defective before it takes the lock or writes anything', async () => {
    const db = emptyDb();
    const spies = stores(db);
    const defective: OrgPack = { ...pack, roles: [] };
    await expect(new OrgPackStore().materialise(connect(db), defective, { actor: 'a', batchId: BATCH, guardRole: guardNothing })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(db.sqls).toEqual([]);
    expect(createUnit).not.toHaveBeenCalled();
    expect(spies.createRole).not.toHaveBeenCalled();
  });

  it('creates a tenant with only its root: units with parents first, every role after the guard, and the rules, the matrix and the entries only as proposals', async () => {
    const db = emptyDb();
    const spies = stores(db);
    const guarded: string[] = [];
    const report = await new OrgPackStore().materialise(connect(db), pack, { actor: 'actor-1', batchId: BATCH, guardRole: (role) => void guarded.push(role.code) });

    expect(db.sqls[0]).toContain('pg_advisory_xact_lock');
    const created = (createUnit as jest.Mock).mock.calls.map((call) => (call[1] as { code: string }).code);
    expect(created).toHaveLength(pack.units.length - 1);
    expect(created).not.toContain(ROOT_UNIT);
    expect((createUnit as jest.Mock).mock.calls[0]?.[1]).toMatchObject({ parentId: 'unit-root', legalBasisRef: pack.label, validFrom: TODAY });
    expect(guarded).toEqual(pack.roles.map((role) => role.code));
    expect(spies.createRole).toHaveBeenCalledTimes(pack.roles.length);
    expect(spies.createRole.mock.calls[0]?.[1]).toMatchObject({ guestAllowed: false, createdBy: 'actor-1' });

    // the policies are submitted, never approved: nobody who proposed them can put them in force
    expect(spies.createRule).toHaveBeenCalledTimes(2);
    expect(spies.createRule.mock.calls.map((call) => `${call[1].type}/${call[1].code}`)).toEqual([WORKFLOW, ABSENCE]);
    expect(spies.createRule.mock.calls[0]?.[1]).toMatchObject({ unitId: null, effectiveFrom: TODAY, effectiveTo: null });
    expect(spies.createRule.mock.calls[0]?.[1].reason).toContain(`batch ${BATCH}`);
    expect(spies.submitRule).toHaveBeenCalledTimes(2);
    expect(spies.createDraft).toHaveBeenCalledTimes(1);
    expect(spies.submitMatrix).toHaveBeenCalledWith(expect.anything(), 'matrix-draft', 1, 'actor-1');
    expect(spies.propose).toHaveBeenCalledTimes(pack.entries.length);
    expect(spies.submitEntry).toHaveBeenCalledTimes(pack.entries.length);

    const byResult = report.counts;
    expect(byResult.CREATED).toBe(report.items.length - 1);
    expect(report.items.find((item) => item.key === `UNIT:${ROOT_UNIT}`)).toMatchObject({ result: 'UNCHANGED' });
    expect(report.items.find((item) => item.key === 'UNIT:NM_DPM')).toMatchObject({ result: 'CREATED', id: idOfUnit('NM_DPM') });
    expect(report.items.find((item) => item.section === 'DOA')).toMatchObject({ result: 'CREATED', id: 'matrix-draft' });
    expect(report.label).toBe(pack.label);
    expect(report.verification.label).toBe(pack.label);
  });

  it('proposes the entries parents first, giving a child the record of its parent', async () => {
    const db = emptyDb();
    const spies = stores(db);
    await new OrgPackStore().materialise(connect(db), pack, { actor: 'a', batchId: BATCH, guardRole: guardNothing });
    const order = spies.propose.mock.calls.map((call) => `${call[1].masterType}:${call[1].businessKey}`);
    expect(order.indexOf('REPORTING_PERIOD_KIND:MONTH')).toBeLessThan(order.indexOf('REPORT_TYPE:PVN_MONTHLY'));
    expect(order.indexOf('REPORT_TYPE:PVN_MONTHLY')).toBeLessThan(order.indexOf('RECEIVING_AGENCY:PVN'));
    expect(order.indexOf('ISSUE_CATEGORY:DELAY_CAUSE')).toBeLessThan(order.indexOf('ISSUE_CATEGORY:DC_FUNDING'));
    const child = spies.propose.mock.calls.find((call) => call[1].businessKey === 'DC_FUNDING');
    expect(child?.[1].content.parentRecordId).toBe('rec-DELAY_CAUSE');
    expect(spies.propose.mock.calls[0]?.[1].reason).toContain('somebody other than who proposed it');
  });

  it('stops at the guard of a role and writes no role after it, so a person cannot create a role above what they hold', async () => {
    const db = emptyDb();
    const spies = stores(db);
    const refuse = (role: { code: string }): void => {
      if (role.code === pack.roles[1]?.code) throw new Error('role above the caller');
    };
    await expect(new OrgPackStore().materialise(connect(db), pack, { actor: 'a', batchId: BATCH, guardRole: refuse })).rejects.toThrow('role above the caller');
    expect(spies.createRole).toHaveBeenCalledTimes(1);
    expect(spies.createRule).not.toHaveBeenCalled();
    expect(spies.propose).not.toHaveBeenCalled();
  });

  it('changes nothing on a second run over a tenant that stands as the pack says', async () => {
    const db = completeDb();
    const spies = stores(db);
    const guard = jest.fn();
    const report = await new OrgPackStore().materialise(connect(db), pack, { actor: 'a', batchId: BATCH, guardRole: guard });
    expect(createUnit).not.toHaveBeenCalled();
    for (const spy of Object.values(spies)) if (spy !== spies.findMatrix) expect(spy).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(report.counts).toEqual({ CREATED: 0, UNCHANGED: report.items.length, PENDING: 0, DRIFT: 0, BLOCKED: 0 });
    expect(report.verification.structureComplete).toBe(true);
  });

  it('reports what differs from the pack as drift and what waits for approval as pending, and never overwrites either', async () => {
    const db = completeDb();
    const planning = db.units.find((unit) => unit.code === PLANNING_UNIT) as UnitRow;
    planning.name = 'Renamed by the customer';
    const closed = db.units.find((unit) => unit.code === 'NM_DPM') as UnitRow;
    closed.status = 'Closed';
    const approver = db.roles.find((role) => role.code === ROLE_APPROVER) as RoleRow;
    approver.rank = 99;
    db.rules[ABSENCE] = [{ status: 'SUBMITTED', params: pack.absence, effective_to: null }];
    db.rules[WORKFLOW] = [{ status: 'APPROVED', params: { not: 'the pack' }, effective_to: null }];
    db.doa = [{ status: 'Draft', unit_id: idOfUnit(pack.doa.unitCode), approver_role_id: idOfRole(pack.doa.roleCode) }];
    const spies = stores(db);
    const report = await new OrgPackStore().materialise(connect(db), pack, { actor: 'a', batchId: BATCH, guardRole: guardNothing });
    const resultOf = (key: string): string | undefined => report.items.find((item) => item.key === key)?.result;
    expect(resultOf(`UNIT:${PLANNING_UNIT}`)).toBe('DRIFT');
    expect(resultOf('UNIT:NM_DPM')).toBe('BLOCKED');
    expect(resultOf(`ROLE:${ROLE_APPROVER}`)).toBe('DRIFT');
    expect(resultOf('RULE:ABSENCE_POLICY:DEFAULT')).toBe('PENDING');
    expect(resultOf('RULE:APPROVAL_WORKFLOW_DEFINITION:REPORT_ACCEPT')).toBe('DRIFT');
    expect(report.items.find((item) => item.section === 'DOA')?.result).toBe('PENDING');
    expect(createUnit).not.toHaveBeenCalled();
    expect(spies.createRole).not.toHaveBeenCalled();
    expect(spies.createRule).not.toHaveBeenCalled();
    expect(spies.createDraft).not.toHaveBeenCalled();
    expect(report.verification.structureComplete).toBe(false);
  });

  it('blocks the units under a root the tenant does not have, and then refuses the matrix that has no unit to stand on', async () => {
    const db = emptyDb();
    db.units = [];
    const spies = stores(db);
    const failure = await new OrgPackStore().materialise(connect(db), pack, { actor: 'a', batchId: BATCH, guardRole: guardNothing }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'doa' });
    expect(createUnit).not.toHaveBeenCalled();
    expect(spies.createDraft).not.toHaveBeenCalled();
  });

  it('puts the rule into a matrix that carries the rules in force and starts the day after the version in force', async () => {
    const db = completeDb();
    db.doa = [];
    db.published = { id: 'matrix-in-force', effective_from: '2026-11-30' };
    const spies = stores(db);
    spies.findMatrix.mockResolvedValue({ rules: [{ document_type: 'CONTRACT', unit_id: 'u', amount_min_vnd: '100', approver_role_id: 'r' }, { document_type: 'PAYMENT', unit_id: 'u2', include_subtree: false, amount_min_vnd: '0', amount_max_vnd: '500', approver_role_id: 'r2', approval_levels: 2, requires_distinct_approvers: false }] } as never);
    await new OrgPackStore().materialise(connect(db), pack, { actor: 'a', batchId: BATCH, guardRole: guardNothing });
    const draft = spies.createDraft.mock.calls[0]?.[1];
    expect(draft?.effective_from).toBe('2026-12-01');
    expect(draft?.legal_basis_ref).toBe(pack.label);
    expect(draft?.rules).toHaveLength(3);
    // a rule of the matrix in force is carried with the defaults the framework applies, and one with its own values keeps them
    expect(draft?.rules[0]).toEqual({ document_type: 'CONTRACT', unit_id: 'u', include_subtree: true, amount_min_vnd: '100', amount_max_vnd: null, approver_role_id: 'r', approval_levels: 1, requires_distinct_approvers: true });
    expect(draft?.rules[1]).toEqual({ document_type: 'PAYMENT', unit_id: 'u2', include_subtree: false, amount_min_vnd: '0', amount_max_vnd: '500', approver_role_id: 'r2', approval_levels: 2, requires_distinct_approvers: false });
    expect(draft?.rules[2]).toMatchObject({ document_type: pack.doa.documentType, unit_id: idOfUnit(pack.doa.unitCode), approver_role_id: idOfRole(pack.doa.roleCode) });
  });

  it('starts the matrix today when none is in force', async () => {
    const db = completeDb();
    db.doa = [];
    const spies = stores(db);
    await new OrgPackStore().materialise(connect(db), pack, { actor: 'a', batchId: BATCH, guardRole: guardNothing });
    expect(spies.findMatrix).not.toHaveBeenCalled();
    expect(spies.createDraft.mock.calls[0]?.[1].effective_from).toBe(TODAY);
    expect(spies.createDraft.mock.calls[0]?.[1].rules).toHaveLength(1);
  });

  it('finds the parent of an entry among the records of the tenant when it was not created in this run, and blocks the child when there is none', async () => {
    const delayCause = pack.entries.find((entry) => entry.key === 'DELAY_CAUSE');
    expect(delayCause).toBeDefined();
    const withParent = (): FakeDb => {
      const db = completeDb();
      // the parent exists and waits for review; its children do not exist
      db.entries = db.entries.filter((entry) => !entry.business_key.startsWith('DC_'));
      db.entries = db.entries.map((entry) => (entry.business_key === 'DELAY_CAUSE' ? { ...entry, status: 'IN_REVIEW' } : entry));
      return db;
    };

    const found = withParent();
    found.records['ISSUE_CATEGORY:DELAY_CAUSE'] = 'record-of-parent';
    const spies = stores(found);
    const report = await new OrgPackStore().materialise(connect(found), pack, { actor: 'a', batchId: BATCH, guardRole: guardNothing });
    expect(spies.propose.mock.calls.every((call) => call[1].content.parentRecordId === 'record-of-parent')).toBe(true);
    expect(spies.propose).toHaveBeenCalledTimes(pack.entries.filter((entry) => entry.key.startsWith('DC_')).length);
    expect(report.items.find((item) => item.key === 'ENTRY:ISSUE_CATEGORY:DELAY_CAUSE')?.result).toBe('PENDING');

    jest.restoreAllMocks();
    jest.spyOn(GovernanceRuleStore.prototype, 'today').mockResolvedValue(TODAY);
    const lost = withParent();
    const none = stores(lost);
    const blocked = await new OrgPackStore().materialise(connect(lost), pack, { actor: 'a', batchId: BATCH, guardRole: guardNothing });
    expect(none.propose).not.toHaveBeenCalled();
    const children = blocked.items.filter((item) => item.key.startsWith('ENTRY:ISSUE_CATEGORY:DC_'));
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((item) => item.result === 'BLOCKED' && item.detail === 'the parent entry does not exist')).toBe(true);
  });
});
