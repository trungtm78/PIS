import { randomUUID } from 'node:crypto';
import { INTAKE_CATEGORY_KEYS, INTAKE_EVENT_TYPES, INTAKE_SPECS, IssIntake, PERSONAL_MEMBERS, intakeOperationId, readIntake } from '../src/iss-intake';
import type { IntakeRequest } from '../src/iss-intake';
import { IssWorld, NOW, PEOPLE, PROJECT, PROJECT_OTHER, TENANT_A, UNIT_1, UNIT_2, id, memberId } from './support/iss-fixtures';

const world = new IssWorld();
const intake = new IssIntake(world.issues);
const SYSTEM = memberId(PEOPLE.SYSTEM);
const SOURCE = '7d1d1a52-3a41-4c6c-9a4b-0a5d2c3f4e01';

const payloadOf = (eventType: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  eventType === 'ctr.guarantee.expired.v1'
    ? { tenant_id: TENANT_A, project_id: PROJECT, contract_id: undefined, kind: 'ADVANCE', expires_on: '2026-12-01', issue_required: true, source_module: 'CTR', source_reference: SOURCE, ...extra }
    : { tenant_id: TENANT_A, source_ref_id: SOURCE, project_id: PROJECT, reference_code: 'LC-A-001', ...extra };

const requestOf = (eventType: string, extra: Record<string, unknown> = {}): IntakeRequest => {
  const reading = readIntake(eventType, payloadOf(eventType, extra));
  if (reading.kind !== 'REQUEST') throw new Error(`${eventType} is not a request`);
  return reading.request;
};

const open = (request: IntakeRequest, eventId: string = randomUUID(), at: Date = NOW) => world.as((tx) => intake.open(tx, request, eventId, SYSTEM, at));

describe('readIntake: the contract of the events that ask for an issue (TK-ISS-005-2)', () => {
  it('knows the events of CTR, PMT, PAY and LND, each filed under a category of its source', () => {
    expect(INTAKE_EVENT_TYPES).toEqual(['ctr.guarantee.expired.v1', 'pmt.permit.expired.v1', 'pay.advance.overdue.v1', 'pay.reconciliation.overdue.v1', 'lnd.complaint.filed.v1', 'lnd.deadline.breached.v1']);
    expect(INTAKE_SPECS.map((spec) => [spec.sourceModule, spec.categoryKey])).toEqual([
      ['CTR', INTAKE_CATEGORY_KEYS.CTR],
      ['PMT', INTAKE_CATEGORY_KEYS.PMT],
      ['PAY', INTAKE_CATEGORY_KEYS.PAY],
      ['PAY', INTAKE_CATEGORY_KEYS.PAY],
      ['LND', INTAKE_CATEGORY_KEYS.LND],
      ['LND', INTAKE_CATEGORY_KEYS.LND],
    ]);
  });

  it.each(INTAKE_EVENT_TYPES)('reads %s: the ids, the severity of its kind and a reference code that is safe to show', (eventType) => {
    const reading = readIntake(eventType, payloadOf(eventType));
    expect(reading.kind).toBe('REQUEST');
    if (reading.kind !== 'REQUEST') return;
    expect(reading.request).toMatchObject({ sourceRefId: SOURCE, projectId: PROJECT, referenceReplaced: false });
    expect(reading.request.referenceCode).toMatch(eventType === 'ctr.guarantee.expired.v1' ? /^ADVANCE-2026-12-01$/ : /^LC-A-001$/);
    expect(reading.request.spec.eventType).toBe(eventType);
  });

  it('lower-cases the ids, reads a contract, a unit and a severity the event names, and ignores a severity it cannot judge', () => {
    const upper = SOURCE.toUpperCase();
    const reading = readIntake('pmt.permit.expired.v1', { source_ref_id: upper, project_id: PROJECT.toUpperCase(), contract_id: id(1, 1).toUpperCase(), owner_unit_id: UNIT_2.toUpperCase(), severity: 'CRITICAL', reference_code: 'GP-0001' });
    expect(reading).toMatchObject({ kind: 'REQUEST', request: { sourceRefId: SOURCE, projectId: PROJECT, contractId: id(1, 1), ownerUnitId: UNIT_2, severity: 'CRITICAL' } });
    expect(readIntake('pmt.permit.expired.v1', { ...payloadOf('pmt.permit.expired.v1'), severity: 'URGENT' })).toMatchObject({ kind: 'REQUEST', request: { severity: 'HIGH' } });
    expect(readIntake('lnd.complaint.filed.v1', { ...payloadOf('lnd.complaint.filed.v1'), contract_id: null, owner_unit_id: null })).toMatchObject({ kind: 'REQUEST', request: { severity: 'MEDIUM' } });
  });

  it('leaves alone an event that asks for no issue, and refuses what is not a well formed request', () => {
    expect(readIntake('ctr.guarantee.expired.v1', payloadOf('ctr.guarantee.expired.v1', { issue_required: false }))).toEqual({ kind: 'NOT_WANTED' });
    expect(readIntake('ctr.guarantee.expired.v1', payloadOf('ctr.guarantee.expired.v1', { issue_required: 'yes' }))).toEqual({ kind: 'NOT_WANTED' });
    for (const [type, broken] of [
      ['unknown.event.v1', payloadOf('pmt.permit.expired.v1')],
      ['pmt.permit.expired.v1', payloadOf('pmt.permit.expired.v1', { source_ref_id: 'not-a-uuid' })],
      ['pmt.permit.expired.v1', payloadOf('pmt.permit.expired.v1', { source_ref_id: undefined })],
      ['pmt.permit.expired.v1', payloadOf('pmt.permit.expired.v1', { project_id: 12 })],
      ['pmt.permit.expired.v1', payloadOf('pmt.permit.expired.v1', { contract_id: 'x' })],
      ['pmt.permit.expired.v1', payloadOf('pmt.permit.expired.v1', { owner_unit_id: 7 })],
    ] as const) {
      expect(readIntake(type, { ...broken })).toEqual({ kind: 'INVALID' });
    }
  });

  it('AC-ST-ISS-005-2: never takes a reference that could be a name or an identity number, and uses the start of the source id instead', () => {
    for (const unsafe of ['Nguyen Van A', '079000000001', '012345678', 'Ho dan Nguyen', '12', 'a'.repeat(41), undefined, 42, '../etc/passwd x']) {
      const reading = readIntake('lnd.complaint.filed.v1', { ...payloadOf('lnd.complaint.filed.v1'), reference_code: unsafe });
      expect(reading.kind).toBe('REQUEST');
      if (reading.kind !== 'REQUEST') continue;
      expect(reading.request.referenceCode).toBe(SOURCE.slice(0, 8));
      expect(reading.request.referenceReplaced).toBe(unsafe !== undefined);
    }
    // A code that merely looks like part of an identity number is a code: only 9 and 12 digits are refused.
    expect(readIntake('lnd.complaint.filed.v1', { ...payloadOf('lnd.complaint.filed.v1'), reference_code: '0790000000' })).toMatchObject({ request: { referenceCode: '0790000000', referenceReplaced: false } });
  });

  it('derives the operation id of the issue from the delivery, the same each time', () => {
    const delivery = randomUUID();
    expect(intakeOperationId(delivery)).toBe(intakeOperationId(delivery));
    expect(intakeOperationId(delivery)).not.toBe(intakeOperationId(randomUUID()));
    expect(intakeOperationId(delivery)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('names the members that identify a person or a place, so that producers and reviewers have the list', () => {
    expect(PERSONAL_MEMBERS).toEqual(expect.arrayContaining(['name', 'citizen_id', 'address', 'phone', 'household_name']));
  });
});

describe('IssIntake (automatic issues from PMT, PAY, LND and CTR, ST-ISS-005)', () => {
  const categories = new Map<string, string>();

  beforeAll(async () => {
    await world.start();
    const policies: Array<[string, string[]]> = [
      [INTAKE_CATEGORY_KEYS.LND, ['MEDIUM', 'HIGH']],
      [INTAKE_CATEGORY_KEYS.PMT, ['HIGH']],
      [INTAKE_CATEGORY_KEYS.PAY, ['HIGH', 'MEDIUM']],
    ];
    for (const [key, severities] of policies) {
      const version = await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', key);
      categories.set(key, version);
      for (const severity of severities) {
        await world.as((tx) =>
          world.policies.publish(tx, { code: `SLA-${key}-${severity}`, categoryVersionId: version, severity, calendarCode: 'WORKDAY_VN', responseHours: 4, resolveHours: 16, validFrom: '2026-08-05' }, SYSTEM),
        );
      }
    }
    // CTR has a category and no policy for its severity: a gap the tenant has to close.
    categories.set(INTAKE_CATEGORY_KEYS.CTR, await world.seedCategory(TENANT_A, 'ISSUE_CATEGORY', INTAKE_CATEGORY_KEYS.CTR));
  }, 300_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  const issueOf = async (source: string) =>
    (await world.owner<{ id: string; title: string; description: string; status: string; source_module: string; reported_by: string; owner_unit_id: string; severity: string; category_version_id: string }>(
      'select id, title, description, status, source_module, reported_by, owner_unit_id, severity, category_version_id from machvon.issue where source_ref_id = $1::uuid order by created_at desc',
      [source],
    ))[0];

  it('opens an issue for each kind of event: attributed to the source, under the policy of its category, in the unit that owns the project, in the name of the system', async () => {
    for (const eventType of ['lnd.complaint.filed.v1', 'pmt.permit.expired.v1', 'pay.advance.overdue.v1', 'pay.reconciliation.overdue.v1', 'lnd.deadline.breached.v1']) {
      const source = randomUUID();
      const request = requestOf(eventType, { source_ref_id: source });
      const outcome = await open(request);
      expect(outcome.kind).toBe('OPENED');
      const stored = await issueOf(source);
      expect(stored).toMatchObject({
        status: 'OPEN',
        source_module: request.spec.sourceModule,
        reported_by: SYSTEM,
        owner_unit_id: UNIT_1,
        severity: request.spec.severity,
        category_version_id: categories.get(request.spec.categoryKey),
      });
      expect(stored?.title).toBe(`${request.spec.title}: LC-A-001`);
      expect(stored?.description).toBe(`${request.spec.title}: LC-A-001 (${request.spec.sourceModule}, ${request.spec.categoryKey})`);
    }
  });

  it('AC-ST-ISS-005-1: opens one issue per source object however many events come, and the second event changes nothing', async () => {
    const source = randomUUID();
    const first = await open(requestOf('pmt.permit.expired.v1', { source_ref_id: source }));
    expect(first.kind).toBe('OPENED');
    const before = await world.row((first as { issue: { id: string } }).issue.id);
    const eventsBefore = await world.events((first as { issue: { id: string } }).issue.id);
    expect((await open(requestOf('pmt.permit.expired.v1', { source_ref_id: source }))).kind).toBe('DUPLICATE');
    expect((await open(requestOf('pmt.permit.expired.v1', { source_ref_id: source, reference_code: 'GP-0002' }))).kind).toBe('DUPLICATE');
    expect(await world.owner('select count(*)::int as n from machvon.issue where source_ref_id = $1::uuid', [source])).toEqual([{ n: 1 }]);
    expect(await world.row((first as { issue: { id: string } }).issue.id)).toEqual(before);
    expect(await world.events((first as { issue: { id: string } }).issue.id)).toEqual(eventsBefore);
    // The same object under another module is another source; the same delivery again answers the issue that exists.
    expect((await open(requestOf('lnd.complaint.filed.v1', { source_ref_id: source }))).kind).toBe('OPENED');
    const delivery = randomUUID();
    const other = randomUUID();
    expect((await open(requestOf('pay.advance.overdue.v1', { source_ref_id: other }), delivery)).kind).toBe('OPENED');
    expect((await open(requestOf('pay.advance.overdue.v1', { source_ref_id: other }), delivery)).kind).toBe('DUPLICATE');
  });

  it('opens a new issue for an object whose issue was closed (BR-ISS-07 counts the issues that are not closed)', async () => {
    const source = randomUUID();
    const first = (await open(requestOf('pmt.permit.expired.v1', { source_ref_id: source }))) as { issue: { id: string } };
    await world.inProgress({ id: first.issue.id } as never);
    await world.owner("update machvon.issue set status = 'PENDING_VERIFICATION' where id = $1::uuid", [first.issue.id]);
    await world.owner(
      `insert into machvon.issue_event (tenant_id, id, issue_id, event_kind, payload, created_by) values ($1::uuid, gen_random_uuid(), $2::uuid, 'VERIFICATION_REQUESTED', '{"evidence_document_version_ids":["00000000-0000-4000-8000-000000000001"]}'::jsonb, $3::uuid)`,
      [TENANT_A, first.issue.id, SYSTEM],
    );
    await world.owner("update machvon.issue set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid where id = $1::uuid", [first.issue.id, memberId(PEOPLE.VERIFIER)]);
    expect((await open(requestOf('pmt.permit.expired.v1', { source_ref_id: source }))).kind).toBe('OPENED');
    expect(await world.owner('select count(*)::int as n from machvon.issue where source_ref_id = $1::uuid', [source])).toEqual([{ n: 2 }]);
  });

  it('AC-ST-ISS-005-2: holds only the kind of problem, the reference code and the category, though the event also carried a household, an identity number and an address', async () => {
    const source = randomUUID();
    const reading = readIntake('lnd.complaint.filed.v1', {
      ...payloadOf('lnd.complaint.filed.v1', { source_ref_id: source }),
      household_name: 'Nguyen Van A',
      citizen_id: '079000000001',
      address: '12 Le Loi, Cao Bang',
      content: 'The compensation for my plot is too low',
    });
    expect(reading.kind).toBe('REQUEST');
    if (reading.kind !== 'REQUEST') return;
    await open(reading.request);
    const stored = await issueOf(source);
    const rows = await world.owner('select to_jsonb(i) as issue, (select jsonb_agg(to_jsonb(e)) from machvon.issue_event e where e.issue_id = i.id) as events from machvon.issue i where i.id = $1::uuid', [stored?.id]);
    const text = JSON.stringify(rows);
    for (const personal of ['Nguyen Van A', '079000000001', 'Le Loi', 'Cao Bang', 'too low', 'compensation']) expect(text).not.toContain(personal);
    expect(stored?.title).toBe('Land complaint filed: LC-A-001');
  });

  it('files the issue in the unit the event names and under the severity it names, when it names them', async () => {
    const source = randomUUID();
    await open(requestOf('pay.advance.overdue.v1', { source_ref_id: source, owner_unit_id: UNIT_2, severity: 'MEDIUM' }));
    expect(await issueOf(source)).toMatchObject({ owner_unit_id: UNIT_2, severity: 'MEDIUM' });
  });

  it('answers PROJECT_UNKNOWN for a project that is not the tenant\'s, and writes nothing', async () => {
    const source = randomUUID();
    expect((await open(requestOf('pmt.permit.expired.v1', { source_ref_id: source, project_id: randomUUID() }))).kind).toBe('PROJECT_UNKNOWN');
    expect(await issueOf(source)).toBeUndefined();
  });

  it('refuses, to be retried, an event whose category the tenant has not defined or whose policy is missing', async () => {
    const source = randomUUID();
    // CTR has a category and no policy for HIGH.
    expect(await world.refusal(open(requestOf('ctr.guarantee.expired.v1', { source_reference: source })))).toEqual({ code: 'SLA_POLICY_MISSING', status: 422 });
    expect(await issueOf(source)).toBeUndefined();
    await world.owner("update machvon.master_record set status = 'RETIRED' where business_key = $1", [INTAKE_CATEGORY_KEYS.LND]);
    try {
      expect(await world.refusal(open(requestOf('lnd.complaint.filed.v1', { source_ref_id: randomUUID() })))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'category_key' });
    } finally {
      await world.owner("update machvon.master_record set status = 'EFFECTIVE' where business_key = $1", [INTAKE_CATEGORY_KEYS.LND]);
    }
  });

  it('refuses a contract that is not the project\'s', async () => {
    expect(await world.refusal(open(requestOf('pmt.permit.expired.v1', { source_ref_id: randomUUID(), project_id: PROJECT_OTHER, contract_id: randomUUID() })))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
