import { randomUUID } from 'node:crypto';
import { RetentionReviewStore } from '../src/retention-review-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const store = new RetentionReviewStore();

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(1)), work);

async function item(dueOn: string, tenant = TENANT_A, recordClass = 'project_dossier'): Promise<string> {
  const rows = await harness.owner<{ id: string }>(tenant, [
    [
      `insert into machvon.retention_review_item (tenant_id, id, record_class, resource_type, resource_id, policy_id, basis_date, due_on, end_action)
       values ($1, gen_random_uuid(), $2, 'project', $3, gen_random_uuid(), date '2010-01-01', $4::date, 'ARCHIVE_TRANSFER') returning id`,
      [tenant, recordClass, randomUUID(), dueOn],
    ],
  ]);
  return (rows[0] as { id: string }).id;
}

describe('RetentionReviewStore (the review list of the retention job, ST-ADM-017)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, 1, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('lists the oldest due day first, then by id, and continues after the last row of a page', async () => {
    const late = await item('2031-01-01');
    const early = await item('2029-05-05');
    const same = [await item('2030-02-02'), await item('2030-02-02')].sort();
    const first = await as((tx) => store.list(tx, { limit: 2, after: undefined }));
    expect(first.map((row) => row.id)).toEqual([early, same[0]]);
    const anchor = first[first.length - 1];
    const next = await as((tx) => store.list(tx, { limit: 10, after: { code: (anchor as { dueOn: string }).dueOn, id: (anchor as { id: string }).id } }));
    expect(next.map((row) => row.id)).toEqual([same[1], late]);
    expect(first[0]).toMatchObject({ recordClass: 'project_dossier', resourceType: 'project', basisDate: '2010-01-01', dueOn: '2029-05-05', endAction: 'ARCHIVE_TRANSFER', status: 'PENDING_REVIEW' });
    expect(first[0]?.listedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('finds one item, never one of another tenant, and nothing for an unknown id', async () => {
    const own = await item('2032-03-03');
    const foreign = await item('2032-03-03', TENANT_B);
    expect(await as((tx) => store.find(tx, own))).toMatchObject({ id: own, dueOn: '2032-03-03' });
    expect(await as((tx) => store.find(tx, foreign))).toBeUndefined();
    expect(await as((tx) => store.find(tx, randomUUID()))).toBeUndefined();
    expect((await as((tx) => store.list(tx, { limit: 100, after: undefined }))).map((row) => row.id)).not.toContain(foreign);
  });

  it('refuses a cursor whose day is not a date with 422 VALIDATION_FAILED naming the cursor', async () => {
    await expect(as((tx) => store.list(tx, { limit: 5, after: { code: 'yesterday', id: randomUUID() } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'cursor' });
  });
});
