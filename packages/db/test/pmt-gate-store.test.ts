import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { assertOneWinner, runLoops, tallyOutcomes } from '@machvon/kernel';
import { PmtGateStore } from '../src/pmt-gate-store';
import type { GateRuleInput } from '../src/pmt-gate-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const TODAY = '2026-10-24';
const gates = new PmtGateStore({ today: () => TODAY });
const ACTOR = 1;
const APPROVER = 2;
const PROVINCE = 1;
const DEPARTMENT = 2;
const FAMILY = 0x96;
const TYPE_BUILDING = id(FAMILY, 41);
const TYPE_ENV = id(FAMILY, 42);
const TYPE_DRAFT = id(FAMILY, 43);
const DOCUMENT = id(FAMILY, 31);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
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

interface ProjectOptions {
  group?: string;
  vnd?: string;
  tenant?: string;
}

/** A project of its own (nothing a test of the gates changes leaks into another one). */
async function freshProject(options: ProjectOptions = {}): Promise<string> {
  const n = next();
  const projectId = id(FAMILY, 100 + n);
  await seedAs([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', $8::numeric, 'IMPLEMENTATION', 1, $9)`,
      [options.tenant ?? TENANT_A, projectId, `PRJ-G-${String(n).padStart(3, '0')}`, `Project ${n}`, unitId(DEPARTMENT), unitId(PROVINCE), id(FAMILY, 42), options.vnd ?? '1000000', options.group ?? 'B'],
    ],
  ]);
  return projectId;
}

async function dossierOf(projectId: string, componentId: string | null = null, tenant = TENANT_A): Promise<string> {
  const dossierId = id(FAMILY, 300 + next());
  await seedAs([
    [
      `insert into machvon.permit_dossier (tenant_id, id, project_id, project_component_id, owner_unit_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6)`,
      [tenant, dossierId, projectId, componentId, unitId(DEPARTMENT), memberId(ACTOR)],
    ],
  ]);
  return dossierId;
}

/** Every test writes the rules it needs: the rules of the tests before it would overlap them. */
const clearRules = (): Promise<unknown[]> => owner('delete from machvon.permit_gate_rule');

interface PermitOptions {
  typeId?: string;
  typeCode?: string;
  status?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  noExpiry?: boolean;
}

async function permitOf(dossierId: string, options: PermitOptions = {}, tenant = TENANT_A): Promise<string> {
  const permitId = randomUUID();
  const status = options.status ?? 'ISSUED';
  const issued = ['ISSUED', 'EXPIRED', 'SUPERSEDED', 'REVOKED'].includes(status);
  await seedAs([
    [
      `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_type_code, permit_no, status, issued_on, valid_from, valid_until, no_expiry, document_version_id, is_required,
                                   exemption_basis, exemption_decision_document_version_id, revoke_reason, revocation_document_version_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date, $8::date, $9::date, $10, $11, true, $12, $13, $14, $13, $15, $15)`,
      [
        tenant,
        permitId,
        dossierId,
        options.typeId ?? TYPE_BUILDING,
        options.typeCode ?? 'BUILDING',
        issued ? `GP-${String(next()).padStart(4, '0')}` : null,
        status,
        issued ? (options.validFrom === undefined ? '2026-01-01' : options.validFrom) : null,
        options.noExpiry === true ? null : issued ? (options.validUntil === undefined ? '2026-12-31' : options.validUntil) : null,
        options.noExpiry === true,
        issued ? DOCUMENT : null,
        status === 'EXEMPTED' ? 'Exempt under the construction law' : null,
        status === 'EXEMPTED' || status === 'REVOKED' ? DOCUMENT : null,
        status === 'REVOKED' ? 'The authority took the permit back' : null,
        memberId(ACTOR),
      ],
    ],
  ]);
  return permitId;
}

const waiverOf = async (projectId: string, gate: string, typeId: string, overrides: { status?: string; validUntil?: string; approvedAt?: string } = {}): Promise<string> => {
  const waiverId = randomUUID();
  await seedAs([
    [
      `insert into machvon.permit_gate_waiver (tenant_id, id, project_id, gate_code, permit_type_id, reason, decision_document_version_id, valid_until, approved_by, approved_at, status, created_by, updated_by,
                                               revoked_at, revoked_by, revoked_reason)
       values ($1, $2, $3, $4, $5, 'The decision allows the work to begin', $6, $7::date, $8, $9::timestamptz, $10, $11, $11,
               case when $10 = 'REVOKED' then now() end, case when $10 = 'REVOKED' then $8::uuid end, case when $10 = 'REVOKED' then 'The permit was issued' end)`,
      [TENANT_A, waiverId, projectId, gate, typeId, DOCUMENT, overrides.validUntil ?? '2026-12-31', memberId(APPROVER), overrides.approvedAt ?? '2026-06-01T03:00:00Z', overrides.status ?? 'ACTIVE', memberId(ACTOR)],
    ],
  ]);
  return waiverId;
};

const input = (overrides: Partial<GateRuleInput> = {}): GateRuleInput => ({
  gateCode: 'CONTRACT_ACTIVATION',
  permitTypeId: TYPE_BUILDING,
  requirement: 'VALID_PERMIT',
  appliesToRule: {},
  legalBasis: 'Luật Xây dựng 135/2025, điều 41',
  effectiveFrom: '2026-01-01',
  ...overrides,
});

const publish = (data: GateRuleInput) => as((tx) => gates.publish(tx, data, memberId(ACTOR)));
const evaluate = (projectId: string, gate: string, asOf?: string, tenant = TENANT_A) => as((tx) => gates.evaluate(tx, projectId, gate, asOf), tenant);

const GATES = ['CONTRACT_ACTIVATION', 'START_CONSTRUCTION', 'ACCEPTANCE_COMPLETION', 'ADVANCE_DISBURSEMENT'] as const;

beforeAll(async () => {
  await harness.start();
  for (const tenant of [TENANT_A, TENANT_B]) {
    await harness.seedUnits(tenant, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
    ]);
    await harness.seedMembership(tenant, ACTOR, PROVINCE);
    await seedAs(
      [
        [TYPE_BUILDING, 'BUILDING', 'PUBLISHED'],
        [TYPE_ENV, 'ENV_PERMIT', 'PUBLISHED'],
        [TYPE_DRAFT, 'DRAFTED', 'DRAFT'],
      ].map(([typeId, code, status]) => [
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, $3, $4, 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, $5, $6, $6)`,
        [tenant, typeId, code, `Permit type ${code}`, status, memberId(ACTOR)],
      ]),
    );
  }
}, 240_000);

beforeEach(async () => {
  await clearRules();
});

afterAll(async () => {
  await harness.stop();
}, 60_000);

jest.setTimeout(240_000);

describe('PmtGateStore.publish and retire (publishPermitGateRule, retirePermitGateRule, ST-PMT-004)', () => {
  it('publishes the first rule of a gate and a permit type at revision 1, and the next one takes over from its day, ending the one before', async () => {
    const first = await publish(input({ gateCode: 'START_CONSTRUCTION', projectMilestoneCode: 'START_CONSTRUCTION' }));
    expect(first).toMatchObject({ revision: 1, version: 1, supersededId: null, permitTypeCode: 'BUILDING' });
    const second = await publish(input({ gateCode: 'START_CONSTRUCTION', effectiveFrom: '2027-01-01', legalBasis: 'Nghị định 217/2026, điều 12', requirement: 'VALID_OR_EXEMPT' }));
    expect(second).toMatchObject({ revision: 2, supersededId: first.id });
    const rows = await owner<{ id: string; status: string; effective_from: string; effective_until: string | null; revision: number; permit_type_code: string; version: string }>(
      'select id, status, effective_from::text, effective_until::text, revision, permit_type_code, version::text from machvon.permit_gate_rule where gate_code = $1 order by revision',
      ['START_CONSTRUCTION'],
    );
    expect(rows).toEqual([
      { id: first.id, status: 'RETIRED', effective_from: '2026-01-01', effective_until: '2026-12-31', revision: 1, permit_type_code: 'BUILDING', version: '2' },
      { id: second.id, status: 'PUBLISHED', effective_from: '2027-01-01', effective_until: null, revision: 2, permit_type_code: 'BUILDING', version: '1' },
    ]);
    // Another gate and another permit type have their own sequence of revisions.
    expect((await publish(input({ gateCode: 'HANDOVER' }))).revision).toBe(1);
    expect((await publish(input({ gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE_ENV }))).revision).toBe(1);
  });

  it('refuses a rule that overlaps the one before it (409 GATE_RULE_OVERLAP), a start in the past for a revision, and an end that is not after the start', async () => {
    await publish(input({ gateCode: 'ACCEPTANCE_COMPLETION', effectiveFrom: '2026-06-01', effectiveUntil: '2026-12-31' }));
    // The same days again, a start inside the first rule, and a start before it: none can follow it.
    for (const effectiveFrom of ['2026-06-01', '2026-08-01', '2026-03-01']) expect(await refusal(publish(input({ gateCode: 'ACCEPTANCE_COMPLETION', effectiveFrom })))).toEqual({ code: 'GATE_RULE_OVERLAP', status: 409 });
    // A rule after it that begins in the past cannot change which rule applied on those days.
    await publish(input({ gateCode: 'ADVANCE_DISBURSEMENT', effectiveFrom: '2026-01-01' }));
    expect(await refusal(publish(input({ gateCode: 'ADVANCE_DISBURSEMENT', effectiveFrom: '2026-10-01' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_from' });
    expect(await refusal(publish(input({ gateCode: 'ADVANCE_DISBURSEMENT', effectiveFrom: '2027-03-01', effectiveUntil: '2027-03-01' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
    expect(await refusal(publish(input({ gateCode: 'ADVANCE_DISBURSEMENT', effectiveFrom: '2027-03-01', effectiveUntil: '2027-02-01' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
  });

  it('refuses a rule without a legal basis (422 LEGAL_BASIS_REQUIRED) and every malformed field', async () => {
    expect(await refusal(publish(input({ legalBasis: '   ' })))).toEqual({ code: 'LEGAL_BASIS_REQUIRED', status: 422, detail: 'legal_basis' });
    const bad = async (overrides: Partial<GateRuleInput>, detail: string) => expect(await refusal(publish(input(overrides)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail });
    await bad({ gateCode: 'ANY_GATE' }, 'gate_code');
    await bad({ requirement: 'ALWAYS' }, 'requirement');
    await bad({ legalBasis: 'x'.repeat(2001) }, 'legal_basis');
    await bad({ legalBasis: 'a\u0000b' }, 'legal_basis');
    await bad({ projectMilestoneCode: '  ' }, 'project_milestone_code');
    await bad({ projectMilestoneCode: 'x'.repeat(101) }, 'project_milestone_code');
    await bad({ appliesToRule: { unknown_key: 1 } }, 'applies_to_rule');
    await bad({ appliesToRule: 'every project' }, 'applies_to_rule');
    await bad({ effectiveFrom: '2026-02-30' }, 'effective_from');
    await bad({ permitTypeId: randomUUID() }, 'permit_type_id');
    // A version of a permit type that was never published is no permit to ask for.
    await bad({ permitTypeId: TYPE_DRAFT }, 'permit_type_id');
  });

  it('lets exactly one of several publications of the same gate and permit type win the first day', async () => {
    let gate: (typeof GATES)[number] = 'CONTRACT_ACTIVATION';
    const rounds = await runLoops({
      loops: 4,
      reset: async (loop) => {
        gate = GATES[loop - 1] as (typeof GATES)[number];
        await owner('delete from machvon.permit_gate_rule where gate_code = $1', [gate]);
      },
      commands: () =>
        [0, 1, 2, 3].map(() => async () => {
          // The permit type of every racer differs from the rules the other tests wrote for the gate, so the first day is open.
          await publish(input({ gateCode: gate, permitTypeId: TYPE_ENV, effectiveFrom: '2030-01-01' }));
        }),
      verify: async ({ outcomes }) => {
        // The first publication of a code can only be followed by a later one: at the same day the others overlap.
        assertOneWinner(outcomes, ['409 GATE_RULE_OVERLAP']);
        const published = await owner<{ n: string }>("select count(*)::text as n from machvon.permit_gate_rule where gate_code = $1 and permit_type_code = 'ENV_PERMIT' and effective_from = '2030-01-01' and status = 'PUBLISHED'", [gate]);
        expect(published[0]?.n).toBe('1');
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': 4, '409 GATE_RULE_OVERLAP': 12 });
  }, 240_000);

  it('ends a rule on a day that is not past, only earlier than before, and asking for the end it has changes nothing', async () => {
    const rule = await publish(input({ gateCode: 'HANDOVER', permitTypeId: TYPE_ENV, effectiveFrom: '2026-01-01' }));
    const ended = await as((tx) => gates.retire(tx, rule.id, '2027-06-30', memberId(ACTOR)));
    expect(ended).toMatchObject({ version: 2, changed: true });
    expect(ended.row).toMatchObject({ gateCode: 'HANDOVER', status: 'PUBLISHED' });
    const again = await as((tx) => gates.retire(tx, rule.id, '2027-06-30', memberId(ACTOR)));
    expect(again).toMatchObject({ version: 2, changed: false });
    const earlier = await as((tx) => gates.retire(tx, rule.id, '2027-03-31', memberId(ACTOR)));
    expect(earlier).toMatchObject({ version: 3, changed: true });
    expect(await refusal(as((tx) => gates.retire(tx, rule.id, '2027-04-30', memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
    expect(await refusal(as((tx) => gates.retire(tx, rule.id, '2026-06-01', memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
    expect(await refusal(as((tx) => gates.retire(tx, rule.id, '2025-12-31', memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
    expect(await refusal(as((tx) => gates.retire(tx, randomUUID(), '2027-03-31', memberId(ACTOR))))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(as((tx) => gates.retire(tx, rule.id, 'tomorrow', memberId(ACTOR))))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_until' });
    const [stored] = await owner<{ status: string; effective_until: string }>('select status, effective_until::text from machvon.permit_gate_rule where id = $1::uuid', [rule.id]);
    expect(stored).toEqual({ status: 'RETIRED', effective_until: '2027-03-31' });
  });

  it('reads the rules newest first by gate and status, in pages, and a rule of another tenant is not there', async () => {
    await publish(input({ gateCode: 'HANDOVER' }));
    await publish(input({ gateCode: 'HANDOVER', effectiveFrom: '2027-01-01' }));
    await publish(input({ gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE_ENV }));
    await publish(input({ gateCode: 'ACCEPTANCE_COMPLETION' }));
    const all = await as((tx) => gates.list(tx, {}, { limit: 100, after: undefined }));
    expect(all.length).toBeGreaterThan(3);
    expect(all.map((row) => row.createdAtKey)).toEqual([...all.map((row) => row.createdAtKey)].sort().reverse());
    const handover = await as((tx) => gates.list(tx, { gateCode: 'HANDOVER' }, { limit: 100, after: undefined }));
    expect(handover.every((row) => row.gateCode === 'HANDOVER')).toBe(true);
    const retired = await as((tx) => gates.list(tx, { status: 'RETIRED' }, { limit: 100, after: undefined }));
    expect(retired.every((row) => row.status === 'RETIRED')).toBe(true);
    const page = await as((tx) => gates.list(tx, {}, { limit: 2, after: undefined }));
    const last = page[1] as (typeof page)[number];
    const rest = await as((tx) => gates.list(tx, {}, { limit: 100, after: { code: last.createdAtKey, id: last.id } }));
    expect([...page, ...rest].map((row) => row.id)).toEqual(all.map((row) => row.id));
    expect(await as((tx) => gates.list(tx, {}, { limit: 100, after: undefined }), TENANT_B)).toEqual([]);
    expect(await as((tx) => gates.find(tx, all[0]?.id ?? '', false), TENANT_B)).toBeUndefined();
  });

  it('is immutable in the database: a rule keeps its content for good, may only be ended, and is never deleted by the application role', async () => {
    const rule = await publish(input({ gateCode: 'ACCEPTANCE_COMPLETION', permitTypeId: TYPE_ENV, effectiveFrom: '2026-02-01' }));
    await expect(owner("update machvon.permit_gate_rule set legal_basis = 'Another basis' where id = $1::uuid", [rule.id])).rejects.toThrow(/immutable/);
    await expect(owner("update machvon.permit_gate_rule set requirement = 'SUBMITTED_ONLY' where id = $1::uuid", [rule.id])).rejects.toThrow(/immutable/);
    await expect(owner("update machvon.permit_gate_rule set status = 'DRAFT' where id = $1::uuid", [rule.id])).rejects.toThrow(/does not move/);
    await expect(owner("update machvon.permit_gate_rule set effective_until = '2030-01-01' where id = $1::uuid", [rule.id])).rejects.toThrow(/only be ended/);
    await expect(as((tx) => tx.query('delete from machvon.permit_gate_rule where id = $1::uuid', [rule.id]))).rejects.toThrow(/permission denied/);
    await expect(as((tx) => tx.query('truncate machvon.permit_gate_rule'))).rejects.toThrow(/permission denied/);
    await expect(
      owner(
        `insert into machvon.permit_gate_rule (tenant_id, id, gate_code, permit_type_id, requirement, applies_to_rule, legal_basis, effective_from, effective_until, status, created_by, updated_by)
         values ($1, gen_random_uuid(), 'HANDOVER', $2, 'VALID_PERMIT', '{}'::jsonb, 'x', '2030-01-01', '2030-01-01', 'PUBLISHED', $3, $3)`,
        [TENANT_A, TYPE_BUILDING, memberId(ACTOR)],
      ),
    ).rejects.toThrow(/permit_gate_rule_dates_chk/);
  });
});

describe('PmtGateStore.evaluate (evaluatePermitGates, ST-PMT-004, AC-ST-PMT-004-1)', () => {
  it('is BLOCKED without the permit and PASSED with it, by the rule in force on the day, with its legal basis and the permit that satisfies it', async () => {
    await publish(input({ gateCode: 'CONTRACT_ACTIVATION', permitTypeId: TYPE_ENV, requirement: 'VALID_PERMIT', effectiveFrom: '2026-01-01', legalBasis: 'Luật Bảo vệ môi trường 2020, điều 41' }));
    const project = await freshProject();
    const blocked = await evaluate(project, 'CONTRACT_ACTIVATION');
    expect(blocked).toMatchObject({ projectId: project, gateCode: 'CONTRACT_ACTIVATION', asOf: TODAY, status: 'BLOCKED' });
    expect(blocked?.verdicts.find((verdict) => verdict.permitTypeCode === 'ENV_PERMIT')).toMatchObject({ outcome: 'BLOCKING', requirement: 'VALID_PERMIT', legalBasis: 'Luật Bảo vệ môi trường 2020, điều 41', permit: null, waiver: null });
    const dossier = await dossierOf(project);
    const permit = await permitOf(dossier, { typeId: TYPE_ENV, typeCode: 'ENV_PERMIT', validFrom: '2026-03-01', validUntil: '2026-12-31' });
    const passed = await evaluate(project, 'CONTRACT_ACTIVATION');
    const verdict = passed?.verdicts.find((entry) => entry.permitTypeCode === 'ENV_PERMIT');
    expect(verdict).toMatchObject({ outcome: 'SATISFIED', permit: { id: permit, status: 'ISSUED', validUntil: '2026-12-31' } });
    // The same project on other days: before the permit began, on its first and last day, after it ended.
    const status = async (asOf: string) => (await evaluate(project, 'CONTRACT_ACTIVATION', asOf))?.verdicts.find((entry) => entry.permitTypeCode === 'ENV_PERMIT')?.outcome;
    expect(await status('2026-02-28')).toBe('BLOCKING');
    expect(await status('2026-03-01')).toBe('SATISFIED');
    expect(await status('2026-12-31')).toBe('SATISFIED');
    expect(await status('2027-01-01')).toBe('BLOCKING');
    // Before the rule began there was nothing to ask for.
    expect((await evaluate(project, 'CONTRACT_ACTIVATION', '2025-12-31'))?.verdicts.find((entry) => entry.permitTypeCode === 'ENV_PERMIT')).toBeUndefined();
  });

  it('counts an exemption only where the rule allows it, and a filed permit only where a filing is enough (AC-ST-PMT-004-1: an exempted project passes)', async () => {
    await publish(input({ gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE_BUILDING, requirement: 'VALID_OR_EXEMPT' }));
    await publish(input({ gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE_ENV, requirement: 'SUBMITTED_ONLY' }));
    const exempted = await freshProject();
    const exemptedDossier = await dossierOf(exempted);
    await permitOf(exemptedDossier, { status: 'EXEMPTED' });
    await permitOf(exemptedDossier, { typeId: TYPE_ENV, typeCode: 'ENV_PERMIT', status: 'SUBMITTED' });
    expect((await evaluate(exempted, 'START_CONSTRUCTION'))?.status).toBe('PASSED');
    // A plan only (PLANNED) is not a filing; a rejection is not either.
    const planned = await freshProject();
    const plannedDossier = await dossierOf(planned);
    await permitOf(plannedDossier, { status: 'EXEMPTED' });
    await permitOf(plannedDossier, { typeId: TYPE_ENV, typeCode: 'ENV_PERMIT', status: 'PLANNED' });
    const stuck = await evaluate(planned, 'START_CONSTRUCTION');
    expect(stuck?.status).toBe('BLOCKED');
    expect(stuck?.verdicts.map((verdict) => [verdict.permitTypeCode, verdict.outcome])).toEqual([
      ['BUILDING', 'SATISFIED'],
      ['ENV_PERMIT', 'BLOCKING'],
    ]);
    const rejected = await freshProject();
    await permitOf(await dossierOf(rejected), { typeId: TYPE_ENV, typeCode: 'ENV_PERMIT', status: 'REJECTED' });
    expect((await evaluate(rejected, 'START_CONSTRUCTION'))?.verdicts.map((verdict) => [verdict.permitTypeCode, verdict.outcome])).toEqual([
      ['BUILDING', 'BLOCKING'],
      ['ENV_PERMIT', 'BLOCKING'],
    ]);
    // An exemption does not satisfy a rule that asks for a valid permit.
    await publish(input({ gateCode: 'ACCEPTANCE_COMPLETION', permitTypeId: TYPE_BUILDING, requirement: 'VALID_PERMIT' }));
    expect((await evaluate(exempted, 'ACCEPTANCE_COMPLETION'))?.status).toBe('BLOCKED');
  });

  it('judges a permit by the day: one that has since expired, been renewed or replaced counted while it was valid, one that was taken back never counts', async () => {
    await publish(input({ gateCode: 'HANDOVER', permitTypeId: TYPE_BUILDING, requirement: 'VALID_PERMIT', effectiveFrom: '2025-01-01' }));
    const project = await freshProject();
    const dossier = await dossierOf(project);
    await permitOf(dossier, { status: 'EXPIRED', validFrom: '2025-06-01', validUntil: '2026-06-30' });
    await permitOf(dossier, { status: 'ISSUED', validFrom: '2026-07-01', validUntil: '2027-06-30', typeId: TYPE_BUILDING });
    const outcome = async (asOf: string) => (await evaluate(project, 'HANDOVER', asOf))?.status;
    expect(await outcome('2025-07-01')).toBe('PASSED');
    expect(await outcome('2026-06-30')).toBe('PASSED');
    expect(await outcome('2026-07-01')).toBe('PASSED');
    expect(await outcome('2025-05-31')).toBe('BLOCKED');
    expect(await outcome('2027-07-01')).toBe('BLOCKED');
    const revoked = await freshProject();
    await permitOf(await dossierOf(revoked), { status: 'REVOKED', validFrom: '2025-06-01', validUntil: '2027-06-30' });
    expect((await evaluate(revoked, 'HANDOVER', '2026-01-01'))?.status).toBe('BLOCKED');
    // A permit with no end counts from its first day for ever; the permits of every dossier of the project count (one per component).
    const forever = await freshProject();
    await permitOf(await dossierOf(forever), { status: 'ISSUED', validFrom: '2025-06-01', noExpiry: true });
    expect((await evaluate(forever, 'HANDOVER', '2090-01-01'))?.status).toBe('PASSED');
    const split = await freshProject();
    await dossierOf(split);
    await permitOf(await dossierOf(split, randomUUID()), { status: 'ISSUED', validFrom: '2025-06-01', validUntil: '2027-12-31' });
    expect((await evaluate(split, 'HANDOVER', '2026-10-24'))?.status).toBe('PASSED');
  });

  it('does not ask a project for what the rule does not apply to it, and the rule of a gate is not the rule of another', async () => {
    await publish(input({ gateCode: 'ADVANCE_DISBURSEMENT', permitTypeId: TYPE_ENV, appliesToRule: { project_group_keys: ['A'] }, effectiveFrom: '2026-01-01' }));
    const small = await freshProject({ group: 'B' });
    const big = await freshProject({ group: 'A' });
    const open = await evaluate(small, 'ADVANCE_DISBURSEMENT');
    expect(open).toMatchObject({ status: 'PASSED', verdicts: [] });
    expect((await evaluate(big, 'ADVANCE_DISBURSEMENT'))?.status).toBe('BLOCKED');
    // A rule of investment size: only the projects of at least five billion are asked.
    await publish(input({ gateCode: 'ADVANCE_DISBURSEMENT', permitTypeId: TYPE_BUILDING, appliesToRule: { min_total_investment_vnd: '5000000000' }, effectiveFrom: '2026-01-01' }));
    const costly = await freshProject({ group: 'B', vnd: '6000000000' });
    expect((await evaluate(costly, 'ADVANCE_DISBURSEMENT'))?.verdicts.map((verdict) => verdict.permitTypeCode)).toEqual(['BUILDING']);
    expect((await evaluate(small, 'ADVANCE_DISBURSEMENT'))?.verdicts).toEqual([]);
  });

  it('(AC-ST-PMT-004-2: unless a waiver is active) lets a waiver in force pass the gate with the waiver named, and not one that ended, was revoked, was granted later, or is for another gate or permit', async () => {
    await publish(input({ gateCode: 'ACCEPTANCE_COMPLETION', permitTypeId: TYPE_ENV, requirement: 'VALID_PERMIT', effectiveFrom: '2025-01-01' }));
    const project = await freshProject();
    const waiver = await waiverOf(project, 'ACCEPTANCE_COMPLETION', TYPE_ENV, { validUntil: '2026-12-31', approvedAt: '2026-06-01T03:00:00Z' });
    const waived = await evaluate(project, 'ACCEPTANCE_COMPLETION');
    expect(waived?.status).toBe('PASSED_WITH_WAIVER');
    expect(waived?.verdicts.find((verdict) => verdict.permitTypeCode === 'ENV_PERMIT')).toMatchObject({ outcome: 'WAIVED', waiver: { id: waiver, validUntil: '2026-12-31' }, permit: null });
    const outcome = async (asOf: string) => (await evaluate(project, 'ACCEPTANCE_COMPLETION', asOf))?.status;
    expect(await outcome('2026-12-31')).toBe('PASSED_WITH_WAIVER');
    expect(await outcome('2027-01-01')).toBe('BLOCKED');
    // The waiver did not exist before it was granted (Vietnam day 2026-06-01).
    expect(await outcome('2026-05-31')).toBe('BLOCKED');
    expect(await outcome('2026-06-01')).toBe('PASSED_WITH_WAIVER');
    // Ended, revoked and expired waivers do not count; neither does a waiver for another gate, another permit type or another project.
    const ended = await freshProject();
    await waiverOf(ended, 'ACCEPTANCE_COMPLETION', TYPE_ENV, { status: 'REVOKED' });
    await waiverOf(ended, 'ACCEPTANCE_COMPLETION', TYPE_ENV, { status: 'EXPIRED' });
    await waiverOf(ended, 'HANDOVER', TYPE_ENV);
    await waiverOf(ended, 'ACCEPTANCE_COMPLETION', TYPE_BUILDING);
    expect((await evaluate(ended, 'ACCEPTANCE_COMPLETION'))?.status).toBe('BLOCKED');
    // A permit that satisfies the rule wins over a waiver: the verdict is SATISFIED and names the permit.
    const both = await freshProject();
    await waiverOf(both, 'ACCEPTANCE_COMPLETION', TYPE_ENV);
    await permitOf(await dossierOf(both), { typeId: TYPE_ENV, typeCode: 'ENV_PERMIT', validFrom: '2026-01-01', validUntil: '2026-12-31' });
    expect((await evaluate(both, 'ACCEPTANCE_COMPLETION'))?.status).toBe('PASSED');
  });

  it('says BLOCKED when any one rule is not met, naming every rule it judged, and lists the blocking ones when it refuses a command (AC-ST-PMT-004-2: the guard every command calls answers PERMIT_GATE_BLOCKED)', async () => {
    await publish(input({ gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE_BUILDING, requirement: 'VALID_OR_EXEMPT' }));
    await publish(input({ gateCode: 'START_CONSTRUCTION', permitTypeId: TYPE_ENV, requirement: 'SUBMITTED_ONLY' }));
    const project = await freshProject();
    const dossier = await dossierOf(project);
    await permitOf(dossier, { typeId: TYPE_BUILDING, typeCode: 'BUILDING', validFrom: '2026-01-01', validUntil: '2026-12-31' });
    const evaluation = await evaluate(project, 'START_CONSTRUCTION');
    expect(evaluation?.status).toBe('BLOCKED');
    expect(evaluation?.verdicts.map((verdict) => [verdict.permitTypeCode, verdict.outcome])).toEqual([
      ['BUILDING', 'SATISFIED'],
      ['ENV_PERMIT', 'BLOCKING'],
    ]);
    const refused = await refusal(as((tx) => gates.assertPasses(tx, project, 'START_CONSTRUCTION')));
    expect(refused).toMatchObject({ code: 'PERMIT_GATE_BLOCKED', status: 409, detail: 'gate_code' });
    expect(refused.extensions).toMatchObject({ gate_code: 'START_CONSTRUCTION', as_of: TODAY });
    expect(refused.extensions?.blocking).toEqual([expect.objectContaining({ permit_type_code: 'ENV_PERMIT', requirement: 'SUBMITTED_ONLY', legal_basis: expect.any(String) })]);
    // Once the missing one is filed the same command goes through.
    await permitOf(dossier, { typeId: TYPE_ENV, typeCode: 'ENV_PERMIT', status: 'SUBMITTED' });
    const passed = await as((tx) => gates.assertPasses(tx, project, 'START_CONSTRUCTION'));
    expect(passed.status).toBe('PASSED');
    // A gate with no rule in force asks for nothing.
    expect((await as((tx) => gates.assertPasses(tx, project, 'HANDOVER', '2024-01-01'))).verdicts).toEqual([]);
  });

  it('knows no project of another tenant or that does not exist, and refuses a gate or a day that is not one', async () => {
    const foreign = await freshProject({ tenant: TENANT_B });
    expect(await evaluate(foreign, 'CONTRACT_ACTIVATION')).toBeUndefined();
    expect(await evaluate(randomUUID(), 'CONTRACT_ACTIVATION')).toBeUndefined();
    expect(await refusal(as((tx) => gates.assertPasses(tx, foreign, 'CONTRACT_ACTIVATION')))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    const project = await freshProject();
    expect(await refusal(evaluate(project, 'ANY_GATE'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'gate_code' });
    for (const asOf of ['yesterday', '2026-02-30', '2026-13-01', '26-01-01']) expect(await refusal(evaluate(project, 'CONTRACT_ACTIVATION', asOf))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'as_of' });
  });
});
