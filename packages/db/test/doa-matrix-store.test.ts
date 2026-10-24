import { randomUUID } from 'node:crypto';
import type { DoaQuery, DoaRuleContent } from '@machvon/kernel';
import { DoaMatrixStore } from '../src/doa-matrix-store';
import type { DoaMatrixInput } from '../src/doa-matrix-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId } from './support/authz-fixtures';

const AUTHOR = memberId(1);
const EDITOR = memberId(2);
const APPROVER = memberId(3);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;
const PROVINCE = unitId(1);
const DEPARTMENT = unitId(2);
const BOARD = unitId(3);
const OTHER_BRANCH = unitId(4);
const LEADER_BQLGT = roleId(1);
const LEADER_STC = roleId(2);
const LEADER_UBND = roleId(3);
const BOARD_HEAD = roleId(4);

const band = (min: string, max: string | null, role: string, extra: Partial<DoaRuleContent> = {}): DoaRuleContent => ({
  document_type: 'FX',
  unit_id: PROVINCE,
  amount_min_vnd: min,
  amount_max_vnd: max,
  approver_role_id: role,
  ...extra,
});
/** Three bands for FX at the province: the thresholds of the acceptance example. */
const THREE_BANDS: DoaRuleContent[] = [
  band('0', '5000000000', LEADER_BQLGT),
  band('5000000000', '25000000000', LEADER_STC),
  band('25000000000', null, LEADER_UBND, { approval_levels: 2 }),
];
const matrix = (rules: DoaRuleContent[] = THREE_BANDS, extra: Partial<DoaMatrixInput> = {}): DoaMatrixInput => ({
  effective_from: '2026-01-01',
  legal_basis_ref: 'Internal regulation 12/QD-2026',
  rules,
  ...extra,
});

describe('DoaMatrixStore (ST-ADM-011)', () => {
  const harness = new AuthzHarness();
  const store = new DoaMatrixStore();
  const asA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, AUTHOR), work);
  const asB = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_B, AUTHOR), work);

  const draft = (input: DoaMatrixInput = matrix()): Promise<{ id: string; revision: number; version: number }> => asA((tx) => store.createDraft(tx, input, AUTHOR));
  const submit = (id: string, version = 1, editor = AUTHOR): Promise<{ version: number }> => asA((tx) => store.submit(tx, id, version, editor));
  const decide = (id: string, decision: 'approve' | 'return' | 'reject', version = 2, by = APPROVER) => asA((tx) => store.decide(tx, id, version, decision, by));
  /** A matrix that is in force from the day given. */
  async function inForce(effectiveFrom: string, rules: DoaRuleContent[] = THREE_BANDS, extra: Partial<DoaMatrixInput> = {}): Promise<string> {
    const { id } = await draft(matrix(rules, { effective_from: effectiveFrom, ...extra }));
    await submit(id);
    await decide(id, 'approve');
    return id;
  }
  const resolve = (query: Partial<DoaQuery> & { amountVnd: string | null }) =>
    asA((tx) => store.resolve(tx, { documentType: 'FX', unitId: DEPARTMENT, businessDate: '2026-03-01', ...query }));
  const count = async (sql: string): Promise<number> => Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, []]]))[0]?.n);
  const refusal = async (work: Promise<unknown>) => work.then(() => undefined, (error: { code: string; status: number; detail?: string; extensions?: { errors?: Array<{ field: string; code: string }> } }) => error);
  const findingsOf = (error: { extensions?: { errors?: Array<{ field: string; code: string }> } } | undefined): string[] => (error?.extensions?.errors ?? []).map((entry) => `${entry.field}:${entry.code}`);

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
      { n: 3, path: path(1, 2, 3), parent: 2 },
      { n: 4, path: path(1, 4), parent: 1 },
    ]);
    await harness.seedUnits(TENANT_B, [{ n: 11, path: path(11) }]);
    for (const n of [1, 2, 3]) await harness.seedMembership(TENANT_A, n, 1);
    for (const [n, code] of [[1, 'LEADER_BQLGT'], [2, 'LEADER_STC'], [3, 'LEADER_UBND'], [4, 'BOARD_HEAD']] as const) await harness.seedRole(TENANT_A, n, code, [], 60);
    await harness.seedRole(TENANT_B, 11, 'LEADER_B', [], 60);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    // A matrix is kept for good, so the tests clear it as the owner of the database, with the guard that protects rules lifted for the clean-up only.
    await harness.owner(TENANT_A, [
      ['alter table machvon.doa_rule disable trigger doa_rule_guard', []],
      ['delete from machvon.doa_rule', []],
      ['alter table machvon.doa_rule enable trigger doa_rule_guard', []],
      ['delete from machvon.doa_matrix_version', []],
    ]);
    await harness.owner(TENANT_B, [
      ['alter table machvon.doa_rule disable trigger doa_rule_guard', []],
      ['delete from machvon.doa_rule', []],
      ['alter table machvon.doa_rule enable trigger doa_rule_guard', []],
      ['delete from machvon.doa_matrix_version', []],
    ]);
  });

  describe('createDraft', () => {
    it('numbers the drafts 1, 2, 3 without gaps, even when created in parallel', async () => {
      const created = await Promise.all([draft(), draft(), draft()]);
      expect(created.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
      expect((await draft()).revision).toBe(4);
    });

    it('stores a Draft at version 1 with its rules, the defaults of the optional fields and the author as last editor', async () => {
      const { id } = await draft();
      const row = await asA((tx) => store.find(tx, id));
      expect(row).toMatchObject({ status: 'Draft', version: 1, revision: 1, effectiveFrom: '2026-01-01', effectiveUntil: null, legalBasis: 'Internal regulation 12/QD-2026', createdBy: AUTHOR, lastEditedBy: AUTHOR, approvedBy: null, publishedAt: null });
      expect(row?.rules.map((rule) => [rule.amount_min_vnd, rule.amount_max_vnd, rule.approver_role_id, rule.approval_levels, rule.include_subtree, rule.requires_distinct_approvers])).toEqual([
        ['0', '5000000000', LEADER_BQLGT, 1, true, true],
        ['5000000000', '25000000000', LEADER_STC, 1, true, true],
        ['25000000000', null, LEADER_UBND, 2, true, true],
      ]);
    });

    it('keeps amounts of 24 digits exactly', async () => {
      const huge = '999999999999999999999999';
      const { id } = await draft(matrix([band('0', huge, LEADER_BQLGT), band(huge, null, LEADER_UBND)]));
      expect((await asA((tx) => store.find(tx, id)))?.rules.map((rule) => rule.amount_min_vnd)).toEqual(['0', huge]);
    });

    it('allows a gap in a draft (the editor shows it) and refuses an overlap, naming the position', async () => {
      expect((await draft(matrix([band('0', '5', LEADER_BQLGT), band('9', null, LEADER_UBND)]))).revision).toBe(1);
      const overlap = await refusal(draft(matrix([band('0', '9', LEADER_BQLGT), band('5', null, LEADER_UBND)])));
      expect(overlap).toMatchObject({ code: 'DOA_MATRIX_INVALID', status: 422, detail: 'rules[1].amount_min_vnd' });
      expect(findingsOf(overlap)).toEqual(['rules[1].amount_min_vnd:OVERLAP']);
      expect(await count('select count(*) as n from machvon.doa_matrix_version')).toBe(1);
    });

    it('refuses dates that do not make sense', async () => {
      expect(findingsOf(await refusal(draft(matrix(THREE_BANDS, { effective_until: '2026-01-01' }))))).toEqual(['effective_until:RANGE_INVALID']);
      expect(findingsOf(await refusal(draft(matrix(THREE_BANDS, { effective_from: '2026-02-30' }))))).toEqual(['effective_from:DATE_INVALID']);
      expect(await count('select count(*) as n from machvon.doa_matrix_version')).toBe(0);
    });

    it('refuses a unit or a role the tenant does not have, or no longer has, or that belongs to another tenant', async () => {
      await harness.seedRole(TENANT_A, 9, 'RETIRED_ROLE', [], 10);
      await harness.owner(TENANT_A, [["update machvon.role_definition set status = 'Retired' where code = 'RETIRED_ROLE'", []]]);
      await harness.owner(TENANT_A, [["update machvon.organization_unit set status = 'Dissolved' where id = $1", [unitId(4)]]]);
      try {
        const failure = await refusal(
          draft(matrix([band('0', '5', roleId(9), { unit_id: OTHER_BRANCH }), band('5', null, roleId(11)), band('0', null, LEADER_UBND, { unit_id: unitId(11) }), band('0', null, randomUUID(), { document_type: 'PAY' })])),
        );
        expect(failure).toMatchObject({ code: 'DOA_MATRIX_INVALID', status: 422 });
        expect(findingsOf(failure)).toEqual([
          'rules[0].unit_id:UNIT_UNKNOWN',
          'rules[0].approver_role_id:ROLE_UNKNOWN',
          'rules[1].approver_role_id:ROLE_UNKNOWN',
          'rules[2].unit_id:UNIT_UNKNOWN',
          'rules[3].approver_role_id:ROLE_UNKNOWN',
        ]);
        expect(await count('select count(*) as n from machvon.doa_matrix_version')).toBe(0);
      } finally {
        await harness.owner(TENANT_A, [["update machvon.organization_unit set status = 'Active' where id = $1", [unitId(4)]]]);
      }
    });
  });

  describe('updateDraft', () => {
    it('replaces the whole draft: dates, legal basis and rules, one version up, the editor recorded', async () => {
      const { id } = await draft();
      const updated = await asA((tx) => store.updateDraft(tx, id, 1, matrix([band('0', null, LEADER_STC)], { effective_from: '2026-02-01', effective_until: '2027-02-01', legal_basis_ref: 'Amended regulation' }), EDITOR));
      expect(updated.version).toBe(2);
      expect(await asA((tx) => store.find(tx, id))).toMatchObject({
        status: 'Draft',
        version: 2,
        effectiveFrom: '2026-02-01',
        effectiveUntil: '2027-02-01',
        legalBasis: 'Amended regulation',
        createdBy: AUTHOR,
        lastEditedBy: EDITOR,
        rules: [expect.objectContaining({ amount_min_vnd: '0', amount_max_vnd: null, approver_role_id: LEADER_STC })],
      });
    });

    it('answers 404 for an unknown draft, 409 VERSION_CONFLICT for a stale version, and 409 DOA_MATRIX_NOT_DRAFT for one that was submitted', async () => {
      const { id } = await draft();
      expect(await refusal(asA((tx) => store.updateDraft(tx, randomUUID(), 1, matrix(), EDITOR)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(asA((tx) => store.updateDraft(tx, id, 7, matrix(), EDITOR)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await submit(id);
      expect(await refusal(asA((tx) => store.updateDraft(tx, id, 2, matrix(), EDITOR)))).toMatchObject({ code: 'DOA_MATRIX_NOT_DRAFT', status: 409 });
    });

    it('keeps the draft as it was when the new rules are refused', async () => {
      const { id } = await draft();
      const failure = await refusal(asA((tx) => store.updateDraft(tx, id, 1, matrix([band('0', '9', LEADER_BQLGT), band('5', null, LEADER_UBND)]), EDITOR)));
      expect(failure).toMatchObject({ code: 'DOA_MATRIX_INVALID' });
      const row = await asA((tx) => store.find(tx, id));
      expect(row).toMatchObject({ version: 1, lastEditedBy: AUTHOR });
      expect(row?.rules).toHaveLength(3);
    });
  });

  describe('submit (BR-ADM-04)', () => {
    it('refuses a gap, a start above 0 and an end below no end, each naming the field, and leaves the draft', async () => {
      const gap = await draft(matrix([band('0', '5', LEADER_BQLGT), band('9', null, LEADER_UBND)]));
      expect(findingsOf(await refusal(submit(gap.id)))).toEqual(['rules[1].amount_min_vnd:GAP']);
      const notZero = await draft(matrix([band('1', null, LEADER_BQLGT)]));
      expect(findingsOf(await refusal(submit(notZero.id)))).toEqual(['rules[0].amount_min_vnd:NOT_FROM_ZERO']);
      const notInfinite = await draft(matrix([band('0', '5', LEADER_BQLGT)]));
      expect(findingsOf(await refusal(submit(notInfinite.id)))).toEqual(['rules[0].amount_max_vnd:NOT_TO_INFINITY']);
      for (const { id } of [gap, notZero, notInfinite]) expect((await asA((tx) => store.find(tx, id)))?.status).toBe('Draft');
    });

    it('moves a complete draft to PendingApproval, one version up, with the submitter as last editor, and not twice', async () => {
      const { id } = await draft();
      expect((await submit(id, 1, EDITOR)).version).toBe(2);
      expect(await asA((tx) => store.find(tx, id))).toMatchObject({ status: 'PendingApproval', version: 2, lastEditedBy: EDITOR });
      expect(await refusal(submit(id, 2))).toMatchObject({ code: 'DOA_MATRIX_NOT_DRAFT', status: 409 });
    });

    it('answers 404 for an unknown version and 409 VERSION_CONFLICT for a stale one', async () => {
      expect(await refusal(submit(randomUUID()))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const { id } = await draft();
      expect(await refusal(submit(id, 5))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    });

    it('checks the units and roles again: a role retired since the draft was written stops the submission', async () => {
      const { id } = await draft();
      await harness.owner(TENANT_A, [["update machvon.role_definition set status = 'Retired' where id = $1", [LEADER_STC]]]);
      try {
        expect(findingsOf(await refusal(submit(id)))).toEqual(['rules[1].approver_role_id:ROLE_UNKNOWN']);
      } finally {
        await harness.owner(TENANT_A, [["update machvon.role_definition set status = 'Active' where id = $1", [LEADER_STC]]]);
      }
    });
  });

  describe('decide', () => {
    async function pending(extra: Partial<DoaMatrixInput> = {}, rules: DoaRuleContent[] = THREE_BANDS): Promise<string> {
      const { id } = await draft(matrix(rules, extra));
      await submit(id);
      return id;
    }

    it('refuses the author and whoever last edited the draft with 403 SELF_APPROVAL_DENIED, then lets a third person approve', async () => {
      const { id } = await draft();
      await submit(id, 1, EDITOR);
      expect(await refusal(decide(id, 'approve', 2, AUTHOR))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(decide(id, 'approve', 2, EDITOR))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await asA((tx) => store.find(tx, id)))?.status).toBe('PendingApproval');
      const done = await decide(id, 'approve', 2, APPROVER);
      expect(done).toMatchObject({ status: 'PUBLISHED', version: 3, supersededId: undefined });
      const row = await asA((tx) => store.find(tx, id));
      expect(row).toMatchObject({ status: 'Published', approvedBy: APPROVER, version: 3 });
      expect(row?.publishedAt).not.toBeNull();
    });

    it('lets the author approve nothing even when nobody else touched the draft', async () => {
      const id = await pending();
      expect(await refusal(decide(id, 'approve', 2, AUTHOR))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    });

    it('supersedes the matrix in force on the first day of the new one, so only one is Published and no day is lost', async () => {
      const first = await inForce('2026-01-01');
      const second = await pending({ effective_from: '2026-07-01' }, [band('0', null, LEADER_UBND)]);
      const done = await decide(second, 'approve');
      expect(done.supersededId).toBe(first);
      expect(await asA((tx) => store.find(tx, first))).toMatchObject({ status: 'Superseded', effectiveUntil: '2026-07-01' });
      expect(await count("select count(*) as n from machvon.doa_matrix_version where status = 'Published'")).toBe(1);
      expect((await resolve({ amountVnd: '1', businessDate: '2026-06-30' })).approverRoleId).toBe(LEADER_BQLGT);
      expect((await resolve({ amountVnd: '1', businessDate: '2026-07-01' })).approverRoleId).toBe(LEADER_UBND);
    });

    it('keeps an earlier end date of the matrix it replaces', async () => {
      const first = await inForce('2026-01-01', THREE_BANDS, { effective_until: '2026-03-01' });
      await inForce('2026-07-01', [band('0', null, LEADER_UBND)]);
      expect(await asA((tx) => store.find(tx, first))).toMatchObject({ status: 'Superseded', effectiveUntil: '2026-03-01' });
      await expect(resolve({ amountVnd: '1', businessDate: '2026-05-01' })).rejects.toMatchObject({ code: 'DOA_RULE_NOT_FOUND' });
    });

    it('refuses a version that does not start after the one in force with 422 NOT_AFTER_CURRENT, and leaves both', async () => {
      const current = await inForce('2026-06-01');
      for (const from of ['2026-06-01', '2026-01-01']) {
        const id = await pending({ effective_from: from });
        const failure = await refusal(decide(id, 'approve'));
        expect(findingsOf(failure)).toEqual(['effective_from:NOT_AFTER_CURRENT']);
        expect((await asA((tx) => store.find(tx, id)))?.status).toBe('PendingApproval');
      }
      expect((await asA((tx) => store.find(tx, current)))?.status).toBe('Published');
    });

    it('checks the units and roles again when it takes effect', async () => {
      const id = await pending();
      await harness.owner(TENANT_A, [["update machvon.role_definition set status = 'Retired' where id = $1", [LEADER_UBND]]]);
      try {
        expect(findingsOf(await refusal(decide(id, 'approve')))).toEqual(['rules[2].approver_role_id:ROLE_UNKNOWN']);
        expect((await asA((tx) => store.find(tx, id)))?.status).toBe('PendingApproval');
      } finally {
        await harness.owner(TENANT_A, [["update machvon.role_definition set status = 'Active' where id = $1", [LEADER_UBND]]]);
      }
    });

    it('sends a version back to Draft on return, where it can be edited and submitted again, and ends it on reject', async () => {
      const id = await pending();
      expect(await decide(id, 'return')).toMatchObject({ status: 'RETURNED', version: 3 });
      expect(await asA((tx) => store.find(tx, id))).toMatchObject({ status: 'Draft', approvedBy: null });
      await asA((tx) => store.updateDraft(tx, id, 3, matrix([band('0', null, LEADER_STC)]), EDITOR));
      await submit(id, 4, EDITOR);
      expect(await decide(id, 'reject', 5)).toMatchObject({ status: 'REJECTED', version: 6 });
      expect(await asA((tx) => store.find(tx, id))).toMatchObject({ status: 'Rejected', approvedBy: null });
      expect(await refusal(decide(id, 'approve', 6))).toMatchObject({ code: 'DOA_STATE_INVALID', status: 409 });
    });

    it('answers 409 DOA_STATE_INVALID for a version that is not waiting, 409 VERSION_CONFLICT for a stale one and 404 for an unknown one', async () => {
      const { id } = await draft();
      expect(await refusal(decide(id, 'approve', 1))).toMatchObject({ code: 'DOA_STATE_INVALID', status: 409 });
      await submit(id);
      expect(await refusal(decide(id, 'approve', 9))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(decide(randomUUID(), 'approve', 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('serialises two approvals at the same time: both succeed, the later start supersedes and exactly one version stays Published', async () => {
      const first = await pending({ effective_from: '2026-03-01' });
      const second = await pending({ effective_from: '2026-09-01' }, [band('0', null, LEADER_UBND)]);
      const results = await Promise.allSettled([decide(first, 'approve'), decide(second, 'approve')]);
      const refused = results.filter((result) => result.status === 'rejected');
      expect(await count("select count(*) as n from machvon.doa_matrix_version where status = 'Published'")).toBe(1);
      // Whichever ran first published; the other either superseded it or, when it started earlier, was refused as not after the current.
      if (refused.length === 0) expect((await asA((tx) => store.find(tx, second)))?.status).toBe('Published');
      else expect(findingsOf((refused[0] as PromiseRejectedResult).reason)).toEqual(['effective_from:NOT_AFTER_CURRENT']);
    });
  });

  describe('resolve (BR-ADM-03, AC-ST-ADM-011-1)', () => {
    it('gives the approver of each band at its edges: 4,999,999,999, 5,000,000,000 and 25,000,000,000 VND, the last needing 2 distinct levels', async () => {
      const id = await inForce('2026-01-01');
      expect(await resolve({ amountVnd: '4999999999' })).toMatchObject({ matrixVersionId: id, approverRoleId: LEADER_BQLGT, approvalLevels: 1 });
      expect(await resolve({ amountVnd: '5000000000' })).toMatchObject({ matrixVersionId: id, approverRoleId: LEADER_STC, approvalLevels: 1 });
      expect(await resolve({ amountVnd: '25000000000' })).toMatchObject({ matrixVersionId: id, approverRoleId: LEADER_UBND, approvalLevels: 2, requiresDistinctApprovers: true });
    });

    it('takes the rule of the nearest unit, a rule without its subtree reaches only its own unit, and a unit in another branch falls back to the province', async () => {
      await inForce('2026-01-01', [...THREE_BANDS, band('0', null, BOARD_HEAD, { unit_id: DEPARTMENT, include_subtree: false })]);
      expect((await resolve({ amountVnd: '30000000000', unitId: DEPARTMENT })).approverRoleId).toBe(BOARD_HEAD);
      expect((await resolve({ amountVnd: '30000000000', unitId: BOARD })).approverRoleId).toBe(LEADER_UBND);
      expect((await resolve({ amountVnd: '30000000000', unitId: OTHER_BRANCH })).approverRoleId).toBe(LEADER_UBND);
    });

    it('judges a document without an amount as 0 and a day by the matrix that covered it', async () => {
      await inForce('2026-01-01');
      expect((await resolve({ amountVnd: null })).approverRoleId).toBe(LEADER_BQLGT);
      await inForce('2027-01-01', [band('0', null, LEADER_STC)]);
      expect((await resolve({ amountVnd: '30000000000', businessDate: '2026-12-31' })).approverRoleId).toBe(LEADER_UBND);
      expect((await resolve({ amountVnd: '30000000000', businessDate: '2027-01-01' })).approverRoleId).toBe(LEADER_STC);
    });

    it('does not count a draft, a pending version or a rejected one, and finds nothing before any matrix: 422 DOA_RULE_NOT_FOUND', async () => {
      await draft();
      await leaveVersionsThatDoNotCount();
      await expect(resolve({ amountVnd: '1' })).rejects.toMatchObject({ code: 'DOA_RULE_NOT_FOUND', status: 422 });
      await inForce('2026-06-01');
      await expect(resolve({ amountVnd: '1', businessDate: '2026-05-31' })).rejects.toMatchObject({ code: 'DOA_RULE_NOT_FOUND' });
      await expect(resolve({ amountVnd: '1', documentType: 'NO_SUCH_TYPE', businessDate: '2026-07-01' })).rejects.toMatchObject({ code: 'DOA_RULE_NOT_FOUND' });
    });

    it('refuses an amount that is not whole VND and a unit that is not in the tenant', async () => {
      await inForce('2026-01-01');
      await expect(resolve({ amountVnd: '12.5' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      await expect(resolve({ amountVnd: '1', unitId: unitId(11) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'unit_id' });
    });

    async function leaveVersionsThatDoNotCount(): Promise<void> {
      const { id } = await draft();
      await submit(id);
      const rejected = await draft();
      await submit(rejected.id);
      await decide(rejected.id, 'reject');
    }
  });

  describe('list', () => {
    it('gives the versions newest revision first with their rules in the order they were written, and pages by revision', async () => {
      const ids: string[] = [];
      for (let n = 0; n < 3; n += 1) ids.push((await draft(matrix([band('5', null, LEADER_STC), band('0', '5', LEADER_BQLGT)]))).id);
      const first = await asA((tx) => store.list(tx, { limit: 2, after: undefined }));
      expect(first.map((row) => row.id)).toEqual([ids[2], ids[1]]);
      expect(first[0]?.rules.map((rule) => rule.amount_min_vnd)).toEqual(['5', '0']);
      const last = first[1] as { revision: number; id: string };
      const rest = await asA((tx) => store.list(tx, { limit: 2, after: { code: String(last.revision), id: last.id } }));
      expect(rest.map((row) => row.id)).toEqual([ids[0]]);
      await expect(asA((tx) => store.list(tx, { limit: 2, after: { code: 'x', id: randomUUID() } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cursor' });
      expect(await asB((tx) => store.list(tx, { limit: 10, after: undefined }))).toEqual([]);
    });
  });

  it('keeps tenants apart', async () => {
    const { id } = await draft();
    expect(await asB((tx) => store.find(tx, id))).toBeUndefined();
    expect(await refusal(asB((tx) => store.submit(tx, id, 1, AUTHOR)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await refusal(asB((tx) => store.updateDraft(tx, id, 1, matrix([band('0', null, roleId(11), { unit_id: unitId(11) })]), AUTHOR)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await asB((tx) => store.createDraft(tx, matrix([band('0', null, roleId(11), { unit_id: unitId(11) })]), AUTHOR))).revision).toBe(1);
    await expect(asB((tx) => store.resolve(tx, { documentType: 'FX', amountVnd: '1', unitId: unitId(11), businessDate: '2026-03-01' }))).rejects.toMatchObject({ code: 'DOA_RULE_NOT_FOUND' });
  });

  describe('database guards', () => {
    const owner = (sql: string, params: unknown[] = []) => harness.owner(TENANT_A, [[sql, params]]);

    it('keeps a version that left the draft state immutable: dates, legal basis, revision and author, even for the owner role', async () => {
      const id = await inForce('2026-01-01');
      for (const [sql, params] of [
        ["update machvon.doa_matrix_version set effective_from = '2026-02-01' where id = $1", [id]],
        ["update machvon.doa_matrix_version set legal_basis_ref = 'changed' where id = $1", [id]],
        ["update machvon.doa_matrix_version set effective_until = '2030-01-01' where id = $1", [id]],
        ['update machvon.doa_matrix_version set revision = revision + 10 where id = $1', [id]],
        ['update machvon.doa_matrix_version set created_by = $2 where id = $1', [id, APPROVER]],
        ['update machvon.doa_matrix_version set approved_by = $2 where id = $1', [id, EDITOR]],
        ["update machvon.doa_matrix_version set published_at = now() - interval '1 day' where id = $1", [id]],
      ] as Array<[string, unknown[]]>) {
        await expect(owner(sql, params)).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('allows only the transitions of the state machine, and nothing out of Rejected or Superseded', async () => {
      const { id } = await draft();
      await expect(owner("update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [id, APPROVER])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.doa_matrix_version set status = 'Superseded' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await submit(id);
      await expect(owner("update machvon.doa_matrix_version set status = 'Superseded' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await decide(id, 'reject');
      await expect(owner("update machvon.doa_matrix_version set status = 'Draft' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      const published = await inForce('2026-01-01');
      await expect(owner("update machvon.doa_matrix_version set status = 'Draft' where id = $1", [published])).rejects.toMatchObject({ code: '23514' });
      await owner("update machvon.doa_matrix_version set status = 'Superseded', effective_until = '2026-06-01' where id = $1", [published]);
      await expect(owner("update machvon.doa_matrix_version set status = 'Published' where id = $1", [published])).rejects.toMatchObject({ code: '23514' });
    });

    it('does not let the author or the last editor be the approver, even when the application check is bypassed', async () => {
      const { id } = await draft();
      await submit(id, 1, EDITOR);
      await expect(owner("update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [id, AUTHOR])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [id, EDITOR])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.doa_matrix_version set status = 'Published', published_at = now() where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a second Published version in a tenant', async () => {
      await inForce('2026-01-01');
      const { id } = await draft(matrix(THREE_BANDS, { effective_from: '2027-01-01' }));
      await submit(id);
      await expect(owner("update machvon.doa_matrix_version set status = 'Published', approved_by = $2, published_at = now() where id = $1", [id, APPROVER])).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses overlapping bands of one document type and unit in a version, and lets the same bands stand in different units', async () => {
      const { id } = await draft(matrix([band('0', '5', LEADER_BQLGT)]));
      const insert = (unit: string, min: string): Promise<unknown> =>
        owner(
          `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id)
           values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1, 'FX', $2, $3, null, $4)`,
          [id, unit, min, LEADER_STC],
        );
      await expect(insert(PROVINCE, '3')).rejects.toMatchObject({ code: '23P01' });
      await insert(DEPARTMENT, '3');
    });

    it('changes the rules of a version only while it is a draft', async () => {
      const { id } = await draft();
      const ruleId = (await owner('select id from machvon.doa_rule where matrix_version_id = $1 limit 1', [id]))[0] as { id: string };
      await submit(id);
      for (const [sql, params] of [
        ['update machvon.doa_rule set approval_levels = 3 where id = $1', [ruleId.id]],
        ['delete from machvon.doa_rule where id = $1', [ruleId.id]],
        [
          `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id)
           values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1, 'PAY', $2, 0, null, $3)`,
          [id, DEPARTMENT, LEADER_STC],
        ],
      ] as Array<[string, unknown[]]>) {
        await expect(owner(sql, params)).rejects.toMatchObject({ code: '23514' });
      }
      await expect(
        owner(
          `insert into machvon.doa_rule (tenant_id, id, matrix_version_id, document_type, unit_id, amount_min_vnd, amount_max_vnd, approver_role_id)
           values (current_setting('app.tenant_id')::uuid, gen_random_uuid(), $1, 'PAY', $2, 0, null, $3)`,
          [randomUUID(), DEPARTMENT, LEADER_STC],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('moves a rule only within drafts', async () => {
      const first = await draft();
      const second = await draft();
      await submit(second.id);
      const ruleId = (await owner('select id from machvon.doa_rule where matrix_version_id = $1 limit 1', [first.id]))[0] as { id: string };
      await expect(owner('update machvon.doa_rule set matrix_version_id = $2 where id = $1', [ruleId.id, second.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('does not let the application role delete a version', async () => {
      const { id } = await draft();
      await expect(asA((tx) => tx.query('delete from machvon.doa_matrix_version where id = $1::uuid', [id]))).rejects.toMatchObject({ code: '42501' });
    });
  });
});
