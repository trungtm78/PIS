import { randomUUID } from 'node:crypto';
import { BiPolicyStore } from '@machvon/db';
import type { Requester, TenantDatabase } from '@machvon/db';
import { BUILDER, BiApp, DATASET, DEPRECATED_DATASET, NOBODY, POLICY_ADMIN, POLICY_SCOPED, QUERIER, SCOPED, TENANT_A, TENANT_B, contextFor, memberId, roleId, unitId } from './bi-app';
import type { Reply } from './bi-app';

jest.setTimeout(120_000);

const app = new BiApp();
const store = new BiPolicyStore();
const ANALYST_ROLE = roleId(3);
const draftBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  dataset_id: DATASET,
  grantee_kind: 'ROLE',
  grantee_ref_id: ANALYST_ROLE,
  row_predicate_ast: { op: 'unit_in_scope' },
  column_masks: { account_no: 'HIDE' },
  ...overrides,
});
const draft = (overrides: Record<string, unknown> = {}, member = POLICY_ADMIN, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/bi/access-policies', { member, body: draftBody(overrides), ...(tenantId === undefined ? {} : { tenantId }) });
const list = (query = '', member = POLICY_ADMIN, tenantId?: string): Promise<Reply> => app.call('GET', `/bi/access-policies${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
const inTenant = <T>(member: number, work: (tx: Parameters<Parameters<TenantDatabase['withTenant']>[1]>[0]) => Promise<T>): Promise<T> =>
  (app.harness.tenants as TenantDatabase).withTenant(contextFor(TENANT_A, memberId(member)), work as never) as Promise<T>;
const analyst = (): Requester => ({ membershipId: memberId(QUERIER), roleIds: [ANALYST_ROLE], unitIds: [unitId(1), unitId(2)] });

describe('the access policies of BI (ST-BI-003, BI BR-BI-05)', () => {
  beforeAll(() => app.start(), 240_000);
  afterAll(() => app.stop(), 60_000);
  beforeEach(() => app.resetPolicies());

  describe('drafting a policy', () => {
    it('AC-ST-BI-003-1: UAT-AC473 drafts a policy that allows nothing until it is activated, with the revision of the dataset and grantee, and lists it', async () => {
      const first = await draft();
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'DRAFT', revision: 1 });
      const second = await draft({ column_masks: { account_no: 'HIDE', beneficiary: 'MASK' } });
      expect(second.json).toMatchObject({ revision: 2 });
      const listed = items(await list(`?dataset_id=${DATASET}`));
      expect(listed.map((item) => [item.revision, item.status, item.grantee_kind, item.hidden_columns])).toEqual([[1, 'DRAFT', 'ROLE', ['account_no']], [2, 'DRAFT', 'ROLE', ['account_no']]]);
      expect(items(await list('?status=ACTIVE'))).toEqual([]);
      // A draft opens nothing: the analyst is still refused.
      await expect(inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, analyst()))).rejects.toMatchObject({ code: 'ACCESS_POLICY_MISSING', status: 403 });
    });

    it('drafts for a unit tree and for one membership too, and refuses a grantee that is not in the tenant', async () => {
      expect((await draft({ grantee_kind: 'UNIT_TREE', grantee_ref_id: unitId(2) })).status).toBe(200);
      expect((await draft({ grantee_kind: 'MEMBERSHIP', grantee_ref_id: memberId(QUERIER) })).status).toBe(200);
      for (const [kind, ref] of [['ROLE', randomUUID()], ['UNIT_TREE', randomUUID()], ['MEMBERSHIP', randomUUID()], ['ROLE', unitId(2)]] as const) {
        const refused = await draft({ grantee_kind: kind, grantee_ref_id: ref });
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'grantee_ref_id']);
      }
    });

    it('AC-ST-BI-003-2: UAT-AC476 refuses a predicate outside the grammar (PREDICATE_NOT_ALLOWED), a field the dataset does not offer (DIMENSION_NOT_IN_DATASET), bad masks and a dataset that is not open', async () => {
      const sql = await draft({ row_predicate_ast: { op: 'raw_sql', sql: 'select * from payment_request' } });
      expect([sql.status, sql.json.code]).toEqual([422, 'PREDICATE_NOT_ALLOWED']);
      const foreign = await draft({ row_predicate_ast: { op: 'eq', field: 'contractor_tax_id', value: 'x' } });
      expect([foreign.status, foreign.json.code, foreign.json.detail]).toEqual([422, 'DIMENSION_NOT_IN_DATASET', 'contractor_tax_id']);
      const mask = await draft({ column_masks: { account_no: 'SHOW' } });
      expect([mask.status, mask.json.code, mask.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'column_masks.account_no']);
      for (const dataset of [randomUUID(), DEPRECATED_DATASET]) {
        const closed = await draft({ dataset_id: dataset });
        expect([closed.status, closed.json.code, closed.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'dataset_id']);
      }
      expect((await draft({ unknown_field: 1 })).status).toBe(400);
      expect(items(await list())).toEqual([]);
    });

    it('audits and announces the draft', async () => {
      const made = await draft();
      const id = made.json.resource_id as string;
      const audited = await app.harness.owner<{ action: string }>(TENANT_A, [['select action from machvon.audit_event where resource_id = $1', [id]]]);
      expect(audited.map((row) => row.action)).toEqual(['bi.policy_drafted']);
      const events = await app.harness.owner<{ type: string }>(TENANT_A, [['select type from machvon.outbox_event where aggregate_id = $1', [id]]]);
      expect(events.map((row) => row.type)).toEqual(['bi.policy.drafted.v1']);
    });
  });

  describe('closed by default, and activation by someone else', () => {
    it('AC-ST-BI-003-1: UAT-AC473 refuses (403 ACCESS_POLICY_MISSING, never an empty set) until a policy is active, refuses the author activating it (SELF_APPROVAL_DENIED), and then applies it with account_no hidden', async () => {
      const made = await draft({ row_predicate_ast: { op: 'and', args: [{ op: 'unit_in_scope' }, { op: 'in', field: 'fund', values: ['NSTW'] }] } });
      const id = made.json.resource_id as string;
      await expect(inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, analyst()))).rejects.toMatchObject({ code: 'ACCESS_POLICY_MISSING' });
      await expect(inTenant(POLICY_ADMIN, (tx) => store.activate(tx, id, memberId(POLICY_ADMIN)))).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const active = await inTenant(BUILDER, (tx) => store.activate(tx, id, memberId(BUILDER)));
      expect(active).toMatchObject({ status: 'ACTIVE', approvedBy: memberId(BUILDER) });
      const applicable = await inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, analyst()));
      expect(applicable.map((policy) => [policy.id, policy.columnMasks])).toEqual([[id, { account_no: 'HIDE' }]]);
      expect(applicable[0]?.rowPredicate).toEqual(made.json.row_predicate_ast ?? { op: 'and', args: [{ op: 'unit_in_scope' }, { op: 'in', field: 'fund', values: ['NSTW'] }] });
      // Someone it does not cover is still refused: not by their role, nor by their unit, nor by name.
      await expect(inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, { membershipId: memberId(NOBODY), roleIds: [roleId(1)], unitIds: [unitId(6)] }))).rejects.toMatchObject({ code: 'ACCESS_POLICY_MISSING' });
      // Another dataset is closed to the same person.
      await expect(inTenant(QUERIER, (tx) => store.applicable(tx, DEPRECATED_DATASET, analyst()))).rejects.toMatchObject({ code: 'ACCESS_POLICY_MISSING' });
    });

    it('applies a policy for a unit tree to those in or under the unit, and one for a membership to that person only', async () => {
      const tree = await draft({ grantee_kind: 'UNIT_TREE', grantee_ref_id: unitId(2) });
      const person = await draft({ grantee_kind: 'MEMBERSHIP', grantee_ref_id: memberId(QUERIER), column_masks: {} });
      await inTenant(BUILDER, (tx) => store.activate(tx, tree.json.resource_id as string, memberId(BUILDER)));
      await inTenant(BUILDER, (tx) => store.activate(tx, person.json.resource_id as string, memberId(BUILDER)));
      const byUnit = await inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, { membershipId: memberId(NOBODY), roleIds: [], unitIds: [unitId(1), unitId(2)] }));
      expect(byUnit.map((policy) => policy.granteeKind)).toEqual(['UNIT_TREE']);
      const byName = await inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, { membershipId: memberId(QUERIER), roleIds: [], unitIds: [] }));
      expect(byName.map((policy) => policy.granteeKind)).toEqual(['MEMBERSHIP']);
      await expect(inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, { membershipId: memberId(NOBODY), roleIds: [], unitIds: [unitId(6)] }))).rejects.toMatchObject({ code: 'ACCESS_POLICY_MISSING' });
    });

    it('keeps one active policy for a grantee when two drafts are activated at the same moment', async () => {
      const one = (await draft()).json.resource_id as string;
      const two = (await draft({ column_masks: {} })).json.resource_id as string;
      const results = await Promise.allSettled([
        inTenant(BUILDER, (tx) => store.activate(tx, one, memberId(BUILDER))),
        inTenant(QUERIER, (tx) => store.activate(tx, two, memberId(QUERIER))),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const states = items(await list(`?dataset_id=${DATASET}`)).map((item) => item.status);
      expect(states.filter((state) => state === 'ACTIVE')).toHaveLength(1);
      expect(states.filter((state) => state === 'RETIRED')).toHaveLength(1);
      expect(await inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, analyst()))).toHaveLength(1);
    });

    it('retires the policy a new one replaces, so a grantee has one active policy, and does not activate a policy twice or one that is not there', async () => {
      const one = (await draft()).json.resource_id as string;
      const two = (await draft({ column_masks: {} })).json.resource_id as string;
      await inTenant(BUILDER, (tx) => store.activate(tx, one, memberId(BUILDER)));
      await inTenant(BUILDER, (tx) => store.activate(tx, two, memberId(BUILDER)));
      expect(items(await list(`?dataset_id=${DATASET}`)).map((item) => [item.revision, item.status])).toEqual([[1, 'RETIRED'], [2, 'ACTIVE']]);
      const applicable = await inTenant(QUERIER, (tx) => store.applicable(tx, DATASET, analyst()));
      expect(applicable.map((policy) => policy.id)).toEqual([two]);
      await expect(inTenant(BUILDER, (tx) => store.activate(tx, two, memberId(BUILDER)))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      await expect(inTenant(BUILDER, (tx) => store.activate(tx, randomUUID(), memberId(BUILDER)))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the list, and who may draft and read', () => {
    it('pages the list without repeating or skipping a policy, and refuses a filter or a cursor it does not know', async () => {
      for (let n = 0; n < 3; n += 1) await draft({ column_masks: { [`c${n}`]: 'HIDE' } });
      const seen: number[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await list(`?limit=2${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        seen.push(...items(reply).map((item) => item.revision as number));
        if (reply.json.next_cursor === null) break;
        cursor = reply.json.next_cursor as string;
      }
      expect(seen).toEqual([1, 2, 3]);
      expect((await list('?status=GONE')).status).toBe(422);
      expect((await list('?dataset_id=nope')).status).toBe(422);
      expect((await list(`?cursor=${encodeURIComponent(Buffer.from(JSON.stringify({ code: 'x', id: randomUUID() })).toString('base64url'))}`)).status).toBe(422);
    });

    it('keeps drafting and reading to whoever holds the right over the whole tenant', async () => {
      // The right is held, but over one unit: a policy is the tenant's, so it is not drafted nor read.
      for (const member of [QUERIER, BUILDER, NOBODY, SCOPED, POLICY_SCOPED]) {
        expect((await draft({}, member)).status).toBe(403);
        expect((await list('', member)).status).toBe(403);
      }
      expect(items(await list())).toEqual([]);
    });

    it('keeps each tenant to its own policies', async () => {
      await draft();
      expect((await draft({}, POLICY_ADMIN, TENANT_B)).status).toBe(403);
      expect((await list('', BUILDER, TENANT_B)).status).toBe(403);
    });
  });
});
