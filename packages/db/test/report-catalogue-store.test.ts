import { vietnamDateOf } from '@machvon/kernel';
import { MasterStore } from '../src/master-store';
import type { MasterContent } from '../src/master-store';
import { ReportCatalogueStore } from '../src/report-catalogue-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const masters = new MasterStore();
const catalogue = new ReportCatalogueStore();
const STEWARD = 1;
const CHECKER = 2;
const PUBLISHER = 3;
const TODAY = vietnamDateOf(new Date());
const DECISION_DOCUMENT = id(0x70, 1);

const as = <T>(member: number, work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

const content = (attributes: Record<string, unknown>, label: string, validFrom = '2024-01-01'): MasterContent => ({ label, attributes, parentRecordId: null, validFrom, validUntil: null, legalBasis: null });

/** An entry that is in force: proposed, approved by a second person, published by a third. */
async function inForce(masterType: string, key: string, attributes: Record<string, unknown>, label: string, tenant = TENANT_A): Promise<void> {
  const created = await as(STEWARD, (tx) => masters.propose(tx, { masterType, businessKey: key, content: content(attributes, label), reason: 'Entry of the report catalogue' }, memberId(STEWARD)), tenant);
  const submitted = await as(STEWARD, (tx) => masters.submit(tx, created.changeRequestId, 1, memberId(STEWARD)), tenant);
  await as(CHECKER, (tx) => masters.decide(tx, created.changeRequestId, submitted.version, 'approve', memberId(CHECKER)), tenant);
  const record = await as(PUBLISHER, (tx) => masters.findRecord(tx, created.recordId), tenant);
  await as(PUBLISHER, (tx) => masters.publish(tx, created.recordId, record?.version ?? 0, DECISION_DOCUMENT, memberId(PUBLISHER)), tenant);
}

describe('the report catalogue of a tenant (MD.03)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const n of [STEWARD, CHECKER, PUBLISHER]) await harness.seedMembership(tenant, n, 1);
      await harness.owner(tenant, [
        [
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`,
          [tenant, DECISION_DOCUMENT, memberId(STEWARD)],
        ],
      ]);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('is empty for a tenant that keeps nothing, and reads the entries in force with their attributes and labels', async () => {
    expect(await as(STEWARD, (tx) => catalogue.read(tx, TODAY))).toEqual({ periodKinds: [], reportTypes: [], agencies: [] });

    await inForce('REPORTING_PERIOD_KIND', 'MONTH', { grain: 'MONTH', months: 1, entry_deadline_working_days: 5 }, 'Thang');
    await inForce('REPORT_TYPE', 'PVN_MONTHLY', { period_kind_key: 'MONTH', audience: 'PARENT_GROUP', form_code: 'PVN-MONTHLY' }, 'Bao cao thang PVN');
    await inForce('RECEIVING_AGENCY', 'PVN', { agency_kind: 'PARENT_GROUP', channel: 'FILE', report_type_keys: ['PVN_MONTHLY'], receiver_code: 'PVN' }, 'Tap doan');

    const read = await as(STEWARD, (tx) => catalogue.read(tx, TODAY));
    expect(read.periodKinds.map((one) => one.key)).toEqual(['MONTH']);
    expect(read.reportTypes).toEqual([{ key: 'PVN_MONTHLY', label: 'Bao cao thang PVN', attributes: { period_kind_key: 'MONTH', audience: 'PARENT_GROUP', form_code: 'PVN-MONTHLY' } }]);
    expect(read.agencies).toEqual([{ key: 'PVN', label: 'Tap doan', attributes: { agency_kind: 'PARENT_GROUP', channel: 'FILE', report_type_keys: ['PVN_MONTHLY'], receiver_code: 'PVN' } }]);
  });

  it('does not count a proposal that has not been published, nor an entry that is not yet in force on the day', async () => {
    await as(STEWARD, (tx) => masters.propose(tx, { masterType: 'RECEIVING_AGENCY', businessKey: 'DRAFT_ONLY', content: content({ agency_kind: 'COMMITTEE', channel: 'FILE' }, 'Draft'), reason: 'Entry of the report catalogue' }, memberId(STEWARD)));
    const before = await as(STEWARD, (tx) => catalogue.read(tx, '2020-01-01'));
    expect(before).toEqual({ periodKinds: [], reportTypes: [], agencies: [] });
    const now = await as(STEWARD, (tx) => catalogue.read(tx, TODAY));
    expect(now.agencies.map((one) => one.key)).toEqual(['PVN']);
  });

  it('keeps the tenants apart: another tenant sees none of it', async () => {
    expect(await as(STEWARD, (tx) => catalogue.read(tx, TODAY), TENANT_B)).toEqual({ periodKinds: [], reportTypes: [], agencies: [] });
  });
});
