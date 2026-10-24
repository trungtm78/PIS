import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { IssSlaDeadlines } from '../src/iss-sla-deadline';
import { IssIssueStore, issueScope, issueText } from '../src/iss-issue-store';
import type { CreatedIssue, IssuePlace, IssueScopes, NewIssue } from '../src/iss-issue-store';
import { IssSlaPolicyStore } from '../src/iss-sla-policy-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const policies = new IssSlaPolicyStore({ today: () => '2026-08-01' });
const issues = new IssIssueStore(new IssSlaDeadlines(policies));

const REPORTER = 1;
const ASSIGNER = 2;
const WORKER_U1 = 3;
const WORKER_U2 = 4;
const NO_GRANT = 5;
const SUSPENDED = 6;
const WORKER_ALL = 7;
const GUEST = 8;
const CONTRACTOR = id(0x7d, 8);
const FAMILY = 0x7d;
const PROJECT = id(FAMILY, 1);
const PROJECT_OTHER = id(FAMILY, 2);
const CONTRACT = id(FAMILY, 3);
const CONTRACT_OTHER_PROJECT = id(FAMILY, 4);
const DOCUMENT_CLEAN = id(FAMILY, 5);
const DOCUMENT_PENDING = id(FAMILY, 6);
const FOREIGN_PROJECT = id(FAMILY, 7);
const UNIT_1 = unitId(1);
const UNIT_2 = unitId(2);
const UNIT_3 = unitId(3);
/** Monday 10 August 2026, 09:00 in Vietnam: inside the window of the SLA (07:30 to 17:00). */
const NOW = new Date('2026-08-10T02:00:00Z');

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = REPORTER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function sqlRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

const accessOf = (permissions: readonly string[], scope: Scope, member = REPORTER): EffectiveAccess => ({
  membershipId: memberId(member),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions, scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const subtree = (n: number): Scope => ({ kind: 'UNIT_SUBTREE', refIds: [unitId(n)], paths: [`/u${n}/`] });
const TENANT_WIDE: Scope = { kind: 'TENANT' };

/** The scopes of a command for a caller whose grant carries the permission over `scope`. */
const scopesOf = (permission: string, scope: Scope, member = REPORTER, reporter = false): IssueScopes => {
  const access = accessOf([permission, 'issue.read'], scope, member);
  return { act: issueScope(access, permission, NOW, reporter ? { reporter: memberId(member) } : {}), read: issueScope(access, 'issue.read', NOW, reporter ? { reporter: memberId(member) } : {}) };
};
const everything = (permission: string): IssueScopes => scopesOf(permission, TENANT_WIDE);

let category = '';
let counter = 0;

const request = (extra: Partial<NewIssue> = {}): NewIssue => {
  counter += 1;
  return {
    projectId: PROJECT,
    categoryVersionId: category,
    severity: 'HIGH',
    title: `Land handover is blocked ${counter}`,
    description: 'The handover of plot 12 is blocked by an unresolved compensation',
    ownerUnitId: UNIT_1,
    clientOperationId: randomUUID(),
    ...extra,
  };
};
const allowAll = (): void => undefined;
const open = (data: NewIssue = request(), at = NOW, member = REPORTER, tenant = TENANT_A): Promise<CreatedIssue> => as((tx) => issues.create(tx, data, memberId(member), at, allowAll), tenant, member);
const row = async (issueId: string): Promise<Record<string, unknown>> => (await owner<Record<string, unknown>>('select * from machvon.issue where id = $1::uuid', [issueId]))[0] as Record<string, unknown>;
const events = (issueId: string) => owner<{ event_kind: string; from_status: string | null; to_status: string | null; note: string | null; payload: Record<string, unknown> }>(
  'select event_kind, from_status, to_status, note, payload from machvon.issue_event where issue_id = $1::uuid order by created_at, id',
  [issueId],
);

/** The request for verification that a closing follows (the database refuses to close an issue that no one asked to have verified). */
const verificationRequested = (issueId: string): Promise<unknown> =>
  owner(
    `insert into machvon.issue_event (tenant_id, id, issue_id, event_kind, from_status, to_status, payload, created_by)
     values ($1::uuid, gen_random_uuid(), $2::uuid, 'VERIFICATION_REQUESTED', 'IN_PROGRESS', 'PENDING_VERIFICATION', '{"evidence_document_version_ids":["${DOCUMENT_CLEAN}"]}'::jsonb, $3::uuid)`,
    [TENANT_A, issueId, memberId(WORKER_U1)],
  );

async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    // The tables this story only reads (projects, contracts, documents) are seeded with the foreign keys they have to other modules switched off.
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function seedWorld(tenant: string): Promise<void> {
  await harness.seedUnits(tenant, [
    { n: 1, path: '/u1/' },
    { n: 2, path: '/u2/' },
    { n: 3, path: '/u3/' },
  ]);
  for (const n of [REPORTER, ASSIGNER, WORKER_U1, WORKER_U2, NO_GRANT]) await harness.seedMembership(tenant, n, 1);
  await harness.seedMembership(tenant, SUSPENDED, 1, { status: 'Suspended' });
  await harness.seedMembership(tenant, WORKER_ALL, 1);
  await harness.seedMembership(tenant, GUEST, 1);
  await seedReplica([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $4, 'Bridge', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'), ($1, $3, $7, 'Road', $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [tenant, tenant === TENANT_A ? PROJECT : FOREIGN_PROJECT, PROJECT_OTHER, `PRJ-${tenant.slice(-1)}-1`, UNIT_1, id(FAMILY, 20), `PRJ-${tenant.slice(-1)}-2`],
    ],
    [
      `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version)
       values ($1, $2, $3, $4, $4, $5, 'LUMP_SUM', 'VND', 'DRAFT', 1), ($1, $6, $7, $4, $4, $8, 'LUMP_SUM', 'VND', 'DRAFT', 1)`,
      [tenant, CONTRACT, tenant === TENANT_A ? PROJECT : FOREIGN_PROJECT, id(FAMILY, 21), `HD-${tenant.slice(-1)}-1`, CONTRACT_OTHER_PROJECT, PROJECT_OTHER, `HD-${tenant.slice(-1)}-2`],
    ],
    [
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
       values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $3)`,
      [tenant, CONTRACTOR, id(FAMILY, 22)],
    ],
    [
      `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
       values ($1, $2, 'REFERENCE', 'CV', 'Evidence', 'INTERNAL', $3, $3)`,
      [tenant, id(FAMILY, 22), memberId(REPORTER)],
    ],
    [
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
       values ($1, $2, $4, 1, 'tenants/iss/clean.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
              ($1, $3, $4, 2, 'tenants/iss/pending.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
      [tenant, DOCUMENT_CLEAN, DOCUMENT_PENDING, id(FAMILY, 22)],
    ],
  ]);
  const thisYear = 2026;
  await harness.owner(
    tenant,
    [thisYear, thisYear + 1].map((year, index): [string, unknown[]] => [
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       values ($1, $2, 'WORKDAY_VN', $3, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $4, $4, now())`,
      [tenant, id(0x7e, (tenant === TENANT_A ? 1 : 3) + index), year, memberId(REPORTER)],
    ]),
  );
  await harness.owner(tenant, [
    ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [memberId(GUEST), CONTRACTOR]],
  ]);
  await harness.seedRole(tenant, 1, 'WORKER', ['issue.work', 'issue.read'], 20);
  await harness.seedRole(tenant, 2, 'ASSIGNER', ['issue.assign', 'issue.read'], 30);
  await harness.seedGrants(tenant, [
    { n: 1, member: WORKER_U1, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
    { n: 2, member: WORKER_U2, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_2] },
    { n: 3, member: ASSIGNER, role: 2, kind: 'TENANT' },
    { n: 4, member: SUSPENDED, role: 1, kind: 'TENANT' },
    { n: 5, member: WORKER_ALL, role: 1, kind: 'TENANT' },
  ]);
}

async function seedCategory(tenant: string, masterType: string, key: string, status = 'EFFECTIVE'): Promise<string> {
  const recordId = randomUUID();
  const versionId = randomUUID();
  await harness.owner(tenant, [
    [
      `insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by)
       values ($1, $2, 'TENANT', $3, $4, $5, $6, $6)`,
      [tenant, recordId, masterType, key, status, memberId(REPORTER)],
    ],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 1, $5, '{}', '2024-01-01', $6, 'TENANT', $7, $7)`,
      [tenant, versionId, recordId, masterType, key, status, memberId(REPORTER)],
    ],
    ['update machvon.master_record set current_version_id = $2 where id = $1', [recordId, versionId]],
  ]);
  return versionId;
}

describe('IssIssueStore (create, assign, work, comment and transfer issues, ST-ISS-002)', () => {
  beforeAll(async () => {
    await harness.start();
    await seedWorld(TENANT_A);
    await seedWorld(TENANT_B);
    category = await seedCategory(TENANT_A, 'ISSUE_CATEGORY', 'LAND');
    await as((tx) =>
      policies.publish(tx, { code: 'SLA-LAND-HIGH', categoryVersionId: category, severity: 'HIGH', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, memberId(REPORTER)),
    );
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('opening an issue', () => {
    it('stores the policy version, the deadlines and the calendar versions the count used, and writes the first event (TODOS: where ISS keeps the calendar versions)', async () => {
      const created = await open();
      // Monday 09:00 plus 4 working hours is 13:00; plus 16 hours is Tuesday 15:30 (8 hours on Monday, 8 on Tuesday from 07:30).
      expect(created).toMatchObject({ status: 'OPEN', version: 1, replayed: false, assigneeId: null, escalationLevel: 0, geoRecorded: false, sourceModule: 'MANUAL' });
      expect(created.responseDueAt).toBe('2026-08-10T06:00:00.000Z');
      expect(created.dueAt).toBe('2026-08-11T08:30:00.000Z');
      expect(created.code).toMatch(/^VM-2026-\d{6}$/);
      const stored = await row(created.id);
      expect(stored).toMatchObject({ status: 'OPEN', version: '1', reported_by: memberId(REPORTER), owner_unit_id: UNIT_1, sla_policy_id: created.policyId, escalation_level: 0, geo_consent: false });
      expect((stored.due_at as Date).toISOString()).toBe(created.dueAt);
      expect((stored.opened_at as Date).toISOString()).toBe(NOW.toISOString());
      const [first, ...rest] = await events(created.id);
      expect(rest).toEqual([]);
      expect(first).toMatchObject({ event_kind: 'CREATED', from_status: null, to_status: 'OPEN' });
      expect(first?.payload).toMatchObject({ sla_policy_id: created.policyId, sla_policy_code: 'SLA-LAND-HIGH', sla_policy_revision: 1, response_due_at: created.responseDueAt, due_at: created.dueAt });
      expect(first?.payload.calendar_version_ids).toEqual([id(0x7e, 1)]);
    });

    it('numbers the issues of a tenant in a year in order and independently of another tenant', async () => {
      const a = await open();
      const b = await open();
      expect(Number(b.code.slice(-6))).toBe(Number(a.code.slice(-6)) + 1);
      expect(a.code.slice(0, 8)).toBe('VM-2026-');
      const concurrent = await Promise.all([open(), open(), open()]);
      expect(new Set(concurrent.map((issue) => issue.code)).size).toBe(3);
      expect(await owner<{ n: string }>('select count(*)::text as n from machvon.issue', [], TENANT_B)).toEqual([{ n: '0' }]);
    });

    it('refuses a severity without a policy (SLA_POLICY_MISSING) and writes nothing', async () => {
      const before = (await owner<{ n: string }>('select count(*)::text as n from machvon.issue'))[0]?.n;
      expect(await refusal(open(request({ severity: 'LOW' })))).toEqual({ code: 'SLA_POLICY_MISSING', status: 422 });
      expect(await refusal(open(request(), new Date('2026-08-03T02:00:00Z')))).toEqual({ code: 'SLA_POLICY_MISSING', status: 422 });
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.issue'))[0]?.n).toBe(before);
    });

    it('refuses what is not the tenant\'s own: another tenant\'s project, unit, category, or a contract of another project', async () => {
      expect(await refusal(open(request({ projectId: FOREIGN_PROJECT })))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(open(request({ ownerUnitId: id(0x10, 99) })))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(open(request({ categoryVersionId: randomUUID() })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'category_version_id' });
      const foreign = await seedCategory(TENANT_B, 'ISSUE_CATEGORY', 'FOREIGN');
      expect(await refusal(open(request({ categoryVersionId: foreign })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'category_version_id' });
      const wrongType = await seedCategory(TENANT_A, 'PRIORITY', 'URGENT');
      expect(await refusal(open(request({ categoryVersionId: wrongType })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'category_version_id' });
      const retired = await seedCategory(TENANT_A, 'ISSUE_CATEGORY', 'OLD', 'RETIRED');
      expect(await refusal(open(request({ categoryVersionId: retired })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'category_version_id' });
      expect(await refusal(open(request({ contractId: CONTRACT_OTHER_PROJECT })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'contract_id' });
      expect((await open(request({ contractId: CONTRACT }))).status).toBe('OPEN');
    });

    it('lets the caller decide whether they may open an issue in that place, after the place is known to be the tenant\'s', async () => {
      const seen: IssuePlace[] = [];
      const denied = (place: IssuePlace): void => {
        seen.push(place);
        throw Object.assign(new Error('SCOPE_DENIED'), { code: 'SCOPE_DENIED', status: 403 });
      };
      expect(await refusal(as((tx) => issues.create(tx, request({ contractId: CONTRACT }), memberId(REPORTER), NOW, denied)))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(seen).toEqual([{ ownerUnitId: UNIT_1, ownerUnitPath: '/u1/', projectId: PROJECT, contractId: CONTRACT }]);
    });

    it('validates the content: severity, texts, source pairing, identifiers', async () => {
      const refuses = async (extra: Partial<NewIssue>, detail: string): Promise<void> => expect(await refusal(open(request(extra)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail });
      await refuses({ severity: 'URGENT' }, 'severity');
      await refuses({ title: '   ' }, 'title');
      await refuses({ description: 'x'.repeat(2001) }, 'description');
      await refuses({ title: 'bad\0title' }, 'title');
      await refuses({ sourceModule: 'XYZ', sourceRefId: randomUUID() }, 'source_module');
      await refuses({ sourceModule: 'PMT' }, 'source_ref_id');
      await refuses({ sourceRefId: randomUUID() }, 'source_ref_id');
      await refuses({ projectId: 'not-a-uuid' }, 'project_id');
      await refuses({ clientOperationId: 'nope' }, 'client_operation_id');
      expect(issueText('  padded  ', 'title')).toBe('padded');
    });

    it('lower-cases the identifiers it stores and compares', async () => {
      const created = await open(request({ ownerUnitId: UNIT_1.toUpperCase(), projectId: PROJECT.toUpperCase() }));
      expect(await row(created.id)).toMatchObject({ owner_unit_id: UNIT_1, project_id: PROJECT });
      expect(created.ownerUnitId).toBe(UNIT_1);
    });
  });

  describe('one open issue for each source (BR-ISS-07)', () => {
    it('refuses a second open issue for the same source, and takes a new one when the first is closed', async () => {
      const source = randomUUID();
      const first = await open(request({ sourceModule: 'PMT', sourceRefId: source }));
      expect(first.sourceModule).toBe('PMT');
      expect(await refusal(open(request({ sourceModule: 'PMT', sourceRefId: source })))).toEqual({ code: 'DUPLICATE_SOURCE_OPEN', status: 409 });
      // The same object under another module is another source.
      expect((await open(request({ sourceModule: 'QMS', sourceRefId: source }))).status).toBe('OPEN');
      await owner("update machvon.issue set status = 'ASSIGNED', assignee_id = $2::uuid where id = $1::uuid", [first.id, memberId(WORKER_U1)]);
      await owner("update machvon.issue set status = 'IN_PROGRESS' where id = $1::uuid", [first.id]);
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [first.id]);
      await verificationRequested(first.id);
      await owner("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid where id = $1::uuid", [first.id, memberId(ASSIGNER)]);
      expect((await open(request({ sourceModule: 'PMT', sourceRefId: source }))).status).toBe('OPEN');
    });
  });

  describe('a create sent twice from an offline phone, and the position (AC-ST-ISS-002-2, UAT-AC355)', () => {
    it('stores one issue for one client operation id and answers the same issue to the retry, with or without the position', async () => {
      const operation = randomUUID();
      const data = request({ clientOperationId: operation, geoConsent: true, geoLat: '10.800000', geoLng: '106.700000', geoAccuracyM: '12' });
      const first = await open(data);
      const retry = await open(data);
      expect(retry).toMatchObject({ id: first.id, code: first.code, replayed: true, status: 'OPEN', geoRecorded: true, policyId: first.policyId, responseDueAt: first.responseDueAt });
      expect(await owner<{ n: string }>('select count(*)::text as n from machvon.issue where client_operation_id = $1::uuid', [operation])).toEqual([{ n: '1' }]);
      expect(await events(first.id)).toHaveLength(1);
      expect(await row(first.id)).toMatchObject({ geo_consent: true, geo_lat: '10.800000', geo_lng: '106.700000', geo_accuracy_m: '12.00' });
    });

    it('stores the position only when the person consented, and refuses coordinates sent without consent', async () => {
      const without = request({ geoConsent: false, geoLat: '10.8', geoLng: '106.7' });
      expect(await refusal(open(without))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'geo_consent' });
      expect(await refusal(open(request({ geoLat: '10.8', geoLng: '106.7' })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'geo_consent' });
      expect(await owner<{ n: string }>('select count(*)::text as n from machvon.issue where client_operation_id = $1::uuid', [without.clientOperationId])).toEqual([{ n: '0' }]);
      const consentedWithoutPosition = await open(request({ geoConsent: true }));
      expect(await row(consentedWithoutPosition.id)).toMatchObject({ geo_consent: true, geo_lat: null, geo_lng: null, geo_accuracy_m: null });
      const empty = await open(request());
      expect(await row(empty.id)).toMatchObject({ geo_consent: false, geo_lat: null });
      expect(empty.geoRecorded).toBe(false);
    });

    it('refuses a position that is not one: half a pair, off the earth, an accuracy that is not a distance', async () => {
      const refuses = async (extra: Partial<NewIssue>, detail: string): Promise<void> =>
        expect(await refusal(open(request({ geoConsent: true, ...extra })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail });
      await refuses({ geoLat: '10.8' }, 'geo_lng');
      await refuses({ geoLng: '106.7' }, 'geo_lat');
      await refuses({ geoLat: '91', geoLng: '106.7' }, 'geo_lat');
      await refuses({ geoLat: 'north', geoLng: '106.7' }, 'geo_lat');
      await refuses({ geoLat: '10.8', geoLng: '181' }, 'geo_lng');
      await refuses({ geoLat: '10.8', geoLng: '106.7', geoAccuracyM: '-3' }, 'geo_accuracy_m');
      await refuses({ geoAccuracyM: '12' }, 'geo_lat');
    });

    it('refuses the same operation id with another request (IDEMPOTENCY_CONFLICT), and gives another person their own operation', async () => {
      const operation = randomUUID();
      await open(request({ clientOperationId: operation }));
      expect(await refusal(open(request({ clientOperationId: operation })))).toEqual({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
      const mine = request({ clientOperationId: operation, title: 'Another person, the same id' });
      expect((await open(mine, NOW, ASSIGNER)).replayed).toBe(false);
    });

    it('answers a race between two sends of one operation with one issue', async () => {
      const data = request();
      const results = await Promise.all([open(data), open(data), open(data)]);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(await owner<{ n: string }>('select count(*)::text as n from machvon.issue where client_operation_id = $1::uuid', [data.clientOperationId])).toEqual([{ n: '1' }]);
    });

    it('stores the position in the database only with consent whatever the application did (issue_geo_consent_chk)', async () => {
      const created = await open();
      const refused = await sqlRefusal(owner("update machvon.issue set geo_lat = 10.1 where id = $1::uuid", [created.id]));
      expect(refused.sqlstate).toBe('23514');
      const direct = await sqlRefusal(
        owner(
          `insert into machvon.issue (tenant_id, id, code, project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, status, version, reported_by, opened_at,
                                      response_due_at, due_at, geo_consent, geo_lat, geo_lng)
           select tenant_id, $1::uuid, 'VM-2026-900001', project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, 'OPEN', 1, reported_by, opened_at,
                  response_due_at, due_at, false, 10.8, 106.7 from machvon.issue where id = $2::uuid`,
          [randomUUID(), created.id],
        ),
      );
      expect(direct.message).toContain('issue_geo_consent_chk');
    });
  });

  describe('assigning', () => {
    it('gives the issue to a person who can work it and writes the event', async () => {
      const created = await open();
      const assign = (assigneeId: string, note?: string) => as((tx) => issues.assign(tx, created.id, 1, { assigneeId, note }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER);
      // The assigner holds issue.assign and issue.read, not issue.work, so cannot be given the issue.
      expect(await refusal(assign(memberId(ASSIGNER)))).toEqual({ code: 'ASSIGNEE_OUT_OF_SCOPE', status: 422 });
      const assigned = await assign(memberId(WORKER_U1), 'Please take it');
      expect(assigned).toMatchObject({ status: 'ASSIGNED', version: 2, assigneeId: memberId(WORKER_U1), previousAssigneeId: null, previousStatus: 'OPEN' });
      expect(await row(created.id)).toMatchObject({ status: 'ASSIGNED', assignee_id: memberId(WORKER_U1), version: '2', updated_by: memberId(ASSIGNER) });
      const trail = await events(created.id);
      expect(trail.map((event) => event.event_kind)).toEqual(['CREATED', 'ASSIGNED']);
      expect(trail[1]).toMatchObject({ from_status: 'OPEN', to_status: 'ASSIGNED', note: 'Please take it' });
    });

    it('refuses an assignee who cannot work the issue: no grant, a unit elsewhere, a suspended membership, a stranger', async () => {
      const created = await open();
      const assign = (assigneeId: string) => as((tx) => issues.assign(tx, created.id, 1, { assigneeId }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER);
      for (const assignee of [memberId(NO_GRANT), memberId(WORKER_U2), memberId(SUSPENDED), id(0x20, 999)]) {
        expect(await refusal(assign(assignee))).toMatchObject({ code: 'ASSIGNEE_OUT_OF_SCOPE', status: 422 });
      }
      expect((await row(created.id)).status).toBe('OPEN');
      expect(await refusal(assign('not-a-uuid'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'assignee_id' });
    });

    it('moves from any working state back to ASSIGNED with a new person (REASSIGNED), and refuses the same person again and a state that is not assignable', async () => {
      const created = await open();
      const assign = (version: number, assigneeId: string) => as((tx) => issues.assign(tx, created.id, version, { assigneeId }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER);
      await assign(1, memberId(WORKER_U1));
      expect(await refusal(assign(2, memberId(WORKER_U1)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'assignee_id' });
      expect(await assign(2, memberId(WORKER_ALL))).toMatchObject({ version: 3, previousAssigneeId: memberId(WORKER_U1), previousStatus: 'ASSIGNED' });
      expect((await events(created.id)).map((event) => event.event_kind)).toEqual(['CREATED', 'ASSIGNED', 'REASSIGNED']);
      await owner("update machvon.issue set status = 'IN_PROGRESS' where id = $1::uuid", [created.id]);
      expect(await refusal(assign(3, memberId(WORKER_ALL)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'assignee_id' });
      expect(await assign(3, memberId(WORKER_U1))).toMatchObject({ previousStatus: 'IN_PROGRESS', status: 'ASSIGNED', version: 4 });
      await owner("update machvon.issue set status = 'IN_PROGRESS' where id = $1::uuid", [created.id]);
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [created.id]);
      await verificationRequested(created.id);
      // The verifier gives the result back with the reason (ST-ISS-003): without a reason it is refused.
      expect(await refusal(assign(4, memberId(WORKER_ALL)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      await owner("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid where id = $1::uuid", [created.id, memberId(ASSIGNER)]);
      expect(await refusal(assign(4, memberId(WORKER_ALL)))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
    });

    it('answers a stale version with VERSION_CONFLICT carrying the current one', async () => {
      const created = await open();
      expect(await refusal(as((tx) => issues.assign(tx, created.id, 7, { assigneeId: memberId(WORKER_U1) }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER))).toEqual({
        code: 'VERSION_CONFLICT',
        status: 409,
      });
    });

    it('does not find an issue outside the scope of the caller (404), and refuses one the caller can read but not assign (403)', async () => {
      const created = await open(request({ ownerUnitId: UNIT_2 }));
      const elsewhere = scopesOf('issue.assign', subtree(1), ASSIGNER);
      expect(await refusal(as((tx) => issues.assign(tx, created.id, 1, { assigneeId: memberId(WORKER_U2) }, memberId(ASSIGNER), elsewhere, NOW), TENANT_A, ASSIGNER))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const readOnly: IssueScopes = { act: scopesOf('issue.assign', subtree(1), ASSIGNER).act, read: scopesOf('issue.read', subtree(2), ASSIGNER).read };
      expect(await refusal(as((tx) => issues.assign(tx, created.id, 1, { assigneeId: memberId(WORKER_U2) }, memberId(ASSIGNER), readOnly, NOW), TENANT_A, ASSIGNER))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(as((tx) => issues.assign(tx, created.id, 1, { assigneeId: memberId(WORKER_U2) }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_B, ASSIGNER))).toEqual({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('starting', () => {
    async function assigned(): Promise<CreatedIssue> {
      const created = await open();
      await as((tx) => issues.assign(tx, created.id, 1, { assigneeId: memberId(WORKER_U1) }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER);
      return created;
    }
    const start = (issueId: string, version: number, member: number, note?: string, at = NOW) =>
      as((tx) => issues.start(tx, issueId, version, note, memberId(member), scopesOf('issue.work', subtree(1), member), at), TENANT_A, member);

    it('records the moment of the first response and moves to IN_PROGRESS', async () => {
      const created = await assigned();
      expect(await refusal(start(created.id, 2, WORKER_U1, '   '))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      const started = await start(created.id, 2, WORKER_U1, 'On my way', new Date('2026-08-10T03:00:00Z'));
      expect(started).toMatchObject({ status: 'IN_PROGRESS', version: 3 });
      expect(((await row(created.id)).responded_at as Date).toISOString()).toBe('2026-08-10T03:00:00.000Z');
      const trail = await events(created.id);
      expect(trail[trail.length - 1]).toMatchObject({ event_kind: 'STARTED', from_status: 'ASSIGNED', to_status: 'IN_PROGRESS', note: 'On my way' });
    });

    it('keeps the first response when the issue is assigned again and started again', async () => {
      const created = await assigned();
      await start(created.id, 2, WORKER_U1, undefined, new Date('2026-08-10T03:00:00Z'));
      await as((tx) => issues.assign(tx, created.id, 3, { assigneeId: memberId(WORKER_ALL) }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER);
      await as((tx) => issues.start(tx, created.id, 4, undefined, memberId(WORKER_ALL), scopesOf('issue.work', TENANT_WIDE, WORKER_ALL), new Date('2026-08-10T08:00:00Z')), TENANT_A, WORKER_ALL);
      expect(((await row(created.id)).responded_at as Date).toISOString()).toBe('2026-08-10T03:00:00.000Z');
    });

    it("is the assignee's alone (403), and only from ASSIGNED (409)", async () => {
      const created = await assigned();
      expect(await refusal(as((tx) => issues.start(tx, created.id, 2, undefined, memberId(WORKER_ALL), scopesOf('issue.work', TENANT_WIDE, WORKER_ALL), NOW), TENANT_A, WORKER_ALL))).toEqual({
        code: 'SCOPE_DENIED',
        status: 403,
      });
      expect(await refusal(start(created.id, 1, WORKER_U1))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      await start(created.id, 2, WORKER_U1);
      expect(await refusal(start(created.id, 3, WORKER_U1))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      const fresh = await open();
      expect(await refusal(start(fresh.id, 1, WORKER_U1))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
    });

    it('is not found by someone whose scope does not reach the issue', async () => {
      const created = await assigned();
      expect(await refusal(as((tx) => issues.start(tx, created.id, 2, undefined, memberId(WORKER_U2), scopesOf('issue.work', subtree(2), WORKER_U2), NOW), TENANT_A, WORKER_U2))).toEqual({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
    });
  });

  describe('commenting', () => {
    const comment = (issueId: string, input: { note: string; documentVersionId?: string }, member: number, scope: IssueScopes) => as((tx) => issues.comment(tx, issueId, input, memberId(member), scope), TENANT_A, member);

    it('adds an opinion or an attached clean document to the timeline without changing the issue', async () => {
      const created = await open();
      const before = await row(created.id);
      const plain = await comment(created.id, { note: 'The owner was told' }, WORKER_U1, scopesOf('issue.work', subtree(1), WORKER_U1));
      const evidence = await comment(created.id, { note: 'Photo of the plot', documentVersionId: DOCUMENT_CLEAN.toUpperCase() }, WORKER_U1, scopesOf('issue.work', subtree(1), WORKER_U1));
      expect(plain).toMatchObject({ attachedDocument: false, version: 1, status: 'OPEN' });
      expect(evidence).toMatchObject({ attachedDocument: true });
      expect(await row(created.id)).toEqual(before);
      const trail = await events(created.id);
      expect(trail.map((event) => event.event_kind)).toEqual(['CREATED', 'COMMENTED', 'EVIDENCE_ADDED']);
      expect(trail[2]).toMatchObject({ note: 'Photo of the plot', from_status: 'OPEN', to_status: 'OPEN' });
    });

    it('refuses a document that is not scanned clean (DOCUMENT_NOT_CLEAN) or not the tenant\'s, an empty note and a closed issue', async () => {
      const created = await open();
      const scope = scopesOf('issue.work', subtree(1), WORKER_U1);
      expect(await refusal(comment(created.id, { note: 'See attached', documentVersionId: DOCUMENT_PENDING }, WORKER_U1, scope))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(comment(created.id, { note: 'See attached', documentVersionId: randomUUID() }, WORKER_U1, scope))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'document_version_id' });
      expect(await refusal(comment(created.id, { note: ' ' }, WORKER_U1, scope))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      await owner("update machvon.issue set status = 'ASSIGNED', assignee_id = $2::uuid where id = $1::uuid", [created.id, memberId(WORKER_U1)]);
      await owner("update machvon.issue set status = 'IN_PROGRESS' where id = $1::uuid", [created.id]);
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [created.id]);
      await verificationRequested(created.id);
      await owner("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid where id = $1::uuid", [created.id, memberId(ASSIGNER)]);
      expect(await refusal(comment(created.id, { note: 'Too late' }, WORKER_U1, scope))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
      expect((await events(created.id)).map((event) => event.event_kind)).toEqual(['CREATED', 'VERIFICATION_REQUESTED']);
    });

    it('lets the person who reported the issue comment on it from another unit, and nobody else outside the scope', async () => {
      const created = await open(request({ ownerUnitId: UNIT_2 }));
      const reporterScope = scopesOf('issue.work', subtree(1), REPORTER, true);
      expect((await comment(created.id, { note: 'Any news?' }, REPORTER, reporterScope)).status).toBe('OPEN');
      const stranger = scopesOf('issue.work', subtree(1), WORKER_U1, true);
      expect(await refusal(comment(created.id, { note: 'Hello' }, WORKER_U1, stranger))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('transferring to another unit (AC-ST-ISS-002-1, UAT-AC350)', () => {
    const transfer = (issueId: string, version: number, targetUnitId: string, reason = 'The works are in another commune', scope = everything('issue.assign'), tenant = TENANT_A) =>
      as((tx) => issues.transfer(tx, issueId, version, { targetUnitId, reason }, memberId(ASSIGNER), scope, NOW), tenant, ASSIGNER);

    it('changes the unit and keeps the deadlines and the overdue day; the days overdue stay and go on counting', async () => {
      const created = await open();
      // The issue fell due on Tuesday 11 August at 15:30 and became overdue then.
      await owner('update machvon.issue set overdue_since = due_at where id = $1::uuid', [created.id]);
      const before = await row(created.id);
      const lineOf = async () => (await as((tx) => issues.find(tx, created.id, issueScope(accessOf(['issue.read'], TENANT_WIDE), 'issue.read', NOW))))!;
      const friday = new Date('2026-08-14T03:00:00Z');
      const unitA = await lineOf();
      expect(unitA).toMatchObject({ ownerUnitId: UNIT_1, overdueSince: '2026-08-11T08:30:00.000Z' });
      expect(await as((tx) => issues.overdueDays(tx, [unitA], friday))).toEqual([3]);
      const moved = await transfer(created.id, 1, UNIT_3);
      expect(moved).toMatchObject({ ownerUnitId: UNIT_3, fromUnitId: UNIT_1, version: 2, status: 'OPEN' });
      const after = await row(created.id);
      expect(after.owner_unit_id).toBe(UNIT_3);
      for (const column of ['due_at', 'response_due_at', 'overdue_since', 'opened_at', 'sla_policy_id', 'severity', 'assignee_id']) expect(after[column]).toEqual(before[column]);
      const unitB = await lineOf();
      expect(unitB).toMatchObject({ ownerUnitId: UNIT_3, dueAt: unitA.dueAt, overdueSince: unitA.overdueSince });
      expect(await as((tx) => issues.overdueDays(tx, [unitB], friday))).toEqual([3]);
      expect(await as((tx) => issues.overdueDays(tx, [unitB], new Date('2026-08-17T03:00:00Z')))).toEqual([4]);
      const trail = await events(created.id);
      expect(trail[trail.length - 1]).toMatchObject({ event_kind: 'TRANSFERRED', from_status: 'OPEN', to_status: 'OPEN', note: 'The works are in another commune', payload: { from_unit_id: UNIT_1, to_unit_id: UNIT_3 } });
    });

    it('keeps the assignee and the state of the issue, and refuses a closed issue, the same unit, a stranger unit and a missing reason', async () => {
      const created = await open();
      await as((tx) => issues.assign(tx, created.id, 1, { assigneeId: memberId(WORKER_U1) }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER);
      expect(await transfer(created.id, 2, UNIT_2)).toMatchObject({ status: 'ASSIGNED', assigneeId: memberId(WORKER_U1), version: 3 });
      expect(await refusal(transfer(created.id, 3, UNIT_2))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'target_unit_id' });
      expect(await refusal(transfer(created.id, 3, id(0x10, 98)))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'target_unit_id' });
      expect(await refusal(transfer(created.id, 3, UNIT_1, '  '))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      expect(await refusal(transfer(created.id, 2, UNIT_1))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      await owner("update machvon.issue set status = 'IN_PROGRESS' where id = $1::uuid", [created.id]);
      await owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [created.id]);
      await verificationRequested(created.id);
      await owner("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid where id = $1::uuid", [created.id, memberId(ASSIGNER)]);
      expect(await refusal(transfer(created.id, 3, UNIT_1))).toEqual({ code: 'ISSUE_STATE_INVALID', status: 409 });
    });

    it('is refused to someone whose scope does not reach the issue, and a unit of another tenant is not a unit', async () => {
      const created = await open(request({ ownerUnitId: UNIT_2 }));
      expect(await refusal(transfer(created.id, 1, UNIT_3, 'Reason', scopesOf('issue.assign', subtree(1), ASSIGNER)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(transfer(created.id, 1, UNIT_3, 'Reason', everything('issue.assign'), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('days overdue', () => {
    it('counts the working days after the day the issue became overdue up to the day it was closed, and never guesses past the last calendar', async () => {
      const lines = [
        { overdueSince: null, closedAt: null, calendarCode: 'WORKDAY_VN' },
        // Overdue from Thursday 6 August 17:00, closed on Monday 10 August: the Friday and the Monday are the working days after it.
        { overdueSince: '2026-08-06T10:00:00.000Z', closedAt: '2026-08-10T04:00:00.000Z', calendarCode: 'WORKDAY_VN' },
        { overdueSince: '2026-12-30T04:00:00.000Z', closedAt: '2028-01-05T04:00:00.000Z', calendarCode: 'WORKDAY_VN' },
        { overdueSince: '2026-08-06T10:00:00.000Z', closedAt: null, calendarCode: 'NO_SUCH_CALENDAR' },
        { overdueSince: '2026-08-10T04:00:00.000Z', closedAt: null, calendarCode: 'WORKDAY_VN' },
      ];
      expect(await as((tx) => issues.overdueDays(tx, lines, new Date('2026-08-12T04:00:00Z')))).toEqual([null, 2, null, null, 2]);
      expect(await as((tx) => issues.overdueDays(tx, [lines[0] as (typeof lines)[number]], NOW))).toEqual([null]);
    });
  });

  describe('reading in the scope of the caller (AC-ST-ISS-002-3, UAT-PLAN-23)', () => {
    let mine: CreatedIssue;
    let theirs: CreatedIssue;
    let projectScoped: CreatedIssue;
    let contractScoped: CreatedIssue;
    const listFor = (access: EffectiveAccess, limit = 100, tenant = TENANT_A) =>
      as((tx) => issues.list(tx, issueScope(access, 'issue.read', NOW), { limit, after: undefined }), tenant).then((lines) => lines.map((line) => line.id));

    beforeAll(async () => {
      mine = await open(request({ ownerUnitId: UNIT_1 }));
      theirs = await open(request({ ownerUnitId: UNIT_2 }));
      projectScoped = await open(request({ ownerUnitId: UNIT_2, projectId: PROJECT_OTHER }));
      contractScoped = await open(request({ ownerUnitId: UNIT_2, contractId: CONTRACT }));
    });

    it('shows an officer only the issues of their unit tree, a project grant the issues of the project, a contract grant the issues of the contract', async () => {
      const officer = await listFor(accessOf(['issue.read'], subtree(1)));
      expect(officer).toContain(mine.id);
      expect(officer).not.toContain(theirs.id);
      const projectGuest = await listFor(accessOf(['issue.read'], { kind: 'PROJECT', refIds: [PROJECT_OTHER] }));
      expect(projectGuest).toEqual([projectScoped.id]);
      const contractGuest = await listFor(accessOf(['issue.read'], { kind: 'CONTRACT', refIds: [CONTRACT] }));
      expect(contractGuest).toContain(contractScoped.id);
      expect(contractGuest).not.toContain(mine.id);
      expect(contractGuest).not.toContain(projectScoped.id);
      const unitOnly = await listFor(accessOf(['issue.read'], { kind: 'UNIT_ONLY', refIds: [UNIT_2], paths: ['/u2/'] }));
      expect(unitOnly).toEqual(expect.arrayContaining([theirs.id, projectScoped.id, contractScoped.id]));
      expect(unitOnly).not.toContain(mine.id);
      const all = await listFor(accessOf(['issue.read'], TENANT_WIDE));
      expect(all).toEqual(expect.arrayContaining([mine.id, theirs.id, projectScoped.id, contractScoped.id]));
      expect(await listFor(accessOf(['issue.work'], TENANT_WIDE))).toEqual([]);
      expect(await listFor({ ...accessOf(['issue.read'], TENANT_WIDE), membershipActive: false })).toEqual([]);
    });

    it('shows the person who reported an issue their own wherever it lies, but only to someone who holds the permission', async () => {
      const reporter = accessOf(['issue.read'], subtree(3), REPORTER);
      const lines = await as((tx) => issues.list(tx, issueScope(reporter, 'issue.read', NOW, { reporter: memberId(REPORTER) }), { limit: 500, after: undefined }));
      expect(lines.map((line) => line.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      const withoutPermission = accessOf(['issue.work'], subtree(3), REPORTER);
      expect(await as((tx) => issues.list(tx, issueScope(withoutPermission, 'issue.read', NOW, { reporter: memberId(REPORTER) }), { limit: 500, after: undefined }))).toEqual([]);
    });

    it('finds one issue inside the scope and answers undefined outside it and for the id of another tenant', async () => {
      const officer = issueScope(accessOf(['issue.read'], subtree(1)), 'issue.read', NOW);
      const found = await as((tx) => issues.find(tx, mine.id, officer));
      expect(found).toMatchObject({
        id: mine.id,
        code: mine.code,
        status: 'OPEN',
        severity: 'HIGH',
        projectCode: 'PRJ-a-1',
        categoryLabel: 'LAND',
        ownerUnitName: 'Unit 1',
        reporterName: 'User 1',
        assigneeId: null,
        policy: { code: 'SLA-LAND-HIGH', revision: 1, responseHours: 4, resolveHours: 16, requireEvidence: true, requireIndependentVerifier: true },
        place: { ownerUnitId: UNIT_1, ownerUnitPath: '/u1/', projectId: PROJECT },
        geoConsent: false,
        calendarCode: 'WORKDAY_VN',
      });
      expect(await as((tx) => issues.find(tx, theirs.id, officer))).toBeUndefined();
      expect(await as((tx) => issues.find(tx, mine.id, issueScope(accessOf(['issue.read'], TENANT_WIDE), 'issue.read', NOW)), TENANT_B)).toBeUndefined();
    });

    it('pages by code, newest first', async () => {
      const everyone = accessOf(['issue.read'], TENANT_WIDE);
      const first = await as((tx) => issues.list(tx, issueScope(everyone, 'issue.read', NOW), { limit: 3, after: undefined }));
      expect(first).toHaveLength(3);
      const last = first[2] as (typeof first)[number];
      const second = await as((tx) => issues.list(tx, issueScope(everyone, 'issue.read', NOW), { limit: 3, after: { code: last.codeKey, id: last.id } }));
      expect(second[0]?.codeKey.localeCompare(last.codeKey)).toBeLessThan(0);
      const codes = [...first, ...second].map((line) => line.codeKey);
      expect(codes).toEqual([...codes].sort().reverse());
    });

    it('lists the people an issue may be given to: active members who hold issue.work over its place, by name, and nobody outside the scope of the caller (CR-ISS-14)', async () => {
      const assignOf = (n: number) => issueScope(accessOf(['issue.assign', 'issue.read'], TENANT_WIDE, n), 'issue.assign', NOW);
      const names = (people: Array<{ membershipId: string }> | undefined) => people?.map((person) => person.membershipId);
      const inUnit1 = await open(request({ ownerUnitId: UNIT_1 }));
      const inUnit2 = await open(request({ ownerUnitId: UNIT_2 }));
      expect(names(await as((tx) => issues.assignees(tx, inUnit1.id, assignOf(ASSIGNER), NOW)))).toEqual([memberId(WORKER_U1), memberId(WORKER_ALL)]);
      expect(names(await as((tx) => issues.assignees(tx, inUnit2.id, assignOf(ASSIGNER), NOW)))).toEqual([memberId(WORKER_U2), memberId(WORKER_ALL)]);
      expect((await as((tx) => issues.assignees(tx, inUnit1.id, assignOf(ASSIGNER), NOW)))?.[0]).toEqual({ membershipId: memberId(WORKER_U1), displayName: 'User 3' });
      // Every person listed is accepted by the command, and the suspended member and the member without a grant are neither listed nor accepted.
      const accepted = await as((tx) => issues.assign(tx, inUnit1.id, 1, { assigneeId: memberId(WORKER_ALL) }, memberId(ASSIGNER), everything('issue.assign'), NOW), TENANT_A, ASSIGNER);
      expect(accepted.status).toBe('ASSIGNED');
      const outside = issueScope(accessOf(['issue.assign'], subtree(2)), 'issue.assign', NOW);
      expect(await as((tx) => issues.assignees(tx, inUnit1.id, outside, NOW))).toBeUndefined();
      expect(await as((tx) => issues.assignees(tx, inUnit1.id, assignOf(ASSIGNER), NOW), TENANT_B)).toBeUndefined();
    });

    it('tells a guest contractor from the staff', async () => {
      expect(await as((tx) => issues.isGuest(tx, memberId(GUEST)))).toBe(true);
      expect(await as((tx) => issues.isGuest(tx, memberId(REPORTER)))).toBe(false);
      expect(await as((tx) => issues.isGuest(tx, id(0x20, 999)))).toBe(false);
    });

    it('lists the timeline of an issue oldest first, in pages', async () => {
      const created = await open();
      for (const note of ['one', 'two', 'three']) await as((tx) => issues.comment(tx, created.id, { note }, memberId(WORKER_U1), scopesOf('issue.work', subtree(1), WORKER_U1)), TENANT_A, WORKER_U1);
      const firstPage = await as((tx) => issues.events(tx, created.id, { limit: 2, after: undefined }));
      expect(firstPage.map((event) => event.kind)).toEqual(['CREATED', 'COMMENTED']);
      expect(firstPage[0]).toMatchObject({ actorName: 'User 1', note: null });
      const tail = firstPage[1] as (typeof firstPage)[number];
      const rest = await as((tx) => issues.events(tx, created.id, { limit: 10, after: { code: tail.createdAtKey, id: tail.id } }));
      expect(rest.map((event) => event.note)).toEqual(['two', 'three']);
      expect(await as((tx) => issues.events(tx, created.id, { limit: 10, after: undefined }), TENANT_B)).toEqual([]);
    });
  });

  describe('what the database holds whatever the application did', () => {
    it('refuses a status that the machine does not reach, a closing without the closer and the verifier, and a verifier who is the assignee', async () => {
      const created = await open();
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'CLOSED' where id = $1::uuid", [created.id])))).sqlstate).toBe('23514');
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'IN_PROGRESS' where id = $1::uuid", [created.id])))).message).toContain('does not move from OPEN to IN_PROGRESS');
      await as((tx) => tx.query("update machvon.issue set status = 'ASSIGNED', assignee_id = $2::uuid where id = $1::uuid", [created.id, memberId(WORKER_U1)]));
      await as((tx) => tx.query("update machvon.issue set status = 'IN_PROGRESS' where id = $1::uuid", [created.id]));
      await as((tx) => tx.query("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [created.id]));
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'CLOSED' where id = $1::uuid", [created.id])))).message).toContain('issue_close_chk');
      await verificationRequested(created.id);
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = assignee_id, verifier_id = assignee_id where id = $1::uuid", [created.id])))).message).toContain('issue_verifier_chk');
    });

    it('keeps the origin and the deadline the SLA fixed, and the day the issue became overdue', async () => {
      const created = await open();
      for (const assignment of ["severity = 'LOW'", "response_due_at = response_due_at + interval '1 hour'", "title = title", "code = 'VM-2026-999999'", 'opened_at = now()', 'geo_consent = true']) {
        const attempt = as((tx) => tx.query(`update machvon.issue set ${assignment} where id = $1::uuid`, [created.id]));
        if (assignment === 'title = title') await attempt;
        else expect((await sqlRefusal(attempt)).sqlstate).toBe('23514');
      }
      await owner('update machvon.issue set overdue_since = due_at where id = $1::uuid', [created.id]);
      expect((await sqlRefusal(as((tx) => tx.query('update machvon.issue set overdue_since = null where id = $1::uuid', [created.id])))).message).toContain('BR-ISS-04');
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set overdue_since = overdue_since + interval '1 day' where id = $1::uuid", [created.id])))).sqlstate).toBe('23514');
      // The deadline moves only by a counted extension, a command with its own event (ST-ISS-003, V1063).
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue set due_at = due_at + interval '1 day' where id = $1::uuid", [created.id])))).sqlstate).toBe('23514');
    });

    it('lets nobody delete an issue or rewrite and delete its timeline', async () => {
      const created = await open();
      expect((await sqlRefusal(as((tx) => tx.query('delete from machvon.issue where id = $1::uuid', [created.id])))).sqlstate).toBe('42501');
      expect((await sqlRefusal(as((tx) => tx.query('truncate machvon.issue_event')))).sqlstate).toBe('42501');
      expect((await sqlRefusal(as((tx) => tx.query("update machvon.issue_event set note = 'x' where issue_id = $1::uuid", [created.id])))).sqlstate).toBe('42501');
      expect((await sqlRefusal(as((tx) => tx.query('delete from machvon.issue_event where issue_id = $1::uuid', [created.id])))).sqlstate).toBe('42501');
      expect((await sqlRefusal(owner('delete from machvon.issue_event where issue_id = $1::uuid', [created.id]))).message).toContain('append-only');
      expect((await sqlRefusal(owner("update machvon.issue_event set note = 'x' where issue_id = $1::uuid", [created.id]))).message).toContain('append-only');
    });

    it('refuses an issue that names a source without an object, an incomplete one, and a position outside the earth', async () => {
      const created = await open();
      const insert = (set: string) =>
        owner(
          `insert into machvon.issue (tenant_id, id, code, project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, status, version, reported_by, opened_at,
                                      response_due_at, due_at, source_module, source_ref_id, geo_consent, geo_lat, geo_lng, geo_accuracy_m)
           select tenant_id, $1::uuid, 'VM-2026-900002', project_id, category_version_id, severity, ${set} from machvon.issue where id = $2::uuid`,
          [randomUUID(), created.id],
        );
      const base = "title, description, owner_unit_id, sla_policy_id, 'OPEN', 1, reported_by, opened_at, response_due_at, due_at";
      expect((await sqlRefusal(insert(`${base}, 'PMT', null, false, null, null, null`))).message).toContain('issue_source_chk');
      expect((await sqlRefusal(insert(`${base}, 'MANUAL', null, true, 91, 100, null`))).message).toContain('issue_geo_chk');
      expect((await sqlRefusal(insert(`${base}, 'MANUAL', null, true, 10, null, null`))).message).toContain('issue_geo_chk');
      expect((await sqlRefusal(insert(`${base}, 'MANUAL', null, true, null, null, 5`))).message).toContain('issue_geo_chk');
      expect((await sqlRefusal(insert("title, null, owner_unit_id, sla_policy_id, 'OPEN', 1, reported_by, opened_at, response_due_at, due_at, 'MANUAL', null, false, null, null, null"))).message).toContain('issue_core_chk');
      expect((await sqlRefusal(insert(`title, description, owner_unit_id, sla_policy_id, 'OPEN', 1, reported_by, opened_at, due_at + interval '1 hour', due_at, 'MANUAL', null, false, null, null, null`))).message).toContain('issue_due_chk');
    });
  });
});
