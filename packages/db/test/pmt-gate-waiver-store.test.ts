import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { vietnamDateOf } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { PmtWaiverExpiry } from '../src/pmt-gate-waiver-expiry';
import { MAX_WAIVER_DAYS, PmtGateWaiverStore } from '../src/pmt-gate-waiver-store';
import type { WaiverInput } from '../src/pmt-gate-waiver-store';
import { PmtGateStore } from '../src/pmt-gate-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
// The grant stamps the time of the database, so the day of the tests is the real Vietnam day.
const TODAY = vietnamDateOf(new Date());
const waivers = new PmtGateWaiverStore({ today: () => TODAY });
const gates = new PmtGateStore({ today: () => TODAY });
const job = new PmtWaiverExpiry(new AuditWriter(harness.tenants));
const OFFICER = 1; // made the decision document and is in charge of the dossier
const LEADER = 2; // holds permit.gate.waive: the approver
const PERMIT_MAKER = 3; // made a permit of the type
const WORKER = '00000000-0000-4000-8000-000000000000';
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0x97;
const TYPE_BUILDING = id(FAMILY, 41);
const TYPE_BUILDING_V2 = id(FAMILY, 44);
const TYPE_ENV = id(FAMILY, 42);
/** A moment of the Vietnam day (09:00); the job counts days by the Vietnam date. */
const at = (date: string): Date => new Date(`${date}T02:00:00.000Z`);
const inDays = (days: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const onlyBranch =
  (unit: number): ScopeBuilder =>
  (start) => ({ sql: `p.owner_unit_id = $${start}::uuid`, params: [unitId(unit)] });

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = LEADER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const run = (date: string, tenant = TENANT_A) => harness.tenants.withTenant(contextFor(tenant, WORKER), (tx) => job.run(tx, WORKER, at(date)));

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
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

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

let counter = 0;
const next = (): number => {
  counter += 1;
  return counter;
};

/** A project of its own, with the dossier the officer is in charge of. */
async function freshProject(options: { tenant?: string; unit?: number; dossier?: boolean } = {}): Promise<string> {
  const n = next();
  const tenant = options.tenant ?? TENANT_A;
  const projectId = id(FAMILY, 100 + n);
  await seedAs([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B')`,
      [tenant, projectId, `PRJ-W-${String(n).padStart(3, '0')}`, `Waiver project ${n}`, unitId(options.unit ?? DEPARTMENT), unitId(PROVINCE), id(FAMILY, 42)],
    ],
  ]);
  if (options.dossier !== false) {
    await seedAs([
      [
        `insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, owner_membership_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5, $5)`,
        [tenant, id(FAMILY, 300 + n), projectId, unitId(DEPARTMENT), memberId(OFFICER)],
      ],
    ]);
  }
  return projectId;
}

/** A document version made by `creator`: the decision the waiver rests on. */
async function decision(creator = OFFICER, options: { infected?: boolean; tenant?: string } = {}): Promise<string> {
  const tenant = options.tenant ?? TENANT_A;
  const documentId = randomUUID();
  const versionId = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`,
    [tenant, documentId, memberId(creator)],
    tenant,
  );
  await owner(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', $5, '{}'::jsonb, 'RENDERED_FINAL')`,
    [tenant, versionId, documentId, `tenants/test/${versionId}.pdf`, options.infected === true ? 'INFECTED' : 'CLEAN'],
    tenant,
  );
  return versionId;
}

/** A permit of the type in the dossier of the project, made by `creator` and last changed by `updater`. */
async function permitMadeBy(projectId: string, typeCode: string, typeId: string, creator: number, updater = creator, responsible?: number): Promise<void> {
  const dossier = (await owner<{ id: string }>('select id from machvon.permit_dossier where project_id = $1::uuid limit 1', [projectId]))[0]?.id;
  await seedAs([
    [
      `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_type_code, status, is_required, responsible_membership_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'PLANNED', true, $6, $7, $8)`,
      [TENANT_A, randomUUID(), dossier, typeId, typeCode, responsible === undefined ? null : memberId(responsible), memberId(creator), memberId(updater)],
    ],
  ]);
}

async function input(projectId: string, overrides: Partial<WaiverInput> = {}): Promise<WaiverInput> {
  return {
    projectId,
    gateCode: 'START_CONSTRUCTION',
    permitTypeId: TYPE_BUILDING,
    reason: 'The competent authority allowed the work to begin while the permit is being finished',
    decisionDocumentVersionId: await decision(),
    validUntil: inDays(30),
    ...overrides,
  };
}

const grant = (data: WaiverInput, member = LEADER, scope: ScopeBuilder = everything, tenant = TENANT_A) => as((tx) => waivers.grant(tx, data, memberId(member), scope), member, tenant);
const revoke = (waiverId: string, reason: unknown = 'The permit was issued after all', member = LEADER, scope: ScopeBuilder = everything) =>
  as((tx) => waivers.revoke(tx, waiverId, reason, memberId(member), scope), member);
const evaluate = (projectId: string, gate: string, asOf?: string) => as((tx) => gates.evaluate(tx, projectId, gate, asOf));
const rowOf = async (waiverId: string) =>
  (
    await owner<{ status: string; version: string; permit_type_code: string | null; created_by: string; approved_by: string; revoked_by: string | null; revoked_reason: string | null; valid_until: string }>(
      'select status, version::text as version, permit_type_code, created_by, approved_by, revoked_by, revoked_reason, valid_until::text as valid_until from machvon.permit_gate_waiver where id = $1::uuid',
      [waiverId],
    )
  )[0];
const countFor = async (projectId: string): Promise<number> => (await owner('select 1 from machvon.permit_gate_waiver where project_id = $1::uuid', [projectId])).length;

describe('PmtGateWaiverStore (the waivers of the permit gates, ST-PMT-005)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const member of [OFFICER, LEADER, PERMIT_MAKER]) await harness.seedMembership(tenant, member, PROVINCE);
      await seedAs(
        [
          [TYPE_BUILDING, 'BUILDING', 'PUBLISHED', 1],
          [TYPE_BUILDING_V2, 'BUILDING', 'DRAFT', 2],
          [TYPE_ENV, 'ENV_PERMIT', 'PUBLISHED', 1],
        ].map(([typeId, code, status, revision]) => [
          `insert into machvon.permit_type (tenant_id, id, code, revision, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
           values ($1, $2, $3, $4, $5, 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, $6, $7, $7)`,
          [tenant, typeId, code, revision, `Permit type ${code}`, status, memberId(OFFICER)],
        ]),
      );
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('grant', () => {
    it('grants a waiver to someone other than those who asked for it, with the type code, the maker and the length recorded (AC-ST-PMT-005-1)', async () => {
      const project = await freshProject();
      const granted = await grant(await input(project, { validUntil: inDays(30) }));
      expect(granted).toMatchObject({ projectId: project, gateCode: 'START_CONSTRUCTION', permitTypeCode: 'BUILDING', validUntil: inDays(30), version: 1, status: 'ACTIVE', grantedOn: TODAY, days: 31 });
      expect(await rowOf(granted.id)).toMatchObject({ status: 'ACTIVE', version: '1', permit_type_code: 'BUILDING', created_by: memberId(OFFICER), approved_by: memberId(LEADER), revoked_by: null });
    });

    it('lets the gate through while the waiver is in force and stops again the day after its last day, before the job has run (AC-ST-PMT-005-1)', async () => {
      const project = await freshProject();
      await as((tx) => gates.publish(tx, { gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE_BUILDING, requirement: 'VALID_PERMIT', appliesToRule: {}, legalBasis: 'Fixture decree', effectiveFrom: '2026-01-01' }, memberId(OFFICER)), OFFICER);
      expect((await evaluate(project, 'START_CONSTRUCTION'))?.status).toBe('BLOCKED');
      const granted = await grant(await input(project, { validUntil: inDays(2) }));
      const during = await evaluate(project, 'START_CONSTRUCTION');
      expect(during?.status).toBe('PASSED_WITH_WAIVER');
      expect(during?.verdicts[0]).toMatchObject({ outcome: 'WAIVED', waiver: { id: granted.id, validUntil: inDays(2) } });
      expect((await evaluate(project, 'START_CONSTRUCTION', inDays(2)))?.status).toBe('PASSED_WITH_WAIVER');
      expect((await evaluate(project, 'START_CONSTRUCTION', inDays(3)))?.status).toBe('BLOCKED');
      await revoke(granted.id);
      expect((await evaluate(project, 'START_CONSTRUCTION'))?.status).toBe('BLOCKED');
    });

    it('refuses a waiver longer than the longest, naming it, and keeps the longest and the shortest (AC-ST-PMT-005-1: 90 days)', async () => {
      expect(MAX_WAIVER_DAYS).toBe(90);
      const project = await freshProject();
      const tooLong = await refusal(grant(await input(project, { validUntil: inDays(90) })));
      expect(tooLong).toEqual({ code: 'WAIVER_TOO_LONG', status: 422, detail: 'valid_until', extensions: { max_days: 90, requested_days: 91, latest_day: inDays(89) } });
      expect(await countFor(project)).toBe(0);
      const longest = await grant(await input(project, { validUntil: inDays(89) }));
      expect(longest.days).toBe(90);
      const shortest = await grant(await input(project, { gateCode: 'HANDOVER', validUntil: TODAY }));
      expect(shortest.days).toBe(1);
    });

    it.each([
      ['a day in the past', () => inDays(-1)],
      ['a text that is not a date', () => 'next week'],
      ['a day that does not exist', () => '2026-02-30'],
      ['no day', () => undefined],
    ])('refuses %s as the last day', async (_name, day) => {
      const project = await freshProject();
      expect(await refusal(grant(await input(project, { validUntil: day() as string })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      expect(await countFor(project)).toBe(0);
    });

    it('refuses the people who asked for it: the maker of the decision, the officer of the dossier, whoever made or changed or answers for a permit of the type (AC-ST-PMT-005-1)', async () => {
      const project = await freshProject();
      // The leader made the decision document themselves.
      const own = await input(project, { decisionDocumentVersionId: await decision(LEADER) });
      expect(await refusal(grant(own))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      // The leader is in charge of the dossier.
      const dossierMine = await freshProject();
      await owner('update machvon.permit_dossier set owner_membership_id = $2::uuid where project_id = $1::uuid', [dossierMine, memberId(LEADER)]);
      expect(await refusal(grant(await input(dossierMine)))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      // The leader made, last changed or answers for a permit of the type.
      for (const [creator, updater, responsible] of [[LEADER, OFFICER, undefined], [OFFICER, LEADER, undefined], [OFFICER, OFFICER, LEADER]] as const) {
        const other = await freshProject();
        await permitMadeBy(other, 'BUILDING', TYPE_BUILDING, creator, updater, responsible);
        expect(await refusal(grant(await input(other)))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
        expect(await countFor(other)).toBe(0);
      }
      // A permit of another type does not make them a party to this waiver.
      const unrelated = await freshProject();
      await permitMadeBy(unrelated, 'ENV_PERMIT', TYPE_ENV, LEADER);
      expect((await grant(await input(unrelated))).status).toBe('ACTIVE');
      // Someone who has nothing to do with it may grant it.
      const fine = await freshProject();
      await permitMadeBy(fine, 'BUILDING', TYPE_BUILDING, PERMIT_MAKER);
      expect((await grant(await input(fine))).status).toBe('ACTIVE');
      expect(await countFor(project)).toBe(0);
    });

    it('needs a decision document the tenant holds that is not infected (DECISION_DOCUMENT_REQUIRED)', async () => {
      const project = await freshProject();
      for (const version of [randomUUID(), await decision(OFFICER, { infected: true }), await decision(OFFICER, { tenant: TENANT_B })]) {
        expect(await refusal(grant(await input(project, { decisionDocumentVersionId: version })))).toEqual({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422, detail: 'decision_document_version_id' });
      }
      expect(await countFor(project)).toBe(0);
    });

    it.each([
      ['a gate that is not one', { gateCode: 'ANY_GATE' }, 'gate_code'],
      ['a project that is not an identifier', { projectId: 'x' }, 'project_id'],
      ['a permit type that is not an identifier', { permitTypeId: 'x' }, 'permit_type_id'],
      ['a permit type the tenant does not hold', { permitTypeId: randomUUID() }, 'permit_type_id'],
      ['a decision that is not an identifier', { decisionDocumentVersionId: 'x' }, 'decision_document_version_id'],
      ['no reason', { reason: '   ' }, 'reason'],
      ['a reason that is too long', { reason: 'x'.repeat(2001) }, 'reason'],
      ['a reason with a control character', { reason: 'bell\u0007' }, 'reason'],
    ] as const)('refuses %s as a fault of the request', async (_name, change, field) => {
      const project = await freshProject();
      expect(await refusal(grant(await input(project, change as Partial<WaiverInput>)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    });

    it('lets one waiver be in force for a project, a gate and a permit type code, whichever version of the type it names', async () => {
      const project = await freshProject();
      const first = await grant(await input(project));
      const twice = await refusal(grant(await input(project)));
      expect(twice).toEqual({ code: 'WAIVER_STATE_INVALID', status: 409, detail: 'status', extensions: { active_waiver_id: first.id } });
      expect((await refusal(grant(await input(project, { permitTypeId: TYPE_BUILDING_V2 })))).code).toBe('WAIVER_STATE_INVALID');
      // Another gate, another type or another project is another waiver.
      expect((await grant(await input(project, { gateCode: 'HANDOVER' }))).status).toBe('ACTIVE');
      expect((await grant(await input(project, { permitTypeId: TYPE_ENV }))).status).toBe('ACTIVE');
      expect((await grant(await input(await freshProject()))).status).toBe('ACTIVE');
      // Once the first has ended a new decision may follow.
      await revoke(first.id);
      expect((await grant(await input(project))).status).toBe('ACTIVE');
      expect(await countFor(project)).toBe(4);
    });

    it('lets exactly one of several grants of the same waiver win', async () => {
      const project = await freshProject();
      const data = await Promise.all(Array.from({ length: 4 }, () => input(project)));
      const results = await Promise.allSettled(data.map((item) => grant(item)));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.flatMap((result) => (result.status === 'rejected' ? [(result.reason as { code: string }).code] : []))).toEqual(['WAIVER_STATE_INVALID', 'WAIVER_STATE_INVALID', 'WAIVER_STATE_INVALID']);
      expect(await countFor(project)).toBe(1);
    });

    it('knows no project outside the scope of the caller or of another tenant (404)', async () => {
      const project = await freshProject();
      expect(await refusal(grant(await input(project), LEADER, onlyBranch(OTHER_BRANCH)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(grant(await input(randomUUID())))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const foreign = await freshProject({ tenant: TENANT_B });
      expect(await refusal(grant(await input(foreign)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await grant(await input(project), LEADER, onlyBranch(DEPARTMENT))).status).toBe('ACTIVE');
    });
  });

  describe('revoke', () => {
    it('ends a waiver in force with the words that explain it, and a waiver that has ended cannot be revoked again', async () => {
      const project = await freshProject();
      const granted = await grant(await input(project));
      const revoked = await revoke(granted.id, '  The permit was issued after all  ');
      expect(revoked).toMatchObject({ id: granted.id, projectId: project, gateCode: 'START_CONSTRUCTION', permitTypeCode: 'BUILDING', version: 2, status: 'REVOKED' });
      expect(await rowOf(granted.id)).toMatchObject({ status: 'REVOKED', version: '2', revoked_by: memberId(LEADER), revoked_reason: 'The permit was issued after all' });
      expect(await refusal(revoke(granted.id))).toEqual({ code: 'WAIVER_STATE_INVALID', status: 409, detail: 'status', extensions: { waiver_status: 'REVOKED' } });
    });

    it('refuses a reason that is blank, too long or not text, and a waiver outside the scope or unknown (404)', async () => {
      const project = await freshProject();
      const granted = await grant(await input(project));
      for (const reason of ['   ', 'x'.repeat(2001), 5, null]) expect(await refusal(revoke(granted.id, reason))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(revoke(granted.id, 'reason', LEADER, onlyBranch(OTHER_BRANCH)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(revoke(randomUUID()))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await rowOf(granted.id))?.status).toBe('ACTIVE');
    });
  });

  describe('what the database keeps', () => {
    it('keeps what was decided, whoever writes: a waiver only ends', async () => {
      const project = await freshProject();
      const granted = await grant(await input(project));
      for (const change of [
        "reason = 'Another reason'",
        `valid_until = valid_until + 30`,
        "gate_code = 'HANDOVER'",
        'approved_by = created_by',
        "approved_at = approved_at + interval '1 day'",
        'decision_document_version_id = id',
        'permit_type_id = id',
        'created_by = approved_by',
      ]) {
        expect(await databaseRefusal(owner(`update machvon.permit_gate_waiver set ${change} where id = $1::uuid`, [granted.id]))).toMatchObject({ sqlstate: '23514' });
      }
      expect(await databaseRefusal(owner('update machvon.permit_gate_waiver set approved_by = created_by where id = $1::uuid', [granted.id]))).toMatchObject({ message: expect.stringContaining('only ends') });
    });

    it('never changes once ended, is born in force, and is never deleted', async () => {
      const project = await freshProject();
      const granted = await grant(await input(project));
      await revoke(granted.id);
      expect(await databaseRefusal(owner("update machvon.permit_gate_waiver set status = 'ACTIVE', revoked_at = null, revoked_by = null, revoked_reason = null where id = $1::uuid", [granted.id]))).toMatchObject({
        message: expect.stringContaining('never changes'),
      });
      expect(await databaseRefusal(owner('delete from machvon.permit_gate_waiver where id = $1::uuid', [granted.id]))).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('never deleted') });
      expect(await databaseRefusal(owner("update machvon.permit_gate_waiver set revoked_reason = 'x' where id = $1::uuid", [granted.id]))).toMatchObject({ sqlstate: '23514' });
      const insert = (status: string, extra = '') =>
        owner(
          `insert into machvon.permit_gate_waiver (tenant_id, id, project_id, gate_code, permit_type_id, reason, decision_document_version_id, valid_until, approved_by, status, created_by, updated_by${extra})
           values ($1, $2, $3, 'HANDOVER', $4, 'Reason', $5, $6::date, $7, $8, $9, $9${extra === '' ? '' : ", now(), $7, 'because'"})`,
          [TENANT_A, randomUUID(), project, TYPE_ENV, randomUUID(), inDays(5), memberId(LEADER), status, memberId(OFFICER)],
        );
      expect(await databaseRefusal(insert('EXPIRED'))).toMatchObject({ message: expect.stringContaining('starts in force') });
      expect(await databaseRefusal(insert('REVOKED', ', revoked_at, revoked_by, revoked_reason'))).toMatchObject({ message: expect.stringContaining('starts in force') });
      const grants = await owner<{ can_delete: boolean; can_truncate: boolean }>("select has_table_privilege('machvon_app', 'machvon.permit_gate_waiver', 'DELETE') as can_delete, has_table_privilege('machvon_app', 'machvon.permit_gate_waiver', 'TRUNCATE') as can_truncate");
      expect(grants[0]).toEqual({ can_delete: false, can_truncate: false });
    });

    it('holds the checks of the table: the approver is not the maker, the reason and the gate are real, a revoked waiver tells who and why', async () => {
      const project = await freshProject();
      const base = [TENANT_A, randomUUID(), project, TYPE_ENV, randomUUID(), inDays(5)];
      const insert = (gate: string, reason: string, approved: number, created: number) =>
        owner(
          `insert into machvon.permit_gate_waiver (tenant_id, id, project_id, gate_code, permit_type_id, reason, decision_document_version_id, valid_until, approved_by, status, created_by, updated_by)
           values ($1, $2, $3, $7, $4, $8, $5, $6::date, $9, 'ACTIVE', $10, $10)`,
          [...base, gate, reason, memberId(approved), memberId(created)],
        );
      expect(await databaseRefusal(insert('HANDOVER', 'Reason', LEADER, LEADER))).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('permit_gate_waiver_maker_chk') });
      expect(await databaseRefusal(insert('NOT_A_GATE', 'Reason', LEADER, OFFICER))).toMatchObject({ message: expect.stringContaining('permit_gate_waiver_gate_chk') });
      expect(await databaseRefusal(insert('HANDOVER', ' ', LEADER, OFFICER))).toMatchObject({ message: expect.stringContaining('permit_gate_waiver_reason_chk') });
      const granted = await grant(await input(project));
      expect(await databaseRefusal(owner("update machvon.permit_gate_waiver set status = 'REVOKED' where id = $1::uuid", [granted.id]))).toMatchObject({ message: expect.stringContaining('permit_gate_waiver_revoked_chk') });
    });
  });

  describe('the reads', () => {
    const page = { limit: 50, after: undefined };

    it('lists the waivers newest first with the project, the type and the dates, by project, gate and status, in pages', async () => {
      const project = await freshProject();
      const first = await grant(await input(project));
      const second = await grant(await input(project, { gateCode: 'HANDOVER', permitTypeId: TYPE_ENV, validUntil: inDays(10) }));
      await revoke(first.id);
      const all = await as((tx) => waivers.list(tx, everything, { projectId: project }, page));
      expect(all.map((row) => [row.id, row.status])).toEqual([
        [second.id, 'ACTIVE'],
        [first.id, 'REVOKED'],
      ]);
      expect(all[0]).toMatchObject({ project: { id: project, name: expect.stringContaining('Waiver project') }, gateCode: 'HANDOVER', permitTypeCode: 'ENV_PERMIT', permitTypeName: 'Permit type ENV_PERMIT', validUntil: inDays(10), grantedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), revokedOn: null, version: 1 });
      expect(all[1]).toMatchObject({ revokedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), revokedReason: 'The permit was issued after all', version: 2 });
      expect((await as((tx) => waivers.list(tx, everything, { projectId: project, status: 'ACTIVE' }, page))).map((row) => row.id)).toEqual([second.id]);
      expect((await as((tx) => waivers.list(tx, everything, { projectId: project, gateCode: 'START_CONSTRUCTION' }, page))).map((row) => row.id)).toEqual([first.id]);
      const page1 = await as((tx) => waivers.list(tx, everything, { projectId: project }, { limit: 1, after: undefined }));
      const anchor = page1[0] as { createdAtKey: string; id: string };
      const page2 = await as((tx) => waivers.list(tx, everything, { projectId: project }, { limit: 5, after: { code: anchor.createdAtKey, id: anchor.id } }));
      expect(page2.map((row) => row.id)).toEqual([first.id]);
      expect((await as((tx) => waivers.find(tx, first.id, everything)))?.id).toBe(first.id);
    });

    it('keeps to the scope and the tenant of the caller', async () => {
      const project = await freshProject();
      const granted = await grant(await input(project));
      expect(await as((tx) => waivers.list(tx, onlyBranch(OTHER_BRANCH), { projectId: project }, page))).toEqual([]);
      expect(await as((tx) => waivers.find(tx, granted.id, onlyBranch(OTHER_BRANCH)))).toBeUndefined();
      expect(await as((tx) => waivers.list(tx, everything, {}, page), LEADER, TENANT_B)).toEqual([]);
      expect(await as((tx) => waivers.find(tx, granted.id, everything), LEADER, TENANT_B)).toBeUndefined();
    });
  });

  describe('the job gate-waiver-expiry', () => {
    // The waivers the tests above left in force whose last day is today or earlier would be ended by the first pass below: end them first.
    beforeAll(async () => {
      await run(inDays(1));
    });

    const waiverIn = async (project: string, gate: string, validUntil: string): Promise<string> =>
      (await grant(await input(project, { gateCode: gate, validUntil }))).id;
    const auditsOf = (waiverId: string) => owner<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.gate_waiver_expired'", [waiverId]);
    const eventsOf = (waiverId: string) => owner<{ payload: Record<string, unknown>; event_key: string }>("select payload, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.gate_waiver.expired.v1'", [waiverId]);

    it('ends the waivers whose last day has passed once, with an audit row and an event, and leaves the ones still in force (the last day counts)', async () => {
      const project = await freshProject();
      const lapsed = await waiverIn(project, 'START_CONSTRUCTION', inDays(0));
      const lastDay = await waiverIn(project, 'HANDOVER', inDays(1));
      const later = await waiverIn(project, 'ACCEPTANCE_COMPLETION', inDays(20));
      const revoked = await waiverIn(project, 'ADVANCE_DISBURSEMENT', inDays(1));
      await revoke(revoked);
      // On the last day nothing ends; the day after, the lapsed ones do.
      const sameDay = await run(inDays(0));
      expect(sameDay.expired).toBe(0);
      const pass = await run(inDays(1));
      expect(pass.expired).toBe(1);
      expect(await rowOf(lapsed)).toMatchObject({ status: 'EXPIRED', version: '2' });
      expect((await rowOf(lastDay))?.status).toBe('ACTIVE');
      expect((await rowOf(later))?.status).toBe('ACTIVE');
      expect((await rowOf(revoked))?.status).toBe('REVOKED');
      const audits = await auditsOf(lapsed);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.diff).toMatchObject({ project_id: project, gate_code: 'START_CONSTRUCTION', permit_type_code: 'BUILDING', from_status: 'ACTIVE', to_status: 'EXPIRED', valid_until: inDays(0) });
      const events = await eventsOf(lapsed);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_key: `permit_gate_waiver:${lapsed}:expired`, payload: { gate_waiver_id: lapsed, project_id: project, gate_code: 'START_CONSTRUCTION', permit_type_code: 'BUILDING', status: 'EXPIRED', valid_until: inDays(0) } });
      // A second pass the same day does nothing; the day after the next, the other one ends.
      expect((await run(inDays(1))).expired).toBe(0);
      expect(await auditsOf(lapsed)).toHaveLength(1);
      expect((await run(inDays(2))).expired).toBe(1);
      expect((await rowOf(lastDay))?.status).toBe('EXPIRED');
    });

    it('tells how many waivers are still in force, for the gauge, and does nothing for another tenant', async () => {
      const project = await freshProject();
      await waiverIn(project, 'START_CONSTRUCTION', inDays(0));
      await waiverIn(project, 'HANDOVER', inDays(50));
      const before = Number((await owner<{ n: string }>("select count(*)::text as n from machvon.permit_gate_waiver where status = 'ACTIVE'"))[0]?.n);
      const pass = await run(inDays(1));
      expect(pass.active).toBe(before - pass.expired);
      expect(pass.active).toBeGreaterThanOrEqual(1);
      expect(await run(inDays(1), TENANT_B)).toEqual({ expired: 0, active: 0 });
    });

    it('lets a new decision follow once the waiver has expired', async () => {
      const project = await freshProject();
      const first = await waiverIn(project, 'START_CONSTRUCTION', inDays(0));
      expect((await refusal(grant(await input(project)))).code).toBe('WAIVER_STATE_INVALID');
      await run(inDays(1));
      expect((await rowOf(first))?.status).toBe('EXPIRED');
      expect((await grant(await input(project))).status).toBe('ACTIVE');
    });
  });
});
