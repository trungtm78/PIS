import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { ApprovalEffects } from '../src/approval-store';
import { MemberStore } from '../src/member-store';
import { UnitReorganizationStore, inputOf, missingOf } from '../src/unit-reorganization-store';
import type { ReorganizationProjectPort, ReorganizationRecord, StoredProposal } from '../src/unit-reorganization-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, grantId, id, memberId, roleId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new UnitReorganizationStore();
const ROOT = 1;
const SKHDT = 2; // the old unit with 3 members, 5 grants and 4 projects
const SKKH = 3; // a second old unit, to merge with
const STC = 4; // the unit that takes over
const DISTRICT = 5; // a unit with 6 projects, for the split
const WARD_A = 6;
const WARD_B = 7;
const PROPOSER = 10;
const OWNER = 11;
const LEADER_ROLE = 1;
const ADVISOR_ROLE = 2;
const TODAY = '2026-11-20';
const NOW = new Date('2026-11-20T03:00:00Z');
const PROJECT_FAMILY = 0x50;
const projectId = (n: number): string => id(PROJECT_FAMILY, n);

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = OWNER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return { code: e.code ?? '', status: e.status ?? 0 };
  }
  throw new Error('expected a refusal');
}

interface Recorded {
  audits: string[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}
const effects = (recorded: Recorded = { audits: [], events: [] }): ApprovalEffects & { recorded: Recorded } => ({
  actor: memberId(OWNER),
  audit: (entry) => {
    recorded.audits.push(entry.action);
    return Promise.resolve();
  },
  emit: (event) => {
    recorded.events.push({ type: event.type, payload: event.payload });
    return Promise.resolve();
  },
  recorded,
});

/** A port that records the transfers and can be made to fail on a project. */
function recordingPort(failOn?: string): ReorganizationProjectPort & { calls: Array<{ projectId: string; toUnitId: string; idempotencyKey: string }>; failOn: string | undefined } {
  const port = {
    calls: [] as Array<{ projectId: string; toUnitId: string; idempotencyKey: string }>,
    failOn,
    transfer: async (tx: TenantTx, call: { projectId: string; toUnitId: string; idempotencyKey: string }) => {
      if (port.failOn === call.projectId) throw new Error('PRJ is down');
      port.calls.push({ projectId: call.projectId, toUnitId: call.toUnitId, idempotencyKey: call.idempotencyKey });
      // The module that owns projects moves the owner; the saga does not look again.
      await tx.query('update machvon.project set owner_unit_id = $2::uuid where id = $1::uuid', [call.projectId, call.toUnitId]);
    },
  };
  return port;
}

const proposalOf = (overrides: Partial<StoredProposal> & Pick<StoredProposal, 'predecessor_unit_ids' | 'successors'>): StoredProposal => ({ mapping: { memberships: [], projects: [] }, ...overrides });
const propose = (kind: ReorganizationRecord['kind'], proposal: StoredProposal, effectiveFrom = '2026-11-01'): Promise<ReorganizationRecord> =>
  as((tx) => store.insert(tx, { kind, effectiveFrom, legalBasisRef: 'Nghị quyết 12/NQ-UBND ngày 01/10/2026', proposal, requestedBy: memberId(PROPOSER) }), PROPOSER);
const approve = (reorganization: ReorganizationRecord, by = OWNER) => as((tx) => store.decide(tx, reorganization.id, reorganization.version, { decision: 'approve', by: memberId(by), reason: 'Đúng nghị quyết.', evidenceIds: [], now: NOW }), by);

/** The saga as the job drives it: step after step, each in its own transaction, until it is applied (or waits). */
async function drive(reorganizationId: string, port: ReorganizationProjectPort, e = effects(), today = TODAY, limit = 500): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const outcome = await as((tx) => store.step(tx, e, reorganizationId, today, NOW, port));
    if (outcome.kind !== 'STEP') return [...keys, outcome.kind];
    keys.push(outcome.key);
  }
  throw new Error('the saga did not end');
}

describe('the reorganisation of organisation units (ST-ADM-015, ADM 3.2)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: SKHDT, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(SKHDT)}/` },
      { n: SKKH, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(SKKH)}/` },
      { n: STC, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(STC)}/` },
      { n: DISTRICT, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(DISTRICT)}/` },
      { n: WARD_A, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(WARD_A)}/` },
      { n: WARD_B, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(WARD_B)}/` },
    ]);
    // 3 members of the old unit, one of the second old unit, the proposer and the owner.
    for (const [member, unit] of [[1, SKHDT], [2, SKHDT], [3, SKHDT], [4, SKKH], [5, DISTRICT], [6, DISTRICT], [PROPOSER, ROOT], [OWNER, ROOT]] as const) await harness.seedMembership(TENANT_A, member, unit);
    await harness.seedRole(TENANT_A, LEADER_ROLE, 'LEADER', ['approval.decide'], 60);
    await harness.seedRole(TENANT_A, ADVISOR_ROLE, 'ADVISOR', ['approval_task.read'], 20);
    // 5 grants over the old unit (and one over another, that is not touched).
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: 1, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(SKHDT)] },
      { n: 2, member: 2, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(SKHDT)] },
      { n: 3, member: 3, role: ADVISOR_ROLE, kind: 'UNIT_ONLY', refs: [unitId(SKHDT)] },
      { n: 4, member: 1, role: ADVISOR_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(SKHDT), unitId(WARD_A)] },
      { n: 5, member: 4, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(SKKH)] },
      { n: 6, member: 3, role: LEADER_ROLE, kind: 'TENANT' },
      { n: 7, member: 5, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(DISTRICT)] },
    ]);
    const projects: Array<[number, number]> = [[1, SKHDT], [2, SKHDT], [3, SKHDT], [4, SKHDT], [11, DISTRICT], [12, DISTRICT], [13, DISTRICT], [14, DISTRICT], [15, DISTRICT], [16, DISTRICT]];
    // The projects are the module PRJ's: they are seeded with the foreign keys to the other modules switched off.
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [n, unit] of projects) {
        await client.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, projectId(n), `P-${n}`, unitId(unit), unitId(ROOT), id(0x50, 90)],
        );
      }
    } finally {
      await client.end();
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('what the old units hold (the facts the proposal is judged by)', () => {
    it('lists the active members and the projects that are not closed, and what stands in the way: child units left behind and a reorganisation already open', async () => {
      await owner("update machvon.project set status = 'CLOSED' where id = $1", [projectId(4)]);
      const facts = await as((tx) => store.facts(tx, [unitId(SKHDT), unitId(SKKH)], [unitId(STC)]));
      expect(facts.membershipIds).toEqual([memberId(1), memberId(2), memberId(3), memberId(4)]);
      expect(facts.projectIds).toEqual([projectId(1), projectId(2), projectId(3)]);
      expect(facts.units.map((unit) => [unit.id, unit.status])).toEqual([[unitId(SKHDT), 'Active'], [unitId(SKKH), 'Active']]);
      expect(facts.successors.map((unit) => unit.id)).toEqual([unitId(STC)]);
      expect(facts.strandedChildIds).toEqual([]);
      expect(facts.busyUnitIds).toEqual([]);
      await owner("update machvon.project set status = 'IMPLEMENTATION' where id = $1", [projectId(4)]);
      // A unit under an old unit that is not itself reorganised would be left under a unit that stops existing.
      await harness.seedUnits(TENANT_A, [{ n: 30, parent: SKHDT, path: `/${unitId(ROOT)}/${unitId(SKHDT)}/${unitId(30)}/` }]);
      expect((await as((tx) => store.facts(tx, [unitId(SKHDT)], []))).strandedChildIds).toEqual([unitId(30)]);
      expect((await as((tx) => store.facts(tx, [unitId(SKHDT), unitId(30)], []))).strandedChildIds).toEqual([]);
      await owner("update machvon.organization_unit set status = 'Dissolved', valid_until = date '2026-06-01' where id = $1", [unitId(30)]);
    });
  });

  describe('AC-ST-ADM-015-1, UAT-AC111: merging two units into one', () => {
    it('the proposer cannot approve; the owner approves; the saga moves 4 members, 5 grants and 4 projects to the successor, ends the old grants, keeps the names and announces it once', async () => {
      const merge = await propose('MERGE', proposalOf({ predecessor_unit_ids: [unitId(SKHDT), unitId(SKKH)], successors: [{ existing_unit_id: unitId(STC) }] }));
      expect(merge.status).toBe('PendingApproval');
      expect(await refusal(approve(merge, PROPOSER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => store.decide(tx, merge.id, 99, { decision: 'approve', by: memberId(OWNER), reason: 'Đúng nghị quyết.', evidenceIds: [], now: NOW })))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      const { after } = await approve(merge);
      expect(after).toMatchObject({ status: 'Applying', approvedBy: memberId(OWNER), decisionReason: 'Đúng nghị quyết.' });
      expect(await refusal(approve(after))).toEqual({ code: 'REORG_STATE_INVALID', status: 409 });

      const port = recordingPort();
      const e = effects();
      const keys = await drive(merge.id, port, e);
      expect(keys.at(-1)).toBe('APPLIED');
      // Every step has its key.
      expect(keys.filter((key) => key.startsWith(`reorg:${merge.id}:membership:`))).toHaveLength(4);
      expect(keys.filter((key) => key.startsWith(`reorg:${merge.id}:grant:`))).toHaveLength(5);
      expect(keys.filter((key) => key.startsWith(`reorg:${merge.id}:project:`))).toHaveLength(4);

      expect((await owner<{ organization_id: string; version: string }>('select organization_id, version::text from machvon.membership where id = any($1::uuid[]) order by id', [[memberId(1), memberId(2), memberId(3), memberId(4)]])).map((row) => [row.organization_id, row.version])).toEqual(Array(4).fill([unitId(STC), '2']));
      // The old grants Expired, the new ones are over the successor and carry the reorganisation; the grant that was not over an old unit is untouched.
      const grants = await owner<{ status: string; scope_ref_ids: string[]; reorganization_id: string | null; membership_id: string; effective_until: string | null }>('select status, scope_ref_ids, reorganization_id, membership_id, effective_until::text from machvon.role_grant order by id');
      const old = grants.filter((grant) => grant.status === 'Expired');
      expect(old).toHaveLength(5);
      expect(old.every((grant) => grant.effective_until !== null)).toBe(true);
      const made = grants.filter((grant) => grant.reorganization_id === merge.id);
      expect(made).toHaveLength(5);
      expect(made.every((grant) => grant.status === 'Active')).toBe(true);
      expect(made.map((grant) => grant.scope_ref_ids.slice().sort())).toEqual(expect.arrayContaining([[unitId(STC)], [unitId(STC), unitId(WARD_A)].sort()]));
      expect(grants.filter((grant) => grant.status === 'Active' && grant.reorganization_id === null).map((grant) => grant.membership_id).sort()).toEqual([memberId(3), memberId(5)].sort());
      // The projects went through the port, each under its own key; and the old units are Superseded with the date, the successor and their names.
      expect(port.calls.map((call) => call.projectId).sort()).toEqual([projectId(1), projectId(2), projectId(3), projectId(4)].sort());
      expect(port.calls.every((call) => call.toUnitId === unitId(STC) && call.idempotencyKey === `reorg:${merge.id}:project:${call.projectId}`)).toBe(true);
      const units = await owner<{ id: string; name: string; status: string; valid_until: string; successor_id: string }>('select id, name, status, valid_until::text, successor_id from machvon.organization_unit where id = any($1::uuid[]) order by id', [[unitId(SKHDT), unitId(SKKH)]]);
      expect(units).toEqual([
        { id: unitId(SKHDT), name: 'Unit 2', status: 'Superseded', valid_until: '2026-11-01', successor_id: unitId(STC) },
        { id: unitId(SKKH), name: 'Unit 3', status: 'Superseded', valid_until: '2026-11-01', successor_id: unitId(STC) },
      ]);
      expect((await owner<{ predecessor_unit_id: string }>('select predecessor_unit_id from machvon.organization_unit_succession where reorganization_id = $1 order by predecessor_unit_id', [merge.id])).map((row) => row.predecessor_unit_id)).toEqual([unitId(SKHDT), unitId(SKKH)]);
      // Applied, with the figures; one announcement of the reorganisation and one bulk change of access.
      const done = await as((tx) => store.find(tx, merge.id));
      expect(done).toMatchObject({ status: 'Applied', resultSummary: { memberships: 4, grants: 5, projects: 4 } });
      expect(done?.appliedAt).not.toBeNull();
      expect(e.recorded.events.filter((event) => event.type === 'iam.org_unit.reorganization_applied.v1')).toHaveLength(1);
      const access = e.recorded.events.filter((event) => event.type === 'iam.access.changed.v1');
      expect(access).toHaveLength(1);
      expect((access[0]?.payload.membership_ids as string[]).sort()).toEqual([memberId(1), memberId(2), memberId(3), memberId(4)].sort());
      // The timeline: every step is there once; a second pass has nothing to do.
      expect((await as((tx) => store.steps(tx, merge.id))).length).toBe(keys.length - 1);
      expect(await refusal(as((tx) => store.step(tx, effects(), merge.id, TODAY, NOW, port)))).toEqual({ code: 'REORG_STATE_INVALID', status: 409 });
      // A reorganisation that is over is final.
      await expect(owner("update machvon.unit_reorganization set status = 'Applying' where id = $1", [merge.id])).rejects.toThrow(/that is over is not changed|does not go from/);
      await expect(owner("update machvon.unit_reorganization set legal_basis_ref = 'other' where id = $1", [merge.id])).rejects.toThrow(/not changed/);
    });
  });

  describe('a failed saga goes on from the step that failed', () => {
    it('stops on the project the module could not move, says which, and after it is decided again the steps done are not done again', async () => {
      const split = await propose(
        'SPLIT',
        proposalOf({
          predecessor_unit_ids: [unitId(DISTRICT)],
          successors: [{ existing_unit_id: unitId(WARD_A) }, { existing_unit_id: unitId(WARD_B) }],
          mapping: { memberships: [{ membership_id: memberId(5), successor_unit_id: unitId(WARD_A) }], projects: [], default_successor_unit_id: unitId(WARD_B) },
        }),
      );
      await approve(split);
      const port = recordingPort(projectId(13));
      const e = effects();
      let failed = '';
      let stepOfFailure = '';
      try {
        await drive(split.id, port, e);
      } catch (error) {
        failed = (error as Error).message;
        stepOfFailure = (error as { reorganizationStep?: string }).reorganizationStep ?? '';
      }
      expect(failed).toBe('PRJ is down');
      // The error says which step it stopped at, so that the job can record it.
      expect(stepOfFailure).toBe(`reorg:${split.id}:project:${projectId(13)}`);
      // The job marks it failed, in a transaction of its own, with the step.
      await as((tx) => store.fail(tx, split.id, { step: `reorg:${split.id}:project:${projectId(13)}`, code: 'PROJECT_TRANSFER_UNAVAILABLE' }, NOW));
      const failedRecord = await as((tx) => store.find(tx, split.id));
      expect(failedRecord).toMatchObject({ status: 'Failed', resultSummary: { failed: { step: `reorg:${split.id}:project:${projectId(13)}`, code: 'PROJECT_TRANSFER_UNAVAILABLE' } } });
      const movedBefore = port.calls.length;
      expect(movedBefore).toBe(2);
      // The cause is mended and the owner decides again (the proposer still may not).
      port.failOn = undefined;
      expect(await refusal(approve(failedRecord as ReorganizationRecord, PROPOSER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      await approve(failedRecord as ReorganizationRecord);
      const keys = await drive(split.id, port, e);
      expect(keys.at(-1)).toBe('APPLIED');
      // The projects done before are not moved again; the rest are; each exactly once in all.
      expect(port.calls.map((call) => call.projectId).sort()).toEqual([11, 12, 13, 14, 15, 16].map(projectId).sort());
      expect(keys.some((key) => key.includes(`:project:${projectId(11)}`))).toBe(false);
      // The member went where the mapping says and the others went to the default; the grant over the district is over the default successor.
      expect((await owner<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [memberId(5)]))[0]?.organization_id).toBe(unitId(WARD_A));
      expect((await owner<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [memberId(6)]))[0]?.organization_id).toBe(unitId(WARD_B));
      expect((await owner<{ scope_ref_ids: string[] }>("select scope_ref_ids from machvon.role_grant where reorganization_id = $1 and status = 'Active'", [split.id]))[0]?.scope_ref_ids).toEqual([unitId(WARD_B)]);
      expect((await owner<{ status: string }>('select status from machvon.organization_unit where id = $1', [unitId(DISTRICT)]))[0]?.status).toBe('Superseded');
    });

    it('stops with REORG_MAPPING_INCOMPLETE on a member who has no successor, whatever the proposal said', async () => {
      await harness.seedUnits(TENANT_A, [{ n: 40, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(40)}/` }, { n: 41, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(41)}/` }, { n: 42, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(42)}/` }]);
      await harness.seedMembership(TENANT_A, 40, 40);
      const split = await propose('SPLIT', proposalOf({ predecessor_unit_ids: [unitId(40)], successors: [{ existing_unit_id: unitId(41) }, { existing_unit_id: unitId(42) }] }));
      await approve(split);
      expect(await refusal(drive(split.id, recordingPort()))).toEqual({ code: 'REORG_MAPPING_INCOMPLETE', status: 422 });
    });
  });

  describe('the day of the reorganisation', () => {
    it('waits for its day: nothing is moved before the effective date, and the saga runs from that day', async () => {
      await harness.seedUnits(TENANT_A, [{ n: 50, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(50)}/` }, { n: 51, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(51)}/` }]);
      await harness.seedMembership(TENANT_A, 50, 50);
      const later = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(50)], successors: [{ existing_unit_id: unitId(51) }] }), '2026-12-01');
      await approve(later);
      expect(await as((tx) => store.dueIds(tx, '2026-11-30', 10))).not.toContain(later.id);
      expect(await as((tx) => store.step(tx, effects(), later.id, '2026-11-30', NOW, recordingPort()))).toEqual({ kind: 'WAITING' });
      expect((await owner<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [memberId(50)]))[0]?.organization_id).toBe(unitId(50));
      expect(await as((tx) => store.dueIds(tx, '2026-12-01', 10))).toContain(later.id);
      const keys = await drive(later.id, recordingPort(), effects(), '2026-12-01');
      expect(keys.at(-1)).toBe('APPLIED');
      // A dissolution leaves the unit Dissolved.
      expect((await owner<{ status: string; valid_until: string }>('select status, valid_until::text from machvon.organization_unit where id = $1', [unitId(50)]))[0]).toEqual({ status: 'Dissolved', valid_until: '2026-12-01' });
    });

    it('a rename into a new unit creates it on the day, with the name given, and moves everything to it', async () => {
      await harness.seedUnits(TENANT_A, [{ n: 60, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(60)}/` }]);
      await harness.seedMembership(TENANT_A, 60, 60);
      const rename = await propose(
        'RENAME',
        proposalOf({ predecessor_unit_ids: [unitId(60)], successors: [{ new_unit: { code: 'SO-MOI', name: 'Sở Tài chính', parentId: unitId(ROOT), unitType: 'DEPARTMENT', validFrom: '2026-11-01' } }] }),
      );
      await approve(rename);
      const keys = await drive(rename.id, recordingPort());
      expect(keys.at(-1)).toBe('APPLIED');
      const [created] = await owner<{ id: string; name: string; status: string; valid_from: string }>("select id, name, status, valid_from::text from machvon.organization_unit where code = 'SO-MOI'");
      expect(created).toMatchObject({ name: 'Sở Tài chính', status: 'Active', valid_from: '2026-11-01' });
      expect((await owner<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [memberId(60)]))[0]?.organization_id).toBe(created?.id);
      expect((await owner<{ name: string; status: string; successor_id: string }>('select name, status, successor_id from machvon.organization_unit where id = $1', [unitId(60)]))[0]).toEqual({ name: 'Unit 60', status: 'Superseded', successor_id: created?.id });
    });

    it('a successor that was planned stands from the day', async () => {
      await harness.seedUnits(TENANT_A, [{ n: 70, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(70)}/` }, { n: 71, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(71)}/` }]);
      await owner("update machvon.organization_unit set status = 'Planned' where id = $1", [unitId(71)]);
      const dissolve = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(70)], successors: [{ existing_unit_id: unitId(71) }] }));
      await approve(dissolve);
      await drive(dissolve.id, recordingPort());
      expect((await owner<{ status: string }>('select status from machvon.organization_unit where id = $1', [unitId(71)]))[0]?.status).toBe('Active');
    });
  });

  describe('the windows of the grants (a limited grant stays limited)', () => {
    it('makes a grant again with its own window: it ends when the old one ended, a grant that has not started starts when it was to, and one that is over is not made again', async () => {
      await harness.seedUnits(TENANT_A, [{ n: 90, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(90)}/` }, { n: 91, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(91)}/` }]);
      await harness.seedMembership(TENANT_A, 90, 91);
      await harness.seedGrants(TENANT_A, [
        { n: 90, member: 90, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(90)], from: '2026-01-01T00:00:00Z', until: '2027-06-01T00:00:00Z' },
        { n: 91, member: 90, role: ADVISOR_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(90)], from: '2027-01-01T00:00:00Z', until: null },
        { n: 92, member: 90, role: ADVISOR_ROLE, kind: 'UNIT_ONLY', refs: [unitId(90)], from: '2026-01-01T00:00:00Z', until: '2026-02-01T00:00:00Z' },
      ]);
      const dissolve = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(90)], successors: [{ existing_unit_id: unitId(91) }] }));
      await approve(dissolve);
      await drive(dissolve.id, recordingPort());
      const made = await owner<{ role_id: string; scope_kind: string; effective_from: string; effective_until: string | null }>(
        "select role_id, scope_kind, effective_from::text, effective_until::text from machvon.role_grant where reorganization_id = $1 order by scope_kind, role_id",
        [dissolve.id],
      );
      // Two grants were made again: the limited one with its end, the one that had not started with its start; the grant that was over is not.
      expect(made).toHaveLength(2);
      const limited = made.find((grant) => grant.role_id === roleId(LEADER_ROLE));
      const waiting = made.find((grant) => grant.role_id === roleId(ADVISOR_ROLE));
      expect(Date.parse(limited?.effective_until as string)).toBe(Date.parse('2027-06-01T00:00:00Z'));
      expect(Date.parse(limited?.effective_from as string)).toBeGreaterThanOrEqual(NOW.getTime() - 1000);
      expect(Date.parse(waiting?.effective_from as string)).toBe(Date.parse('2027-01-01T00:00:00Z'));
      expect(waiting?.effective_until).toBeNull();
      // The old ones Expired, the one that was over is left as it was.
      const old = await owner<{ id: string; status: string }>('select id, status from machvon.role_grant where membership_id = $1 and reorganization_id is null order by id', [memberId(90)]);
      expect(old.map((grant) => grant.status).sort()).toEqual(['Active', 'Expired', 'Expired']);
    });
  });

  describe('proposals that meet', () => {
    const seed = (numbers: number[]) => harness.seedUnits(TENANT_A, numbers.map((n) => ({ n, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(n)}/` })));

    it('a unit is held by a proposal that is not over when it is an old unit or a successor of it, and an old unit of another may not be our successor; two into one successor do not collide', async () => {
      await seed([100, 101, 102, 103]);
      await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(100)], successors: [{ existing_unit_id: unitId(101) }] }));
      const busy = async (preds: number[], succs: number[]) => (await as((tx) => store.facts(tx, preds.map(unitId), succs.map(unitId)))).busyUnitIds;
      expect(await busy([100], [102])).toEqual([unitId(100)]);
      // Their successor is not ours to retire.
      expect(await busy([101], [102])).toEqual([unitId(101)]);
      // Our successor is their old unit: data would be moved into a unit that stops existing.
      expect(await busy([103], [100])).toEqual([unitId(100)]);
      expect(await busy([103], [101])).toEqual([]);
    });

    it('moves the suspended and the invited members with the active ones, so that none is left in a unit that no longer exists, and an ended membership stays as history', async () => {
      await seed([170, 171]);
      for (const n of [170, 171, 172]) await harness.seedMembership(TENANT_A, n, 170);
      await owner("update machvon.membership set status = 'Suspended' where id = $1", [memberId(171)]);
      await owner("update machvon.membership set status = 'Invited' where id = $1", [memberId(172)]);
      await harness.seedMembership(TENANT_A, 173, 170);
      await owner("update machvon.membership set status = 'Ended' where id = $1", [memberId(173)]);
      const facts = await as((tx) => store.facts(tx, [unitId(170)], [unitId(171)]));
      expect(facts.membershipIds).toEqual([memberId(170), memberId(171), memberId(172)]);
      const dissolve = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(170)], successors: [{ existing_unit_id: unitId(171) }] }));
      await approve(dissolve);
      await drive(dissolve.id, recordingPort());
      const placed = await owner<{ id: string; organization_id: string; status: string }>('select id, organization_id, status from machvon.membership where id = any($1::uuid[]) order by id', [[170, 171, 172, 173].map(memberId)]);
      expect(placed.map((row) => [row.status, row.organization_id])).toEqual([['Active', unitId(171)], ['Suspended', unitId(171)], ['Invited', unitId(171)], ['Ended', unitId(170)]]);
    });

    it('the unit a new successor goes under is held in both directions: it cannot be retired while a proposal waits to create a unit under it, and a proposal cannot create one under a unit that another retires', async () => {
      await seed([180, 181, 182, 183]);
      await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(180)], successors: [{ existing_unit_id: unitId(181) }] }));
      const creating = await propose('RENAME', proposalOf({ predecessor_unit_ids: [unitId(182)], successors: [{ new_unit: { code: 'SO-182', name: 'Sở mới', parentId: unitId(183), unitType: 'DEPARTMENT', validFrom: '2026-11-01' } }] }));
      expect(creating.status).toBe('PendingApproval');
      const facts = (preds: number[], succ: number[], parents: number[]) => as((tx) => store.facts(tx, preds.map(unitId), succ.map(unitId), parents.map(unitId)));
      // Under the unit that another proposal retires: held.
      expect((await facts([184], [], [180])).busyUnitIds).toEqual([unitId(180)]);
      // The unit that a proposal creates a successor under cannot be retired by another.
      expect((await facts([183], [181], [])).busyUnitIds).toEqual([unitId(183)]);
      expect((await facts([184], [181], [])).busyUnitIds).toEqual([]);
    });

    it('an invitation into an old unit that commits while the unit is being retired is not left behind: the invitation holds the unit row until it commits, and the retirement looks again under the lock and stops', async () => {
      await seed([190, 191]);
      await harness.seedMembership(TENANT_A, 190, 190);
      const dissolve = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(190)], successors: [{ existing_unit_id: unitId(191) }] }));
      await approve(dissolve);
      // Step until the members have moved: the next step is the retirement.
      for (let i = 0; i < 20; i += 1) {
        const outcome = await as((tx) => store.step(tx, effects(), dissolve.id, TODAY, NOW, recordingPort()));
        if (outcome.kind === 'STEP' && outcome.key.includes(':membership:')) break;
      }
      const members = new MemberStore();
      const account = await as((tx) => members.ensureInvitedAccount(tx, 'late-invite@example.test', undefined));
      // The invitation looks at the unit (Active), and the person is inserted after the retirement has begun to wait.
      const inviting = as(async (tx) => {
        expect((await members.unitOf(tx, unitId(190)))?.status).toBe('Active');
        await new Promise((resolve) => setTimeout(resolve, 700));
        await members.insertInvitedMember(tx, { userAccountId: account, organizationId: unitId(190), membershipType: 'STAFF', invitedBy: memberId(OWNER) });
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const retiring = refusal(as((tx) => store.step(tx, effects(), dissolve.id, TODAY, NOW, recordingPort())));
      await inviting;
      expect(await retiring).toEqual({ code: 'UNIT_VALIDITY_INVALID', status: 422 });
      expect((await owner<{ status: string }>('select status from machvon.organization_unit where id = $1', [unitId(190)]))[0]?.status).toBe('Active');
      // A later pass moves the person too, and then the unit is retired.
      const keys = await drive(dissolve.id, recordingPort());
      expect(keys.at(-1)).toBe('APPLIED');
      expect((await owner<{ n: string }>("select count(*)::text as n from machvon.membership where organization_id = $1 and status in ('Invited', 'Active', 'Suspended')", [unitId(190)]))[0]?.n).toBe('0');
    });

    it('takes the membership before the grant, the order of the revocation of a grant: a grant revoked while the step waits is not carried over, and nothing deadlocks', async () => {
      await seed([200, 201]);
      await harness.seedMembership(TENANT_A, 200, 201);
      await harness.seedGrants(TENANT_A, [{ n: 200, member: 200, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(200)], from: '2026-01-01T00:00:00Z', until: '2027-06-01T00:00:00Z' }]);
      const dissolve = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(200)], successors: [{ existing_unit_id: unitId(201) }] }));
      await approve(dissolve);
      // Someone who holds the membership revokes the grant (membership first, then the grant) and commits a moment later.
      const revoking = as(async (tx) => {
        await tx.query('select id from machvon.membership where id = $1::uuid for update', [memberId(200)]);
        await new Promise((resolve) => setTimeout(resolve, 600));
        await tx.query("update machvon.role_grant set status = 'Revoked', revoked_at = now(), version = version + 1 where id = $1::uuid", [grantId(200)]);
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const keys = await drive(dissolve.id, recordingPort());
      await revoking;
      expect(keys.at(-1)).toBe('APPLIED');
      expect(keys.some((key) => key.includes(':grant-gone:'))).toBe(true);
      const active = await owner<{ n: string }>("select count(*)::text as n from machvon.role_grant where membership_id = $1 and status = 'Active'", [memberId(200)]);
      expect(active[0]?.n).toBe('0');
    });

    it('a successor that a saga created is held by it until it is over: no other proposal retires it, whatever happens to the saga', async () => {
      await seed([160]);
      await harness.seedMembership(TENANT_A, 160, 160);
      const rename = await propose('RENAME', proposalOf({ predecessor_unit_ids: [unitId(160)], successors: [{ new_unit: { code: 'SO-160', name: 'Sở mới', parentId: unitId(ROOT), unitType: 'DEPARTMENT', validFrom: '2026-11-01' } }] }));
      await approve(rename);
      // One step: the successor is created.
      expect((await as((tx) => store.step(tx, effects(), rename.id, TODAY, NOW, recordingPort()))).kind).toBe('STEP');
      const createdId = (await owner<{ id: string }>("select id from machvon.organization_unit where code = 'SO-160'"))[0]?.id as string;
      expect((await as((tx) => store.facts(tx, [createdId], []))).busyUnitIds).toEqual([createdId]);
      // (The unit it was created under is held by the saga, and the successor it created is not an old unit of anyone.)
      expect((await as((tx) => store.facts(tx, [unitId(ROOT)], [createdId]))).busyUnitIds).toEqual([unitId(ROOT)]);
      // Over, it holds nothing.
      await drive(rename.id, recordingPort());
      expect((await as((tx) => store.facts(tx, [createdId], []))).busyUnitIds).toEqual([]);
    });

    it('looks at the successors again on the day: one that stopped existing meanwhile receives nothing, and the saga stops with the unit named', async () => {
      await seed([110, 111, 112]);
      await harness.seedMembership(TENANT_A, 110, 110);
      const first = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(110)], successors: [{ existing_unit_id: unitId(111) }] }));
      await approve(first);
      const second = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(111)], successors: [{ existing_unit_id: unitId(112) }] }));
      await approve(second);
      expect((await drive(second.id, recordingPort())).at(-1)).toBe('APPLIED');
      expect(await refusal(drive(first.id, recordingPort()))).toEqual({ code: 'UNIT_VALIDITY_INVALID', status: 422 });
      expect((await owner<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [memberId(110)]))[0]?.organization_id).toBe(unitId(110));
    });

    it('a successor whose end has come before the effective date receives nothing: the facts say when each unit ends, and the saga looks again on the day', async () => {
      await seed([140, 141]);
      await harness.seedMembership(TENANT_A, 140, 140);
      await owner("update machvon.organization_unit set valid_until = date '2026-10-01' where id = $1", [unitId(141)]);
      expect((await as((tx) => store.facts(tx, [unitId(140)], [unitId(141)]))).successors.map((unit) => [unit.id, unit.validUntil])).toEqual([[unitId(141), '2026-10-01']]);
      const dissolve = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(140)], successors: [{ existing_unit_id: unitId(141) }] }));
      await approve(dissolve);
      expect(await refusal(drive(dissolve.id, recordingPort()))).toEqual({ code: 'UNIT_VALIDITY_INVALID', status: 422 });
      expect((await owner<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [memberId(140)]))[0]?.organization_id).toBe(unitId(140));
      // A successor that ends after the legal date but before the day the saga runs receives nothing either.
      await seed([142]);
      await owner("update machvon.organization_unit set valid_until = date '2026-11-10' where id = $1", [unitId(142)]);
      const late = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(140)], successors: [{ existing_unit_id: unitId(142) }] }));
      await approve(late);
      expect(await refusal(drive(late.id, recordingPort(), effects(), '2026-11-20'))).toEqual({ code: 'UNIT_VALIDITY_INVALID', status: 422 });
    });

    it('finds the people who would hold two memberships in one unit: in two old units that merge, or already in the successor; a membership that has ended is not one', async () => {
      await seed([120, 121, 122]);
      await harness.seedMembership(TENANT_A, 120, 120);
      await harness.seedMembership(TENANT_A, 121, 121);
      await harness.seedMembership(TENANT_A, 122, 122);
      const merge = inputOf({ kind: 'MERGE', effectiveFrom: '2026-11-01', proposal: proposalOf({ predecessor_unit_ids: [unitId(120), unitId(121)], successors: [{ existing_unit_id: unitId(122) }] }) });
      const collisions = () => as((tx) => store.membershipCollisions(tx, merge, [unitId(122)]));
      expect(await collisions()).toEqual([]);
      // The same person in both old units.
      await owner("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) select tenant_id, gen_random_uuid(), user_id, $2::uuid, 'Active', valid_from from machvon.membership where id = $1", [memberId(120), unitId(121)]);
      const user = (await owner<{ user_id: string }>('select user_id from machvon.membership where id = $1', [memberId(120)]))[0]?.user_id;
      expect(await collisions()).toEqual([user]);
      // A suspended membership moves too, so it collides; one that has ended is history and does not.
      await owner("update machvon.membership set status = 'Suspended' where user_id = $1 and organization_id = $2", [user, unitId(121)]);
      expect(await collisions()).toEqual([user]);
      await owner("update machvon.membership set status = 'Ended' where user_id = $1 and organization_id = $2", [user, unitId(121)]);
      expect(await collisions()).toEqual([]);
      // Already in the successor.
      await owner("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) select tenant_id, gen_random_uuid(), user_id, $2::uuid, 'Active', valid_from from machvon.membership where id = $1", [memberId(120), unitId(122)]);
      expect(await collisions()).toEqual([user]);
      // A new unit is a successor nobody is in yet: only the people who move together can meet in it.
      const rename = inputOf({ kind: 'RENAME', effectiveFrom: '2026-11-01', proposal: proposalOf({ predecessor_unit_ids: [unitId(120)], successors: [{ new_unit: { code: 'X', name: 'X', parentId: unitId(ROOT), unitType: 'DEPARTMENT', validFrom: '2026-11-01' } }] }) });
      expect(await as((tx) => store.membershipCollisions(tx, rename, ['new']))).toEqual([]);
    });

    it('looks at the child units again before it retires an old unit: one that came under it while the proposal waited stops the saga there', async () => {
      await seed([130, 131]);
      await harness.seedMembership(TENANT_A, 130, 130);
      const dissolve = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(130)], successors: [{ existing_unit_id: unitId(131) }] }));
      await approve(dissolve);
      await harness.seedUnits(TENANT_A, [{ n: 132, parent: 130, path: `/${unitId(ROOT)}/${unitId(130)}/${unitId(132)}/` }]);
      let stepOfFailure = '';
      let code = '';
      try {
        await drive(dissolve.id, recordingPort());
      } catch (error) {
        code = (error as { code?: string }).code ?? '';
        stepOfFailure = (error as { reorganizationStep?: string }).reorganizationStep ?? '';
      }
      expect(code).toBe('UNIT_VALIDITY_INVALID');
      expect(stepOfFailure).toBe(`reorg:${dissolve.id}:retire:${unitId(130)}`);
      expect((await owner<{ status: string }>('select status from machvon.organization_unit where id = $1', [unitId(130)]))[0]?.status).toBe('Active');
    });
  });

  describe('grants that meet on the successor', () => {
    it('a holder who already has the role over the successor keeps one grant, whose window takes in the one that moves; windows that are apart are not joined; and the saga does not fail on the one-active-grant rule', async () => {
      await harness.seedUnits(TENANT_A, [150, 151, 152].map((n) => ({ n, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(n)}/` })));
      await harness.seedMembership(TENANT_A, 150, 151);
      await harness.seedMembership(TENANT_A, 151, 151);
      await harness.seedGrants(TENANT_A, [
        // Member 150 already has the role over the successor, for a shorter time than the grant that moves.
        { n: 150, member: 150, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(151)], from: '2026-01-01T00:00:00Z', until: '2026-12-01T00:00:00Z' },
        { n: 151, member: 150, role: LEADER_ROLE, kind: 'UNIT_SUBTREE', refs: [unitId(150)], from: '2026-01-01T00:00:00Z', until: '2027-06-01T00:00:00Z' },
        // Member 151 has it over the successor until a date before the one that moves starts: the windows are apart.
        { n: 152, member: 151, role: ADVISOR_ROLE, kind: 'UNIT_ONLY', refs: [unitId(151)], from: '2026-01-01T00:00:00Z', until: '2026-12-01T00:00:00Z' },
        { n: 153, member: 151, role: ADVISOR_ROLE, kind: 'UNIT_ONLY', refs: [unitId(150)], from: '2027-03-01T00:00:00Z', until: '2027-09-01T00:00:00Z' },
      ]);
      const merge = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(150)], successors: [{ existing_unit_id: unitId(151) }] }));
      await approve(merge);
      const keys = await drive(merge.id, recordingPort());
      expect(keys.at(-1)).toBe('APPLIED');
      const active = await owner<{ membership_id: string; role_id: string; effective_from: string; effective_until: string | null; version: string }>(
        "select membership_id, role_id, effective_from::text, effective_until::text, version::text from machvon.role_grant where membership_id = any($1::uuid[]) and status = 'Active' order by membership_id, role_id",
        [[memberId(150), memberId(151)]],
      );
      // One grant each: the widened one ends when the longer one did; the one apart is left as it was.
      expect(active).toHaveLength(2);
      const widened = active.find((grant) => grant.membership_id === memberId(150));
      expect(Date.parse(widened?.effective_until as string)).toBe(Date.parse('2027-06-01T00:00:00Z'));
      expect(Date.parse(widened?.effective_from as string)).toBe(Date.parse('2026-01-01T00:00:00Z'));
      // A command prepared against the grant as it was is refused as stale: the widened grant and the ones that ended have a new version.
      expect(widened?.version).toBe('2');
      expect((await owner<{ version: string }>('select version::text from machvon.role_grant where id = $1', [grantId(151)]))[0]?.version).toBe('2');
      const apart = active.find((grant) => grant.membership_id === memberId(151));
      expect(Date.parse(apart?.effective_until as string)).toBe(Date.parse('2026-12-01T00:00:00Z'));
      const steps = await as((tx) => store.steps(tx, merge.id));
      expect(steps.filter((step) => step.key.startsWith('grant:')).map((step) => step.detail.carried).sort()).toEqual(['APART', 'WIDENED']);
    });
  });

  describe('the decision', () => {
    it('returns a proposal to Draft, rejects one (Cancelled) and refuses a decision on one that is over or being applied', async () => {
      await harness.seedUnits(TENANT_A, [{ n: 80, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(80)}/` }, { n: 81, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(81)}/` }]);
      const first = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(80)], successors: [{ existing_unit_id: unitId(81) }] }));
      const returned = await as((tx) => store.decide(tx, first.id, first.version, { decision: 'return', by: memberId(OWNER), reason: 'Bổ sung căn cứ pháp lý.', evidenceIds: [randomUUID()], now: NOW }));
      expect(returned.after).toMatchObject({ status: 'Draft', decisionReason: 'Bổ sung căn cứ pháp lý.' });
      expect(await refusal(approve(returned.after))).toEqual({ code: 'REORG_STATE_INVALID', status: 409 });
      const rejected = await as((tx) => store.decide(tx, first.id, returned.after.version, { decision: 'reject', by: memberId(OWNER), reason: 'Không đúng thẩm quyền.', evidenceIds: [], now: NOW }));
      expect(rejected.after.status).toBe('Cancelled');
      // The proposer may withdraw their own proposal (a returned one too), but not approve or send it back.
      const own = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(80)], successors: [{ existing_unit_id: unitId(81) }] }));
      expect(await refusal(as((tx) => store.decide(tx, own.id, own.version, { decision: 'return', by: memberId(PROPOSER), reason: 'Tự trả lại đề xuất.', evidenceIds: [], now: NOW }), PROPOSER))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const withdrawn = await as((tx) => store.decide(tx, own.id, own.version, { decision: 'reject', by: memberId(PROPOSER), reason: 'Rút lại đề xuất này.', evidenceIds: [], now: NOW }), PROPOSER);
      expect(withdrawn.after).toMatchObject({ status: 'Cancelled', approvedBy: null });
      // A saga that failed is carried on, not abandoned half way: it cannot be rejected.
      const half = await propose('DISSOLVE', proposalOf({ predecessor_unit_ids: [unitId(81)], successors: [{ existing_unit_id: unitId(80) }] }));
      await approve(half);
      await as((tx) => store.fail(tx, half.id, { step: `reorg:${half.id}:membership:x`, code: 'STEP_FAILED' }, NOW));
      const stopped = (await as((tx) => store.find(tx, half.id))) as ReorganizationRecord;
      expect(await refusal(as((tx) => store.decide(tx, half.id, stopped.version, { decision: 'reject', by: memberId(OWNER), reason: 'Bỏ dở giữa chừng.', evidenceIds: [], now: NOW })))).toEqual({ code: 'REORG_STATE_INVALID', status: 409 });
      expect(await refusal(approve(rejected.after))).toEqual({ code: 'REORG_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => store.decide(tx, randomUUID(), 1, { decision: 'approve', by: memberId(OWNER), reason: 'x', evidenceIds: [], now: NOW })))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      // The proposal in the table never changes.
      await expect(owner("update machvon.unit_reorganization set mapping_json = '{}'::jsonb where id = $1", [first.id])).rejects.toThrow(/not changed/);
      await expect(owner("update machvon.unit_reorganization set status = 'Applied' where id = $1", [first.id])).rejects.toThrow(/that is over is not changed|does not go from/);
    });

    it('lists the proposals newest first with who proposed and who approved, and by state', async () => {
      const all = await as((tx) => store.list(tx, {}, { limit: 100, after: undefined }));
      expect(all.length).toBeGreaterThan(3);
      expect([...all.map((row) => row.createdAt)].sort().reverse()).toEqual(all.map((row) => row.createdAt));
      const applied = await as((tx) => store.list(tx, { status: 'Applied' }, { limit: 100, after: undefined }));
      expect(applied.length).toBeGreaterThan(0);
      expect(applied.every((row) => row.status === 'Applied' && row.requestedByName !== null && row.approvedByName !== null)).toBe(true);
      const page = await as((tx) => store.list(tx, {}, { limit: 2, after: undefined }));
      const next = await as((tx) => store.list(tx, {}, { limit: 2, after: { code: page[1]?.sortKey as string, id: page[1]?.id as string } }));
      expect(next.map((row) => row.id)).not.toContain(page[0]?.id);
    });
  });

  describe('the pure parts the store hands to the kernel', () => {
    it('reads the stored proposal back in the form the kernel judges, and lists what has no successor', async () => {
      const [stored] = await as((tx) => store.list(tx, { status: 'Applied' }, { limit: 1, after: undefined }));
      const input = inputOf(stored as ReorganizationRecord);
      expect(input.predecessorIds.length).toBeGreaterThan(0);
      const split = inputOf({ kind: 'SPLIT', effectiveFrom: '2026-11-01', proposal: proposalOf({ predecessor_unit_ids: [unitId(DISTRICT)], successors: [{ existing_unit_id: unitId(WARD_A) }, { existing_unit_id: unitId(WARD_B) }], mapping: { memberships: [], projects: [{ project_id: projectId(11), successor_unit_id: unitId(WARD_A) }] } }) });
      expect(missingOf(split, { membershipIds: [memberId(5)], projectIds: [projectId(11), projectId(12)] }, [unitId(WARD_A), unitId(WARD_B)])).toEqual({ memberships: [memberId(5)], projects: [projectId(12)] });
    });
  });
});
