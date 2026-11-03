import { randomUUID } from 'node:crypto';
import { MIGRATION_STATUSES, MIGRATION_TRANSITIONS, reportReference, verificationReport } from '@machvon/kernel';
import type { MigrationStatus, TableMeasure } from '@machvon/kernel';
import { PlacementMigrationStore, migrationReconciliation, tenantOfMigration } from '../src/placement-migration-store';
import type { MigrationRow } from '../src/placement-migration-store';
import { APPROVER, NOW, PlacementHarness, REASON, REQUESTER, hours, minutes, recorder } from './support/placement-fixtures';
import { contextFor } from './support/authz-fixtures';

const store = new PlacementMigrationStore();
const MEASURE: TableMeasure[] = [{ table: 'allocation_line', rows: 2, checksum: '12345678901234567890', money: { amount_vnd: '300000000000000000000', ctmtqg_subset_vnd: '0' } }];
const intact = { targetIntact: async () => true };

describe('the promotion of a tenant to a silo (ST-SAS-018, SAS.md 3.3, BR-SAS-05)', () => {
  const harness = new PlacementHarness();

  const start = (tenant: string, silo: string, overrides: Partial<{ minutes: number; window: Date; reason: string; by: string }> = {}, at = NOW, effects = recorder()) =>
    harness.inTenant(tenant, (tx) =>
      store.start(tx, effects, { tenantId: tenant, toPlacementId: silo, writeFreezeMaxMinutes: overrides.minutes ?? 30, plannedWindowStart: overrides.window ?? minutes(60), reason: overrides.reason ?? REASON, requestedBy: overrides.by ?? REQUESTER }, at),
    );
  const find = (tenant: string, id: string) => harness.inTenant(tenant, (tx) => store.find(tx, id)) as Promise<MigrationRow>;
  /** Plays the worker up to AwaitingCutover with a comparison that agrees (or not). */
  async function awaiting(tenant: string, silo: string, match = true, at = NOW): Promise<MigrationRow> {
    const migration = await start(tenant, silo);
    const effects = recorder();
    await harness.inTenant(tenant, async (tx) => {
      await store.beginCopy(tx, effects, migration.id);
      await store.copied(tx, migration.id);
      const target = match ? MEASURE : [{ ...(MEASURE[0] as TableMeasure), money: { amount_vnd: '300000000000000000001', ctmtqg_subset_vnd: '0' } }];
      await store.recordVerification(tx, effects, migration.id, verificationReport(MEASURE, target, at), ['tenant_theme_draft']);
    });
    return find(tenant, migration.id);
  }
  const approve = (tenant: string, id: string, version: number, by = APPROVER, at = minutes(2), effects = recorder(by)) =>
    harness.inTenant(tenant, (tx) => store.approve(tx, effects, { migrationId: id, approver: by, reason: 'The comparison agrees and the window is agreed with the customer.', expectedVersion: version }, at));
  const abort = (tenant: string, id: string, version: number, at = minutes(3), checks = intact, effects = recorder(APPROVER)) =>
    harness.inTenant(tenant, (tx) => store.abort(tx, effects, { migrationId: id, actor: APPROVER, reason: 'The customer asked to stop the promotion.', expectedVersion: version }, at, checks));

  beforeAll(() => harness.start(), 180_000);
  afterAll(() => harness.stop(), 60_000);

  describe('starting a promotion', () => {
    it('plans it for the window asked for: the tenant is Active on the pool, the silo is free, and the platform is told', async () => {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      const effects = recorder();
      const migration = await start(tenant, silo, { minutes: 45, window: minutes(90) }, NOW, effects);
      expect(migration).toMatchObject({
        tenantId: tenant,
        toPlacementId: silo,
        status: 'Planned',
        writeFreezeMaxMinutes: 45,
        reason: REASON,
        requestedBy: REQUESTER,
        cutoverApprovedBy: null,
        report: null,
        checksumMatch: null,
        endedAt: null,
        version: 1,
      });
      expect(migration.fromPlacementId).toBe((await harness.tenantRow(tenant)).placement_id);
      expect(migration.plannedWindowStart).toEqual(minutes(90));
      expect(migration.workflowId).toBe(`placement-migration:${tenant}:${migration.id}`);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.placement_migration_started']);
      expect(effects.audits[0]?.reason).toBe(REASON);
      expect(effects.events).toEqual([
        { type: 'sas.placement_migration.started.v1', eventKey: `placement_migration:${migration.id}:started`, payload: { migration_id: migration.id, tenant_id: tenant, from_placement_id: migration.fromPlacementId, to_placement_id: silo } },
      ]);
      // Nothing about the tenant moved: it is on the pool until a switched migration says otherwise.
      expect(await harness.tenantRow(tenant)).toMatchObject({ isolation_mode: 'POOL', write_frozen_until: null });
    });

    it('refuses a start that cannot be accepted with 422 VALIDATION_FAILED naming the field, before anything is read', async () => {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      await expect(start(tenant, silo, { minutes: 4 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'write_freeze_max_minutes' });
      await expect(start(tenant, silo, { minutes: 241 })).rejects.toMatchObject({ detail: 'write_freeze_max_minutes' });
      await expect(start(tenant, silo, { window: minutes(-6) })).rejects.toMatchObject({ detail: 'planned_window_start' });
      await expect(start(tenant, silo, { reason: 'too short' })).rejects.toMatchObject({ detail: 'reason' });
      expect(await harness.admin('select 1 from machvon.tenant_placement_migration where tenant_id = $1', [tenant])).toEqual([]);
    });

    it('is 404 for a tenant that does not exist', async () => {
      const silo = await harness.silo();
      await expect(harness.control.withControl((tx) => store.start(tx, recorder(), { tenantId: '00000000-0000-4000-8000-0000000000ff', toPlacementId: silo, writeFreezeMaxMinutes: 30, plannedWindowStart: minutes(5), reason: REASON, requestedBy: REQUESTER }, NOW))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('refuses a tenant that is not Active with 409 TENANT_STATE_INVALID, and one that is on a silo already', async () => {
      const silo = await harness.silo();
      for (const status of ['Suspended', 'Offboarding', 'Provisioning']) {
        await expect(start(await harness.tenant(status), silo)).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', status: 409 });
      }
      const onSilo = await harness.tenant('Active', 'vn-north', { isolation: 'SILO' });
      await expect(start(onSilo, silo)).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', detail: 'ALREADY_SILO' });
    });

    it('refuses a second promotion while one is open with 409 MIGRATION_ALREADY_OPEN, and allows a new one once it ended', async () => {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      const first = await start(tenant, silo);
      await expect(start(tenant, await harness.silo())).rejects.toMatchObject({ code: 'MIGRATION_ALREADY_OPEN', status: 409 });
      await abort(tenant, first.id, first.version);
      const again = await start(tenant, await harness.silo());
      expect(again.status).toBe('Planned');
    });

    it('refuses a placement that is not a free Active silo of the region, with 422 PLACEMENT_UNAVAILABLE naming why', async () => {
      const tenant = await harness.tenant();
      const refused = async (silo: string) => start(tenant, silo).catch((error: { code: string; status: number; extensions?: { reason?: string } }) => ({ code: error.code, status: error.status, reason: error.extensions?.reason }));
      expect(await refused('00000000-0000-4000-8000-0000000000fe')).toEqual({ code: 'PLACEMENT_UNAVAILABLE', status: 422, reason: 'NOT_FOUND' });
      expect(await refused(await harness.silo({ kind: 'POOL', max: 100 }))).toEqual({ code: 'PLACEMENT_UNAVAILABLE', status: 422, reason: 'NOT_SILO' });
      expect(await refused(await harness.silo({ status: 'Draining' }))).toEqual({ code: 'PLACEMENT_UNAVAILABLE', status: 422, reason: 'NOT_ACTIVE' });
      expect(await refused(await harness.silo({ region: 'vn-south' }))).toEqual({ code: 'PLACEMENT_UNAVAILABLE', status: 422, reason: 'OTHER_REGION' });
      const taken = await harness.silo();
      await harness.tenant('Active', 'vn-north', { placement: taken, isolation: 'SILO' });
      expect(await refused(taken)).toEqual({ code: 'PLACEMENT_UNAVAILABLE', status: 422, reason: 'NO_ROOM' });
      expect(await refused((await harness.tenantRow(tenant)).placement_id)).toEqual({ code: 'PLACEMENT_UNAVAILABLE', status: 422, reason: 'SAME_PLACEMENT' });
    });

    it('gives a silo to one tenant only: a second promotion to a silo that another tenant is on its way to is refused, also when both ask at the same time', async () => {
      const silo = await harness.silo();
      const first = await harness.tenant();
      const second = await harness.tenant();
      await start(first, silo);
      await expect(start(second, silo)).rejects.toMatchObject({ code: 'PLACEMENT_UNAVAILABLE', extensions: { reason: 'NO_ROOM' } });
      const race = await harness.silo();
      const settled = await Promise.allSettled([start(await harness.tenant(), race), start(await harness.tenant(), race)]);
      expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect((settled.find((entry) => entry.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'PLACEMENT_UNAVAILABLE' });
    });

    it('frees the silo when the promotion to it ends without a switch', async () => {
      const silo = await harness.silo();
      const first = await start(await harness.tenant(), silo);
      const tenantOfFirst = first.tenantId;
      await abort(tenantOfFirst, first.id, first.version);
      expect((await start(await harness.tenant(), silo)).status).toBe('Planned');
    });
  });

  describe('the placements to choose from', () => {
    it('counts the tenants on each and those on their way, and says which silo can be chosen', async () => {
      const free = await harness.silo();
      const coming = await harness.silo();
      await start(await harness.tenant(), coming);
      const choices = await harness.control.withControl((tx) => store.placements(tx));
      expect(choices.find((choice) => choice.id === free)).toMatchObject({ kind: 'SILO', region: 'vn-north', status: 'Active', maxTenants: 1, tenants: 0, incoming: 0, available: true });
      expect(choices.find((choice) => choice.id === coming)).toMatchObject({ tenants: 0, incoming: 1, available: false });
      const pool = choices.find((choice) => choice.kind === 'POOL');
      expect(pool).toMatchObject({ available: false });
      expect(JSON.stringify(choices)).not.toContain('cluster-');
      expect(JSON.stringify(choices)).not.toContain('kms-');
    });
  });

  describe('approving the cutover', () => {
    it('AC-ST-SAS-018-1 UAT-AC150: refuses the one who started with 403 SELF_APPROVAL_DENIED, and does not freeze anything', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      await expect(approve(tenant, waiting.id, waiting.version, REQUESTER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await find(tenant, waiting.id)).status).toBe('AwaitingCutover');
      expect((await harness.tenantRow(tenant)).write_frozen_until).toBeNull();
    });

    it('AC-ST-SAS-018-1 UAT-AC150: refuses a copy that differs with 422 MIGRATION_VERIFICATION_FAILED naming the table, and the migration goes on waiting', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo(), false);
      expect(waiting.checksumMatch).toBe(false);
      await expect(approve(tenant, waiting.id, waiting.version)).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED', status: 422, extensions: { reason: 'MISMATCH', tables: ['allocation_line'] } });
      const still = await find(tenant, waiting.id);
      expect(still.status).toBe('AwaitingCutover');
      expect(still.cutoverApprovedBy).toBeNull();
      expect((await harness.tenantRow(tenant)).write_frozen_until).toBeNull();
      // The initiator is told so first, whatever the copy.
      await expect(approve(tenant, waiting.id, waiting.version, REQUESTER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    });

    it('refuses a comparison that is too old, and a migration that does not wait for approval, and a stale version', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      await expect(approve(tenant, waiting.id, waiting.version, APPROVER, minutes(11))).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED', extensions: { reason: 'STALE' } });
      await expect(approve(tenant, waiting.id, waiting.version + 1)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: waiting.version } });
      const planned = await start(await harness.tenant(), await harness.silo());
      await expect(approve(planned.tenantId, planned.id, planned.version)).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID', status: 409 });
      await expect(approve(tenant, '00000000-0000-4000-8000-0000000000fd', 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('AC-ST-SAS-018-1 UAT-AC150: lets another System Admin approve a copy that agrees: writes are frozen for the minutes asked for, and the approver and the words are kept', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      const effects = recorder(APPROVER);
      const frozen = await approve(tenant, waiting.id, waiting.version, APPROVER, minutes(2), effects);
      expect(frozen).toMatchObject({ status: 'CutoverFrozen', cutoverApprovedBy: APPROVER, writeFreezeStartedAt: minutes(2), cutoverApprovedAt: minutes(2), version: waiting.version + 1 });
      expect(frozen.approvalReason).toContain('comparison agrees');
      expect((await harness.tenantRow(tenant)).write_frozen_until).toEqual(minutes(32));
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.placement_cutover_approved']);
      expect(effects.audits[0]?.diff).toMatchObject({ requested_by: REQUESTER, approved_by: APPROVER, verification_report_ref: waiting.verificationReportRef });
      // It cannot be approved twice.
      await expect(approve(tenant, frozen.id, frozen.version)).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' });
    });

    it('does not freeze a tenant that stopped being Active since the promotion was planned', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      await harness.admin("update machvon.tenant set status = 'Suspended' where id = $1", [tenant]);
      await expect(approve(tenant, waiting.id, waiting.version)).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', status: 409 });
    });
  });

  describe('the comparison that is kept', () => {
    it('is kept whole, with a reference to it, and the verdict is worked out again from the numbers when it is read', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      expect(waiting.report?.unreadable).toEqual(['tenant_theme_draft']);
      expect(waiting.verificationReportRef).toBe(reportReference(verificationReport(MEASURE, MEASURE, waiting.verifiedAt as Date)));
      expect(migrationReconciliation(waiting)).toMatchObject({ match: true, sourceRows: 2, targetRows: 2 });
      const different = await awaiting(await harness.tenant(), await harness.silo(), false);
      expect(migrationReconciliation(different)).toMatchObject({ match: false, mismatchedTables: ['allocation_line'] });
      expect(migrationReconciliation(await start(await harness.tenant(), await harness.silo()))).toBeUndefined();
    });

    it('is audited when the verdict changes, not at every pass', async () => {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      const migration = await start(tenant, silo);
      const effects = recorder();
      await harness.inTenant(tenant, async (tx) => {
        await store.beginCopy(tx, effects, migration.id);
        await store.copied(tx, migration.id);
        await store.recordVerification(tx, effects, migration.id, verificationReport(MEASURE, MEASURE, NOW), []);
        await store.recordVerification(tx, effects, migration.id, verificationReport(MEASURE, MEASURE, minutes(1)), []);
        await store.recordVerification(tx, effects, migration.id, verificationReport(MEASURE, [], minutes(2)), []);
      });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.placement_migration_copy_started', 'tenant.placement_migration_verified', 'tenant.placement_migration_verified']);
      expect((await find(tenant, migration.id)).verifiedAt).toEqual(minutes(2));
    });

    it('is taken only while the copy is being verified or waiting for the cutover', async () => {
      const tenant = await harness.tenant();
      const migration = await start(tenant, await harness.silo());
      await expect(harness.inTenant(tenant, (tx) => store.recordVerification(tx, recorder(), migration.id, verificationReport(MEASURE, MEASURE, NOW), []))).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' });
    });
  });

  describe('the switch', () => {
    async function frozen(at = minutes(2)): Promise<{ tenant: string; silo: string; migration: MigrationRow }> {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      const waiting = await awaiting(tenant, silo);
      return { tenant, silo, migration: await approve(tenant, waiting.id, waiting.version, APPROVER, at) };
    }
    const agreeing = verificationReport(MEASURE, MEASURE, minutes(5));

    it('AC-ST-SAS-018-1 UAT-AC150: moves the routing of the tenant to the silo, lifts the freeze, and tells the platform', async () => {
      const { tenant, silo, migration } = await frozen();
      const effects = recorder();
      const switched = await harness.inTenant(tenant, (tx) => store.switch(tx, effects, migration.id, agreeing, [], minutes(6)));
      expect(switched).toMatchObject({ status: 'Switched', switchedAt: minutes(6), checksumMatch: true });
      expect(await harness.tenantRow(tenant)).toMatchObject({ placement_id: silo, isolation_mode: 'SILO', write_frozen_until: null });
      expect(effects.events.map((event) => event.type)).toEqual(['sas.placement_migration.switched.v1']);
      expect(effects.events[0]?.payload).toEqual({ migration_id: migration.id, tenant_id: tenant, from_placement_id: migration.fromPlacementId, to_placement_id: silo });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.placement_switched']);
    });

    it('refuses to switch on a comparison that disagrees, or once the freeze is over, and leaves the routing alone', async () => {
      const { tenant, migration } = await frozen();
      const disagreeing = verificationReport(MEASURE, [], minutes(5));
      await expect(harness.inTenant(tenant, (tx) => store.switch(tx, recorder(), migration.id, disagreeing, [], minutes(6)))).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED', status: 422 });
      await expect(harness.inTenant(tenant, (tx) => store.switch(tx, recorder(), migration.id, agreeing, [], minutes(32)))).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID', detail: 'FREEZE_OVER' });
      expect((await harness.tenantRow(tenant)).isolation_mode).toBe('POOL');
      expect((await find(tenant, migration.id)).status).toBe('CutoverFrozen');
    });

    it('is possible only from CutoverFrozen', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      await expect(harness.inTenant(tenant, (tx) => store.switch(tx, recorder(), waiting.id, agreeing, [], minutes(6)))).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' });
    });

    it('completes after the observation, and keeps the old data for 30 days', async () => {
      const { tenant, migration } = await frozen();
      await harness.inTenant(tenant, (tx) => store.switch(tx, recorder(), migration.id, agreeing, [], minutes(6)));
      const effects = recorder();
      const done = await harness.inTenant(tenant, (tx) => store.complete(tx, effects, migration.id, hours(25)));
      expect(done).toMatchObject({ status: 'Completed', completedAt: hours(25), sourcePurgedAt: null });
      expect(done.sourcePurgeDueAt).toEqual(new Date(hours(25).getTime() + 30 * 86_400_000));
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.placement_migration_completed']);
      await expect(harness.inTenant(tenant, (tx) => store.complete(tx, recorder(), migration.id, hours(26)))).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' });
    });
  });

  describe('aborting', () => {
    it('AC-ST-SAS-018-2 UAT-AC151: a migration in CutoverFrozen that is aborted is RolledBack, and writes work again', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      const frozen = await approve(tenant, waiting.id, waiting.version);
      expect((await harness.tenantRow(tenant)).write_frozen_until).not.toBeNull();
      const effects = recorder(APPROVER);
      const rolled = await abort(tenant, frozen.id, frozen.version, minutes(5), intact, effects);
      expect(rolled).toMatchObject({ status: 'RolledBack', endedAt: minutes(5), endedBy: APPROVER, targetDiscardedAt: null });
      expect(rolled.endReason).toContain('customer asked');
      expect(await harness.tenantRow(tenant)).toMatchObject({ write_frozen_until: null, isolation_mode: 'POOL', placement_id: frozen.fromPlacementId });
      expect(effects.audits).toEqual([expect.objectContaining({ action: 'tenant.placement_migration_aborted', diff: { from_status: 'CutoverFrozen', to_status: 'RolledBack' } })]);
    });

    it('is Aborted before the cutover, from any status that precedes it, and the freeze never started', async () => {
      const tenant = await harness.tenant();
      const planned = await start(tenant, await harness.silo());
      expect(await abort(tenant, planned.id, planned.version)).toMatchObject({ status: 'Aborted' });
      const waiting = await awaiting(await harness.tenant(), await harness.silo());
      expect(await abort(waiting.tenantId, waiting.id, waiting.version)).toMatchObject({ status: 'Aborted', endedBy: APPROVER });
      const copying = await start(await harness.tenant(), await harness.silo());
      await harness.inTenant(copying.tenantId, (tx) => store.beginCopy(tx, recorder(), copying.id));
      expect(await abort(copying.tenantId, copying.id, copying.version + 1)).toMatchObject({ status: 'Aborted' });
    });

    it('puts the routing back when a switched migration is rolled back, but not while the silo holds something the original does not', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      const frozen = await approve(tenant, waiting.id, waiting.version);
      const switched = await harness.inTenant(tenant, (tx) => store.switch(tx, recorder(), frozen.id, verificationReport(MEASURE, MEASURE, minutes(5)), [], minutes(6)));
      expect(await harness.tenantRow(tenant)).toMatchObject({ isolation_mode: 'SILO' });
      await expect(abort(tenant, switched.id, switched.version, minutes(10), { targetIntact: async () => false })).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID', status: 409, detail: 'TARGET_CHANGED' });
      expect((await find(tenant, switched.id)).status).toBe('Switched');
      expect(await harness.tenantRow(tenant)).toMatchObject({ isolation_mode: 'SILO' });
      const rolled = await abort(tenant, switched.id, switched.version, minutes(10));
      expect(rolled.status).toBe('RolledBack');
      expect(await harness.tenantRow(tenant)).toMatchObject({ isolation_mode: 'POOL', placement_id: switched.fromPlacementId, write_frozen_until: null });
    });

    it('refuses a migration that is over, a stale version, and a migration that does not exist', async () => {
      const tenant = await harness.tenant();
      const planned = await start(tenant, await harness.silo());
      await expect(abort(tenant, planned.id, planned.version + 3)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      const ended = await abort(tenant, planned.id, planned.version);
      await expect(abort(tenant, ended.id, ended.version)).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID', status: 409 });
      await expect(abort(tenant, '00000000-0000-4000-8000-0000000000fc', 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('is rolled back by the system when the freeze runs out or the last comparison disagrees: nobody ended it, and the comparison that failed is kept', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo());
      const frozen = await approve(tenant, waiting.id, waiting.version);
      const effects = recorder();
      const failed = verificationReport(MEASURE, [], minutes(6));
      const rolled = await harness.inTenant(tenant, (tx) => store.rollBack(tx, effects, frozen.id, 'FINAL_VERIFICATION_FAILED', minutes(7), { report: failed, unreadable: [] }));
      expect(rolled).toMatchObject({ status: 'RolledBack', endedBy: null, endReason: 'FINAL_VERIFICATION_FAILED', checksumMatch: false });
      expect(migrationReconciliation(rolled)).toMatchObject({ match: false });
      expect((await harness.tenantRow(tenant)).write_frozen_until).toBeNull();
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.placement_migration_rolled_back']);
      const other = await awaiting(await harness.tenant(), await harness.silo());
      await expect(harness.inTenant(other.tenantId, (tx) => store.rollBack(tx, recorder(), other.id, 'FREEZE_EXPIRED', minutes(7)))).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' });
    });
  });

  describe('what the worker records', () => {
    it('remembers the destruction of the copy once, and the deletion of the old data once', async () => {
      const tenant = await harness.tenant();
      const planned = await start(tenant, await harness.silo());
      const ended = await abort(tenant, planned.id, planned.version);
      const effects = recorder();
      await harness.inTenant(tenant, (tx) => store.targetDiscarded(tx, effects, ended.id, minutes(10)));
      await harness.inTenant(tenant, (tx) => store.targetDiscarded(tx, effects, ended.id, minutes(11)));
      expect((await find(tenant, ended.id)).targetDiscardedAt).toEqual(minutes(10));
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.placement_target_discarded']);
      // Only a migration that ended has a copy to destroy.
      const open = await start(await harness.tenant(), await harness.silo());
      await harness.inTenant(open.tenantId, (tx) => store.targetDiscarded(tx, effects, open.id, minutes(12)));
      expect((await find(open.tenantId, open.id)).targetDiscardedAt).toBeNull();
    });

    it('keeps the class of a failure without bumping the version for the same class twice, and a success clears it', async () => {
      const tenant = await harness.tenant();
      const migration = await start(tenant, await harness.silo());
      await harness.inTenant(tenant, (tx) => store.recordError(tx, migration.id, 'PLACEMENT_MOVER_UNAVAILABLE'));
      const once = await find(tenant, migration.id);
      expect(once).toMatchObject({ lastErrorCode: 'PLACEMENT_MOVER_UNAVAILABLE', version: migration.version + 1 });
      await harness.inTenant(tenant, (tx) => store.recordError(tx, migration.id, 'PLACEMENT_MOVER_UNAVAILABLE'));
      expect((await find(tenant, migration.id)).version).toBe(once.version);
      await harness.inTenant(tenant, (tx) => store.beginCopy(tx, recorder(), migration.id));
      expect((await find(tenant, migration.id)).lastErrorCode).toBeNull();
    });

    it('lists what has work to do: the migrations not over, those that ended with a copy to destroy, and those completed with data to delete', async () => {
      const tenant = await harness.tenant();
      const first = await start(tenant, await harness.silo());
      const ended = await abort(tenant, first.id, first.version);
      const second = await start(tenant, await harness.silo(), {}, minutes(1));
      expect((await harness.inTenant(tenant, (tx) => store.workItems(tx))).map((item) => item.id)).toEqual([ended.id, second.id]);
      await harness.inTenant(tenant, (tx) => store.targetDiscarded(tx, recorder(), ended.id, minutes(9)));
      expect((await harness.inTenant(tenant, (tx) => store.workItems(tx))).map((item) => item.id)).toEqual([second.id]);
    });

    it('counts what needs a person: the copies that differ and the workers that fail, and the migrations the system rolled back in the last day', async () => {
      const tenant = await harness.tenant();
      const waiting = await awaiting(tenant, await harness.silo(), false);
      expect(await harness.inTenant(tenant, (tx) => store.pressure(tx, minutes(5)))).toEqual({ open: 1, mismatch: 1, failing: 0 });
      await harness.inTenant(tenant, (tx) => store.recordError(tx, waiting.id, 'STEP_FAILED'));
      expect(await harness.inTenant(tenant, (tx) => store.pressure(tx, minutes(5)))).toEqual({ open: 1, mismatch: 1, failing: 1 });
      const other = await harness.tenant();
      const migration = await awaiting(other, await harness.silo());
      const frozen = await approve(other, migration.id, migration.version);
      await harness.inTenant(other, (tx) => store.rollBack(tx, recorder(), frozen.id, 'FREEZE_EXPIRED', minutes(40)));
      expect(await harness.inTenant(other, (tx) => store.pressure(tx, minutes(41)))).toEqual({ open: 0, mismatch: 0, failing: 1 });
      // A System Admin who rolls a frozen migration back is not a problem to look at: the system did not do it.
      const again = await awaiting(other, await harness.silo());
      const frozenAgain = await approve(other, again.id, again.version, APPROVER, minutes(2));
      await abort(other, frozenAgain.id, frozenAgain.version, minutes(3));
      expect(await harness.inTenant(other, (tx) => store.pressure(tx, minutes(41)))).toEqual({ open: 0, mismatch: 0, failing: 1 });
      expect(await harness.inTenant(other, (tx) => store.pressure(tx, hours(30)))).toEqual({ open: 0, mismatch: 0, failing: 0 });
    });

    it('asks the legal holds of the tenant', async () => {
      const tenant = await harness.tenant();
      expect(await harness.inTenant(tenant, (tx) => store.legalHoldsActive(tx, tenant))).toBe(0);
      await harness.admin("insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, placed_by) values ($1, gen_random_uuid(), '{}'::jsonb, 'Decision 12/QD', 'Investigation', now() - interval '1 day', $2)", [tenant, REQUESTER]);
      expect(await harness.inTenant(tenant, (tx) => store.legalHoldsActive(tx, tenant))).toBe(1);
    });
  });

  describe('what the database holds whatever the application does', () => {
    const base = (tenant: string, silo: string, id: string, status: MigrationStatus = 'Planned', extra: Record<string, unknown> = {}) => {
      const values: Record<string, unknown> = {
        tenant_id: tenant,
        id,
        from_placement_id: '00000000-0000-4000-8000-0000000000b1',
        to_placement_id: silo,
        status,
        write_freeze_max_minutes: 30,
        requested_by: REQUESTER,
        temporal_workflow_id: `placement-migration:${tenant}:${id}`,
        reason: REASON,
        ...extra,
      };
      return values;
    };
    const insert = async (values: Record<string, unknown>) => {
      const keys = Object.keys(values);
      return harness.sqlError(`insert into machvon.tenant_placement_migration (${keys.join(', ')}) values (${keys.map((_, index) => `$${index + 1}`).join(', ')})`, Object.values(values));
    };
    const report = { verification_report: JSON.stringify({ measured_at: NOW.toISOString(), source: [], target: [], unreadable: [] }), verified_at: NOW, verification_report_ref: 'sha256:x', checksum_match: true };
    const approval = { cutover_approved_by: APPROVER, cutover_approved_at: NOW, approval_reason: 'agreed with the customer', write_freeze_started_at: NOW };
    const columnsOf = (status: MigrationStatus, from: MigrationStatus = status): Record<string, unknown> => {
      const open: Record<MigrationStatus, Record<string, unknown>> = {
        Planned: {},
        Copying: {},
        Verifying: {},
        AwaitingCutover: report,
        CutoverFrozen: { ...report, ...approval },
        Switched: { ...report, ...approval, switched_at: NOW },
        Completed: { ...report, ...approval, switched_at: NOW, completed_at: NOW, source_purge_due_at: days30() },
        Aborted: {},
        RolledBack: {},
      };
      if (status === 'Aborted' || status === 'RolledBack') return { ...open[from], ended_at: NOW, end_reason: 'ended' };
      return open[status];
    };
    function days30(): Date {
      return new Date(NOW.getTime() + 30 * 86_400_000);
    }
    const newRow = async (status: MigrationStatus) => {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      const id = randomUUID();
      const error = await insert(base(tenant, silo, id, status, columnsOf(status)));
      expect(error).toBeUndefined();
      return { tenant, silo, id };
    };

    it('moves a migration along exactly the transitions of the rules: every other change of status is refused, and an ended migration never moves', async () => {
      for (const from of MIGRATION_STATUSES) {
        for (const to of MIGRATION_STATUSES) {
          if (from === to) continue;
          const { id } = await newRow(from);
          const allowed = MIGRATION_TRANSITIONS.some(([a, b]) => a === from && b === to);
          const set = { ...columnsOf(to, from), status: to };
          const keys = Object.keys(set);
          const error = await harness.sqlError(`update machvon.tenant_placement_migration set ${keys.map((key, index) => `${key} = $${index + 2}`).join(', ')} where id = $1`, [id, ...Object.values(set)]);
          if (allowed) expect({ from, to, error }).toEqual({ from, to, error: undefined });
          else expect({ from, to, refused: error?.message.includes('PLACEMENT_MIGRATION_IMMUTABLE') ?? false }).toEqual({ from, to, refused: true });
        }
      }
    }, 240_000);

    it('never deletes a migration, and does not let what was asked for change', async () => {
      const { id, silo } = await newRow('Planned');
      expect((await harness.sqlError('delete from machvon.tenant_placement_migration where id = $1', [id]))?.message).toContain('PLACEMENT_MIGRATION_IMMUTABLE');
      for (const [column, value] of [['write_freeze_max_minutes', 60], ['reason', 'A different reason, long enough.'], ['requested_by', APPROVER], ['to_placement_id', await harness.silo()], ['planned_window_start', NOW], ['temporal_workflow_id', 'other']] as const) {
        expect({ column, message: (await harness.sqlError(`update machvon.tenant_placement_migration set ${column} = $2 where id = $1`, [id, value]))?.message.includes('PLACEMENT_MIGRATION_IMMUTABLE') }).toEqual({ column, message: true });
      }
      expect(silo).toBeDefined();
    });

    it('does not take an approval back or hand it to somebody else, and records the freeze and the switch once', async () => {
      const { id } = await newRow('Switched');
      const refused = async (set: string, value: unknown) => (await harness.sqlError(`update machvon.tenant_placement_migration set ${set} where id = $1`, [id, value]))?.message ?? '';
      expect(await refused('cutover_approved_by = $2', REQUESTER)).toMatch(/violates check constraint|IMMUTABLE/);
      expect(await refused('cutover_approved_by = $2', '00000000-0000-4000-8000-0000000000e9')).toContain('PLACEMENT_MIGRATION_IMMUTABLE');
      expect(await refused('write_freeze_started_at = $2', minutes(1))).toContain('PLACEMENT_MIGRATION_IMMUTABLE');
      expect(await refused('switched_at = $2', minutes(1))).toContain('PLACEMENT_MIGRATION_IMMUTABLE');
      expect(await refused('checksum_match = $2', false)).toContain('PLACEMENT_MIGRATION_IMMUTABLE');
    });

    it('lets a migration that ended change only in what was destroyed and what failed', async () => {
      const { id } = await newRow('Aborted');
      expect(await harness.sqlError('update machvon.tenant_placement_migration set target_discarded_at = $2, last_error_code = $3, version = version + 1 where id = $1', [id, NOW, 'STEP_FAILED'])).toBeUndefined();
      expect((await harness.sqlError('update machvon.tenant_placement_migration set target_discarded_at = $2 where id = $1', [id, minutes(1)]))?.message).toContain('recorded once');
      expect((await harness.sqlError('update machvon.tenant_placement_migration set end_reason = $2 where id = $1', [id, 'rewritten']))?.message).toContain('a migration that ended does not change');
      const completed = await newRow('Completed');
      expect(await harness.sqlError('update machvon.tenant_placement_migration set source_purged_at = $2 where id = $1', [completed.id, NOW])).toBeUndefined();
      expect((await harness.sqlError('update machvon.tenant_placement_migration set source_purged_at = $2 where id = $1', [completed.id, minutes(1)]))?.message).toContain('recorded once');
    });

    it('refuses a migration that is frozen, switched or completed without an approver, without a switch time, or switched without an agreeing comparison', async () => {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      const attempt = async (status: MigrationStatus, extra: Record<string, unknown>) => (await insert(base(tenant, silo, randomUUID(), status, extra)))?.message ?? '';
      expect(await attempt('CutoverFrozen', report)).toContain('tenant_placement_migration_approved_ck');
      expect(await attempt('CutoverFrozen', { ...approval })).toContain('tenant_placement_migration_verified_ck');
      // An approval time, words and a freeze but nobody who approved is not an approval.
      expect(await attempt('CutoverFrozen', { ...report, cutover_approved_at: NOW, approval_reason: 'agreed', write_freeze_started_at: NOW })).toContain('tenant_placement_migration_approved_ck');
      expect(await attempt('Switched', { ...report, ...approval })).toContain('tenant_placement_migration_switched_ck');
      expect(await attempt('Switched', { ...report, ...approval, switched_at: NOW, checksum_match: false })).toContain('tenant_placement_migration_switched_ck');
      expect(await attempt('Completed', { ...report, ...approval, switched_at: NOW })).toContain('tenant_placement_migration_completed_ck');
      expect(await attempt('AwaitingCutover', {})).toContain('tenant_placement_migration_verified_ck');
      expect(await attempt('Planned', { cutover_approved_by: REQUESTER })).toContain('violates check constraint');
      expect(await attempt('Planned', { ...approval, cutover_approved_by: REQUESTER })).toContain('violates check constraint');
      expect(await attempt('Planned', { reason: 'short' })).toContain('tenant_placement_migration_reason_ck');
      expect(await attempt('Planned', { ended_at: NOW, end_reason: 'x' })).toContain('tenant_placement_migration_ended_ck');
      expect(await attempt('Aborted', {})).toContain('tenant_placement_migration_ended_ck');
      expect(await attempt('Planned', { verified_at: NOW })).toContain('tenant_placement_migration_report_ck');
    });

    it('allows one open migration for a tenant, and the unique index is the one that says so', async () => {
      const tenant = await harness.tenant();
      expect(await insert(base(tenant, await harness.silo(), randomUUID()))).toBeUndefined();
      expect((await insert(base(tenant, await harness.silo(), randomUUID())))?.message).toContain('tenant_placement_migration_open_uq');
    });

    it('changes the routing of a tenant only with a switched promotion, and puts it back only with a rolled back one', async () => {
      const tenant = await harness.tenant();
      const silo = await harness.silo();
      const move = (placement: string, mode: string) => harness.sqlError('update machvon.tenant set placement_id = $2, isolation_mode = $3 where id = $1', [tenant, placement, mode]);
      expect((await move(silo, 'SILO'))?.message).toContain('TENANT_ROUTING_GUARDED');
      expect((await harness.sqlError("update machvon.tenant set isolation_mode = 'SILO' where id = $1", [tenant]))?.message).toContain('TENANT_ROUTING_GUARDED');
      const id = randomUUID();
      expect(await insert(base(tenant, silo, id, 'Switched', columnsOf('Switched')))).toBeUndefined();
      expect((await move(await harness.silo(), 'SILO'))?.message).toContain('TENANT_ROUTING_GUARDED');
      expect((await move(silo, 'POOL'))?.message).toContain('TENANT_ROUTING_GUARDED');
      expect(await move(silo, 'SILO')).toBeUndefined();
      // Back: only the rolled back one lets it.
      expect((await move('00000000-0000-4000-8000-0000000000b1', 'POOL'))?.message).toContain('TENANT_ROUTING_GUARDED');
      await harness.admin("update machvon.tenant_placement_migration set status = 'RolledBack', ended_at = now(), end_reason = 'x' where id = $1", [id]);
      expect(await move('00000000-0000-4000-8000-0000000000b1', 'POOL')).toBeUndefined();
      // Other columns of the tenant are not the guard's concern.
      expect(await harness.sqlError("update machvon.tenant set name = 'renamed' where id = $1", [tenant])).toBeUndefined();
    });

    it('lets the tenant plane read its migration and nothing else: it cannot start, change or delete one, and sees none of another tenant', async () => {
      const mine = await start(await harness.tenant(), await harness.silo());
      const other = await start(await harness.tenant(), await harness.silo());
      const ctx = contextFor(mine.tenantId, '00000000-0000-4000-8000-000000000001', 0);
      const seen = await harness.tenants.withTenant(ctx, (tx) => tx.query<{ id: string }>('select id from machvon.tenant_placement_migration'));
      expect(seen.map((row) => row.id)).toEqual([mine.id]);
      const denied = async (sql: string, params: unknown[] = []) =>
        harness.tenants
          .withTenant(ctx, (tx) => tx.query(sql, params))
          .then(() => 'allowed')
          .catch((error: Error) => error.message);
      expect(await denied("update machvon.tenant_placement_migration set reason = 'x'")).toContain('permission denied');
      expect(await denied('delete from machvon.tenant_placement_migration')).toContain('permission denied');
      expect(await denied('insert into machvon.tenant_placement_migration (tenant_id, id) values ($1, gen_random_uuid())', [mine.tenantId])).toContain('permission denied');
      expect(await denied('select * from machvon.tenant_placement_migration_directory')).toContain('permission denied');
      expect(await denied('select machvon.placement_migration_tenant_of($1)', [other.id])).toContain('permission denied');
    });

    it('finds the tenant of a migration by its id alone, for the control plane, and the directory follows the migration', async () => {
      const migration = await start(await harness.tenant(), await harness.silo());
      expect(await harness.control.withControl((tx) => tenantOfMigration(tx, migration.id))).toBe(migration.tenantId);
      expect(await harness.control.withControl((tx) => tenantOfMigration(tx, '00000000-0000-4000-8000-0000000000fb'))).toBeUndefined();
      expect((await harness.admin<{ open: boolean }>('select open from machvon.tenant_placement_migration_directory where migration_id = $1', [migration.id]))[0]?.open).toBe(true);
      await abort(migration.tenantId, migration.id, migration.version);
      expect((await harness.admin<{ open: boolean }>('select open from machvon.tenant_placement_migration_directory where migration_id = $1', [migration.id]))[0]?.open).toBe(false);
    });

    it('lists the migrations of a tenant, the newest first, a page at a time', async () => {
      const tenant = await harness.tenant();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const migration = await start(tenant, await harness.silo(), {}, minutes(index));
        ids.push(migration.id);
        await abort(tenant, migration.id, migration.version);
      }
      const page = await harness.inTenant(tenant, (tx) => store.list(tx, { limit: 2 }));
      expect(page.map((row) => row.id)).toEqual([ids[2], ids[1]]);
      const last = page[1] as MigrationRow;
      const rest = await harness.inTenant(tenant, (tx) => store.list(tx, { limit: 2, after: { createdAt: last.createdAt.toISOString(), id: last.id } }));
      expect(rest.map((row) => row.id)).toEqual([ids[0]]);
    });
  });
});
