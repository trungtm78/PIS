import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { PmtDossierStore, dossierScope } from '../src/pmt-dossier-store';
import type { PermitProjectPlace } from '../src/pmt-dossier-store';
import { PmtPermitStore, validityEnd } from '../src/pmt-permit-store';
import type { DecisionInput } from '../src/pmt-permit-store';
import { PmtPermitTypeStore } from '../src/pmt-permit-type-store';
import type { PermitTypeInput } from '../src/pmt-permit-type-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const TODAY = '2026-10-24';
let clock = TODAY;
const types = new PmtPermitTypeStore({ today: () => TODAY });
const dossiers = new PmtDossierStore({ today: () => clock });
const permits = new PmtPermitStore(dossiers);
const ACTOR = 1;
const COLLEAGUE = 2;
const NOW = new Date();
const READ = 'permit.read';
// Units: 1 is the province (/u1/), 2 the department below it (/u1/u2/), 3 another branch (/u3/).
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;

const FAMILY = 0x93;
const DOCUMENT = id(FAMILY, 31);
const SECOND_DOCUMENT = id(FAMILY, 32);
const INFECTED_DOCUMENT = id(FAMILY, 33);
const DOCUMENT_ROW = id(FAMILY, 34);
const ABSENT = id(FAMILY, 99);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as Refusal;
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

/** The SQLSTATE and the message of a statement the database refuses (the owner connection autocommits). */
async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const EVERYWHERE = dossierScope(grant(READ, { kind: 'TENANT' }), READ, NOW);

async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // Foreign keys to the modules this story only reads are out of scope here, so the superuser seeds with them switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function seedTenant(tenant: string): Promise<void> {
  await seedAs([
    [
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'GP', 'Permit scan', 'INTERNAL', $3, $3)`,
      [tenant, DOCUMENT_ROW, memberId(ACTOR)],
    ],
    [
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
       values ($1, $2, $5, 1, 'tenants/pmt/a.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
              ($1, $3, $5, 2, 'tenants/pmt/b.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
              ($1, $4, $5, 3, 'tenants/pmt/c.pdf', repeat('c', 64), 'application/pdf', 1, 'INTERNAL', 'INFECTED', '{}'::jsonb, 'RENDERED_FINAL')`,
      [tenant, DOCUMENT, SECOND_DOCUMENT, INFECTED_DOCUMENT, DOCUMENT_ROW],
    ],
  ]);
}

let projects = 0;
interface ProjectOptions {
  group?: string;
  vnd?: string;
  /** The unit that owns the project (and, with the province above it, invests in it). */
  unit?: number;
  tenant?: string;
}

/** A project of its own, so that no test depends on the dossier another test left. */
async function freshProject(options: ProjectOptions = {}): Promise<string> {
  projects += 1;
  const projectId = id(FAMILY, 100 + projects);
  await seedAs([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', $8::numeric, 'IMPLEMENTATION', 1, $9)`,
      [
        options.tenant ?? TENANT_A,
        projectId,
        `PRJ-T-${String(projects).padStart(3, '0')}`,
        `Test project ${projects}`,
        unitId(options.unit ?? DEPARTMENT),
        unitId(PROVINCE),
        id(FAMILY, 42),
        options.vnd ?? '1000000',
        options.group ?? 'B',
      ],
    ],
  ]);
  return projectId;
}

const typeInput = (code: string, overrides: Partial<PermitTypeInput> = {}): PermitTypeInput => ({
  code,
  name: `Permit type ${code}`,
  category: 'CONSTRUCTION_PERMIT',
  authorityText: 'The authority the regulation names',
  legalBasis: 'Fixture decree, article 1',
  effectiveFrom: '2026-01-01',
  appliesToRule: {},
  ...overrides,
});
const publishType = (data: PermitTypeInput) => as((tx) => types.publish(tx, data, memberId(ACTOR)));

// The codes of the catalogue the dossiers are opened against.
const EVERY = 'EVERY_PROJECT'; // applies to every project; 12 months of validity, 30 days of processing, may be exempted
const UNCONFIRMED = 'WAITS_FOR_LAW'; // applies to every project, still waits for its legal confirmation
const BIG_ONLY = 'BIG_PROJECTS'; // from 5 trillion VND on
const GROUP_A = 'GROUP_A_ONLY'; // projects of group A
const NOT_PLANNED = 'NEVER_PLANNED'; // applies only to group C: the projects of the tests are never planned it, it is added by hand
const REVISED = 'REVISED_TYPE'; // like NEVER_PLANNED; the test that revises it owns it
const ENDING = 'ENDING_TYPE'; // like NEVER_PLANNED; the test that ends it owns it
const LATER = 'STARTS_LATER'; // begins after today
const ENDED = 'ENDED_ALREADY'; // ended before today
const ids: Record<string, string> = {};
const GROUP_C_ONLY = { project_group_keys: ['C'] };

async function seedTypes(): Promise<void> {
  ids[EVERY] = (await publishType(typeInput(EVERY, { defaultValidityMonths: 12, defaultProcessingDays: 30, exemptionAllowed: true }))).id;
  ids[UNCONFIRMED] = (await publishType(typeInput(UNCONFIRMED, { cxnRef: 'CXN-EXE-03' }))).id;
  ids[BIG_ONLY] = (await publishType(typeInput(BIG_ONLY, { appliesToRule: { min_total_investment_vnd: '5000000000000' } }))).id;
  ids[GROUP_A] = (await publishType(typeInput(GROUP_A, { appliesToRule: { project_group_keys: ['A'] } }))).id;
  ids[NOT_PLANNED] = (await publishType(typeInput(NOT_PLANNED, { appliesToRule: GROUP_C_ONLY, defaultValidityMonths: 6 }))).id;
  ids[REVISED] = (await publishType(typeInput(REVISED, { appliesToRule: GROUP_C_ONLY }))).id;
  ids[ENDING] = (await publishType(typeInput(ENDING, { appliesToRule: GROUP_C_ONLY }))).id;
  ids[LATER] = (await publishType(typeInput(LATER, { effectiveFrom: '2027-01-01', appliesToRule: GROUP_C_ONLY }))).id;
  ids[ENDED] = (await publishType(typeInput(ENDED, { effectiveFrom: '2025-01-01', effectiveUntil: '2026-06-30', appliesToRule: GROUP_C_ONLY }))).id;
}

interface OpenOptions extends ProjectOptions {
  projectComponentId?: string;
  ownerMembershipId?: string;
  ownerUnitId?: string;
}

const placeOf = async (projectId: string, tenant = TENANT_A): Promise<PermitProjectPlace> => {
  const place = await as((tx) => dossiers.projectPlace(tx, projectId), tenant);
  if (place === undefined) throw new Error(`no project ${projectId}`);
  return place;
};

const openOn = async (projectId: string, options: OpenOptions = {}) => {
  const place = await placeOf(projectId);
  return as((tx) => dossiers.open(tx, place, { ownerUnitId: unitId(DEPARTMENT), ...options }, memberId(ACTOR)));
};

/** A dossier of a project of its own; a group B project of 1 million VND is planned the two types that apply to every project. */
const freshDossier = async (options: OpenOptions = {}) => {
  const projectId = await freshProject(options);
  return { ...(await openOn(projectId, options)), projectId };
};

const add = (dossierId: string, typeCode: string, extra: { authorityName?: string; expectedDecisionOn?: string; responsibleMembershipId?: string } = {}) =>
  as((tx) => permits.add(tx, dossierId, { permitTypeId: ids[typeCode] as string, ...extra }, memberId(ACTOR)));
const milestone = (permitId: string, version: number, stepCode: string, extra: { plannedOn?: string; actualOn?: string; note?: string; documentVersionId?: string } = {}) =>
  as((tx) => permits.recordMilestone(tx, permitId, version, { stepCode, ...extra }, memberId(ACTOR)));
const decide = (permitId: string, version: number, input: DecisionInput) => as((tx) => permits.decide(tx, permitId, version, input, memberId(ACTOR)));
const renew = (permitId: string, version: number, input: Parameters<PmtPermitStore['renew']>[3]) => as((tx) => permits.renew(tx, permitId, version, input, memberId(ACTOR)));
const revoke = (permitId: string, version: number, reason = 'The authority took the permit back', documentVersionId = DOCUMENT) =>
  as((tx) => permits.revoke(tx, permitId, version, { reason, decisionDocumentVersionId: documentVersionId }, memberId(ACTOR)));
const permitRow = async (permitId: string) => (await owner<Record<string, unknown>>('select *, valid_until::text as valid_until_text from machvon.permit where id = $1::uuid', [permitId]))[0];
const dossierRow = async (dossierId: string) =>
  (await owner<Record<string, unknown>>('select status, readiness_pct::text as readiness_pct, version::text as version from machvon.permit_dossier where id = $1::uuid', [dossierId]))[0];
const planned = (opened: { planned: Array<{ permitId: string; permitTypeCode: string }> }, code: string): string => {
  const found = opened.planned.find((permit) => permit.permitTypeCode === code);
  if (found === undefined) throw new Error(`${code} was not planned`);
  return found.permitId;
};

let counter = 0;
/** A number no other test uses. */
const freshNo = (): string => {
  counter += 1;
  return `GP-${String(counter).padStart(4, '0')}`;
};

const NO_END = { outcome: 'ISSUED', issuedOn: '2026-10-20', validFrom: '2026-10-20', documentVersionId: DOCUMENT } as const;
const TERMS = { ...NO_END, validUntil: '2027-10-19' } as const;

/** Walks a permit from PLANNED to IN_APPRAISAL; returns its version. */
async function toAppraisal(permitId: string, version = 1): Promise<number> {
  const submitted = await milestone(permitId, version, 'SUBMITTED', { actualOn: '2026-10-01' });
  const acknowledged = await milestone(permitId, submitted.version, 'ACKNOWLEDGED', { actualOn: '2026-10-02' });
  return acknowledged.version;
}

/** Walks a permit all the way to ISSUED; returns the version and the number. */
async function issue(permitId: string, extra: Partial<DecisionInput> = {}, version = 1): Promise<{ version: number; no: string }> {
  const no = freshNo();
  const issued = await decide(permitId, await toAppraisal(permitId, version), { ...TERMS, permitNo: no, ...extra });
  return { version: issued.version, no };
}

describe('the project permit dossier (ST-PMT-002)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
      await harness.seedMembership(tenant, COLLEAGUE, PROVINCE);
      await seedTenant(tenant);
    }
    await seedTypes();
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  afterEach(() => {
    clock = TODAY;
  });

  describe('opening a dossier', () => {
    it('plans a PLANNED, required permit for every type version in force that applies to the project, flags the one that waits for its confirmation, and starts at 0 percent', async () => {
      const opened = await freshDossier({ ownerMembershipId: memberId(COLLEAGUE) });
      expect(opened).toMatchObject({ status: 'OPEN', version: 1, asOf: TODAY, ownerMembershipId: memberId(COLLEAGUE) });
      expect(opened.planned.map((permit) => [permit.permitTypeCode, permit.permitTypeRevision, permit.awaitingConfirmation])).toEqual([
        [EVERY, 1, false],
        [UNCONFIRMED, 1, true],
      ]);
      const stored = await owner<{ permit_type_code: string; permit_type_id: string; status: string; is_required: boolean; authority_name: string }>(
        'select permit_type_code, permit_type_id, status, is_required, authority_name from machvon.permit where dossier_id = $1::uuid order by permit_type_code',
        [opened.id],
      );
      expect(stored).toEqual([
        { permit_type_code: EVERY, permit_type_id: ids[EVERY], status: 'PLANNED', is_required: true, authority_name: 'The authority the regulation names' },
        { permit_type_code: UNCONFIRMED, permit_type_id: ids[UNCONFIRMED], status: 'PLANNED', is_required: true, authority_name: 'The authority the regulation names' },
      ]);
      expect(await dossierRow(opened.id)).toEqual({ status: 'OPEN', readiness_pct: '0.00', version: '1' });
    });

    it('reads the condition of each type against the project: a big project of group A gets the types that name them, and a project of group QTQG gets only the types that apply to every project', async () => {
      const big = await freshDossier({ group: 'A', vnd: '9000000000000' });
      expect(big.planned.map((permit) => permit.permitTypeCode)).toEqual([BIG_ONLY, EVERY, GROUP_A, UNCONFIRMED]);
      const small = await freshDossier({ group: 'A', vnd: '1000' });
      expect(small.planned.map((permit) => permit.permitTypeCode)).toEqual([EVERY, GROUP_A, UNCONFIRMED]);
      const other = await freshDossier({ group: 'QTQG' });
      expect(other.planned.map((permit) => permit.permitTypeCode)).toEqual([EVERY, UNCONFIRMED]);
    });

    it('refuses a second dossier of the same project and component with DOSSIER_EXISTS, and allows one per component, also written in capitals', async () => {
      const projectId = await freshProject();
      const component = id(FAMILY, 60 + projects);
      await seedAs([
        [`insert into machvon.project_component (tenant_id, id, project_id, code, name, valid_from, created_by, updated_by) values ($1, $2, $3, 'COMP-1', 'Component', date '2026-01-01', $4, $4)`, [TENANT_A, component, projectId, memberId(ACTOR)]],
      ]);
      await openOn(projectId);
      expect(await refusal(openOn(projectId))).toEqual({ code: 'DOSSIER_EXISTS', status: 409 });
      expect(await owner('select count(*)::int as n from machvon.permit_dossier where project_id = $1::uuid', [projectId])).toEqual([{ n: 1 }]);
      const forComponent = await openOn(projectId, { projectComponentId: component.toUpperCase() });
      expect(forComponent.projectComponentId).toBe(component);
      expect(await refusal(openOn(projectId, { projectComponentId: component }))).toEqual({ code: 'DOSSIER_EXISTS', status: 409 });
    });

    it('lets exactly one of two requests that race to open the same dossier win, and the other get DOSSIER_EXISTS, not a database error', async () => {
      const projectId = await freshProject();
      const results = await Promise.allSettled([openOn(projectId), openOn(projectId)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect((lost?.reason as { code?: string }).code).toBe('DOSSIER_EXISTS');
      expect(await owner('select count(*)::int as n from machvon.permit_dossier where project_id = $1::uuid', [projectId])).toEqual([{ n: 1 }]);
    });

    it('refuses a component of another project, an owner unit or a member that does not exist, a unit that ended, and writes no dossier for them', async () => {
      const projectId = await freshProject();
      const otherProject = await freshProject();
      const component = id(FAMILY, 200);
      await seedAs([
        [`insert into machvon.project_component (tenant_id, id, project_id, code, name, valid_from, created_by, updated_by) values ($1, $2, $3, 'COMP-X', 'Component', date '2026-01-01', $4, $4)`, [TENANT_A, component, otherProject, memberId(ACTOR)]],
      ]);
      expect(await refusal(openOn(projectId, { projectComponentId: component }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'project_component_id' });
      expect(await refusal(openOn(projectId, { ownerUnitId: ABSENT }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_unit_id' });
      expect(await refusal(openOn(projectId, { ownerMembershipId: ABSENT }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_membership_id' });
      await seedAs([['insert into machvon.organization_unit (tenant_id, id, code, name, valid_from, valid_until, path, depth) values ($1, $2, $3, $4, $5::date, $6::date, $7, 0)', [TENANT_A, id(FAMILY, 201), 'U-ENDED', 'Ended unit', '2025-01-01', '2026-06-30', '/ended/']]]);
      expect(await refusal(openOn(projectId, { ownerUnitId: id(FAMILY, 201) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_unit_id' });
      expect(await owner('select count(*)::int as n from machvon.permit_dossier where project_id = $1::uuid', [projectId])).toEqual([{ n: 0 }]);
    });

    it('does not see the project of another tenant', async () => {
      const foreign = await freshProject({ tenant: TENANT_B });
      expect(await as((tx) => dossiers.projectPlace(tx, foreign))).toBeUndefined();
      expect((await as((tx) => dossiers.projectPlace(tx, foreign), TENANT_B))?.projectId).toBe(foreign);
      expect(await as((tx) => dossiers.projectPlace(tx, ABSENT))).toBeUndefined();
    });
  });

  describe('adding a permit', () => {
    it('adds an optional permit of a type in force, written under that version, with the authority of the type when none is given', async () => {
      const opened = await freshDossier();
      const added = await add(opened.id, NOT_PLANNED, { expectedDecisionOn: '2026-12-31', responsibleMembershipId: memberId(COLLEAGUE) });
      expect(added).toMatchObject({ status: 'PLANNED', version: 1, permitTypeCode: NOT_PLANNED, permitTypeRevision: 1, permitTypeId: ids[NOT_PLANNED] });
      expect(await permitRow(added.id)).toMatchObject({
        status: 'PLANNED',
        is_required: false,
        authority_name: 'The authority the regulation names',
        responsible_membership_id: memberId(COLLEAGUE),
        permit_type_code: NOT_PLANNED,
      });
      expect(await refusal(add(opened.id, NOT_PLANNED))).toEqual({ code: 'PERMIT_ALREADY_CURRENT', status: 409 });
      expect(await refusal(add(opened.id, EVERY))).toEqual({ code: 'PERMIT_ALREADY_CURRENT', status: 409 });
    });

    it('refuses a type that does not apply today (not yet begun, already ended, not a type of the tenant), and accepts a type on its last day', async () => {
      const opened = await freshDossier();
      expect(await refusal(add(opened.id, LATER))).toEqual({ code: 'PERMIT_TYPE_NOT_EFFECTIVE', status: 422 });
      expect(await refusal(add(opened.id, ENDED))).toEqual({ code: 'PERMIT_TYPE_NOT_EFFECTIVE', status: 422 });
      expect(await refusal(as((tx) => permits.add(tx, opened.id, { permitTypeId: ABSENT }, memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'permit_type_id' });
      clock = '2026-06-30';
      expect((await add(opened.id, ENDED)).permitTypeCode).toBe(ENDED);
    });

    it('refuses an unknown responsible member, a bad expected decision day and an empty authority, and adds nothing', async () => {
      const opened = await freshDossier();
      expect(await refusal(add(opened.id, NOT_PLANNED, { responsibleMembershipId: ABSENT }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'responsible_membership_id' });
      expect(await refusal(add(opened.id, NOT_PLANNED, { expectedDecisionOn: '2026-02-30' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'expected_decision_on' });
      expect(await refusal(add(opened.id, NOT_PLANNED, { authorityName: '  ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'authority_name' });
      expect(await owner('select count(*)::int as n from machvon.permit where dossier_id = $1::uuid and permit_type_code = $2', [opened.id, NOT_PLANNED])).toEqual([{ n: 0 }]);
    });

    it('answers 404 for a dossier that is not in the tenant', async () => {
      expect(await refusal(as((tx) => permits.add(tx, ABSENT, { permitTypeId: ids[EVERY] as string }, memberId(ACTOR))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the milestones of a permit', () => {
    it('moves a permit PLANNED, SUBMITTED, IN_APPRAISAL, SUPPLEMENT_REQUESTED and back, fixing the expected decision day from the processing time', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      const submitted = await milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-10-01', note: '  Filed at the one-stop office  ', documentVersionId: DOCUMENT.toUpperCase() });
      expect(submitted).toMatchObject({ status: 'SUBMITTED', fromStatus: 'PLANNED', version: 2, stepCode: 'SUBMITTED', actualOn: '2026-10-01', note: 'Filed at the one-stop office', documentVersionId: DOCUMENT, expectedDecisionOn: '2026-10-31' });
      expect(await permitRow(permitId)).toMatchObject({ status: 'SUBMITTED', version: '2' });
      expect(await milestone(permitId, 2, 'ACKNOWLEDGED', { actualOn: '2026-10-02' })).toMatchObject({ status: 'IN_APPRAISAL', version: 3 });
      expect(await milestone(permitId, 3, 'APPRAISAL_MEETING', { plannedOn: '2026-11-05' })).toMatchObject({ status: 'IN_APPRAISAL', version: 4, plannedOn: '2026-11-05', actualOn: null });
      expect((await milestone(permitId, 4, 'SUPPLEMENT_REQUESTED', { actualOn: '2026-10-10' })).status).toBe('SUPPLEMENT_REQUESTED');
      expect(await milestone(permitId, 5, 'SUPPLEMENT_SUBMITTED', { actualOn: '2026-10-12' })).toMatchObject({ status: 'IN_APPRAISAL', version: 6 });
      const steps = await owner<{ step_code: string }>('select step_code from machvon.permit_milestone where permit_id = $1::uuid order by created_at, id', [permitId]);
      expect(steps.map((step) => step.step_code)).toEqual(['SUBMITTED', 'ACKNOWLEDGED', 'APPRAISAL_MEETING', 'SUPPLEMENT_REQUESTED', 'SUPPLEMENT_SUBMITTED']);
    });

    it('keeps the expected decision day the officer gave, and leaves it empty when the type has no processing time', async () => {
      const opened = await freshDossier();
      const given = planned(opened, UNCONFIRMED);
      await owner("update machvon.permit set expected_decision_on = date '2026-12-15' where id = $1::uuid", [given]);
      expect((await milestone(given, 1, 'SUBMITTED', { actualOn: '2026-10-05' })).expectedDecisionOn).toBe('2026-12-15');
      const none = await freshDossier({ group: 'A' });
      expect((await milestone(planned(none, GROUP_A), 1, 'SUBMITTED', { actualOn: '2026-10-05' })).expectedDecisionOn).toBeNull();
    });

    it('refuses a step the status does not allow with PERMIT_STATE_INVALID, a stale version with VERSION_CONFLICT, and records nothing', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      expect(await refusal(milestone(permitId, 1, 'ACKNOWLEDGED', { actualOn: '2026-10-02' }))).toEqual({ code: 'PERMIT_STATE_INVALID', status: 409 });
      expect(await refusal(milestone(permitId, 1, 'HANDED_OVER', { actualOn: '2026-10-02' }))).toEqual({ code: 'PERMIT_STATE_INVALID', status: 409 });
      expect(await refusal(milestone(permitId, 7, 'SUBMITTED', { actualOn: '2026-10-02' }))).toEqual({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      expect(await owner('select count(*)::int as n from machvon.permit_milestone where permit_id = $1::uuid', [permitId])).toEqual([{ n: 0 }]);
      expect(await refusal(milestone(ABSENT, 1, 'SUBMITTED', { actualOn: '2026-10-02' }))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('refuses an unknown step, a step that happened without its day, a day to come, a day before the step before, an unreadable document and an empty note', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      expect(await refusal(milestone(permitId, 1, 'SHIPPED', { actualOn: '2026-10-02' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'step_code' });
      expect(await refusal(milestone(permitId, 1, 'SUBMITTED', { plannedOn: '2026-10-02' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'actual_on' });
      expect(await refusal(milestone(permitId, 1, 'SUBMITTED', {}))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'actual_on' });
      expect(await refusal(milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-10-25' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'actual_on' });
      expect(await refusal(milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-13-01' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'actual_on' });
      expect(await refusal(milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-10-02', documentVersionId: ABSENT }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'document_version_id' });
      expect(await refusal(milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-10-02', documentVersionId: INFECTED_DOCUMENT }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'document_version_id' });
      expect(await refusal(milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-10-02', note: '   ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      await milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-10-05' });
      expect(await refusal(milestone(permitId, 2, 'ACKNOWLEDGED', { actualOn: '2026-10-04' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'actual_on' });
    });

    it('records a handover of an issued permit without changing its status', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      const issued = await issue(permitId);
      expect(await milestone(permitId, issued.version, 'HANDED_OVER', { actualOn: '2026-10-21' })).toMatchObject({ status: 'ISSUED', fromStatus: 'ISSUED', version: issued.version + 1 });
    });

    it('is a record: the database refuses to change or remove a milestone, and the runtime role cannot delete one', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      await milestone(permitId, 1, 'SUBMITTED', { actualOn: '2026-10-05' });
      expect((await databaseRefusal(owner("update machvon.permit_milestone set note = 'rewritten' where permit_id = $1::uuid", [permitId]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(owner('delete from machvon.permit_milestone where permit_id = $1::uuid', [permitId]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.permit_milestone where permit_id = $1::uuid', [permitId])))).sqlstate).toBe('42501');
    });
  });

  describe('deciding a permit', () => {
    it('issues a permit with its number, days and scan, records the decision, and keeps the type version it was written under (AC-ST-PMT-002-1)', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      const no = freshNo();
      const issued = await decide(permitId, await toAppraisal(permitId), { ...TERMS, permitNo: `  ${no}  ` });
      expect(issued).toMatchObject({ status: 'ISSUED', fromStatus: 'IN_APPRAISAL', outcome: 'ISSUED', permitNo: no, validFrom: '2026-10-20', validUntil: '2027-10-19', permitTypeId: ids[EVERY], permitTypeRevision: 1, documentVersionId: DOCUMENT });
      expect(await permitRow(permitId)).toMatchObject({ status: 'ISSUED', permit_no: no, no_expiry: false, document_version_id: DOCUMENT, permit_type_id: ids[EVERY] });
      expect(await owner<{ actual_on: string }>("select actual_on::text as actual_on from machvon.permit_milestone where permit_id = $1::uuid and step_code = 'DECISION'", [permitId])).toEqual([{ actual_on: '2026-10-20' }]);
      // The next revision of the regulation does not touch what was issued under the version before it, and the database says the same.
      const revised = await as((tx) => types.publish(tx, typeInput(EVERY, { effectiveFrom: '2026-11-01', legalBasis: 'Fixture decree, article 2', defaultValidityMonths: 24 }), memberId(ACTOR)));
      expect(revised.revision).toBe(2);
      expect(await as((tx) => dossiers.findPermit(tx, permitId, EVERYWHERE))).toMatchObject({ permitTypeId: ids[EVERY], permitTypeRevision: 1, permitTypeCode: EVERY, status: 'ISSUED' });
      expect((await databaseRefusal(owner('update machvon.permit set permit_type_id = $2::uuid where id = $1::uuid', [permitId, revised.id]))).sqlstate).toBe('23514');
    });

    it('defaults the issue day to the first day and the last day to the months of validity of the type version', async () => {
      const opened = await freshDossier();
      const added = await add(opened.id, NOT_PLANNED);
      const issued = await decide(added.id, await toAppraisal(added.id), { outcome: 'ISSUED', permitNo: freshNo(), validFrom: '2026-07-01', documentVersionId: DOCUMENT });
      expect(issued).toMatchObject({ issuedOn: '2026-07-01', validFrom: '2026-07-01', validUntil: '2026-12-31' });
    });

    it('records a permit without an end as no_expiry, and refuses an end with it, an end before the start, and a missing end when the type has no default', async () => {
      const opened = await freshDossier({ group: 'A' });
      const permitId = planned(opened, GROUP_A);
      const version = await toAppraisal(permitId);
      const base = { ...TERMS, permitNo: freshNo() };
      const withoutEnd = { ...NO_END, permitNo: freshNo() };
      expect(await refusal(decide(permitId, version, { ...base, noExpiry: true }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      expect(await refusal(decide(permitId, version, { ...base, validUntil: '2026-10-19' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      expect(await refusal(decide(permitId, version, withoutEnd))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      const issued = await decide(permitId, version, { ...withoutEnd, noExpiry: true });
      expect(issued).toMatchObject({ noExpiry: true, validUntil: null, status: 'ISSUED' });
      expect(await permitRow(permitId)).toMatchObject({ no_expiry: true, valid_until: null });
    });

    it('refuses an issue without its scan with PERMIT_DOCUMENT_REQUIRED, and without a number, with a day to come or an unreadable scan, and leaves the permit in appraisal', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, UNCONFIRMED);
      const version = await toAppraisal(permitId);
      const terms = { outcome: 'ISSUED', issuedOn: '2026-10-20', validFrom: '2026-10-20', validUntil: '2027-10-19', permitNo: freshNo() };
      expect(await refusal(decide(permitId, version, terms))).toEqual({ code: 'PERMIT_DOCUMENT_REQUIRED', status: 422, detail: 'document_version_id' });
      expect(await refusal(decide(permitId, version, { ...terms, documentVersionId: ABSENT }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'document_version_id' });
      expect(await refusal(decide(permitId, version, { ...terms, documentVersionId: DOCUMENT, permitNo: ' ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'permit_no' });
      expect(await refusal(decide(permitId, version, { ...terms, documentVersionId: DOCUMENT, issuedOn: '2026-10-25' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'issued_on' });
      expect(await refusal(decide(permitId, version, { ...terms, documentVersionId: DOCUMENT, outcome: 'APPROVED' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'outcome' });
      expect(await permitRow(permitId)).toMatchObject({ status: 'IN_APPRAISAL', permit_no: null });
    });

    it('refuses to decide a permit that is not in appraisal, and a stale version', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      const terms = { ...TERMS, permitNo: freshNo() };
      expect(await refusal(decide(permitId, 1, terms))).toEqual({ code: 'PERMIT_STATE_INVALID', status: 409 });
      expect(await refusal(decide(permitId, 9, terms))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    });

    it('refuses a number the type already uses in the tenant, also with other capitals, but allows it for another type (UAT-AC375, AC-ST-PMT-002-1)', async () => {
      const first = await freshDossier();
      const { no } = await issue(planned(first, EVERY));
      // The same number for the same type in another dossier is refused, in capitals too, and the permit stays in appraisal.
      const second = await freshDossier();
      const permitId = planned(second, EVERY);
      const version = await toAppraisal(permitId);
      expect(await refusal(decide(permitId, version, { ...TERMS, permitNo: no }))).toEqual({ code: 'PERMIT_NO_DUPLICATE', status: 409 });
      expect(await refusal(decide(permitId, version, { ...TERMS, permitNo: no.toLowerCase() }))).toEqual({ code: 'PERMIT_NO_DUPLICATE', status: 409 });
      expect(await permitRow(permitId)).toMatchObject({ status: 'IN_APPRAISAL', permit_no: null });
      // The number belongs to a type: another type may carry it.
      const other = planned(second, UNCONFIRMED);
      expect(await decide(other, await toAppraisal(other), { ...TERMS, permitNo: no })).toMatchObject({ status: 'ISSUED', permitNo: no });
      // The unique index agrees when two requests race past the check.
      const raced = await databaseRefusal(owner(`update machvon.permit set status = 'ISSUED', permit_no = $2, issued_on = date '2026-10-20', valid_from = date '2026-10-20', valid_until = date '2027-10-19', document_version_id = $3 where id = $1::uuid`, [permitId, no.toLowerCase(), DOCUMENT]));
      expect(raced.sqlstate).toBe('23505');
    });

    it('refuses a second current permit of the same type in the dossier with PERMIT_ALREADY_CURRENT, also across a revision of the type, and the database agrees (UAT-AC375, AC-ST-PMT-002-1)', async () => {
      const opened = await freshDossier({ group: 'A' });
      const first = planned(opened, GROUP_A);
      await issue(first);
      // Adding the type again while its permit is current is refused: a second permit of a type is a renewal, not a parallel permit.
      expect(await refusal(add(opened.id, GROUP_A))).toEqual({ code: 'PERMIT_ALREADY_CURRENT', status: 409 });
      // The next revision of the type is the same type: the code decides, not the version.
      const next = await as((tx) => types.publish(tx, typeInput(GROUP_A, { effectiveFrom: '2026-11-01', legalBasis: 'Fixture decree, article 2', appliesToRule: { project_group_keys: ['A'] } }), memberId(ACTOR)));
      clock = '2026-11-02';
      expect(await refusal(as((tx) => permits.add(tx, opened.id, { permitTypeId: next.id }, memberId(ACTOR))))).toEqual({ code: 'PERMIT_ALREADY_CURRENT', status: 409 });
      // An application of the type may exist next to a current permit in the database (a renewal on its way); deciding it as a second current one is refused.
      const secondId = randomUUID();
      await owner(`insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, status, created_by, updated_by) values ($1, $2, $3, $4, 'IN_APPRAISAL', $5, $5)`, [TENANT_A, secondId, opened.id, next.id, memberId(ACTOR)]);
      expect(await permitRow(secondId)).toMatchObject({ permit_type_code: GROUP_A });
      expect(await refusal(decide(secondId, 1, { ...TERMS, permitNo: freshNo() }))).toEqual({ code: 'PERMIT_ALREADY_CURRENT', status: 409 });
      const raced = await databaseRefusal(
        owner(`update machvon.permit set status = 'ISSUED', permit_no = $2, issued_on = date '2026-11-02', valid_from = date '2026-11-02', valid_until = date '2027-11-01', document_version_id = $3 where id = $1::uuid`, [secondId, freshNo(), DOCUMENT]),
      );
      expect(raced.sqlstate).toBe('23505');
      expect(await owner("select count(*)::int as n from machvon.permit where dossier_id = $1::uuid and permit_type_code = $2 and status = 'ISSUED'", [opened.id, GROUP_A])).toEqual([{ n: 1 }]);
    });

    it('refuses two applications of one type in a dossier in the database too', async () => {
      const opened = await freshDossier();
      const second = await databaseRefusal(
        owner(`insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, status, created_by, updated_by) values ($1, $2, $3, $4, 'SUBMITTED', $5, $5)`, [TENANT_A, randomUUID(), opened.id, ids[EVERY], memberId(ACTOR)]),
      );
      expect(second).toMatchObject({ sqlstate: '23505' });
      expect(second.message).toContain('permit_code_open_uq');
    });

    it('rejects an application with its reason, recorded as the decision, and the next attempt is a new permit of a type that stays required', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, UNCONFIRMED);
      const version = await toAppraisal(permitId);
      expect(await refusal(decide(permitId, version, { outcome: 'REJECTED' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(decide(permitId, version, { outcome: 'REJECTED', reason: 'Incomplete file', permitNo: freshNo() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'permit_no' });
      expect(await refusal(decide(permitId, version, { outcome: 'REJECTED', reason: 'Incomplete file', noExpiry: true }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'no_expiry' });
      const rejected = await decide(permitId, version, { outcome: 'REJECTED', reason: '  Incomplete file  ', documentVersionId: SECOND_DOCUMENT });
      expect(rejected).toMatchObject({ status: 'REJECTED', outcome: 'REJECTED', issuedOn: null, documentVersionId: SECOND_DOCUMENT });
      expect(await owner("select note, document_version_id from machvon.permit_milestone where permit_id = $1::uuid and step_code = 'DECISION'", [permitId])).toEqual([{ note: 'Incomplete file', document_version_id: SECOND_DOCUMENT }]);
      // A rejected application is never issued afterwards.
      expect((await databaseRefusal(owner(`update machvon.permit set status = 'ISSUED' where id = $1::uuid`, [permitId]))).sqlstate).toBe('23514');
      const again = await add(opened.id, UNCONFIRMED);
      expect(await permitRow(again.id)).toMatchObject({ status: 'PLANNED', is_required: true });
    });
  });

  describe('the readiness of the dossier', () => {
    it('counts the required types covered by a valid permit or an exemption, moves to COMPLETE at 100 and back when a permit is revoked', async () => {
      const opened = await freshDossier();
      const every = planned(opened, EVERY);
      const waits = planned(opened, UNCONFIRMED);
      expect(await dossierRow(opened.id)).toMatchObject({ status: 'OPEN', readiness_pct: '0.00' });
      const issued = await issue(every);
      expect(await dossierRow(opened.id)).toEqual({ status: 'OPEN', readiness_pct: '50.00', version: '2' });
      // An exemption covers a type as well (declared by the exemption command; here the row is what it leaves).
      await owner(`update machvon.permit set status = 'EXEMPTED', exemption_basis = 'Exempt by the regulation', exemption_decision_document_version_id = $2 where id = $1::uuid`, [waits, DOCUMENT]);
      const covered = await as((tx) => dossiers.refreshReadiness(tx, opened.id, memberId(ACTOR)));
      expect(covered).toMatchObject({ readinessPct: '100.00', status: 'COMPLETE', required: 2, satisfied: 2, changed: true });
      expect(await as((tx) => dossiers.refreshReadiness(tx, opened.id, memberId(ACTOR)))).toMatchObject({ changed: false, version: covered.version });
      const revoked = await revoke(every, issued.version);
      expect(revoked.readiness).toMatchObject({ readinessPct: '50.00', status: 'OPEN', satisfied: 1, changed: true });
    });

    it('counts a permit on its last day and no longer the day after it', async () => {
      const opened = await freshDossier({ group: 'A' });
      await issue(planned(opened, GROUP_A), { validUntil: '2026-10-31' });
      clock = '2026-10-31';
      expect(await as((tx) => dossiers.refreshReadiness(tx, opened.id, memberId(ACTOR)))).toMatchObject({ required: 3, satisfied: 1, readinessPct: '33.33' });
      clock = '2026-11-01';
      expect(await as((tx) => dossiers.refreshReadiness(tx, opened.id, memberId(ACTOR)))).toMatchObject({ required: 3, satisfied: 0, readinessPct: '0.00' });
    });

    it('is 0 and OPEN when the dossier requires nothing, and answers 404 for a dossier that does not exist', async () => {
      const projectId = await freshProject();
      const dossierId = randomUUID();
      await owner('insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)', [TENANT_A, dossierId, projectId, unitId(DEPARTMENT), memberId(ACTOR)]);
      expect(await as((tx) => dossiers.refreshReadiness(tx, dossierId, memberId(ACTOR)))).toEqual({ readinessPct: '0.00', status: 'OPEN', required: 0, satisfied: 0, changed: false, version: 1 });
      expect(await refusal(as((tx) => dossiers.refreshReadiness(tx, ABSENT, memberId(ACTOR))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('renewing a permit', () => {
    it('creates a replacement and supersedes the old permit, which keeps what it says; there is one current permit of the type after it (UAT-AC370, AC-ST-PMT-002-1)', async () => {
      const opened = await freshDossier({ group: 'A', vnd: '9000000000000' });
      const permitId = planned(opened, BIG_ONLY);
      const old = await issue(permitId, { validUntil: '2026-12-31' });
      const renewed = await renew(permitId, old.version, { newPermitNo: 'GP-RENEWED-1', newValidUntil: '2027-12-31', documentVersionId: SECOND_DOCUMENT });
      expect(renewed).toMatchObject({
        status: 'ISSUED',
        version: 1,
        permitNo: 'GP-RENEWED-1',
        validFrom: TODAY,
        validUntil: '2027-12-31',
        supersededId: permitId,
        supersededVersion: old.version + 1,
        permitTypeId: ids[BIG_ONLY],
        issuedOn: TODAY,
      });
      expect(await permitRow(permitId)).toMatchObject({ status: 'SUPERSEDED', permit_no: old.no, valid_until_text: '2026-12-31', document_version_id: DOCUMENT });
      expect(await permitRow(renewed.id)).toMatchObject({ supersedes_id: permitId, is_required: true, document_version_id: SECOND_DOCUMENT, authority_name: 'The authority the regulation names' });
      expect(await owner("select count(*)::int as n from machvon.permit where dossier_id = $1::uuid and permit_type_code = $2 and status = 'ISSUED'", [opened.id, BIG_ONLY])).toEqual([{ n: 1 }]);
      expect(await owner("select step_code, actual_on::text as actual_on from machvon.permit_milestone where permit_id = $1::uuid", [renewed.id])).toEqual([{ step_code: 'DECISION', actual_on: TODAY }]);
    });

    it('writes the replacement under the version of the type in force on the day, and the old permit keeps its own version of the type', async () => {
      const opened = await freshDossier();
      const added = await add(opened.id, REVISED);
      const old = await issue(added.id);
      const next = await as((tx) => types.publish(tx, typeInput(REVISED, { effectiveFrom: '2026-11-01', legalBasis: 'Fixture decree, article 2', appliesToRule: GROUP_C_ONLY }), memberId(ACTOR)));
      clock = '2026-11-05';
      const renewed = await renew(added.id, old.version, { newPermitNo: freshNo(), newValidUntil: '2027-12-31', documentVersionId: DOCUMENT });
      expect(renewed).toMatchObject({ permitTypeId: next.id, permitTypeRevision: 2 });
      expect(await permitRow(added.id)).toMatchObject({ permit_type_id: ids[REVISED], status: 'SUPERSEDED' });
    });

    it('renews an expired permit too, and refuses a permit that is neither issued nor expired, one without an end, and a stale version', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      expect(await refusal(renew(permitId, 1, { newPermitNo: freshNo(), newValidUntil: '2028-01-01', documentVersionId: DOCUMENT }))).toEqual({ code: 'PERMIT_STATE_INVALID', status: 409 });
      const issued = await issue(permitId, { validUntil: '2026-11-30' });
      expect(await refusal(renew(permitId, issued.version + 1, { newPermitNo: freshNo(), newValidUntil: '2028-01-01', documentVersionId: DOCUMENT }))).toMatchObject({ code: 'VERSION_CONFLICT' });
      // The expiry job (ST-PMT-004) turns the status; the row it leaves is what a renewal starts from.
      await owner("update machvon.permit set status = 'EXPIRED', version = version + 1 where id = $1::uuid", [permitId]);
      const renewed = await renew(permitId, issued.version + 1, { newPermitNo: freshNo(), newValidUntil: '2027-11-30', documentVersionId: DOCUMENT });
      expect(renewed).toMatchObject({ status: 'ISSUED', supersededId: permitId });
      expect(await permitRow(permitId)).toMatchObject({ status: 'SUPERSEDED' });

      const endless = await freshDossier();
      const endlessId = planned(endless, EVERY);
      const kept = await issue(endlessId, { noExpiry: true, validUntil: undefined });
      expect(await refusal(renew(endlessId, kept.version, { newPermitNo: freshNo(), newValidUntil: '2028-01-01', documentVersionId: DOCUMENT }))).toEqual({ code: 'PERMIT_STATE_INVALID', status: 409 });
    });

    it('refuses a last day that is not later than the last day before it or is in the past, a number that is in use, an unreadable scan, and a type that no longer applies', async () => {
      const opened = await freshDossier();
      const added = await add(opened.id, ENDING);
      const old = await issue(added.id, { validUntil: '2026-12-31' });
      const base = { newPermitNo: freshNo(), newValidUntil: '2027-12-31', documentVersionId: DOCUMENT };
      expect(await refusal(renew(added.id, old.version, { ...base, newValidUntil: '2026-12-31' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_valid_until' });
      expect(await refusal(renew(added.id, old.version, { ...base, newValidUntil: '2026-10-23' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_valid_until' });
      expect(await refusal(renew(added.id, old.version, { ...base, newPermitNo: old.no }))).toEqual({ code: 'PERMIT_NO_DUPLICATE', status: 409 });
      expect(await refusal(renew(added.id, old.version, { ...base, documentVersionId: INFECTED_DOCUMENT }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'document_version_id' });
      expect(await refusal(renew(added.id, old.version, { ...base, newPermitNo: ' ' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'new_permit_no' });
      // Once the type has ended with no successor there is no regulation to renew under.
      await as((tx) => types.retire(tx, ids[ENDING] as string, '2026-12-31', memberId(ACTOR)));
      clock = '2027-01-05';
      expect(await refusal(renew(added.id, old.version, { ...base, newValidUntil: '2028-12-31' }))).toEqual({ code: 'PERMIT_TYPE_NOT_EFFECTIVE', status: 422 });
      expect(await permitRow(added.id)).toMatchObject({ status: 'ISSUED' });
    });
  });

  describe('revoking a permit', () => {
    it('revokes an issued permit with its reason and the decision, keeps what it said, and the database refuses to rewrite it', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      const issued = await issue(permitId);
      const revoked = await revoke(permitId, issued.version, '  Issued by mistake  ', SECOND_DOCUMENT);
      expect(revoked).toMatchObject({ status: 'REVOKED', fromStatus: 'ISSUED', reason: 'Issued by mistake', revocationDocumentVersionId: SECOND_DOCUMENT });
      expect(await permitRow(permitId)).toMatchObject({ status: 'REVOKED', revoke_reason: 'Issued by mistake', revocation_document_version_id: SECOND_DOCUMENT, document_version_id: DOCUMENT });
      expect((await databaseRefusal(owner(`update machvon.permit set revoke_reason = 'rewritten' where id = $1::uuid`, [permitId]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(owner(`update machvon.permit set status = 'ISSUED' where id = $1::uuid`, [permitId]))).sqlstate).toBe('23514');
    });

    it('refuses what is not issued, an empty reason, an unreadable decision and a stale version, and changes nothing', async () => {
      const opened = await freshDossier();
      expect(await refusal(revoke(planned(opened, UNCONFIRMED), 1))).toEqual({ code: 'PERMIT_STATE_INVALID', status: 409 });
      const permitId = planned(opened, EVERY);
      const issued = await issue(permitId);
      expect(await refusal(revoke(permitId, issued.version, '   '))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(revoke(permitId, issued.version, 'Reason', ABSENT))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'decision_document_version_id' });
      expect(await refusal(revoke(permitId, issued.version + 4))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await permitRow(permitId)).toMatchObject({ status: 'ISSUED' });
    });
  });

  describe('what the database keeps for good', () => {
    it('refuses the illegal moves of the state machine and the rewrite of an issued permit, whatever the application did (BR-PMT-01)', async () => {
      const opened = await freshDossier();
      const plannedId = planned(opened, UNCONFIRMED);
      expect((await databaseRefusal(owner(`update machvon.permit set status = 'ISSUED' where id = $1::uuid`, [plannedId]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(owner(`update machvon.permit set status = 'REVOKED' where id = $1::uuid`, [plannedId]))).sqlstate).toBe('23514');
      const issuedId = planned(opened, EVERY);
      await issue(issuedId);
      for (const change of ['valid_until = valid_until + 1', 'valid_from = valid_from - 1', "permit_no = 'REWRITTEN'", 'document_version_id = null', "issued_on = date '2020-01-01'"]) {
        expect((await databaseRefusal(owner(`update machvon.permit set ${change} where id = $1::uuid`, [issuedId]))).sqlstate).toMatch(/^23/);
      }
      expect((await databaseRefusal(owner('update machvon.permit set is_required = not is_required where id = $1::uuid', [issuedId]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(owner('update machvon.permit set dossier_id = $2::uuid where id = $1::uuid', [issuedId, randomUUID()]))).sqlstate).toBe('23514');
      expect((await databaseRefusal(owner('update machvon.permit_dossier set project_id = $2::uuid where id = $1::uuid', [opened.id, randomUUID()]))).sqlstate).toBe('23514');
    });

    it('checks the text of a permit, a permit without an end, a self-superseding permit and a milestone without a date', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      expect((await databaseRefusal(owner(`update machvon.permit set permit_no = ' padded ' where id = $1::uuid`, [permitId]))).message).toContain('permit_no_text_chk');
      expect((await databaseRefusal(owner(`update machvon.permit set no_expiry = true, valid_until = date '2027-01-01' where id = $1::uuid`, [permitId]))).message).toContain('permit_no_expiry_chk');
      expect((await databaseRefusal(owner('update machvon.permit set supersedes_id = id where id = $1::uuid', [permitId]))).sqlstate).toBe('23514');
      const undated = await databaseRefusal(owner(`insert into machvon.permit_milestone (tenant_id, id, permit_id, step_code, created_by) values ($1, $2, $3, 'SUBMITTED', $4)`, [TENANT_A, randomUUID(), permitId, memberId(ACTOR)]));
      expect(undated.message).toContain('permit_milestone_dated_chk');
    });

    it('does not let the runtime role delete or truncate a dossier, a permit or a milestone', async () => {
      for (const table of ['permit_dossier', 'permit', 'permit_milestone']) {
        expect(
          await owner(`select has_table_privilege('machvon_app', 'machvon.${table}', 'DELETE') as can_delete, has_table_privilege('machvon_app', 'machvon.${table}', 'TRUNCATE') as can_truncate`),
        ).toEqual([{ can_delete: false, can_truncate: false }]);
      }
    });
  });

  describe('reading dossiers and permits', () => {
    it('lists the dossiers with their counts, ordered by project code, paged by keyset, and filtered by project', async () => {
      const mine = await freshDossier({ group: 'A', vnd: '9000000000000' });
      await freshDossier();
      const all = await as((tx) => dossiers.list(tx, EVERYWHERE, {}, { limit: 500, after: undefined }));
      const first = await as((tx) => dossiers.list(tx, EVERYWHERE, {}, { limit: 2, after: undefined }));
      const rest = await as((tx) => dossiers.list(tx, EVERYWHERE, {}, { limit: 500, after: { code: first[1]?.projectCode as string, id: first[1]?.id as string } }));
      expect([...first, ...rest].map((line) => line.id)).toEqual(all.map((line) => line.id));
      expect(all.map((line) => line.projectCode)).toEqual([...all.map((line) => line.projectCode)].sort());
      const one = await as((tx) => dossiers.list(tx, EVERYWHERE, { projectId: mine.projectId.toUpperCase() }, { limit: 50, after: undefined }));
      expect(one).toHaveLength(1);
      expect(one[0]).toMatchObject({ id: mine.id, ownerUnitName: 'Unit 2', status: 'OPEN', readinessPct: '0.00', requiredCount: 4, satisfiedCount: 0, issuedCount: 0, expiringCount: 0, unconfirmedCount: 1, ownerMembership: null, version: 1 });
    });

    it('reads one dossier with its permits, and counts the valid and the expiring permits on the day of the read', async () => {
      const opened = await freshDossier({ group: 'A' });
      await issue(planned(opened, GROUP_A), { validUntil: '2027-03-01' });
      await issue(planned(opened, EVERY), { validUntil: '2027-06-30' });
      const detail = await as((tx) => dossiers.find(tx, opened.id, EVERYWHERE));
      expect(detail?.permits.map((permit) => [permit.permitTypeCode, permit.status])).toEqual([
        [EVERY, 'ISSUED'],
        [GROUP_A, 'ISSUED'],
        [UNCONFIRMED, 'PLANNED'],
      ]);
      expect(detail?.permits.find((permit) => permit.permitTypeCode === UNCONFIRMED)).toMatchObject({ cxnRef: 'CXN-EXE-03', exemptionAllowed: false, isRequired: true, permitNo: null });
      expect(detail).toMatchObject({ issuedCount: 2, expiringCount: 0, satisfiedCount: 2, requiredCount: 3 });
      clock = '2027-01-15';
      expect(await as((tx) => dossiers.find(tx, opened.id, EVERYWHERE))).toMatchObject({ issuedCount: 2, expiringCount: 1 });
      clock = '2027-04-01';
      expect(await as((tx) => dossiers.find(tx, opened.id, EVERYWHERE))).toMatchObject({ issuedCount: 1, expiringCount: 0 });
    });

    it('reads one permit with its milestones in the order they happened, in the scope of the caller (UI-PMT-02)', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      const issued = await issue(permitId);
      await milestone(permitId, issued.version, 'HANDED_OVER', { actualOn: '2026-10-22', note: 'Handed over to the site office' });
      const detail = await as((tx) => dossiers.findPermit(tx, permitId, EVERYWHERE));
      expect(detail).toMatchObject({ projectId: opened.projectId, status: 'ISSUED', permitTypeRevision: 1, documentVersionId: DOCUMENT, permitNo: issued.no, revokeReason: null });
      expect(detail?.milestones.map((step) => step.stepCode)).toEqual(['SUBMITTED', 'ACKNOWLEDGED', 'DECISION', 'HANDED_OVER']);
      expect(detail?.milestones[0]).toMatchObject({ actualOn: '2026-10-01', plannedOn: null });
      expect(detail?.milestones[3]).toMatchObject({ note: 'Handed over to the site office' });
      expect(await as((tx) => dossiers.findPermit(tx, ABSENT, EVERYWHERE))).toBeUndefined();
    });

    it('shows nothing of another tenant: every read finds nothing, and a command on a foreign id finds nothing to act on (AC-ST-PMT-002-2)', async () => {
      const opened = await freshDossier();
      const permitId = planned(opened, EVERY);
      expect(await as((tx) => dossiers.list(tx, EVERYWHERE, {}, { limit: 50, after: undefined }), TENANT_B)).toEqual([]);
      expect(await as((tx) => dossiers.find(tx, opened.id, EVERYWHERE), TENANT_B)).toBeUndefined();
      expect(await as((tx) => dossiers.findPermit(tx, permitId, EVERYWHERE), TENANT_B)).toBeUndefined();
      expect(await as((tx) => dossiers.dossierPlace(tx, opened.id), TENANT_B)).toBeUndefined();
      expect(await as((tx) => dossiers.permitPlace(tx, permitId), TENANT_B)).toBeUndefined();
      expect(await refusal(as((tx) => permits.add(tx, opened.id, { permitTypeId: ids[EVERY] as string }, memberId(ACTOR)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => permits.revoke(tx, permitId, 1, { reason: 'x', decisionDocumentVersionId: DOCUMENT }, memberId(ACTOR)), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await owner('select count(*)::int as n from machvon.permit where dossier_id = $1::uuid', [opened.id], TENANT_B)).toEqual([{ n: 0 }]);
      // Without a tenant set the tables show no row at all.
      const bare = await harness.appPool.query('select (select count(*) from machvon.permit_dossier) as dossiers, (select count(*) from machvon.permit) as permits, (select count(*) from machvon.permit_milestone) as milestones');
      expect(bare.rows[0]).toEqual({ dossiers: '0', permits: '0', milestones: '0' });
    });

    it('limits the read to the scope of the grant: a department grant sees its projects, a grant on another branch does not, a grant on the project itself does', async () => {
      const inDepartment = await freshDossier({ unit: DEPARTMENT });
      const elsewhere = await freshDossier({ unit: OTHER_BRANCH, ownerUnitId: unitId(OTHER_BRANCH) });
      const department = dossierScope(grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] }), READ, NOW);
      const branch = dossierScope(grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)], paths: ['/u3/'] }), READ, NOW);
      const project = dossierScope(grant(READ, { kind: 'PROJECT', refIds: [inDepartment.projectId] }), READ, NOW);
      const none = dossierScope(grant('permit.manage', { kind: 'TENANT' }), READ, NOW);
      const idsOf = async (scope: ReturnType<typeof dossierScope>) => (await as((tx) => dossiers.list(tx, scope, {}, { limit: 500, after: undefined }))).map((line) => line.id);
      expect(await idsOf(department)).toContain(inDepartment.id);
      expect(await idsOf(department)).not.toContain(elsewhere.id);
      expect(await idsOf(branch)).toContain(elsewhere.id);
      expect(await idsOf(branch)).not.toContain(inDepartment.id);
      expect(await idsOf(project)).toEqual([inDepartment.id]);
      expect(await idsOf(none)).toEqual([]);
      expect(await as((tx) => dossiers.find(tx, elsewhere.id, department))).toBeUndefined();
      // The unit that keeps the dossier counts as well as the units of the project.
      await owner('update machvon.permit_dossier set owner_unit_id = $2::uuid where id = $1::uuid', [elsewhere.id, unitId(DEPARTMENT)]);
      expect(await idsOf(department)).toContain(elsewhere.id);
    });

    it('tells where a dossier and a permit lie: the project, the units and the unit that keeps the dossier', async () => {
      const opened = await freshDossier();
      const place = await as((tx) => dossiers.dossierPlace(tx, opened.id));
      expect(place).toMatchObject({ ownerUnit: { id: unitId(DEPARTMENT), path: '/u1/u2/' }, investorUnit: { id: unitId(PROVINCE), path: '/u1/' }, dossierUnit: { id: unitId(DEPARTMENT), path: '/u1/u2/' }, projectId: opened.projectId });
      const permitPlace = await as((tx) => dossiers.permitPlace(tx, planned(opened, EVERY)));
      expect(permitPlace?.dossierId).toBe(opened.id);
      const project = await placeOf(opened.projectId);
      expect(project).toMatchObject({ projectCode: place?.projectCode, facts: { projectGroup: 'B', workTypes: [], totalInvestmentVnd: '1000000' } });
    });
  });

  describe('validity of a permit', () => {
    it.each([
      ['2026-01-01', 12, '2026-12-31'],
      ['2026-10-24', 6, '2027-04-23'],
      ['2026-01-31', 1, '2026-02-27'],
      ['2024-01-31', 1, '2024-02-28'],
      ['2026-03-31', 12, '2027-03-30'],
      ['2026-12-15', 3, '2027-03-14'],
    ])('a validity that begins on %s and lasts %d months ends on its last day %s', (from, months, last) => {
      expect(validityEnd(from, months)).toBe(last);
    });
  });
});
