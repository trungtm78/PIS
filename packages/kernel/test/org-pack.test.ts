import { absencePolicyDefaults } from '../src/alert-coverage.ts';
import { MIGRATION_MAPPINGS, judgeMigrationFile, registerMigrationMapping } from '../src/migration-batch.ts';
import {
  ORG_PACK_COLUMNS,
  ORG_PACK_MAPPING,
  directoryGroupOf,
  directoryMappings,
  judgeOrgPack,
  judgeOrgPackRows,
  orgPackCsv,
  orgPackDigest,
  orgPackOfRows,
  orgPackRows,
  planOrgPack,
  seatKey,
  seatReports,
  unitKey,
  verifyOrgPack,
  workflowRuleParams,
} from '../src/org-pack.ts';
import type { OrgPack, OrgPackState, PackRow, PackRole, PackSeat } from '../src/org-pack.ts';
import { readTabularFile } from '../src/tabular-file.ts';

const ENTRY_PERMISSIONS = ['ind.entry', 'ind.read', 'report.create', 'report.submit', 'report.read', 'iam.delegation.create'];
const APPROVER_PERMISSIONS = ['approval.decide', 'report.review', 'report.read', 'ind.read', 'iam.delegation.create'];

const roles: PackRole[] = [
  { code: 'T_ENTRY', name: 'Entry', kind: 'ENTRY', rank: 30, permissions: ENTRY_PERMISSIONS },
  { code: 'T_APPROVER', name: 'Approver', kind: 'UNIT_APPROVER', rank: 40, permissions: APPROVER_PERMISSIONS },
  { code: 'T_PLANNER', name: 'Planner', kind: 'PLANNING_REVIEWER', rank: 50, permissions: ['approval.decide', 'report.review', 'period.lock', 'hpm.push', 'report.read'] },
  { code: 'T_VIEWER', name: 'Viewer', kind: 'LEADERSHIP_VIEWER', rank: 20, permissions: ['home.read', 'report.read', 'bi.query'] },
  { code: 'T_ADMIN', name: 'Admin', kind: 'ADMINISTRATOR', rank: 70, permissions: ['iam.role.manage', 'adm.migration.manage', 'adm.migration.approve'] },
];

const seat = (roleCode: string, unitCode: string, scope: PackSeat['scope'], min = 1, max = 1): PackSeat => ({ roleCode, unitCode, scope, minHolders: min, maxHolders: max });

function basePack(): OrgPack {
  return {
    label: 'TEST-TEMPLATE',
    directoryPrefix: 'MACHVON-TEST',
    units: [
      { code: 'ROOT', name: 'Root', parentCode: null, function: 'ROOT', placeholder: false },
      { code: 'PLAN', name: 'Planning', parentCode: 'ROOT', function: 'AGGREGATOR', placeholder: false },
      { code: 'ONE', name: 'Point one', parentCode: 'ROOT', function: 'INPUT_POINT', placeholder: false },
      { code: 'TWO', name: 'Point two', parentCode: 'ROOT', function: 'INPUT_POINT', placeholder: true },
      { code: 'BOARD', name: 'Board', parentCode: 'ROOT', function: 'LEADERSHIP', placeholder: false },
      { code: 'IT', name: 'IT', parentCode: 'ROOT', function: 'ADMINISTRATION', placeholder: false },
    ],
    roles,
    seats: [
      seat('T_ENTRY', 'ONE', 'UNIT_ONLY'),
      seat('T_APPROVER', 'ONE', 'UNIT_ONLY'),
      seat('T_ENTRY', 'TWO', 'UNIT_ONLY'),
      seat('T_APPROVER', 'TWO', 'UNIT_ONLY'),
      seat('T_PLANNER', 'PLAN', 'TENANT', 2, 4),
      seat('T_VIEWER', 'BOARD', 'TENANT', 1, 5),
      seat('T_ADMIN', 'IT', 'TENANT', 2, 4),
    ],
    steps: [
      { id: 'unit-approver', kind: 'UNIT_APPROVER', name: 'Unit approval', assignee: 'DOA', slaWorkingHours: 24, onTimeout: 'REMIND' },
      { id: 'planning-review', kind: 'PLANNING_REVIEW', name: 'Planning review', assignee: 'ROLE_IN_UNIT', roleCode: 'T_PLANNER', unitCode: 'PLAN', slaWorkingHours: 16, onTimeout: 'REMIND' },
      { id: 'period-close', kind: 'PERIOD_CLOSE', name: 'Close', assignee: 'ROLE_IN_UNIT', roleCode: 'T_PLANNER', unitCode: 'PLAN', slaWorkingHours: 8, onTimeout: 'REMIND' },
      { id: 'push', kind: 'PUSH', name: 'Push', assignee: 'ROLE_IN_UNIT', roleCode: 'T_PLANNER', unitCode: 'PLAN', slaWorkingHours: 8, onTimeout: 'REMIND' },
    ],
    delegation: { delegableRoles: ['T_ENTRY', 'T_APPROVER'], maxDays: 90, standingReviewDays: 180 },
    absence: { ...absencePolicyDefaults(), min_role_holders: 1 },
    doa: { documentType: 'REPORT_ACCEPT', unitCode: 'ROOT', roleCode: 'T_APPROVER', approvalLevels: 1 },
    entries: [
      { masterType: 'ISSUE_CATEGORY', key: 'CAUSE', label: 'Causes', parentKey: null, attributes: {} },
      { masterType: 'ISSUE_CATEGORY', key: 'CAUSE_LAND', label: 'Land', parentKey: 'CAUSE', attributes: {} },
    ],
  };
}

const codes = (pack: OrgPack): string[] => judgeOrgPack(pack).map((defect) => defect.code);
const without = <T>(list: readonly T[], at: (item: T) => boolean): T[] => list.filter((item) => !at(item));

describe('the organisation pack (ENT-3d, HT.02 HT.03 QT.01)', () => {
  it('accepts a whole pack', () => {
    expect(judgeOrgPack(basePack())).toEqual([]);
  });

  describe('the tree of units', () => {
    it('needs one root, known parents, no cycle and at most 8 levels', () => {
      const pack = basePack();
      expect(codes({ ...pack, units: pack.units.map((unit) => (unit.code === 'ONE' ? { ...unit, parentCode: 'NOBODY' } : unit)) })).toContain('UNIT_PARENT');
      expect(codes({ ...pack, units: pack.units.map((unit) => (unit.code === 'PLAN' ? { ...unit, parentCode: null } : unit)) })).toContain('UNIT_ROOT');
      expect(codes({ ...pack, units: pack.units.map((unit) => (unit.code === 'ROOT' ? { ...unit, parentCode: 'ONE' } : unit)) })).toEqual(expect.arrayContaining(['UNIT_ROOT']));
      const chain = Array.from({ length: 10 }, (_, index) => ({ code: `L${index}`, name: `Level ${index}`, parentCode: index === 0 ? 'ROOT' : `L${index - 1}`, function: 'INPUT_POINT' as const, placeholder: false }));
      expect(codes({ ...pack, units: [...pack.units, ...chain] })).toContain('UNIT_DEPTH');
      const cycle = [
        { code: 'CA', name: 'A', parentCode: 'CB', function: 'INPUT_POINT' as const, placeholder: false },
        { code: 'CB', name: 'B', parentCode: 'CA', function: 'INPUT_POINT' as const, placeholder: false },
      ];
      expect(codes({ ...pack, units: [...pack.units, ...cycle] })).toContain('UNIT_CYCLE');
    });

    it('needs exactly one aggregating unit, an input point, and lets only an input point wait for its name', () => {
      const pack = basePack();
      expect(codes({ ...pack, units: pack.units.map((unit) => (unit.code === 'PLAN' ? { ...unit, function: 'INPUT_POINT' } : unit)) })).toContain('AGGREGATOR');
      expect(codes({ ...pack, units: pack.units.map((unit) => (unit.code === 'BOARD' ? { ...unit, placeholder: true } : unit)) })).toContain('UNIT_PLACEHOLDER');
      expect(codes({ ...pack, units: [...pack.units, { ...(pack.units[2] as never as object), code: 'ONE' } as never] })).toContain('UNIT_DUPLICATE');
    });
  });

  describe('the roles and the segregation of duties (HT.02)', () => {
    it('lets the leadership role read and nothing else', () => {
      const pack = basePack();
      const viewer = { ...(roles[3] as PackRole), permissions: ['home.read', 'report.create'] };
      expect(codes({ ...pack, roles: [...roles.slice(0, 3), viewer, roles[4] as PackRole] })).toContain('SOD_VIEWER_WRITES');
    });

    it('keeps decisions away from entry, administration and the viewers', () => {
      const pack = basePack();
      const entry = { ...(roles[0] as PackRole), permissions: [...ENTRY_PERMISSIONS, 'approval.decide'] };
      expect(judgeOrgPack({ ...pack, roles: [entry, ...roles.slice(1)] }).filter((defect) => defect.code === 'SOD_DECIDES')).toHaveLength(1);
      const admin = { ...(roles[4] as PackRole), permissions: ['iam.role.manage', 'rpt.*'] };
      expect(codes({ ...pack, roles: [...roles.slice(0, 4), admin] })).toContain('SOD_DECIDES');
    });

    it('keeps the approver from entering and from closing the period, and the planner from entering', () => {
      const pack = basePack();
      const approver = { ...(roles[1] as PackRole), permissions: [...APPROVER_PERMISSIONS, 'ind.entry', 'period.lock'] };
      const found = codes({ ...pack, roles: [roles[0] as PackRole, approver, ...roles.slice(2)] });
      expect(found).toEqual(expect.arrayContaining(['SOD_ENTRY_APPROVER', 'SOD_APPROVER_CLOSES']));
      const planner = { ...(roles[2] as PackRole), permissions: [...(roles[2] as PackRole).permissions, 'report.create'] };
      expect(codes({ ...pack, roles: [roles[0] as PackRole, roles[1] as PackRole, planner, ...roles.slice(3)] })).toContain('SOD_ENTRY_PLANNER');
    });

    it('wants one role of each kind, a rank below the administrators and no control plane permission', () => {
      const pack = basePack();
      expect(codes({ ...pack, roles: roles.slice(0, 4) })).toContain('ROLE_KIND_COUNT');
      expect(codes({ ...pack, roles: [{ ...(roles[0] as PackRole), rank: 95 }, ...roles.slice(1)] })).toContain('ROLE_RANK');
      expect(codes({ ...pack, roles: [{ ...(roles[0] as PackRole), permissions: ['system.tenant.create'] }, ...roles.slice(1)] })).toContain('ROLE_PERMISSIONS');
    });

    it('wants the roles whose work can be delegated to hold the right to delegate (HT.03)', () => {
      const pack = basePack();
      const entry = { ...(roles[0] as PackRole), permissions: ENTRY_PERMISSIONS.filter((name) => name !== 'iam.delegation.create') };
      expect(codes({ ...pack, roles: [entry, ...roles.slice(1)] })).toContain('DELEGATION_RIGHT');
      expect(codes({ ...pack, delegation: { ...pack.delegation, delegableRoles: ['T_ADMIN'] } })).toContain('DELEGATION_ROLE');
      expect(codes({ ...pack, delegation: { ...pack.delegation, maxDays: 91 } })).toContain('DELEGATION_DAYS');
      expect(codes({ ...pack, delegation: { ...pack.delegation, standingReviewDays: 400 } })).toContain('DELEGATION_REVIEW');
    });
  });

  describe('the seats (HT.02: a unit enters and sees only its own, the planning unit and the leadership see all)', () => {
    it('holds the entry and the approval in the unit and for the unit only', () => {
      const pack = basePack();
      const wide = pack.seats.map((one) => (one.roleCode === 'T_ENTRY' && one.unitCode === 'ONE' ? { ...one, scope: 'TENANT' as const } : one));
      expect(codes({ ...pack, seats: wide })).toContain('SEAT_SCOPE');
      const planner = pack.seats.map((one) => (one.roleCode === 'T_PLANNER' ? { ...one, scope: 'UNIT_ONLY' as const } : one));
      expect(codes({ ...pack, seats: planner })).toContain('SEAT_SCOPE');
      const wrongUnit = pack.seats.map((one) => (one.roleCode === 'T_VIEWER' ? { ...one, unitCode: 'ONE' } : one));
      expect(codes({ ...pack, seats: wrongUnit })).toContain('SEAT_UNIT_FUNCTION');
    });

    it('gives each input point one entry seat and one approval seat of one holder each', () => {
      const pack = basePack();
      expect(codes({ ...pack, seats: without(pack.seats, (one) => one.roleCode === 'T_APPROVER' && one.unitCode === 'TWO') })).toContain('SEAT_INPUT_POINT');
      expect(codes({ ...pack, seats: pack.seats.map((one) => (one.roleCode === 'T_ENTRY' && one.unitCode === 'ONE' ? { ...one, maxHolders: 2 } : one)) })).toContain('SEAT_INPUT_POINT');
    });

    it('wants at least two planning reviewers and two administrators, and a viewer seat in the leadership unit', () => {
      const pack = basePack();
      expect(codes({ ...pack, seats: pack.seats.map((one) => (one.roleCode === 'T_PLANNER' ? { ...one, minHolders: 1 } : one)) })).toContain('SEAT_MIN_HOLDERS');
      expect(codes({ ...pack, seats: pack.seats.map((one) => (one.roleCode === 'T_ADMIN' ? { ...one, minHolders: 1 } : one)) })).toContain('SEAT_MIN_HOLDERS');
      expect(codes({ ...pack, seats: without(pack.seats, (one) => one.roleCode === 'T_VIEWER') })).toContain('SEAT_MISSING');
    });

    it('names a directory group for each seat inside the directory filter, none twice', () => {
      const pack = basePack();
      const mappings = directoryMappings(pack);
      expect(mappings).toHaveLength(pack.seats.length);
      expect(mappings.map((one) => one.adGroup)).toEqual(expect.arrayContaining(['MACHVON-TEST-ONE-ENTRY', 'MACHVON-TEST-ONE-APPROVER', 'MACHVON-TEST-PLAN-REVIEW', 'MACHVON-TEST-BOARD-LEADER', 'MACHVON-TEST-IT-ADMIN']));
      expect(new Set(mappings.map((one) => one.adGroup)).size).toBe(mappings.length);
      expect(directoryGroupOf(pack, { kind: 'ENTRY' }, 'A_B')).toBe('MACHVON-TEST-A-B-ENTRY');
      expect(codes({ ...pack, directoryPrefix: 'OTHER-TEST' })).toContain('DIRECTORY_PREFIX');
    });
  });

  describe('the staged approval (QT.01)', () => {
    it('is the chain of the platform, each step with a deadline in working hours', () => {
      const pack = basePack();
      expect(codes({ ...pack, steps: without(pack.steps, (step) => step.kind === 'PERIOD_CLOSE') })).toEqual([]);
      expect(codes({ ...pack, steps: [...pack.steps].reverse() })).toEqual(expect.arrayContaining(['STEP_CHAIN']));
      expect(codes({ ...pack, steps: pack.steps.map((step) => (step.id === 'push' ? { ...step, slaWorkingHours: 0 } : step)) })).toContain('STEP_DEADLINE');
      expect(codes({ ...pack, steps: pack.steps.map((step) => (step.id === 'push' ? { ...step, slaWorkingHours: 721 } : step)) })).toContain('STEP_DEADLINE');
    });

    it('holds the planning steps by the planning role in the planning unit and takes the unit approver from the matrix', () => {
      const pack = basePack();
      expect(codes({ ...pack, steps: pack.steps.map((step) => (step.id === 'push' ? { ...step, roleCode: 'T_ADMIN' } : step)) })).toContain('STEP_ROLE');
      expect(codes({ ...pack, steps: pack.steps.map((step) => (step.id === 'push' ? { ...step, unitCode: 'ONE' } : step)) })).toContain('STEP_UNIT');
      expect(codes({ ...pack, steps: pack.steps.map((step) => (step.id === 'planning-review' ? { ...step, assignee: 'DOA' as const } : step)) })).toContain('STEP_ASSIGNEE');
    });

    it('builds the rule params with the real unit ids and no person', () => {
      const params = workflowRuleParams(basePack(), new Map([['PLAN', '11111111-1111-4111-8111-111111111111']]));
      expect(params).toMatchObject({ mode: 'STAGED' });
      const steps = params.steps as Array<Record<string, unknown>>;
      expect(steps.map((step) => step.kind)).toEqual(['UNIT_APPROVER', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH']);
      expect(steps[0]).not.toHaveProperty('unit_id');
      expect(steps[1]).toMatchObject({ assignee_type: 'ROLE_IN_UNIT', role_code: 'T_PLANNER', unit_id: '11111111-1111-4111-8111-111111111111' });
      expect(JSON.stringify(params)).not.toContain('membership_ids');
      expect(JSON.stringify(params)).not.toContain('escalate_to');
    });
  });

  it('judges the absence policy, the matrix rule and the catalogue trees', () => {
    const pack = basePack();
    expect(codes({ ...pack, absence: { ...pack.absence, max_cover_days: 999 } })).toContain('ABSENCE_POLICY');
    expect(codes({ ...pack, doa: { ...pack.doa, roleCode: 'T_ENTRY' } })).toContain('DOA_ROLE');
    expect(codes({ ...pack, doa: { ...pack.doa, unitCode: 'ONE' } })).toContain('DOA_UNIT');
    expect(codes({ ...pack, doa: { ...pack.doa, documentType: 'PAYMENT' } })).toContain('DOA_DOCUMENT');
    expect(codes({ ...pack, entries: [...pack.entries, { masterType: 'ISSUE_CATEGORY', key: 'LOST', label: 'Lost', parentKey: 'NOWHERE', attributes: {} }] })).toContain('ENTRY_PARENT');
    expect(codes({ ...pack, entries: [...pack.entries, pack.entries[0] as never] })).toContain('ENTRY_DUPLICATE');
    expect(codes({ ...pack, label: 'lower' })).toContain('PACK_LABEL');
  });

  describe('the file (the real import path)', () => {
    const rowsOf = (pack: OrgPack): PackRow[] => orgPackRows(pack).map((row, index) => ({ rowNumber: index + 1, businessKey: row.business_key, payload: Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '')) }));

    it('turns a pack into rows and the rows back into the same pack', () => {
      const pack = basePack();
      const back = orgPackOfRows(rowsOf(pack));
      expect(back.defects).toEqual([]);
      expect(back.pack).toEqual(pack);
      expect(orgPackDigest(back.pack)).toBe(orgPackDigest(pack));
      expect(judgeOrgPackRows(rowsOf(pack))).toEqual([]);
    });

    it('has a digest that follows the content and not the order of the rows', () => {
      const pack = basePack();
      expect(orgPackDigest(pack)).toBe(orgPackDigest({ ...pack, units: [...pack.units].reverse() }));
      expect(orgPackDigest(pack)).not.toBe(orgPackDigest({ ...pack, label: 'OTHER-TEMPLATE' }));
    });

    it('is a table file that the batch judge reads, with the control totals of its rows', () => {
      const pack = basePack();
      const table = readTabularFile(new TextEncoder().encode(orgPackCsv(pack)));
      expect(table.headers).toEqual([...ORG_PACK_COLUMNS]);
      const judged = judgeMigrationFile(table, ORG_PACK_MAPPING);
      expect(judged.errors).toEqual([]);
      expect(judged.rowCount).toBe(orgPackRows(pack).length);
      expect(judged.totals).toEqual({ rows: orgPackRows(pack).length, amount: '0' });
    });

    it('reports a pack that breaks a rule on the row it breaks, and writes none of its rows', () => {
      const pack = basePack();
      const broken = { ...pack, seats: pack.seats.map((one) => (one.roleCode === 'T_ENTRY' && one.unitCode === 'ONE' ? { ...one, scope: 'TENANT' as const } : one)) };
      const table = readTabularFile(new TextEncoder().encode(orgPackCsv(broken)));
      const judged = judgeMigrationFile(table, ORG_PACK_MAPPING);
      expect(judged.errors.map((error) => [error.code, error.field])).toEqual([['PACK_INVALID', 'data.scope']]);
      expect(judged.errors[0]?.message).toContain('SEAT_SCOPE');
      const at = orgPackRows(broken).findIndex((row) => row.business_key === seatKey('T_ENTRY', 'ONE'));
      expect(judged.errors[0]?.rowNumber).toBe(at + 1);
      expect(judged.rows).toHaveLength(orgPackRows(broken).length - 1);
    });

    it('reports a cell that is not what its kind needs and a file that mixes two packs', () => {
      const rows = rowsOf(basePack());
      const unitRow = rows.find((row) => row.businessKey === unitKey('ONE')) as PackRow;
      const damaged = rows.map((row) => (row === unitRow ? { ...row, payload: { ...row.payload, data: '{not json' } } : row));
      expect(judgeOrgPackRows(damaged).map((defect) => defect.code)).toContain('DATA_NOT_JSON');
      const mixed = rows.map((row, index) => (index === 3 ? { ...row, payload: { ...row.payload, pack: 'OTHER-TEMPLATE' } } : row));
      expect(judgeOrgPackRows(mixed).map((defect) => defect.code)).toContain('PACK_LABEL');
      const renamed = rows.map((row) => (row === unitRow ? { ...row, businessKey: 'UNIT:OTHER' } : row));
      expect(judgeOrgPackRows(renamed).map((defect) => defect.code)).not.toEqual([]);
    });

    it('registers its mapping once for the process and refuses another under the same version', () => {
      registerMigrationMapping(ORG_PACK_MAPPING);
      registerMigrationMapping(ORG_PACK_MAPPING);
      expect(MIGRATION_MAPPINGS.get('ORG-PACK-1')).toBe(ORG_PACK_MAPPING);
      expect(() => registerMigrationMapping({ ...ORG_PACK_MAPPING })).toThrow('already registered');
    });
  });

  describe('the plan and the verification', () => {
    const emptyState = (): OrgPackState => ({ units: new Map(), roles: new Map(), workflowVersions: [], absenceVersions: [], doa: 'NONE', entries: new Map(), holders: new Map() });

    function fullState(pack: OrgPack): OrgPackState {
      const ids = new Map(pack.units.map((unit, index) => [unit.code, `00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`]));
      return {
        units: new Map(pack.units.map((unit) => [unit.code, { id: ids.get(unit.code) as string, name: unit.name, parentCode: unit.parentCode, active: true }])),
        roles: new Map(pack.roles.map((role, index) => [role.code, { id: `role-${index}`, name: role.name, rank: role.rank, permissions: [...role.permissions], active: true }])),
        workflowVersions: [{ status: 'APPROVED', params: workflowRuleParams(pack, ids) }],
        absenceVersions: [{ status: 'APPROVED', params: pack.absence }],
        doa: 'PRESENT',
        entries: new Map(pack.entries.map((entry) => [`${entry.masterType}:${entry.key}`, { label: entry.label, parentKey: entry.parentKey, status: 'EFFECTIVE' }])),
        holders: new Map(pack.seats.map((one) => [`${one.roleCode}@${one.unitCode}`, one.minHolders])),
      };
    }

    it('creates everything in an empty tenant', () => {
      const plan = planOrgPack(basePack(), emptyState());
      expect(new Set(plan.map((item) => item.action))).toEqual(new Set(['CREATE']));
      expect(plan.filter((item) => item.section === 'UNIT')).toHaveLength(6);
      expect(plan.map((item) => item.section)).toEqual(expect.arrayContaining(['UNIT', 'ROLE', 'WORKFLOW', 'ABSENCE', 'DOA', 'ENTRY']));
    });

    it('changes nothing in a tenant that has the pack: a second load is a no-op', () => {
      const pack = basePack();
      const report = verifyOrgPack(pack, fullState(pack));
      expect(report.counts).toEqual({ CREATE: 0, UNCHANGED: report.items.length, PENDING: 0, DRIFT: 0, BLOCKED: 0 });
      expect(report.structureComplete).toBe(true);
      expect(report.seatCounts).toEqual({ VACANT: 0, FILLED: pack.seats.length, OVER: 0 });
    });

    it('reports drift and never asks to overwrite', () => {
      const pack = basePack();
      const state = fullState(pack);
      const units = new Map(state.units);
      units.set('ONE', { ...(units.get('ONE') as never as { id: string; name: string; parentCode: string | null; active: boolean }), name: 'Renamed by the customer' });
      const rolesNow = new Map(state.roles);
      rolesNow.set('T_ENTRY', { ...(rolesNow.get('T_ENTRY') as never as { id: string; name: string; rank: number; permissions: string[]; active: boolean }), permissions: ['ind.read'] });
      const plan = planOrgPack(pack, { ...state, units, roles: rolesNow, doa: 'OTHER_APPROVER', workflowVersions: [{ status: 'APPROVED', params: { mode: 'SINGLE_DECISION', steps: [] } }] });
      expect(plan.filter((item) => item.action === 'DRIFT').map((item) => item.key).sort()).toEqual(['DOA:REPORT_ACCEPT', 'ROLE:T_ENTRY', 'RULE:APPROVAL_WORKFLOW_DEFINITION:REPORT_ACCEPT', 'UNIT:ONE'].sort());
      expect(plan.some((item) => item.action === 'CREATE')).toBe(false);
    });

    it('counts a proposal that waits for approval as pending and a retired entry as blocked', () => {
      const pack = basePack();
      const state = fullState(pack);
      const entries = new Map(state.entries);
      entries.set('ISSUE_CATEGORY:CAUSE', { label: 'Causes', parentKey: null, status: 'IN_REVIEW' });
      entries.set('ISSUE_CATEGORY:CAUSE_LAND', { label: 'Land', parentKey: 'CAUSE', status: 'RETIRED' });
      const plan = planOrgPack(pack, { ...state, entries, doa: 'PENDING', absenceVersions: [{ status: 'SUBMITTED', params: pack.absence }] });
      expect(plan.find((item) => item.key === 'ENTRY:ISSUE_CATEGORY:CAUSE')?.action).toBe('PENDING');
      expect(plan.find((item) => item.key === 'ENTRY:ISSUE_CATEGORY:CAUSE_LAND')?.action).toBe('BLOCKED');
      expect(plan.find((item) => item.section === 'DOA')?.action).toBe('PENDING');
      expect(plan.find((item) => item.section === 'ABSENCE')?.action).toBe('PENDING');
    });

    it('can go red: a seat nobody holds is vacant, a seat over its limit is over', () => {
      const pack = basePack();
      const state = fullState(pack);
      const holders = new Map(state.holders);
      holders.set('T_ENTRY@ONE', 0);
      holders.set('T_APPROVER@TWO', 3);
      const seats = seatReports(pack, { holders });
      expect(seats.find((one) => one.key === 'SEAT:T_ENTRY@ONE')).toMatchObject({ state: 'VACANT', holders: 0, adGroup: 'MACHVON-TEST-ONE-ENTRY' });
      expect(seats.find((one) => one.key === 'SEAT:T_APPROVER@TWO')?.state).toBe('OVER');
      const report = verifyOrgPack(pack, { ...state, holders });
      expect(report.seatCounts).toMatchObject({ VACANT: 1, OVER: 1 });
    });

    it('does not claim the workflow rule can be written before the units exist', () => {
      const plan = planOrgPack(basePack(), emptyState());
      expect(plan.find((item) => item.section === 'WORKFLOW')).toMatchObject({ action: 'CREATE', detail: expect.stringContaining('planning unit') });
    });
  });
});
