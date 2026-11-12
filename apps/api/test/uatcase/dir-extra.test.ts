import { addDirectiveDays, vietnamDateOf } from '@machvon/kernel';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';
import { ROOT_UNIT, UatWorld } from '../uat/uat-world';
import { scopedCaller, seedScopedMembers } from './support';

/**
 * Cases of docs/uat/dir/uat.json that the suite `../uat/dir.uat.test.ts` does not script: the closing of a directive by the three kinds of person of the design (the one who recorded it, the executor, a closer), and the
 * reader whose right is on another unit. Each case is named by its id in the title of its test.
 */
jest.setTimeout(240_000);

const FAMILY = 0xd5;
const UNIT = 2; // the unit the directives are given to
const OTHER_UNIT = 3; // the unit of the outside reader
const OUTSIDER = 40;
const TODAY = vietnamDateOf(new Date());
const DAY = (offset: number): string => addDirectiveDays(TODAY, offset);
const PERSONAS = {
  // G: records the meeting and gives the directive, and also holds the right to close.
  secretary: ['directive.meeting.manage', 'directive.manage', 'directive.close', 'directive.read'],
  // X: the executor of the directive, who also holds the right to close.
  executor: ['directive.progress', 'directive.close', 'directive.read'],
  // C: a closer who had no hand in the directive.
  closer: ['directive.close', 'directive.read'],
  reader: ['directive.read'],
};

describe('UAT cases of the directives that the suite of the area does not script (DIR)', () => {
  const world = new UatWorld();
  const outsider = scopedCaller(world);
  const project = id(FAMILY, 1);
  const evidence = id(FAMILY, 10);

  beforeAll(async () => {
    await world.start(PERSONAS, {}, async (w) => {
      await w.harness.seedUnits(TENANT_A, [
        { n: UNIT, path: `/${unitId(ROOT_UNIT)}/${unitId(UNIT)}/`, parent: ROOT_UNIT },
        { n: OTHER_UNIT, path: `/${unitId(ROOT_UNIT)}/${unitId(OTHER_UNIT)}/`, parent: ROOT_UNIT },
      ]);
      await seedScopedMembers(w, [{ n: OUTSIDER, permissions: ['directive.read'], kind: 'UNIT_ONLY', units: [OTHER_UNIT] }]);
      await w.seedAsAdmin([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'UAT-DIR-X1', 'Plant project', $3, $3, $4, 'INTERNAL', 1000000000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(UNIT), id(FAMILY, 2)],
        ],
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Biên bản bàn giao', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(1)]],
        [
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $3, 1, 'tenants/dir/handover-1.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
          [TENANT_A, evidence, id(FAMILY, 11)],
        ],
      ]);
    });
  }, 300_000);

  afterAll(() => world.stop(), 60_000);

  /** D-1: a directive the secretary (G) recorded and gave to the executor (X). */
  async function directiveD1(): Promise<string> {
    const meeting = await world.as('secretary', 'POST', '/steering-meetings', { body: { meeting_date: DAY(-20), meeting_type: 'WEEKLY', title: 'Giao ban tuần', unit_id: unitId(ROOT_UNIT) } });
    assertStatus(meeting, 200);
    const made = await world.as('secretary', 'POST', `/steering-meetings/${String(meeting.json.resource_id)}/directives`, {
      body: { scope_kind: 'PROJECT', project_id: project, text: 'Hoàn thành thủ tục giải phóng mặt bằng.', assignee_unit_id: unitId(UNIT), assignee_membership_id: world.idOf('executor'), due_on: DAY(10) },
    });
    assertStatus(made, 200);
    return made.json.resource_id as string;
  }

  const stored = async (directiveId: string): Promise<{ status: string; version: string; closed_by: string | null }> =>
    (await world.rows<{ status: string; version: string; closed_by: string | null }>('select status, version::text as version, closed_by from machvon.directive where id = $1::uuid', [directiveId]))[0] as { status: string; version: string; closed_by: string | null };
  const items = (reply: Reply): unknown[] => reply.json.items as unknown[];

  it('UAT-PLAN-136 the one who recorded the directive and its executor are refused the closing (403 SELF_APPROVAL_DENIED), a closer with no evidence is refused (422 DIRECTIVE_EVIDENCE_REQUIRED), and with an evidence file the directive is closed with the evidence and the closer in its history', async () => {
    const given = await directiveD1();
    const close = (persona: string, body: Record<string, unknown>, version: number): Promise<Reply> => world.as(persona, 'POST', `/directives/${given}/closure`, { ifMatch: version, body });
    const untouched = await stored(given);
    assertStatus(await close('secretary', { note: 'Đã hoàn thành.', evidence_document_version_ids: [evidence] }, 1), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await close('executor', { note: 'Đã hoàn thành.', evidence_document_version_ids: [evidence] }, 1), 403, 'SELF_APPROVAL_DENIED');
    assertStatus(await close('closer', { note: 'Đã hoàn thành.' }, 1), 422, 'DIRECTIVE_EVIDENCE_REQUIRED');
    // Three refusals wrote nothing: the directive is as it was, with no closing in its audit trail.
    expect(await stored(given)).toEqual(untouched);
    expect(await world.audits(given, 'directive.closed')).toHaveLength(0);
    expect(await world.rows('select 1 from machvon.directive_evidence where directive_id = $1::uuid', [given])).toHaveLength(0);

    const done = await close('closer', { note: 'Đã bàn giao mặt bằng, có biên bản.', evidence_document_version_ids: [evidence] }, 1);
    assertStatus(done, 200);
    expect(done.json).toMatchObject({ status: 'DONE', resource_version: 2 });
    expect(await stored(given)).toMatchObject({ status: 'DONE', closed_by: world.idOf('closer') });
    expect((await world.audits(given, 'directive.closed'))[0]).toMatchObject({ actor_id: world.idOf('closer'), reason: 'Đã bàn giao mặt bằng, có biên bản.' });
    const detail = await world.as('reader', 'GET', `/directives/${given}`);
    assertStatus(detail, 200);
    expect(detail.json.evidence).toMatchObject([{ document_version_id: evidence, title: 'Biên bản bàn giao' }]);
    const closing = (detail.json.timeline as Array<{ type: string; actor: { display_name: string } }>).at(-1);
    expect(closing).toMatchObject({ type: 'CLOSED' });
    expect((await world.rows<{ actor_id: string }>("select actor_id from machvon.directive_event where directive_id = $1::uuid and event_type = 'CLOSED'", [given]))[0]?.actor_id).toBe(world.idOf('closer'));
  });

  it('UAT-DIR-SCP-01 a reader whose right is on another unit sees no directive, a summary of zero and a 404 for the detail of a directive out of reach, while the reader of the whole tenant sees it', async () => {
    const given = await directiveD1();
    // The control: somebody with the right on the whole tenant sees the directive, so an empty answer below is the scope and not the lack of data.
    expect(items(await world.as('reader', 'GET', '/directives?limit=200')).length).toBeGreaterThanOrEqual(1);
    assertStatus(await world.as('reader', 'GET', `/directives/${given}`), 200);

    const listed = await outsider(OUTSIDER, 'GET', '/directives?limit=200');
    assertStatus(listed, 200);
    expect(items(listed)).toEqual([]);
    const summary = await outsider(OUTSIDER, 'GET', '/directives/summary');
    assertStatus(summary, 200);
    expect(summary.json).toMatchObject({ total: 0 });
    expect(Object.values(summary.json.by_status as Record<string, number>).reduce((sum, value) => sum + value, 0)).toBe(0);
    const detail = await outsider(OUTSIDER, 'GET', `/directives/${given}`);
    assertStatus(detail, 404);
    expect(detail.json).not.toHaveProperty('directive');
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 403, 'SELF_APPROVAL_DENIED'));
    expectCheckFails(() => assertStatus({ status: 422, json: { code: 'VALIDATION_FAILED' } }, 422, 'DIRECTIVE_EVIDENCE_REQUIRED'));
  });
});
