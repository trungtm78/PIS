import { randomUUID } from 'node:crypto';
import { connectorDescriptor, registerBuiltInConnectors } from '@machvon/kernel';
import type { ConnectorDescriptor } from '@machvon/kernel';
import { HUB_AUDIENCE_PERMISSION } from '../src/home-connector-sources';
import { HomeWorkStore } from '../src/home-work-store';
import type { WorkInput, WorkRow } from '../src/home-work-store';
import { registerBuiltInHubAdapters } from '../src/hub-adapters';
import { HubStore } from '../src/hub-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

registerBuiltInConnectors();
registerBuiltInHubAdapters();

const harness = new AuthzHarness();
const store = new HomeWorkStore();
const hub = new HubStore();
const READER = 1;
const NOW = new Date('2026-11-08T03:00:00Z');
const TODAY = '2026-11-08';
const EVERYTHING: ScopeBuilder = () => ({ sql: 'true', params: [] });
const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(READER)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const descriptor = (code: string): ConnectorDescriptor => connectorDescriptor(code) as ConnectorDescriptor;
const holding =
  (...held: string[]) =>
  (permission: string): boolean =>
    held.includes(permission);
const input = (over: Partial<WorkInput> = {}): WorkInput => ({ membershipId: memberId(READER), now: NOW, today: TODAY, unitScope: EVERYTHING, projectScope: EVERYTHING, view: 'scope', includeHidden: true, ...over });

const seedFile = (position: string, status: 'APPLIED' | 'FAILED', at: Date, tenant = TENANT_A): Promise<unknown> =>
  owner(
    `insert into machvon.file_import (tenant_id, connector_code, format_version, file_sha256, file_object_key, status, error_code, rows_total, rows_applied, imported_by, created_at, completed_at)
     values ($1, $2, 'ASSUMED-2026.1', $3, $4, $5, $6, 1, $7, $8, $9::timestamptz, $9::timestamptz)`,
    [tenant, position, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `tenants/${tenant}/import/${randomUUID()}`, status, status === 'FAILED' ? 'IMPORT_SCHEMA_INVALID' : null, status === 'APPLIED' ? 1 : 0, memberId(READER), at.toISOString()],
    tenant,
  );

const sweep = (at: Date, tenant = TENANT_A): Promise<unknown> => as((tx) => hub.sweep(tx, [descriptor('procurement.milestones'), descriptor('treasury.statement'), descriptor('egp.muasamcong')], at, memberId(READER)), tenant);

const read = (holds: string[], tenant = TENANT_A): Promise<WorkRow[]> =>
  as((tx) => store.collect(tx, input({ holds: holding(...holds) })), tenant).then((collected) => {
    expect(collected.unavailableSources).toEqual([]);
    return collected.rows.filter((row) => row.id.startsWith('hub-incident:'));
  });

/** HUB-2: the open incidents of the Integration Hub are work of the alert centre for the integration administrator. */
describe('the incidents of the Integration Hub in the alert centre', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      await harness.seedMembership(tenant, READER, 1);
    }
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  it('shows a failing connector and a stale one to the administrator of incidents, once each, and nothing to a reader without the permission', async () => {
    await seedFile('PROCUREMENT_FILE', 'APPLIED', new Date(NOW.getTime() - 30 * 3_600_000));
    await seedFile('PROCUREMENT_FILE', 'FAILED', new Date(NOW.getTime() - 5 * 3_600_000));
    await seedFile('TREASURY_STATEMENT_FILE', 'APPLIED', new Date(NOW.getTime() - 400 * 3_600_000));
    await sweep(NOW);
    const rows = await read([HUB_AUDIENCE_PERMISSION]);
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
    expect(Object.keys(byKind).sort()).toEqual(['CONNECTOR_FAILING', 'CONNECTOR_STALE']);
    expect(byKind.CONNECTOR_FAILING).toMatchObject({ source: 'CONNECTOR', severity: 'ACTION', target: { screen: 'HUB-03' }, causeKey: 'connector:procurement.milestones', status: 'OPEN' });
    expect(byKind.CONNECTOR_STALE).toMatchObject({ source: 'CONNECTOR', severity: 'ACTION', target: { screen: 'HUB-03' }, causeKey: 'connector:treasury.statement' });
    expect(byKind.CONNECTOR_FAILING?.consequence).toBeTruthy();
    // A second sweep opens nothing new, so the list does not grow.
    await sweep(new Date(NOW.getTime() + 60_000));
    expect(await read([HUB_AUDIENCE_PERMISSION])).toHaveLength(2);
    expect(await read([])).toEqual([]);
  });

  it('keeps an acknowledged incident as taken up and drops a resolved one when the connector recovers', async () => {
    const open = await as((tx) => hub.listIncidents(tx, { open: true, connectorCode: 'procurement.milestones', limit: 10, after: undefined }));
    const incident = open[0];
    expect(incident).toBeDefined();
    await as((tx) => hub.moveIncident(tx, (incident as { id: string }).id, (incident as { version: number }).version, { move: 'ACKNOWLEDGE', reason: 'Looking at the file now' }, memberId(READER)));
    const taken = (await read([HUB_AUDIENCE_PERMISSION])).find((row) => row.kind === 'CONNECTOR_FAILING');
    expect(taken).toMatchObject({ status: 'ACKNOWLEDGED', lifecycle: 'CLAIMED' });
    await seedFile('PROCUREMENT_FILE', 'APPLIED', new Date(NOW.getTime() + 3_600_000));
    await sweep(new Date(NOW.getTime() + 2 * 3_600_000));
    expect((await read([HUB_AUDIENCE_PERMISSION])).map((row) => row.kind)).toEqual(['CONNECTOR_STALE']);
  });

  it('keeps the stale incident of e-GP on the list of a reader whom the alert of the connection itself does not reach (the deduplication never hides what the reader may manage)', async () => {
    await seedFile('EGP_TBMT_FILE', 'APPLIED', new Date(NOW.getTime() - 400 * 3_600_000));
    await sweep(new Date(NOW.getTime() + 10 * 3_600_000));
    const rows = await read([HUB_AUDIENCE_PERMISSION]);
    expect(rows.find((row) => row.causeKey === 'connector:egp.muasamcong')).toMatchObject({ kind: 'CONNECTOR_STALE', target: { screen: 'HUB-03' } });
  });

  it('does not show one tenant the incidents of another', async () => {
    expect(await read([HUB_AUDIENCE_PERMISSION], TENANT_B)).toEqual([]);
  });
});
