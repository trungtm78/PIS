import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { readIntake } from '../src/iss-intake';
import { PmtDossierStore, dossierScope } from '../src/pmt-dossier-store';
import { PmtExpiringPermits, PmtPermitExpiry, alertLevelOf, thresholdOfLevel } from '../src/pmt-permit-expiry';
import { PmtPermitStore } from '../src/pmt-permit-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const audit = new AuditWriter(harness.tenants);
const job = new PmtPermitExpiry(audit);
const ACTOR = 1;
const WORKER = '00000000-0000-4000-8000-000000000000';
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0x95;
const DOCUMENT = id(FAMILY, 31);
const TYPE = id(FAMILY, 41);
/** A moment of the Vietnam day (09:00); the job counts days by the Vietnam date. */
const at = (date: string): Date => new Date(`${date}T02:00:00.000Z`);

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const run = (date: string, tenant = TENANT_A) => harness.tenants.withTenant(contextFor(tenant, WORKER), (tx) => job.run(tx, WORKER, at(date)));

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
const nextCounter = (): number => {
  counter += 1;
  return counter;
};

interface PermitOptions {
  status?: string;
  validUntil?: string | null;
  noExpiry?: boolean;
  required?: boolean;
  responsible?: boolean;
  unit?: number;
  tenant?: string;
  supersedes?: string;
  permitNo?: string | null;
}

interface Seeded {
  projectId: string;
  dossierId: string;
  permitId: string;
}

/** A project, its dossier and one permit of the type, written directly (the commands that write them have their own tests). */
async function seedPermit(options: PermitOptions = {}): Promise<Seeded> {
  const n = nextCounter();
  const tenant = options.tenant ?? TENANT_A;
  const projectId = id(FAMILY, 100 + n);
  const dossierId = id(FAMILY, 300 + n);
  const permitId = randomUUID();
  const status = options.status ?? 'ISSUED';
  const issued = status === 'ISSUED' || status === 'EXPIRED' || status === 'SUPERSEDED';
  await seedAs([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B')`,
      [tenant, projectId, `PRJ-X-${String(n).padStart(3, '0')}`, `Project ${n}`, unitId(options.unit ?? DEPARTMENT), unitId(PROVINCE), id(FAMILY, 42)],
    ],
    [
      `insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, status, readiness_pct, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, $7)`,
      [tenant, dossierId, projectId, unitId(options.unit ?? DEPARTMENT), status === 'ISSUED' && options.required === true ? 'COMPLETE' : 'OPEN', status === 'ISSUED' && options.required === true ? '100' : '0', memberId(ACTOR)],
    ],
    [
      `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_no, status, issued_on, valid_from, valid_until, no_expiry, document_version_id, supersedes_id,
                                   responsible_membership_id, is_required, permit_type_code, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7::date, $7::date, $8::date, $9, $10, $11, $12, $13, 'EXPIRY_TYPE', $14, $14)`,
      [
        tenant,
        permitId,
        dossierId,
        TYPE,
        options.permitNo === undefined ? (issued ? `GP-${String(n).padStart(4, '0')}` : null) : options.permitNo,
        status,
        issued ? '2026-01-01' : null,
        options.noExpiry === true ? null : (options.validUntil ?? '2026-12-31'),
        options.noExpiry === true,
        issued ? DOCUMENT : null,
        options.supersedes ?? null,
        options.responsible === true ? memberId(ACTOR) : null,
        options.required === true,
        memberId(ACTOR),
      ],
    ],
  ]);
  return { projectId, dossierId, permitId };
}

const permitRow = async (permitId: string, tenant = TENANT_A) =>
  (await owner<{ status: string; alert_level_sent: number; version: string }>('select status, alert_level_sent, version::text as version from machvon.permit where id = $1::uuid', [permitId], tenant))[0];
const eventsOf = (permitId: string, type: string, tenant = TENANT_A) =>
  owner<{ payload: Record<string, unknown>; event_key: string }>('select payload, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by created_at', [permitId, type], tenant);

const allow = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const EVERYWHERE = dossierScope(allow('permit.read', { kind: 'TENANT' }), 'permit.read', new Date());

beforeAll(async () => {
  await harness.start();
  for (const tenant of [TENANT_A, TENANT_B]) {
    await harness.seedUnits(tenant, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_BRANCH, path: '/u3/' },
    ]);
    await harness.seedMembership(tenant, ACTOR, PROVINCE);
    await seedAs([
      [
        `insert into machvon.permit_type (tenant_id, id, code, revision, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, 'EXPIRY_TYPE', 1, 'Permit type for the expiry tests', 'CONSTRUCTION_PERMIT', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3)`,
        [tenant, TYPE, memberId(ACTOR)],
      ],
    ]);
  }
}, 240_000);

afterAll(async () => {
  await harness.stop();
}, 60_000);

jest.setTimeout(240_000);

describe('the levels of alert', () => {
  it('are 60, 30, 15 and 0 days, a lapsed permit is at the last, and a permit far from its end has none', () => {
    expect([100, 61, 60, 59, 31, 30, 29, 16, 15, 14, 1, 0, -1, -400].map(alertLevelOf)).toEqual([0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    expect([0, 1, 2, 3, 4, 5].map(thresholdOfLevel)).toEqual([null, 60, 30, 15, 0, null]);
  });
});

describe('PmtPermitExpiry.run (the job permit-expiry, ST-PMT-006, BR-PMT-06)', () => {
  it('sends one reminder at each of 60, 30, 15 and 0 days, none twice, with the version of the permit untouched (AC-ST-PMT-006-1)', async () => {
    const { permitId } = await seedPermit({ responsible: true });
    // 61 days before 2026-12-31: nothing yet.
    expect(await run('2026-10-31')).toMatchObject({ alerted: 0, expired: 0 });
    expect(await run('2026-11-01')).toMatchObject({ alerted: 1, expired: 0 });
    // The same day twice, and the days between the thresholds, send nothing.
    expect(await run('2026-11-01')).toMatchObject({ alerted: 0 });
    expect(await run('2026-11-15')).toMatchObject({ alerted: 0 });
    expect(await run('2026-12-01')).toMatchObject({ alerted: 1 });
    expect(await run('2026-12-01')).toMatchObject({ alerted: 0 });
    expect(await run('2026-12-16')).toMatchObject({ alerted: 1 });
    expect(await run('2026-12-16')).toMatchObject({ alerted: 0 });
    expect(await run('2026-12-31')).toMatchObject({ alerted: 1, expired: 0 });
    expect(await run('2026-12-31')).toMatchObject({ alerted: 0, expired: 0 });
    const alerts = await eventsOf(permitId, 'pmt.permit.expiring.v1');
    expect(alerts.map((event) => [event.payload.threshold_days, event.payload.days_left])).toEqual([
      [60, 60],
      [30, 30],
      [15, 15],
      [0, 0],
    ]);
    expect(alerts.map((event) => event.event_key)).toEqual([1, 2, 3, 4].map((level) => `permit:${permitId}:alert:${level}`));
    expect(alerts[0]?.payload).toMatchObject({ permit_id: permitId, valid_until: '2026-12-31', notification: { deepLink: `/pmt/pmt-05?permit=${permitId}`, recipients: [memberId(ACTOR)], resource: { type: 'permit', id: permitId } } });
    expect(await permitRow(permitId)).toEqual({ status: 'ISSUED', alert_level_sent: 4, version: '1' });
    expect(await eventsOf(permitId, 'pmt.permit.expired.v1')).toEqual([]);
  });

  it('sends the level of the day when days were missed, not the ones that went by', async () => {
    const { permitId } = await seedPermit({ validUntil: '2026-12-31' });
    expect(await run('2026-12-11')).toMatchObject({ alerted: 1 });
    expect((await eventsOf(permitId, 'pmt.permit.expiring.v1')).map((event) => event.payload.threshold_days)).toEqual([30]);
    expect(await run('2026-12-20')).toMatchObject({ alerted: 1 });
    expect((await eventsOf(permitId, 'pmt.permit.expiring.v1')).map((event) => event.payload.threshold_days)).toEqual([30, 15]);
    expect((await permitRow(permitId))?.alert_level_sent).toBe(3);
  });

  it('expires the permit the day after its last day: once, with an issue asked for through the intake contract, the readiness of the dossier counted again, and never renewed by the job', async () => {
    const { permitId, dossierId } = await seedPermit({ required: true, permitNo: 'GP-777/2026' });
    await run('2026-12-31');
    const result = await run('2027-01-01');
    // The permits of the tests before this one are past their day as well and expire with it.
    expect(result.alerted).toBe(0);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await run('2027-01-01')).toMatchObject({ expired: 0 });
    expect(await run('2027-02-01')).toMatchObject({ alerted: 0, expired: 0 });
    expect(await permitRow(permitId)).toEqual({ status: 'EXPIRED', alert_level_sent: 4, version: '2' });
    const [expired, ...more] = await eventsOf(permitId, 'pmt.permit.expired.v1');
    expect(more).toEqual([]);
    expect(expired?.payload).toMatchObject({ source_ref_id: permitId, reference_code: 'GP-777/2026', permit_id: permitId, dossier_id: dossierId, status: 'EXPIRED', valid_until: '2026-12-31', source_module: 'PMT' });
    // The issue intake of ISS reads the event as a well formed request for one issue.
    const reading = readIntake('pmt.permit.expired.v1', expired?.payload as Record<string, unknown>);
    expect(reading.kind).toBe('REQUEST');
    expect(reading.kind === 'REQUEST' ? [reading.request.sourceRefId, reading.request.referenceCode, reading.request.spec.sourceModule] : []).toEqual([permitId, 'GP-777/2026', 'PMT']);
    const audits = await owner<{ diff: Record<string, unknown>; actor_id: string }>("select safe_diff as diff, actor_id from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_expired'", [permitId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: WORKER, diff: { from_status: 'ISSUED', to_status: 'EXPIRED', valid_until: '2026-12-31', readiness_pct: '0.00' } });
    // The dossier was complete on this one required permit; with the permit gone it is open again at 0 percent.
    expect((await owner<{ status: string; readiness_pct: string }>('select status, readiness_pct::text as readiness_pct from machvon.permit_dossier where id = $1::uuid', [dossierId]))[0]).toEqual({ status: 'OPEN', readiness_pct: '0.00' });
  });

  it('leaves alone what has nothing to run out of: a permit without an end, a permit that is not issued, and the permits of another tenant', async () => {
    const forever = await seedPermit({ noExpiry: true });
    const planned = await seedPermit({ status: 'PLANNED', validUntil: null });
    const replaced = await seedPermit({ status: 'SUPERSEDED', validUntil: '2026-11-01' });
    const foreign = await seedPermit({ tenant: TENANT_B, validUntil: '2026-11-01' });
    await run('2030-01-01');
    expect((await permitRow(forever.permitId))?.status).toBe('ISSUED');
    expect((await permitRow(planned.permitId))?.status).toBe('PLANNED');
    expect((await permitRow(replaced.permitId))?.status).toBe('SUPERSEDED');
    // The pass visits the tenant of its transaction only: the other tenant is another pass.
    expect((await permitRow(foreign.permitId, TENANT_B))?.status).toBe('ISSUED');
    expect(await run('2030-01-01', TENANT_B)).toMatchObject({ expired: expect.any(Number) });
    expect((await permitRow(foreign.permitId, TENANT_B))?.status).toBe('EXPIRED');
    expect(await eventsOf(foreign.permitId, 'pmt.permit.expired.v1', TENANT_B)).toHaveLength(1);
    expect(await eventsOf(foreign.permitId, 'pmt.permit.expired.v1')).toEqual([]);
  });

  it('counts, after the pass, the permits within each threshold, and lets two passes at the same moment share the work without a double reminder', async () => {
    const first = await seedPermit({ validUntil: '2027-03-05' });
    const second = await seedPermit({ validUntil: '2027-03-20' });
    const third = await seedPermit({ validUntil: '2027-04-10' });
    const [a, b] = await Promise.all([run('2027-03-01'), run('2027-03-01')]);
    // Permits of the earlier tests are past their day by now and become EXPIRED here: only the ones of this test are asserted.
    // 4, 19 and 40 days from their last day: the levels of 15, 30 and 60 days.
    expect((await permitRow(first.permitId))?.alert_level_sent).toBe(3);
    expect((await permitRow(second.permitId))?.alert_level_sent).toBe(2);
    expect((await permitRow(third.permitId))?.alert_level_sent).toBe(1);
    for (const permit of [first, second, third]) {
      const reminders = await eventsOf(permit.permitId, 'pmt.permit.expiring.v1');
      expect(reminders).toHaveLength(1);
    }
    expect(a.alerted + b.alerted).toBeGreaterThanOrEqual(3);
    const after = await run('2027-03-01');
    expect(after.alerted).toBe(0);
    expect(after.expiring[60]).toBeGreaterThanOrEqual(3);
    expect(after.expiring[30]).toBeGreaterThanOrEqual(2);
    expect(after.expiring[15]).toBeGreaterThanOrEqual(1);
  });

  it('leaves an expired permit to be renewed by the command: a replacement that names it, the old one superseded and never extended', async () => {
    const dossiers = new PmtDossierStore({ today: () => '2027-01-02' });
    const permits = new PmtPermitStore(dossiers);
    const { permitId } = await seedPermit({ validUntil: '2026-12-31', required: true });
    await run('2027-01-01');
    expect((await permitRow(permitId))?.status).toBe('EXPIRED');
    await seedAs([
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Renewal scan', 'INTERNAL', $3, $3) on conflict do nothing`,
        [TENANT_A, id(FAMILY, 34), memberId(ACTOR)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/pmt/renew.pdf', repeat('d', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL') on conflict do nothing`,
        [TENANT_A, DOCUMENT, id(FAMILY, 34)],
      ],
    ]);
    const current = await permitRow(permitId);
    const renewed = await as((tx) => permits.renew(tx, permitId, Number(current?.version), { newPermitNo: 'GP-RENEWED-1', newValidUntil: '2028-01-01', documentVersionId: DOCUMENT }, memberId(ACTOR)));
    expect(renewed).toMatchObject({ status: 'ISSUED', supersededId: permitId, validUntil: '2028-01-01' });
    expect((await permitRow(permitId))?.status).toBe('SUPERSEDED');
    expect((await owner<{ valid_until: string }>('select valid_until::text as valid_until from machvon.permit where id = $1::uuid', [permitId]))[0]?.valid_until).toBe('2026-12-31');
    await expect(owner('update machvon.permit set valid_until = $2::date where id = $1::uuid', [permitId, '2030-01-01'])).rejects.toThrow(/never changes what it says/);
    // The job meets the replacement: two years away, so nothing for it to do; the old one is not touched.
    expect(await run('2027-01-02')).toMatchObject({ alerted: 0, expired: 0 });
  });
});

describe('PmtExpiringPermits.list (listExpiringPermits, PMT-05)', () => {
  const reads = new PmtExpiringPermits({ today: () => '2027-06-10' });
  const list = (withinDays = 60, scope = EVERYWHERE, limit = 100, after?: { code: string; id: string }, tenant = TENANT_A) =>
    as((tx) => reads.list(tx, scope, { withinDays }, { limit, after }), tenant);

  it('shows the issued permits whose last day is within the window, and the ones past it until the job marks them, the soonest first, and the expired ones no renewal has replaced', async () => {
    const soon = await seedPermit({ validUntil: '2027-06-20', responsible: true });
    const later = await seedPermit({ validUntil: '2027-08-01' });
    const far = await seedPermit({ validUntil: '2027-12-01' });
    const lapsed = await seedPermit({ validUntil: '2027-06-01' });
    const expired = await seedPermit({ status: 'EXPIRED', validUntil: '2027-05-01' });
    const replaced = await seedPermit({ status: 'EXPIRED', validUntil: '2027-04-01' });
    await seedPermit({ status: 'ISSUED', validUntil: '2027-04-05', supersedes: replaced.permitId, tenant: TENANT_A });
    const forever = await seedPermit({ noExpiry: true });
    const rows = await list(60);
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(soon.permitId);
    expect(ids).toContain(later.permitId);
    expect(ids).not.toContain(far.permitId);
    expect(ids).not.toContain(forever.permitId);
    expect(ids).not.toContain(replaced.permitId);
    // Soonest first: the permit past its day, then the expired one that waits for a renewal... by last day.
    const mine = ids.filter((found) => [lapsed.permitId, expired.permitId, soon.permitId, later.permitId].includes(found));
    expect(mine).toEqual([expired.permitId, lapsed.permitId, soon.permitId, later.permitId]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(soon.permitId)).toMatchObject({ status: 'ISSUED', daysLeft: 10, alertLevel: 3, validUntil: '2027-06-20', permitTypeCode: 'EXPIRY_TYPE' });
    expect(byId.get(lapsed.permitId)).toMatchObject({ status: 'ISSUED', daysLeft: -9, alertLevel: 4 });
    expect(byId.get(expired.permitId)).toMatchObject({ status: 'EXPIRED', alertLevel: 4 });
    expect(byId.get(later.permitId)).toMatchObject({ daysLeft: 52, alertLevel: 1 });
    expect(byId.get(soon.permitId)?.project.code).toMatch(/^PRJ-X-/);
    // A narrower window leaves the later one out; a wider one brings the far one in.
    expect((await list(30)).map((row) => row.id)).not.toContain(later.permitId);
    expect((await list(365)).map((row) => row.id)).toContain(far.permitId);
  });

  it('is read in the scope of the caller, and the permits of another tenant never show', async () => {
    const mine = await seedPermit({ validUntil: '2027-06-25', unit: DEPARTMENT });
    const theirs = await seedPermit({ validUntil: '2027-06-25', unit: OTHER_BRANCH });
    const foreign = await seedPermit({ validUntil: '2027-06-25', tenant: TENANT_B });
    const departmentOnly = dossierScope(allow('permit.read', { kind: 'UNIT_SUBTREE', refIds: [unitId(DEPARTMENT)], paths: ['/u1/u2/'] } as Scope), 'permit.read', new Date());
    const seen = (await list(60, departmentOnly)).map((row) => row.id);
    expect(seen).toContain(mine.permitId);
    expect(seen).not.toContain(theirs.permitId);
    expect(seen).not.toContain(foreign.permitId);
    expect((await list(60)).map((row) => row.id)).not.toContain(foreign.permitId);
    expect((await list(60, EVERYWHERE, 100, undefined, TENANT_B)).map((row) => row.id)).toContain(foreign.permitId);
  });

  it('pages by the last day and the id, and refuses a window or a cursor that is not one', async () => {
    const page = await list(365, EVERYWHERE, 3);
    expect(page).toHaveLength(3);
    const last = page[2] as (typeof page)[number];
    const next = await list(365, EVERYWHERE, 3, { code: last.validUntil, id: last.id });
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((row) => row.validUntil > last.validUntil || (row.validUntil === last.validUntil && row.id > last.id))).toBe(true);
    for (const bad of [-1, 366, 1.5, Number.NaN]) {
      await expect(list(bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'within_days' });
    }
    for (const cursor of [{ code: 'yesterday', id: randomUUID() }, { code: '2027-02-30', id: randomUUID() }, { code: '2027-06-01', id: 'x' }]) {
      await expect(list(60, EVERYWHERE, 5, cursor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor' });
    }
  });
});
