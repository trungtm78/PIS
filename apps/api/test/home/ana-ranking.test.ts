import { AnaRankingController } from '../../src/modules/home/ana-ranking.controller';
import { MEMBERS, TENANT_A, TENANT_B, UNITS, createAnaFixture, memberId, unitId } from './ana-support';

jest.setTimeout(240_000);

const FAMILY = 0xb8;
const fx = createAnaFixture(FAMILY, new Date('2027-10-20T03:00:00Z'));
const ALL = ['home.read', 'home.ranking.annotate', 'home.ranking.annotation.decide', 'home.ranking.complain', 'home.ranking.complaint.resolve'];

type Metric = { code: string; value: number | null; score: number | null; null_reason: string | null; excluded: string | null; under_complaint: boolean };
type RankedUnit = { unit_id: string; code: string; rank: number | null; composite: number | null; band: string; band_thin: boolean; standing: number; metrics: Metric[]; annotation: { id: string; reason_code: string } | null; pair: { quadrant: string | null; null_reason: string | null } };
type Ranking = { null_reason: string | null; units: RankedUnit[]; bands: Array<{ code: string; units: number; thin: boolean }>; model: { unverified: boolean; rule_version: string } };
type Note = { id: string; status: string; decided_by: { id: string } | null; unit: { id: string } };
type Complaint = { id: string; status: string; due_on: string; resolution: string | null };
const id = (reply: { json: Record<string, unknown> }): string => reply.json.resource_id as string;

async function twoUnits(): Promise<void> {
  const snapshot = await fx.snapshot({ asOf: '2027-10-12' });
  await fx.project(snapshot, UNITS.NORTH, '800000000000');
  await fx.project(snapshot, UNITS.SOUTH, '400000000000');
}
const proposal = (unit: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ unit_id: unitId(unit), reason_code: 'LAND_CLEARANCE', metric_codes: ['RATE'], evidence: 'The compensation of twelve households is not paid yet.', valid_to: '2027-12-31', ...over });
const complaintBody = (unit: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ unit_id: unitId(unit), metric_code: 'RATE', as_of_date: '2027-10-12', claim: 'The Treasury paid three billion more on the ninth of October.', claimed_value: '62.5', ...over });

describe('the ranking on several measures over HTTP (G3-8)', () => {
  beforeAll(async () => {
    await fx.start({
      controllers: [AnaRankingController],
      roles: [
        { n: 1, name: 'RANKING_ALL', permissions: ALL },
        { n: 2, name: 'RANKING_BRANCH', permissions: ['home.read', 'home.ranking.annotate', 'home.ranking.complain'] },
        { n: 3, name: 'RANKING_READ', permissions: ['home.read'] },
      ],
      grants: [
        { n: 1, member: MEMBERS.LEADER, role: 1, kind: 'TENANT' },
        { n: 2, member: MEMBERS.SECOND, role: 1, kind: 'TENANT' },
        { n: 3, member: MEMBERS.BRANCH, role: 2, kind: 'UNIT_SUBTREE', unit: UNITS.NORTH },
        { n: 4, member: MEMBERS.NOBODY, role: 3, kind: 'TENANT' },
      ],
    });
  }, 300_000);
  afterAll(() => fx.stop(), 60_000);
  beforeEach(async () => {
    fx.clock.now = new Date('2027-10-20T03:00:00Z');
    await fx.wipe(['ranking_complaint', 'ranking_annotation']);
  });

  it('ranks the units inside their size band on the measures that stand, with the model and its formula, and flags a band too small to compare', async () => {
    await twoUnits();
    const reply = await fx.get('/home/rankings/multi');
    expect(reply.status).toBe(200);
    const ranking = reply.json as unknown as Ranking;
    expect(ranking.null_reason).toBeNull();
    expect(ranking.model).toMatchObject({ unverified: true, rule_version: 'builtin' });
    const [first, second] = ranking.units;
    // North paid 800 of 1000 and south 400 of 1000: the rate scores 100 and 0 among the two units; the other three measures stand level (100 each); the physical progress is not there.
    expect(first).toMatchObject({ unit_id: unitId(UNITS.NORTH), rank: 1, composite: 100, band: 'LARGE', band_thin: true, standing: 4 });
    expect(second).toMatchObject({ unit_id: unitId(UNITS.SOUTH), rank: 2, composite: 50 });
    expect(first?.metrics.find((metric) => metric.code === 'PHYSICAL')).toMatchObject({ value: null, score: null, null_reason: 'NO_PHYSICAL_PROGRESS' });
    expect(first?.pair).toMatchObject({ quadrant: null, null_reason: 'NO_PHYSICAL_PROGRESS' });
    expect(first?.metrics.find((metric) => metric.code === 'RATE')?.value).toBe(64);
    expect(ranking.bands.find((band) => band.code === 'LARGE')).toMatchObject({ units: 2, thin: true });
  });

  it('says there is no snapshot instead of a ranking, and shows no other tenant', async () => {
    const empty = (await fx.get('/home/rankings/multi')).json as unknown as Ranking;
    expect(empty).toMatchObject({ null_reason: 'NO_SNAPSHOT', units: [] });
    await twoUnits();
    const other = (await fx.get('/home/rankings/multi', 1, TENANT_B)).json as unknown as Ranking;
    expect(other.units).toEqual([]);
  });

  it('proposes a note, keeps the author from approving it, lets another person approve it and shows it beside the unit', async () => {
    await twoUnits();
    const proposed = await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH), MEMBERS.LEADER);
    expect(proposed.status).toBe(200);
    const noteId = id(proposed);
    const own = await fx.post(`/home/rankings/annotations/${noteId}/decision`, { decision: 'APPROVE', note: 'Evidence checked on site.' }, MEMBERS.LEADER);
    expect(own.status).toBe(403);
    expect(own.json.code).toBe('SELF_APPROVAL_DENIED');
    expect((await fx.post(`/home/rankings/annotations/${noteId}/decision`, { decision: 'APPROVE', note: 'Evidence checked on site.' }, MEMBERS.SECOND)).json).toMatchObject({ status: 'APPROVED' });
    const ranking = (await fx.get('/home/rankings/multi')).json as unknown as Ranking;
    expect(ranking.units.find((unit) => unit.unit_id === unitId(UNITS.NORTH))?.annotation).toMatchObject({ id: noteId, reason_code: 'LAND_CLEARANCE' });
    // An approved note is final except that it may be withdrawn: approving it again is a conflict of state.
    const again = await fx.post(`/home/rankings/annotations/${noteId}/decision`, { decision: 'APPROVE', note: 'Evidence checked again.' }, MEMBERS.SECOND);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('RANKING_ANNOTATION_STATE');
    expect((await fx.post(`/home/rankings/annotations/${noteId}/decision`, { decision: 'WITHDRAW', note: 'The households were paid.' }, MEMBERS.LEADER)).json).toMatchObject({ status: 'WITHDRAWN' });
    const listed = (await fx.get('/home/rankings/annotations?status=WITHDRAWN')).json as { items: Note[] };
    expect(listed.items.map((note) => note.id)).toEqual([noteId]);
    expect(listed.items[0]?.decided_by?.id).toBe(memberId(MEMBERS.LEADER));
    expect(Number((await fx.rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where action like 'home.ranking_annotation_%'`))[0]?.n)).toBe(3);
  });

  it('refuses a note outside the closed lists, outside the scope of the proposer and without the right', async () => {
    await twoUnits();
    expect((await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH, { reason_code: 'BECAUSE' }))).status).toBe(422);
    expect((await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH, { metric_codes: [] }))).status).toBe(422);
    expect((await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH, { valid_to: '2029-01-01' }))).status).toBe(422);
    expect((await fx.post('/home/rankings/annotations', proposal(UNITS.SOUTH), MEMBERS.BRANCH)).status).toBe(403);
    expect((await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH), MEMBERS.NOBODY)).status).toBe(403);
    expect((await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH), MEMBERS.BRANCH)).status).toBe(200);
    // The branch is not a decider.
    const branchNote = ((await fx.get('/home/rankings/annotations', MEMBERS.BRANCH)).json as { items: Note[] }).items[0] as Note;
    expect((await fx.post(`/home/rankings/annotations/${branchNote.id}/decision`, { decision: 'APPROVE', note: 'Evidence checked on site.' }, MEMBERS.BRANCH)).status).toBe(403);
    expect((await fx.post(`/home/rankings/annotations/${branchNote.id}/decision`, { decision: 'APPROVE', note: 'no' }, MEMBERS.SECOND)).status).toBe(422);
  });

  it('files a complaint, marks the figure until it is answered, and answers it by a person who did not file it', async () => {
    await twoUnits();
    const filed = await fx.post('/home/rankings/complaints', complaintBody(UNITS.NORTH), MEMBERS.BRANCH);
    expect(filed.status).toBe(200);
    const complaintId = id(filed);
    let ranking = (await fx.get('/home/rankings/multi')).json as unknown as Ranking;
    expect(ranking.units.find((unit) => unit.unit_id === unitId(UNITS.NORTH))?.metrics.find((metric) => metric.code === 'RATE')?.under_complaint).toBe(true);
    const listed = (await fx.get('/home/rankings/complaints', MEMBERS.LEADER)).json as { items: Complaint[] };
    expect(listed.items[0]).toMatchObject({ id: complaintId, status: 'FILED', due_on: '2027-10-30' });
    expect((await fx.post(`/home/rankings/complaints/${complaintId}/resolution`, { action: 'START_REVIEW' }, MEMBERS.LEADER)).json).toMatchObject({ status: 'UNDER_REVIEW' });
    expect((await fx.post(`/home/rankings/complaints/${complaintId}/resolution`, { action: 'START_REVIEW' }, MEMBERS.LEADER)).status).toBe(409);
    expect((await fx.post(`/home/rankings/complaints/${complaintId}/resolution`, { action: 'UPHOLD', resolution: 'no' }, MEMBERS.LEADER)).status).toBe(422);
    expect((await fx.post(`/home/rankings/complaints/${complaintId}/resolution`, { action: 'UPHOLD', resolution: 'The figure is the one the Treasury booked.' }, MEMBERS.LEADER)).json).toMatchObject({ status: 'UPHELD' });
    ranking = (await fx.get('/home/rankings/multi')).json as unknown as Ranking;
    expect(ranking.units.every((unit) => unit.metrics.every((metric) => !metric.under_complaint))).toBe(true);
    const closed = await fx.post(`/home/rankings/complaints/${complaintId}/resolution`, { action: 'REJECT', resolution: 'Trying to answer a second time.' }, MEMBERS.LEADER);
    expect(closed.status).toBe(409);
    expect(closed.json.code).toBe('RANKING_COMPLAINT_STATE');
  });

  it('does not let the person who filed a complaint answer it, and keeps a unit outside the scope of the filer out', async () => {
    await twoUnits();
    const filed = await fx.post('/home/rankings/complaints', complaintBody(UNITS.SOUTH), MEMBERS.SECOND);
    const own = await fx.post(`/home/rankings/complaints/${id(filed)}/resolution`, { action: 'START_REVIEW' }, MEMBERS.SECOND);
    expect(own.status).toBe(403);
    expect(own.json.code).toBe('SELF_APPROVAL_DENIED');
    expect((await fx.post('/home/rankings/complaints', complaintBody(UNITS.SOUTH), MEMBERS.BRANCH)).status).toBe(403);
    expect((await fx.post('/home/rankings/complaints', complaintBody(UNITS.NORTH, { metric_code: 'NOPE' }), MEMBERS.BRANCH)).status).toBe(422);
    expect((await fx.post('/home/rankings/complaints', complaintBody(UNITS.NORTH, { as_of_date: '2027-12-01' }), MEMBERS.BRANCH)).status).toBe(422);
    const branchList = (await fx.get('/home/rankings/complaints', MEMBERS.BRANCH)).json as { items: Complaint[] };
    expect(branchList.items).toEqual([]);
    expect((await fx.post(`/home/rankings/complaints/${id(filed)}/resolution`, { action: 'START_REVIEW' }, MEMBERS.BRANCH)).status).toBe(403);
  });

  it('is idempotent and cannot be edited or removed, and a note cannot be forced to a self approved state', async () => {
    await twoUnits();
    const first = await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH), MEMBERS.LEADER, 'ranking-key-0000000001');
    const second = await fx.post('/home/rankings/annotations', proposal(UNITS.NORTH), MEMBERS.LEADER, 'ranking-key-0000000001');
    expect(id(second)).toBe(id(first));
    expect(Number((await fx.rows<{ n: string }>('select count(*)::text as n from machvon.ranking_annotation'))[0]?.n)).toBe(1);
    const asApp = (sql: string): Promise<unknown> => fx.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MEMBERS.LEADER), scopeVersion: 1 }, (tx) => tx.query(sql, [id(first)]));
    await expect(asApp('delete from machvon.ranking_annotation where id = $1::uuid')).rejects.toBeDefined();
    await expect(asApp("update machvon.ranking_annotation set evidence = 'A different evidence text now' where id = $1::uuid")).rejects.toBeDefined();
    await expect(asApp("update machvon.ranking_annotation set status = 'APPROVED', decided_by = proposed_by, decided_at = now(), decision_note = 'Self approved' where id = $1::uuid")).rejects.toBeDefined();
  });
});
