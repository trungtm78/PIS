import { randomBytes, randomUUID } from 'node:crypto';
import { AstClaimOverdueJob, AuditWriter, WORKER_MEMBERSHIP_ID, INTAKE_CATEGORY_KEYS, overdueEvent, stageLateEvent } from '@machvon/db';
import type { OutboxDelivery } from '@machvon/db';
import { signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { INTAKE_IGNORED_METRIC, INTAKE_OPENED_METRIC, INTAKE_REFERENCE_REPLACED_METRIC, ISS_INTAKE_CONSUMER, IssIntakeConsumer, SOURCE_DEDUPE_METRIC } from '../../src/modules/iss/intake.consumer';
import { issueDetailView } from '../../src/modules/iss/issue-view';
import { CONTRACT, CONTRACTOR, DOCUMENT_CLEAN, IssWorld, PEOPLE, PROJECT, TENANT_A, UNIT_1, memberId } from '../../../../packages/db/test/support/iss-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';

const SIGNING_KEY = randomBytes(32);
const SYSTEM = memberId(PEOPLE.SYSTEM);

class Counters implements MetricsSink {
  readonly counts = new Map<string, number>();
  increment(name: string, labels?: Record<string, string>): void {
    const key = labels === undefined ? name : `${name}{${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')}}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  gauge(): void {
    return undefined;
  }
}

describe('the intake of automatic issues from the events of PMT, PAY, LND, CTR and AST (ST-ISS-005, ISS-11)', () => {
  const world = new IssWorld();
  const metrics = new Counters();
  const consumer = (): IssIntakeConsumer => new IssIntakeConsumer({ database: world.harness.tenants, security: { signingKey: SIGNING_KEY }, metrics });

  const delivery = (type: string, payload: Record<string, unknown>, over: Partial<OutboxDelivery> = {}): OutboxDelivery => ({
    id: randomUUID(),
    tenantId: TENANT_A,
    tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
    type,
    schemaVersion: 1,
    aggregateType: 'complaint',
    aggregateId: randomUUID(),
    aggregateVersion: 1,
    payload,
    eventKey: `key-${randomUUID()}`,
    correlationId: randomUUID(),
    attempts: 0,
    ...over,
  });
  const complaint = (source: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ tenant_id: TENANT_A, source_ref_id: source, project_id: PROJECT, reference_code: 'LC-A-001', ...extra });
  const issuesOf = (source: string) => world.owner<{ id: string; title: string; status: string; source_module: string }>('select id, title, status, source_module from machvon.issue where source_ref_id = $1::uuid', [source]);
  const audits = (issueId: string) => world.owner<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id = $1::uuid order by seq', [issueId]);
  const outbox = (issueId: string) => world.owner<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1::uuid order by created_at, id', [issueId]);
  const inboxRows = (eventId: string) => world.owner('select 1 from machvon.integration_event_inbox where event_key = $1', [eventId]);

  beforeAll(async () => {
    await world.start();
    const version = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.LND);
    await world.as((tx) =>
      world.policies.publish(tx, { code: 'SLA-LND-MEDIUM', categoryVersionId: version, severity: 'MEDIUM', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, SYSTEM),
    );
    const permit = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.PMT);
    await world.as((tx) =>
      world.policies.publish(tx, { code: 'SLA-PMT-HIGH', categoryVersionId: permit, severity: 'HIGH', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, SYSTEM),
    );
    const payment = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.PAY);
    await world.as((tx) =>
      world.policies.publish(tx, { code: 'SLA-PAY-MEDIUM', categoryVersionId: payment, severity: 'MEDIUM', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, SYSTEM),
    );
  }, 300_000);

  afterAll(() => world.stop(), 60_000);

  it('AC-ST-ISS-005-1: the same source event delivered twice, and a second event for the same source, leave exactly one open issue, one audit row and one event', async () => {
    const source = randomUUID();
    const first = delivery('lnd.complaint.filed.v1', complaint(source));
    expect(await consumer().handle(first)).toBe('processed');
    expect(await consumer().handle(first)).toBe('duplicate');
    // Another delivery for the same source object: consumed (its inbox row is written), and it updates nothing.
    const second = delivery('lnd.complaint.filed.v1', complaint(source, { reference_code: 'LC-A-002' }));
    expect(await consumer().handle(second)).toBe('processed');
    const issues = await issuesOf(source);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: 'Land complaint filed: LC-A-001', status: 'OPEN', source_module: 'LND' });
    const issueId = issues[0]?.id as string;
    expect((await audits(issueId)).map((entry) => entry.action)).toEqual(['iss.issue_opened']);
    expect((await audits(issueId))[0]?.safe_diff).toMatchObject({ source_module: 'LND', intake_event_type: 'lnd.complaint.filed.v1', geo_recorded: false });
    expect((await outbox(issueId)).map((event) => event.type)).toEqual(['iss.issue.opened.v1']);
    expect((await outbox(issueId))[0]?.payload).toMatchObject({ issue_id: issueId, project_id: PROJECT, status: 'OPEN', source_module: 'LND', actor_id: WORKER_MEMBERSHIP_ID });
    expect((await world.events(issueId)).map((event) => event.event_kind)).toEqual(['CREATED']);
    expect(await inboxRows(second.id)).toHaveLength(1);
    expect(metrics.counts.get(`${INTAKE_OPENED_METRIC}{source=LND}`)).toBeGreaterThanOrEqual(1);
    expect(metrics.counts.get(`${SOURCE_DEDUPE_METRIC}{source=LND}`)).toBeGreaterThanOrEqual(1);
  });

  it('AC-ST-ISS-005-2: a land complaint that carries a household and an identity number opens an issue with only a reference code, in the issue, the timeline, the audit row and the event', async () => {
    const source = randomUUID();
    const event = delivery(
      'lnd.complaint.filed.v1',
      complaint(source, { household_name: 'Nguyen Van A', citizen_id: '079000000001', address: '12 Le Loi, Cao Bang', phone: '0901234567', content: 'The compensation is too low' }),
    );
    expect(await consumer().handle(event)).toBe('processed');
    const [issue] = await issuesOf(source);
    const everything = JSON.stringify([
      await world.owner('select to_jsonb(i) as issue from machvon.issue i where i.id = $1::uuid', [issue?.id]),
      await world.events(issue?.id as string),
      await audits(issue?.id as string),
      await outbox(issue?.id as string),
      await world.owner('select * from machvon.integration_event_inbox where event_key = $1', [event.id]),
    ]);
    for (const personal of ['Nguyen Van A', '079000000001', 'Le Loi', 'Cao Bang', '0901234567', 'too low']) expect(everything).not.toContain(personal);
    // A reference that looks like an identity number is replaced, and counted.
    const identityLike = randomUUID();
    expect(await consumer().handle(delivery('lnd.complaint.filed.v1', complaint(identityLike, { reference_code: '079000000001' })))).toBe('processed');
    expect((await issuesOf(identityLike))[0]?.title).toBe(`Land complaint filed: ${identityLike.slice(0, 8)}`);
    expect(metrics.counts.get(`${INTAKE_REFERENCE_REPLACED_METRIC}{source=LND}`)).toBe(1);
  });

  it('AC-ST-LND-010-1, UAT-AC387: a stage of land clearance that is late opens one issue, the stage keeps the issue that holds it up, and a second late event for it changes nothing', async () => {
    const stageId = randomUUID();
    const sectionId = randomUUID();
    await world.owner(
      `insert into machvon.land_handover_section (tenant_id, id, project_id, code, name, required_area_m2, status, version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'ISS-LATE-1', 'Km 0 to km 3', 30000, 'NOT_READY', 1, $3::uuid, $3::uuid)`,
      [sectionId, PROJECT, SYSTEM],
    );
    await world.owner(
      `insert into machvon.land_stage_progress (tenant_id, id, project_id, section_id, stage_code, executor_kind, executor_unit_id, mode, status, planned_end, version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, 'NOTICE', 'LAND_FUND_CENTRE', $4::uuid, 'TRACKED_EXTERNAL', 'LATE', date '2026-08-01', 2, $5::uuid, $5::uuid)`,
      [stageId, PROJECT, sectionId, UNIT_1, SYSTEM],
    );
    const late = stageLateEvent({ id: stageId, projectId: PROJECT, ownerUnitId: UNIT_1, sectionCode: 'ISS-LATE-1', stageCode: 'NOTICE', executorKind: 'LAND_FUND_CENTRE', plannedEnd: '2026-08-01', version: 2 }, TENANT_A, new Date());
    const first = delivery(late.type, late.payload, { aggregateType: late.aggregateType, aggregateId: stageId });
    expect(await consumer().handle(first)).toBe('processed');
    const issues = await issuesOf(stageId);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: 'Land clearance stage late: ISS-LATE-1-NOTICE', status: 'OPEN', source_module: 'LND' });
    const linked = () => world.owner<{ blocker_issue_id: string | null }>('select blocker_issue_id from machvon.land_stage_progress where id = $1::uuid', [stageId]);
    expect(await linked()).toEqual([{ blocker_issue_id: issues[0]?.id }]);
    // The stage is late again (a later version): the issue is still open, so there is still one issue and the stage still points at it.
    const again = stageLateEvent({ id: stageId, projectId: PROJECT, ownerUnitId: UNIT_1, sectionCode: 'ISS-LATE-1', stageCode: 'NOTICE', executorKind: 'LAND_FUND_CENTRE', plannedEnd: '2026-08-01', version: 4 }, TENANT_A, new Date());
    expect(await consumer().handle(delivery(again.type, again.payload, { aggregateType: again.aggregateType, aggregateId: stageId }))).toBe('processed');
    expect(await issuesOf(stageId)).toHaveLength(1);
    expect(await linked()).toEqual([{ blocker_issue_id: issues[0]?.id }]);
    // The same delivery twice opens nothing more.
    expect(await consumer().handle(first)).toBe('duplicate');
    expect(await issuesOf(stageId)).toHaveLength(1);
  });

  it('AC-ST-PAY-007-3, UAT-AC336: an item of difference that is past its day opens one issue, the item keeps its identifier, and a second report of it changes nothing', async () => {
    const itemId = randomUUID();
    await world.owner(
      `insert into machvon.reconciliation_item (tenant_id, id, project_id, kind, internal_amount_vnd, confirmed_amount_vnd, owner_membership_id, due_at, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'AMOUNT_MISMATCH', 1000000000, 990000000, $3::uuid, timestamptz '2026-07-10 10:00+07', 'OPEN', $3::uuid, $3::uuid)`,
      [itemId, PROJECT, SYSTEM],
    );
    const reported = overdueEvent({ id: itemId, kind: 'AMOUNT_MISMATCH', projectId: PROJECT, contractId: null, ownerUnitId: UNIT_1, dueAt: '2026-07-10T03:00:00.000000Z', status: 'OPEN' }, TENANT_A, new Date('2026-07-11T06:00:00Z'));
    const first = delivery(reported.type, reported.payload, { aggregateType: reported.aggregateType, aggregateId: itemId, eventKey: reported.eventKey });
    expect(await consumer().handle(first)).toBe('processed');
    const issues = await issuesOf(itemId);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: `Reconciliation item overdue: RI-${itemId.slice(0, 8)}`, status: 'OPEN', source_module: 'PAY' });
    const linked = () => world.owner<{ issue_id: string | null }>('select issue_id from machvon.reconciliation_item where id = $1::uuid', [itemId]);
    expect(await linked()).toEqual([{ issue_id: issues[0]?.id }]);
    // The same delivery again, and the same item reported again under another delivery, open nothing more.
    expect(await consumer().handle(first)).toBe('duplicate');
    expect(await consumer().handle(delivery(reported.type, reported.payload, { aggregateType: reported.aggregateType, aggregateId: itemId }))).toBe('processed');
    expect(await issuesOf(itemId)).toHaveLength(1);
    expect(await linked()).toEqual([{ issue_id: issues[0]?.id }]);
  });

  it('UAT-AC354: a reader without the right to read households sees the issue of a land complaint but not its text; a permit issue is read whole', async () => {
    const land = randomUUID();
    const permit = randomUUID();
    await consumer().handle(delivery('lnd.complaint.filed.v1', complaint(land)));
    await consumer().handle(delivery('pmt.permit.expired.v1', complaint(permit, { reference_code: 'GP-0001' })));
    const scope = world.everything('issue.read', PEOPLE.ASSIGNER).read;
    const viewer = { membershipId: memberId(PEOPLE.ASSIGNER), guest: false };
    for (const [source, expected] of [[land, null], [permit, 'Permit expired: GP-0001 (PMT, PERMIT)']] as const) {
      const [row] = await issuesOf(source);
      const detail = await world.as((tx) => world.issues.find(tx, row?.id as string, scope));
      const view = issueDetailView(detail as NonNullable<typeof detail>, null, viewer, { land: false }, { escalations: [], taskForce: undefined });
      expect(view.description).toBe(expected);
      expect(view.title).toBe(row?.title);
    }
  });

  it('opens an issue for an expired guarantee only when an advance is still owed (CTR, ST-CTR-003)', async () => {
    // The tenant has a category for the guarantees and no policy for them: the delivery that asks for an issue is refused to be retried, the one that does not is left alone.
    const source = randomUUID();
    const payload = { tenant_id: TENANT_A, project_id: PROJECT, contract_id: null, kind: 'ADVANCE', expires_on: '2026-12-01', source_module: 'CTR', source_reference: source };
    expect(await consumer().handle(delivery('ctr.guarantee.expired.v1', { ...payload, issue_required: false }))).toBe('ignored');
    expect(await issuesOf(source)).toEqual([]);
    expect(metrics.counts.get(`${INTAKE_IGNORED_METRIC}{reason=not_wanted}`)).toBe(1);
    const retried = delivery('ctr.guarantee.expired.v1', { ...payload, issue_required: true });
    await expect(consumer().handle(retried)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'category_key' });
    expect(await inboxRows(retried.id)).toEqual([]);
    // The tenant defines the category and the policy: the same delivery, retried, opens the issue.
    const version = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.CTR);
    await world.as((tx) =>
      world.policies.publish(tx, { code: 'SLA-CTR-HIGH', categoryVersionId: version, severity: 'HIGH', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, SYSTEM),
    );
    expect(await consumer().handle(retried)).toBe('processed');
    expect((await issuesOf(source))[0]).toMatchObject({ title: 'Advance guarantee expired: ADVANCE-2026-12-01', source_module: 'CTR' });
  });

  it('AC-ST-AST-004-1, UAT-AC391: a warranty claim nobody answered by its day opens one issue attributed to AST, the claim keeps it, and a second pass or a second event changes nothing', async () => {
    const version = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.AST);
    await world.as((tx) =>
      world.policies.publish(tx, { code: 'SLA-AST-HIGH', categoryVersionId: version, severity: 'HIGH', calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, SYSTEM),
    );
    const handoverId = randomUUID();
    const obligationId = randomUUID();
    const claimId = randomUUID();
    await asSuperuser(
      world.harness.database.adminUrl,
      `insert into machvon.handover
         (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, created_by, updated_by, version, accepted_at, accepted_by, as_built_document_version_id)
       values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'ACCEPTED', 'BG-AST-1', 'COMPLETION', $7, $7, 1, timestamptz '2026-09-01T03:00:00Z', $7, $6)`,
      [TENANT_A, handoverId, PROJECT, CONTRACT, UNIT_1, DOCUMENT_CLEAN, SYSTEM],
    );
    await world.owner(
      `insert into machvon.warranty_obligation
         (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, status, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, 'The whole pump house', date '2026-09-01', date '2027-09-01', 12, 1000, 'ACTIVE', $6, $6, 1)`,
      [TENANT_A, obligationId, PROJECT, CONTRACT, handoverId, SYSTEM],
    );
    await world.owner(
      `insert into machvon.warranty_claim
         (tenant_id, id, obligation_id, claim_no, reported_on, reported_by, defect_description, severity, responder_contractor_id, response_due_on, status, created_by, updated_by, version)
       values ($1, $2, $3, 'WC-001', date '2027-01-10', $4, 'Crack in the wall', 'MAJOR', $5, date '2027-01-17', 'OPEN', $4, $4, 1)`,
      [TENANT_A, claimId, obligationId, SYSTEM, CONTRACTOR],
    );
    const sweep = (at: string) =>
      world.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) =>
        new AstClaimOverdueJob(new AuditWriter(world.harness.tenants)).run(tx, WORKER_MEMBERSHIP_ID, new Date(at)),
      );
    expect((await sweep('2027-01-17T09:00:00+07:00')).flagged).toBe(0);
    expect((await sweep('2027-01-18T09:00:00+07:00')).flagged).toBe(1);
    const [event] = await world.owner<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'ast.warranty_claim.overdue.v1'", [claimId]);
    const first = delivery('ast.warranty_claim.overdue.v1', event?.payload ?? {}, { aggregateType: 'warranty_claim', aggregateId: claimId });
    expect(await consumer().handle(first)).toBe('processed');
    const issues = await issuesOf(claimId);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: 'Warranty claim unanswered: WC-001', status: 'OPEN', source_module: 'AST' });
    const kept = () => world.owner<{ issue_id: string | null; version: string }>('select issue_id, version::text from machvon.warranty_claim where id = $1::uuid', [claimId]);
    expect(await kept()).toEqual([{ issue_id: issues[0]?.id, version: '1' }]);
    expect((await audits(issues[0]?.id as string))[0]?.safe_diff).toMatchObject({ source_module: 'AST', intake_event_type: 'ast.warranty_claim.overdue.v1' });
    // The pass again flags nothing, the same delivery opens nothing more, and another event for the claim finds the issue that is open.
    expect((await sweep('2027-01-19T09:00:00+07:00')).flagged).toBe(0);
    expect(await consumer().handle(first)).toBe('duplicate');
    expect(await consumer().handle(delivery('ast.warranty_claim.overdue.v1', event?.payload ?? {}, { aggregateType: 'warranty_claim', aggregateId: claimId }))).toBe('processed');
    expect(await issuesOf(claimId)).toHaveLength(1);
    expect(await kept()).toEqual([{ issue_id: issues[0]?.id, version: '1' }]);
  });

  it('leaves alone what is not its event, a version it does not know, a payload that is not a request and a project that is not the tenant\'s, and counts them', async () => {
    const before = metrics.counts.get(`${INTAKE_IGNORED_METRIC}{reason=invalid}`) ?? 0;
    expect(await consumer().handle(delivery('prj.stage.changed.v1', complaint(randomUUID())))).toBe('ignored');
    expect(await consumer().handle(delivery('lnd.complaint.filed.v1', complaint(randomUUID()), { schemaVersion: 2 }))).toBe('ignored');
    expect(await consumer().handle(delivery('lnd.complaint.filed.v1', complaint('not-a-uuid')))).toBe('ignored');
    expect(metrics.counts.get(`${INTAKE_IGNORED_METRIC}{reason=invalid}`)).toBe(before + 1);
    const stranger = randomUUID();
    expect(await consumer().handle(delivery('lnd.complaint.filed.v1', complaint(stranger, { project_id: randomUUID() })))).toBe('processed');
    expect(await issuesOf(stranger)).toEqual([]);
    expect(metrics.counts.get(`${INTAKE_IGNORED_METRIC}{reason=project_unknown}`)).toBe(1);
    expect(consumer().name).toBe(ISS_INTAKE_CONSUMER);
  });

  it('refuses a delivery whose signed context was made with another key before it touches the database', async () => {
    const source = randomUUID();
    const forged = delivery('lnd.complaint.filed.v1', complaint(source), { tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, randomBytes(32)) });
    await expect(consumer().handle(forged)).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
    expect(await issuesOf(source)).toEqual([]);
  });
});
