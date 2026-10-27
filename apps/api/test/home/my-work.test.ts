import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { homeModule } from '../../src/modules/home';
import { MyWorkController } from '../../src/modules/home/my-work.controller';
import { HOME_CLOCK } from '../../src/modules/home/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(120_000);

const SIGNING_KEY = randomBytes(32);
const MAKER = 1; // a person who prepares reports and answers explanations, of the north
const OTHER = 2; // another person: their work is not the maker's
const ASKER = 3; // asks explanations of others and concludes them
const NOBODY = 4; // holds no right to read HOME
const SCOPED = 5; // a member of the root unit who may read the north only
const MOVED = 6; // a member of the north who may read the south only now
const B_MEMBER = 1;
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const FAMILY = 0xa9;
const NOW = new Date('2027-10-15T03:00:00Z');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Item = { id: string; kind: string; title: string; subtitle: string | null; status: string; due_on: string | null; original_due_on: string | null; bucket: string; overdue: boolean; days_late: number; target: { screen: string; id: string } };

/** The work of a person over HTTP (ST-HOME-004, HOME-02). */
describe('my work over HTTP (ST-HOME-004)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function mine(query = '', member = MAKER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}/home/my-work${query}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const items = (reply: Reply): Item[] => reply.json.items as Item[];
  const counts = (reply: Reply): Record<string, number> => reply.json.counts as Record<string, number>;
  async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  const day = (offset: number): string => new Date(Date.UTC(2049, 0, 2) + offset * 86_400_000).toISOString().slice(0, 10);

  async function project(unit: number): Promise<string> {
    counter += 1;
    const projectId = id(FAMILY, 500 + counter);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `HM-${String(counter).padStart(3, '0')}`, unitId(unit), id(FAMILY, 30)],
      ],
    ]);
    return projectId;
  }
  async function explanation(projectId: string, options: { to: number; by?: number; status?: string; due: string; original?: string; question?: string }): Promise<string> {
    counter += 1;
    const explanationId = id(FAMILY, 4000 + counter);
    const status = options.status ?? 'REQUESTED';
    await seedReplica([
      [
        `insert into machvon.explanation_request (tenant_id, id, subject_kind, project_id, trigger_code, question, requested_from_membership_id, due_at, original_due_at, status, response_text, responded_by, responded_at, created_by, updated_by)
         values ($1, $2, 'PROJECT', $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, case when $9 = 'RESPONDED' then 'The works were delayed by the weather and are caught up.' end, case when $9 = 'RESPONDED' then $6::uuid end, case when $9 = 'RESPONDED' then now() end, $10, $10)`,
        [TENANT_A, explanationId, projectId, `T-${counter}`, options.question ?? 'Why is the disbursement slow?', memberId(options.to), options.due, options.original ?? options.due, status, memberId(options.by ?? ASKER)],
      ],
    ]);
    return explanationId;
  }
  async function period(deadline: string): Promise<string> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    await seedReplica([
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, $5::timestamptz, 'DEFAULT', 'WEEK', 2027, 'OPEN', $6, $7, $7)`,
        [TENANT_A, periodId, `W-${counter}`, day(counter * 7), deadline, id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
    ]);
    return periodId;
  }
  async function report(projectId: string, periodId: string, options: { status: string; by: number }): Promise<string> {
    counter += 1;
    const reportId = id(FAMILY, 6000 + counter);
    await seedReplica([
      [
        `insert into machvon.report_revision (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, created_by, updated_by, submitted_by, submitted_at, returned_reason, accepted_by, accepted_at)
         values ($1, $2, $3, $4, $5, 1, $6, $6 = 'AMENDMENT_REQUESTED', 1, repeat('b', 64), $7, $7, case when $6 <> 'DRAFT' then $7::uuid end, case when $6 <> 'DRAFT' then now() end, case when $6 in ('RETURNED', 'AMENDMENT_REQUESTED') then 'The figures of the second cell do not match.' end, case when $6 = 'AMENDMENT_REQUESTED' then $8::uuid end, case when $6 = 'AMENDMENT_REQUESTED' then now() end)`,
        [TENANT_A, reportId, projectId, periodId, id(FAMILY, 31), options.status, memberId(options.by), WORKER_MEMBERSHIP_ID],
      ],
    ]);
    return reportId;
  }
  async function approval(member: number, dueAt: string, decided = false): Promise<string> {
    counter += 1;
    const taskId = id(FAMILY, 7000 + counter);
    const instanceId = id(FAMILY, 7500 + counter);
    await seedReplica([
      ['insert into machvon.workflow_instance (tenant_id, id, workflow_version_id, resource_type, resource_id, resource_version, status, started_at, temporal_workflow_id, initiator_membership_id, initiator_user_id, document_type, unit_id) values ($1, $2, $3, $4, $5, 1, $6, now(), $7, $8, $9, $4, $10)', [TENANT_A, instanceId, id(FAMILY, 32), 'reallocation_proposal', randomUUID(), 'Running', `wf-${instanceId}`, memberId(ASKER), id(0x60, ASKER), unitId(ROOT)]],
      [
        `insert into machvon.approval_task (tenant_id, id, workflow_instance_id, assignee_id, due_at, decision, decided_at, decided_by, step_id, status) values ($1, $2, $3, $4, $5::timestamptz, $6::text, $7::timestamptz, case when $6::text is null then null else $4::uuid end, 'review', case when $6::text is null then 'Pending' else 'Decided' end)`,
        [TENANT_A, taskId, instanceId, memberId(member), dueAt, decided ? 'approve' : null, decided ? NOW.toISOString() : null],
      ],
    ]);
    return taskId;
  }
  async function obligation(unit: number, due: string, status = 'DRAFT', revision = 1): Promise<string> {
    counter += 1;
    const reportId = id(FAMILY, 8000 + counter);
    await seedReplica([
      [
        `insert into machvon.mne_report (tenant_id, id, form_id, report_year, period_label, scope_unit_id, due_date, revision, status, payload_json, correction_reason, submitted_by, submitted_at, created_by, updated_by)
         values ($1, $2, $3, 2027, $4, $5, $6::date, $7, $8, '{}'::jsonb, case when $7 > 1 then 'A correction.' end, case when $8 = 'IN_REVIEW' then $9::uuid end, case when $8 = 'IN_REVIEW' then now() end, $9, $9)`,
        [TENANT_A, reportId, id(FAMILY, 33), `H${counter}-2027`, unitId(unit), due, revision, status, WORKER_MEMBERSHIP_ID],
      ],
    ]);
    return reportId;
  }
  const wipe = (): Promise<void> =>
    seedReplica([['delete from machvon.approval_task', []], ['delete from machvon.workflow_instance', []], ['delete from machvon.mne_report', []], ['delete from machvon.report_revision', []], ['delete from machvon.explanation_request', []], ['delete from machvon.reporting_period', []], ['delete from machvon.project', []]]);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
        { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
      ]);
    }
    await harness.seedMembership(TENANT_A, MAKER, NORTH);
    await harness.seedMembership(TENANT_A, OTHER, SOUTH);
    await harness.seedMembership(TENANT_A, ASKER, ROOT);
    await harness.seedMembership(TENANT_A, NOBODY, NORTH);
    await harness.seedMembership(TENANT_A, SCOPED, ROOT);
    await harness.seedMembership(TENANT_A, MOVED, NORTH);
    await harness.seedMembership(TENANT_B, B_MEMBER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'HOME_READER', ['home.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 2, member: OTHER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(SOUTH)] },
      { n: 3, member: ASKER, role: 1, kind: 'TENANT' },
      { n: 4, member: SCOPED, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 5, member: MOVED, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(SOUTH)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MEMBER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MyWorkController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HOME_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(wipe);

  it('serves the controller of the work of a person in the module of HOME', () => {
    expect(homeModule.controllers).toContain(MyWorkController);
  });

  it('AC-ST-HOME-004-1: UAT-AC272 gives the maker the 3 explanations (2 asked for, 1 late with the day it was first asked for), the late one first, and the way to PRJ-19', async () => {
    const p = await project(NORTH);
    const asked1 = await explanation(p, { to: MAKER, due: '2027-10-18T10:00:00Z', question: 'First question?' });
    const asked2 = await explanation(p, { to: MAKER, due: '2027-11-30T10:00:00Z', question: 'Second question?' });
    // Late: asked for on 1 October, sent back with the day of 12 October, past by now (15 October).
    const late = await explanation(p, { to: MAKER, status: 'OVERDUE', due: '2027-10-12T10:00:00Z', original: '2027-10-01T10:00:00Z', question: 'The late question?' });
    const reply = await mine();
    expect(reply.status).toBe(200);
    const explanations = items(reply).filter((item) => item.kind === 'EXPLANATION');
    expect(explanations.map((item) => item.id)).toEqual([late, asked1, asked2]);
    expect(counts(reply)).toMatchObject({ EXPLANATION: 3, overdue: 1, total: 3 });
    expect(explanations[0]).toMatchObject({ bucket: 'OVERDUE', overdue: true, days_late: 3, due_on: '2027-10-12', original_due_on: '2027-10-01', status: 'OVERDUE', target: { screen: 'PRJ-19', id: late } });
    expect(explanations[1]).toMatchObject({ bucket: 'NEAR', overdue: false, days_late: 0 });
    expect(explanations[2]).toMatchObject({ bucket: 'LATER', overdue: false });
  });

  it('AC-ST-HOME-004-2: UAT-AC272 gives a report that came back and an approval that waits, and never the work of another person', async () => {
    const p = await project(NORTH);
    const returned = await report(p, await period('2027-10-10T10:00:00Z'), { status: 'RETURNED', by: MAKER });
    const task = await approval(MAKER, '2027-10-20T10:00:00Z');
    // Other people's work: a report of the other person, an approval of the other, an explanation of the other, a task already decided.
    const other = await project(SOUTH);
    await report(other, await period('2027-10-10T10:00:00Z'), { status: 'RETURNED', by: OTHER });
    await approval(OTHER, '2027-10-20T10:00:00Z');
    await explanation(other, { to: OTHER, due: '2027-10-12T10:00:00Z', status: 'OVERDUE' });
    await approval(MAKER, '2027-10-20T10:00:00Z', true);
    const reply = await mine();
    expect(items(reply).map((item) => [item.kind, item.id])).toEqual([
      ['REPORT_RETURNED', returned],
      ['APPROVAL', task],
    ]);
    expect(items(reply)[0]).toMatchObject({ subtitle: expect.stringMatching(/^HM-/), status: 'RETURNED', bucket: 'OVERDUE', target: { screen: 'DIS-03', id: returned } });
    const theirs = await mine('', OTHER);
    expect(items(theirs).map((item) => item.kind).sort()).toEqual(['APPROVAL', 'EXPLANATION', 'REPORT_RETURNED']);
    expect(JSON.stringify(theirs.json)).not.toContain(returned);
  });

  it('gives a draft whose period is past as work, and not one whose period has still time, nor a report that a later one supersedes or is deleted', async () => {
    const p = await project(NORTH);
    const late = await report(p, await period('2027-10-10T10:00:00Z'), { status: 'DRAFT', by: MAKER });
    await report(p, await period('2027-10-30T10:00:00Z'), { status: 'DRAFT', by: MAKER });
    const old = await report(p, await period('2027-10-09T10:00:00Z'), { status: 'RETURNED', by: MAKER });
    // A revision that a later one supersedes is not the one that is worked on.
    const next = await report(await project(NORTH), await period('2027-10-09T10:00:00Z'), { status: 'DRAFT', by: OTHER });
    await seedReplica([[`update machvon.report_revision set supersedes_id = $1 where id = $2`, [old, next]]]);
    const deleted = await report(p, await period('2027-10-09T10:00:00Z'), { status: 'DRAFT', by: MAKER });
    await seedReplica([[`update machvon.report_revision set deleted_at = now(), deleted_reason = 'Entered by mistake.' where id = $1`, [deleted]]]);
    const reply = await mine();
    expect(items(reply).map((item) => [item.kind, item.id])).toEqual([['REPORT_DRAFT_OVERDUE', late]]);
  });

  it('keeps a report that asked for an amendment when the draft of the amendment was deleted, and says nothing was cut', async () => {
    const p = await project(NORTH);
    const original = await report(p, await period('2027-10-10T10:00:00Z'), { status: 'AMENDMENT_REQUESTED', by: MAKER });
    const draft = await report(await project(NORTH), await period('2027-10-10T10:00:00Z'), { status: 'DRAFT', by: OTHER });
    await seedReplica([[`update machvon.report_revision set supersedes_id = $1 where id = $2`, [original, draft]]]);
    // While the draft of the amendment stands, the original is not the one that is worked on; deleted, it is again.
    expect(items(await mine()).map((item) => item.id)).toEqual([]);
    await seedReplica([[`update machvon.report_revision set deleted_at = now(), deleted_reason = 'Entered by mistake.' where id = $1`, [draft]]]);
    const reply = await mine();
    expect(items(reply).map((item) => [item.kind, item.id])).toEqual([['REPORT_RETURNED', original]]);
    expect(reply.json.truncated).toBe(false);
  });

  it('gives the explanations the person asked for that were answered, to conclude, and not the ones that are still waiting for an answer', async () => {
    const p = await project(NORTH);
    const answered = await explanation(p, { to: MAKER, by: ASKER, status: 'RESPONDED', due: '2027-10-20T10:00:00Z' });
    await explanation(p, { to: MAKER, by: ASKER, status: 'REQUESTED', due: '2027-10-20T10:00:00Z' });
    const reply = await mine('', ASKER);
    expect(items(reply).map((item) => [item.kind, item.id])).toEqual([['EXPLANATION_REVIEW', answered]]);
    // The one who answered has nothing to conclude, and nothing to answer any more.
    expect(items(await mine('', MAKER)).filter((item) => item.kind === 'EXPLANATION_REVIEW')).toEqual([]);
  });

  it('gives the monitoring reports of the unit of the person and the units under it that are not handed in and are late or near, and not the other ones', async () => {
    const late = await obligation(NORTH, '2027-10-10');
    const near = await obligation(NORTH, '2027-10-25');
    await obligation(NORTH, '2028-03-01');
    await obligation(NORTH, '2027-10-12', 'IN_REVIEW');
    await obligation(NORTH, '2027-10-12', 'DRAFT', 2);
    await obligation(SOUTH, '2027-10-10');
    const reply = await mine();
    expect(items(reply).map((item) => [item.kind, item.id, item.bucket])).toEqual([
      ['MNE_OBLIGATION', late, 'OVERDUE'],
      ['MNE_OBLIGATION', near, 'LATER'],
    ]);
    expect(items(reply)[0]).toMatchObject({ target: { screen: 'MNE-03', id: late }, subtitle: expect.any(String) });
    // The person of the south has the one of the south; the one at the root has those of every unit under it.
    expect(items(await mine('', OTHER)).map((item) => item.kind)).toEqual(['MNE_OBLIGATION']);
    expect(items(await mine('', ASKER)).filter((item) => item.kind === 'MNE_OBLIGATION')).toHaveLength(3);
  });

  it('gives the monitoring reports only of the units the person may read, though their own unit is a parent of more', async () => {
    const north = await obligation(NORTH, '2027-10-10');
    await obligation(SOUTH, '2027-10-10');
    // A member of the root unit holds the right to read the north only: the south is under their unit, and is not theirs to see.
    const reply = await mine('', SCOPED);
    expect(items(reply).map((item) => item.id)).toEqual([north]);
    expect(counts(reply)).toMatchObject({ MNE_OBLIGATION: 1, total: 1 });
    expect(JSON.stringify(reply.json)).not.toContain('south');
  });

  it('gives what the person wrote only while they may read the place it is about: a report or an explanation of a project they can no longer read is not theirs to see', async () => {
    const north = await project(NORTH);
    const south = await project(SOUTH);
    // The member of the north may read the south only now: what they authored for the north is out of their sight, what they authored for the south is in it.
    await report(north, await period('2027-10-10T10:00:00Z'), { status: 'RETURNED', by: MOVED });
    const visible = await report(south, await period('2027-10-10T10:00:00Z'), { status: 'RETURNED', by: MOVED });
    await explanation(north, { to: MAKER, by: MOVED, status: 'RESPONDED', due: '2027-10-20T10:00:00Z' });
    const concluded = await explanation(south, { to: OTHER, by: MOVED, status: 'RESPONDED', due: '2027-10-20T10:00:00Z' });
    // What is asked of them by name stays theirs: an explanation addressed to them.
    const owed = await explanation(north, { to: MOVED, by: ASKER, due: '2027-10-20T10:00:00Z' });
    const reply = await mine('', MOVED);
    expect(items(reply).map((item) => [item.kind, item.id]).sort()).toEqual([['EXPLANATION', owed], ['EXPLANATION_REVIEW', concluded], ['REPORT_RETURNED', visible]].sort());
  });

  it('orders the whole list as it is looked at: what is late, then what is near, then the rest, and pages it by cursor with the same order', async () => {
    const p = await project(NORTH);
    const a = await explanation(p, { to: MAKER, due: '2027-10-10T10:00:00Z', status: 'OVERDUE' });
    const b = await explanation(p, { to: MAKER, due: '2027-10-17T10:00:00Z' });
    const c = await approval(MAKER, '2027-10-16T10:00:00Z');
    const d = await explanation(p, { to: MAKER, due: '2027-12-01T10:00:00Z' });
    const all = await mine();
    expect(items(all).map((item) => item.id)).toEqual([a, c, b, d]);
    const first = await mine('?limit=3');
    expect(items(first).map((item) => item.id)).toEqual([a, c, b]);
    const second = await mine(`?limit=3&cursor=${encodeURIComponent(String(first.json.next_cursor))}`);
    expect(items(second).map((item) => item.id)).toEqual([d]);
    expect(second.json.next_cursor).toBeNull();
    // The task the cursor was made of is done meanwhile: the next page goes on all the same.
    await seedReplica([[`update machvon.explanation_request set status = 'CANCELLED' where id = $1`, [b]]]);
    const resumed = await mine(`?limit=3&cursor=${encodeURIComponent(String(first.json.next_cursor))}`);
    expect(resumed.status).toBe(200);
    expect(items(resumed).map((item) => item.id)).toEqual([d]);
    // The counts are of the whole list whatever page is shown.
    expect(counts(first)).toMatchObject({ total: 4, EXPLANATION: 3, APPROVAL: 1, overdue: 1 });
  });

  it('reads nothing of another tenant, and refuses a request that is not well formed (422) and a member who may not read HOME (403)', async () => {
    const p = await project(NORTH);
    await explanation(p, { to: MAKER, due: '2027-10-12T10:00:00Z', status: 'OVERDUE' });
    expect(items(await mine('', B_MEMBER, TENANT_B))).toEqual([]);
    for (const query of ['?limit=0', '?limit=201', '?limit=x', '?cursor=nope', '?cursor=EXPLANATION:00000000-0000-4000-8000-000000000000', `?cursor=${Buffer.from(JSON.stringify(['GUESS', 'x', null])).toString('base64url')}`, `?cursor=${Buffer.from(JSON.stringify(['EXPLANATION', 'x', 'tomorrow'])).toString('base64url')}`]) {
      const reply = await mine(query);
      expect([query, reply.status, reply.json.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
    }
    expect((await mine('', NOBODY)).status).toBe(403);
  });
});
