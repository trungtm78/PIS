import { randomUUID } from 'node:crypto';
import { reconcileCopy } from '@machvon/kernel';
import type { TableMeasure } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { measureTenantTables } from '../src/placement-measure';
import { PlacementMigrationRunner, moveOf, targetIntact } from '../src/placement-migration-runner';
import { PlacementMigrationStore, migrationReconciliation } from '../src/placement-migration-store';
import type { MigrationRow } from '../src/placement-migration-store';
import { MockPlacementMover, UnboundPlacementMover } from '../src/placement-mover';
import type { MoveRef, MoveSource } from '../src/placement-mover';
import { contextFor } from './support/authz-fixtures';
import { APPROVER, NOW, PlacementHarness, REASON, REQUESTER, WORKER, days, hours, minutes, recorder } from './support/placement-fixtures';

const store = new PlacementMigrationStore();
const BIG = '123456789012345678901234';

const oneRowOff = (tables: TableMeasure[]): void => {
  const line = tables.find((table) => table.table === 'ai_budget') as TableMeasure;
  line.money = { ...line.money, limit_vnd: '1' };
};
const oneRowMore = (tables: TableMeasure[]): void => {
  (tables.find((table) => table.table === 'ai_budget') as TableMeasure).rows += 1;
};

describe('the worker of the promotion of a tenant to a silo (ST-SAS-018, SAS.md 3.3, BR-SAS-05)', () => {
  const harness = new PlacementHarness();

  const runnerFor = (mover: MockPlacementMover | UnboundPlacementMover, clock?: () => Date) =>
    new PlacementMigrationRunner({ control: harness.control, tenants: harness.tenants, mover, audit: new AuditWriter(harness.tenants), ...(clock === undefined ? {} : { clock }) });
  const ctxOf = (tenant: string) => contextFor(tenant, WORKER, 0);
  const find = (tenant: string, id: string) => harness.inTenant(tenant, (tx) => store.find(tx, id)) as Promise<MigrationRow>;
  const actionsOf = async (tenant: string, id: string): Promise<string[]> =>
    (await harness.admin<{ action: string }>('select action from machvon.audit_event where tenant_id = $1 and resource_id = $2 order by occurred_at', [tenant, id])).map((row) => row.action);

  /** An Active tenant with two budgets (money in a table of its own), and a silo to go to. */
  async function seeded(): Promise<{ tenant: string; silo: string }> {
    const tenant = await harness.tenant();
    const silo = await harness.silo();
    for (const [period, amount] of [['MONTH', BIG], ['QUARTER', '1000']] as const) {
      await harness.base.owner(tenant, [
        [
          "insert into machvon.ai_budget (tenant_id, id, scope_kind, period, limit_vnd, effective_from, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, '2026-01-01', $5, $5)",
          [tenant, randomUUID(), period, amount, REQUESTER],
        ],
      ]);
    }
    return { tenant, silo };
  }
  const start = (tenant: string, silo: string, window = NOW, at = NOW) =>
    harness.inTenant(tenant, (tx) => store.start(tx, recorder(), { tenantId: tenant, toPlacementId: silo, writeFreezeMaxMinutes: 30, plannedWindowStart: window, reason: REASON, requestedBy: REQUESTER }, at));
  const approve = (tenant: string, id: string, at: Date, by = APPROVER) =>
    harness.inTenant(tenant, async (tx) => {
      const row = (await store.find(tx, id)) as MigrationRow;
      return store.approve(tx, recorder(by), { migrationId: id, approver: by, reason: 'The comparison agrees and the window is agreed with the customer.', expectedVersion: row.version }, at);
    });

  beforeAll(() => harness.start(), 180_000);
  afterAll(() => harness.stop(), 60_000);

  describe('measuring the data of a tenant', () => {
    it('counts the rows, sums the money exactly and hashes the primary keys, for the rows of the tenant alone', async () => {
      const { tenant } = await seeded();
      const other = await seeded();
      const measured = await harness.tenants.withSnapshot(ctxOf(tenant), (tx) => measureTenantTables(tx));
      const line = measured.tables.find((table) => table.table === 'ai_budget') as TableMeasure;
      expect(line.rows).toBe(2);
      expect(line.money).toEqual({ limit_vnd: (BigInt(BIG) + 1000n).toString() });
      expect(line.checksum).toMatch(/^-?\d+$/);
      // The rows of the other tenant are not seen: its numbers are its own.
      const theirs = (await harness.tenants.withSnapshot(ctxOf(other.tenant), (tx) => measureTenantTables(tx))).tables.find((table) => table.table === 'ai_budget') as TableMeasure;
      expect(theirs.rows).toBe(2);
      expect(theirs.checksum).not.toBe(line.checksum);
      // A table the tenant has no row in is measured as empty, with its sums at zero.
      const empty = measured.tables.find((table) => table.table === 'organization_unit') as TableMeasure;
      expect(empty).toMatchObject({ rows: 0, checksum: '0' });
    });

    it('gives the same numbers again, and other numbers when one key or one amount changes', async () => {
      const { tenant } = await seeded();
      const measure = async () => (await harness.tenants.withSnapshot(ctxOf(tenant), (tx) => measureTenantTables(tx))).tables.find((table) => table.table === 'ai_budget') as TableMeasure;
      const before = await measure();
      expect(await measure()).toEqual(before);
      await harness.base.owner(tenant, [['update machvon.ai_budget set limit_vnd = limit_vnd + 1 where limit_vnd = 1000', []]]);
      const amount = await measure();
      expect(amount.rows).toBe(before.rows);
      expect(amount.checksum).not.toBe(before.checksum);
      expect(amount.money.limit_vnd).toBe((BigInt(before.money.limit_vnd as string) + 1n).toString());
      await harness.base.owner(tenant, [['update machvon.ai_budget set id = $1 where limit_vnd = $2', [randomUUID(), BIG]]]);
      const key = await measure();
      expect(key.money).toEqual(amount.money);
      expect(key.checksum).not.toBe(before.checksum);
    });

    it('AC-ST-SAS-018-3: measures the content of every column, so a change to a column that is neither key nor money changes the checksum and nothing else', async () => {
      const { tenant } = await seeded();
      const measure = async () => (await harness.tenants.withSnapshot(ctxOf(tenant), (tx) => measureTenantTables(tx))).tables.find((table) => table.table === 'ai_budget') as TableMeasure;
      const before = await measure();
      await harness.base.owner(tenant, [["update machvon.ai_budget set effective_from = '2026-02-01' where limit_vnd = 1000", []]]);
      const after = await measure();
      expect(after.rows).toBe(before.rows);
      expect(after.money).toEqual(before.money);
      expect(after.checksum).not.toBe(before.checksum);
      // Put back, the same rows give the same checksum again.
      await harness.base.owner(tenant, [["update machvon.ai_budget set effective_from = '2026-01-01' where limit_vnd = 1000", []]]);
      expect((await measure()).checksum).toBe(before.checksum);
    });

    it('AC-ST-SAS-018-3: reads the same checksum whatever the time zone and the date style of the session that measures', async () => {
      const { tenant } = await seeded();
      const measure = async (settings: ReadonlyArray<readonly [string, string]>) =>
        (
          await harness.tenants.withSnapshot(ctxOf(tenant), async (tx) => {
            for (const [name, value] of settings) await tx.query('select set_config($1, $2, true)', [name, value]);
            return measureTenantTables(tx);
          })
        ).tables.find((table) => table.table === 'ai_budget') as TableMeasure;
      const plain = await measure([]);
      expect(await measure([['TimeZone', 'Asia/Tokyo'], ['DateStyle', 'German, DMY']])).toEqual(plain);
      expect(await measure([['TimeZone', 'America/Los_Angeles'], ['IntervalStyle', 'sql_standard'], ['extra_float_digits', '-3']])).toEqual(plain);
    });

    it('names the tables of the tenant plane that the worker cannot read, and measures all the others', async () => {
      const { tenant } = await seeded();
      const measured = await harness.tenants.withSnapshot(ctxOf(tenant), (tx) => measureTenantTables(tx));
      expect(measured.unreadable).toEqual(expect.arrayContaining(['tenant_theme_draft', 'tenant_theme_review', 'tenant_theme_asset']));
      expect(measured.tables.map((table) => table.table)).not.toContain('tenant_theme_draft');
      expect(measured.tables.length).toBeGreaterThan(300);
      expect(measured.tables.map((table) => table.table)).toEqual([...measured.tables.map((table) => table.table)].sort());
    });
  });

  describe('carrying a promotion along', () => {
    it('AC-ST-SAS-018-1 UAT-AC150: copies and compares as soon as the window comes, waits for the approval, switches inside the freeze and completes after 24 hours of observation', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      const runner = runnerFor(mover);
      const migration = await start(tenant, silo, minutes(10));
      // The window has not come: nothing is copied.
      expect(await runner.run(ctxOf(tenant), NOW)).toEqual({ open: 1, mismatch: 0, failing: 0 });
      expect(mover.calls).toEqual([]);
      expect((await find(tenant, migration.id)).status).toBe('Planned');
      // The window has come: copied, compared, and waiting for the approval of another System Admin.
      await runner.run(ctxOf(tenant), minutes(10));
      const waiting = await find(tenant, migration.id);
      expect(waiting).toMatchObject({ status: 'AwaitingCutover', checksumMatch: true, lastErrorCode: null });
      expect(waiting.verificationReportRef).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(waiting.report?.unreadable).toContain('tenant_theme_draft');
      const result = migrationReconciliation(waiting);
      expect(result?.match).toBe(true);
      expect(result?.tables.find((table) => table.table === 'ai_budget')).toMatchObject({ sourceRows: 2, targetRows: 2, match: true, money: [{ column: 'limit_vnd', source: (BigInt(BIG) + 1000n).toString(), target: (BigInt(BIG) + 1000n).toString(), match: true }] });
      expect(mover.calls.slice(0, 2)).toEqual([`copy:${tenant}`, `measureTarget:${tenant}`]);
      // Another System Admin approves: writes are frozen, and the next pass sends the last difference, compares and switches.
      const frozen = await approve(tenant, migration.id, minutes(12));
      expect((await harness.tenantRow(tenant)).write_frozen_until).toEqual(minutes(42));
      expect((await runner.run(ctxOf(tenant), minutes(13))).failing).toBe(0);
      const switched = await find(tenant, migration.id);
      expect(switched).toMatchObject({ status: 'Switched', switchedAt: minutes(13), checksumMatch: true, version: frozen.version + 1 });
      expect(await harness.tenantRow(tenant)).toMatchObject({ placement_id: silo, isolation_mode: 'SILO', write_frozen_until: null });
      // Watched for 24 hours.
      await runner.run(ctxOf(tenant), new Date(hours(24, minutes(13)).getTime() - 1));
      expect((await find(tenant, migration.id)).status).toBe('Switched');
      await runner.run(ctxOf(tenant), hours(24, minutes(13)));
      const completed = await find(tenant, migration.id);
      expect(completed).toMatchObject({ status: 'Completed', completedAt: hours(24, minutes(13)) });
      expect(completed.sourcePurgeDueAt).toEqual(days(30, hours(24, minutes(13))));
      expect(migrationReconciliation(completed)).toMatchObject({ match: true });
      // The approval is the System Admin's command (audited by the pipeline of the API, see the test over HTTP); the worker audits its own steps.
      expect(await actionsOf(tenant, migration.id)).toEqual([
        'tenant.placement_migration_copy_started',
        'tenant.placement_migration_verified',
        'tenant.placement_switched',
        'tenant.placement_migration_completed',
      ]);
    }, 120_000);

    it('AC-ST-SAS-018-1 UAT-AC150: a copy with one row different is waiting with a verdict that disagrees, and the next pass, once the copy has caught up, finds it in agreement', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      mover.tamperAfterNext(oneRowOff);
      const runner = runnerFor(mover);
      const migration = await start(tenant, silo);
      expect(await runner.run(ctxOf(tenant), NOW)).toEqual({ open: 1, mismatch: 1, failing: 0 });
      const off = await find(tenant, migration.id);
      expect(off).toMatchObject({ status: 'AwaitingCutover', checksumMatch: false });
      expect(migrationReconciliation(off)?.mismatchedTables).toEqual(['ai_budget']);
      await expect(approve(tenant, migration.id, minutes(1))).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED', status: 422 });
      await expect(approve(tenant, migration.id, minutes(1), REQUESTER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await runner.run(ctxOf(tenant), minutes(2))).toEqual({ open: 1, mismatch: 0, failing: 0 });
      expect(await find(tenant, migration.id)).toMatchObject({ status: 'AwaitingCutover', checksumMatch: true });
      expect((await approve(tenant, migration.id, minutes(3))).status).toBe('CutoverFrozen');
      await runner.run(ctxOf(tenant), minutes(4));
      expect((await find(tenant, migration.id)).status).toBe('Switched');
    }, 120_000);

    it('keeps the comparison fresh while the cutover waits: a comparison older than ten minutes does not support an approval', async () => {
      const { tenant, silo } = await seeded();
      const runner = runnerFor(new MockPlacementMover());
      const migration = await start(tenant, silo);
      await runner.run(ctxOf(tenant), NOW);
      await expect(approve(tenant, migration.id, minutes(11))).rejects.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED', extensions: { reason: 'STALE' } });
      await runner.run(ctxOf(tenant), minutes(10));
      expect((await find(tenant, migration.id)).verifiedAt).toEqual(minutes(10));
      expect((await approve(tenant, migration.id, minutes(11))).status).toBe('CutoverFrozen');
    }, 120_000);

    it('compares again once writes are frozen, and rolls the migration back when the copy disagrees then: the routing is never changed and writes work again', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      const runner = runnerFor(mover);
      const migration = await start(tenant, silo);
      await runner.run(ctxOf(tenant), NOW);
      await approve(tenant, migration.id, minutes(1));
      // The last difference is sent once writes are frozen, and the copy is left with a row more than the original.
      mover.tamperAfterNext(oneRowMore);
      await runner.run(ctxOf(tenant), minutes(2));
      const rolled = await find(tenant, migration.id);
      expect(rolled).toMatchObject({ status: 'RolledBack', endedBy: null, endReason: 'FINAL_VERIFICATION_FAILED', checksumMatch: false });
      expect(migrationReconciliation(rolled)?.mismatchedTables).toEqual(['ai_budget']);
      expect(await harness.tenantRow(tenant)).toMatchObject({ isolation_mode: 'POOL', write_frozen_until: null });
      // The copy is destroyed, once.
      expect(mover.holds({ tenantId: tenant, toPlacementId: silo })).toBe(false);
      expect((await find(tenant, migration.id)).targetDiscardedAt).not.toBeNull();
      expect(await actionsOf(tenant, migration.id)).toContain('tenant.placement_migration_rolled_back');
    }, 120_000);

    it('rolls the migration back when the freeze has run out before the switch, and does not switch late', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      const migration = await start(tenant, silo);
      await runnerFor(mover).run(ctxOf(tenant), NOW);
      await approve(tenant, migration.id, minutes(1));
      await runnerFor(mover).run(ctxOf(tenant), minutes(31));
      expect(await find(tenant, migration.id)).toMatchObject({ status: 'RolledBack', endedBy: null, endReason: 'FREEZE_EXPIRED' });
      expect(await harness.tenantRow(tenant)).toMatchObject({ isolation_mode: 'POOL', write_frozen_until: null });
      expect(mover.holds({ tenantId: tenant, toPlacementId: silo })).toBe(false);
    }, 120_000);

    it('does not switch when the freeze runs out while the last comparison is made, whatever time the pass started at', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      const migration = await start(tenant, silo);
      await runnerFor(mover).run(ctxOf(tenant), NOW);
      await approve(tenant, migration.id, minutes(1));
      // The pass began inside the freeze; the clock says it is over when the routing would be switched.
      const clock = () => minutes(31);
      await runnerFor(mover, clock).run(ctxOf(tenant), minutes(20));
      expect(await find(tenant, migration.id)).toMatchObject({ status: 'RolledBack', endReason: 'FREEZE_EXPIRED' });
      expect((await harness.tenantRow(tenant)).isolation_mode).toBe('POOL');
    }, 120_000);

    it('destroys the copy of a migration that was aborted, and keeps the pass going for the others', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      const runner = runnerFor(mover);
      const migration = await start(tenant, silo);
      await runner.run(ctxOf(tenant), NOW);
      expect(mover.holds({ tenantId: tenant, toPlacementId: silo })).toBe(true);
      const waiting = await find(tenant, migration.id);
      await harness.inTenant(tenant, (tx) => store.abort(tx, recorder(APPROVER), { migrationId: migration.id, actor: APPROVER, reason: 'The customer asked to stop the promotion.', expectedVersion: waiting.version }, minutes(5), { targetIntact: async () => true }));
      await runner.run(ctxOf(tenant), minutes(6));
      expect(mover.holds({ tenantId: tenant, toPlacementId: silo })).toBe(false);
      const ended = await find(tenant, migration.id);
      expect(ended).toMatchObject({ status: 'Aborted', targetDiscardedAt: minutes(6) });
      // Nothing is left to do for it.
      const calls = mover.calls.length;
      await runner.run(ctxOf(tenant), minutes(7));
      expect(mover.calls.length).toBe(calls);
    }, 120_000);

    it('deletes the old data of a completed migration after 30 days, and keeps it while a legal hold is in force', async () => {
      const held = await seeded();
      const free = await seeded();
      const mover = new MockPlacementMover();
      const runner = runnerFor(mover);
      const migrations: string[] = [];
      for (const { tenant, silo } of [held, free]) {
        const migration = await start(tenant, silo);
        migrations.push(migration.id);
        await runner.run(ctxOf(tenant), NOW);
        await approve(tenant, migration.id, minutes(1));
        await runner.run(ctxOf(tenant), minutes(2));
        await runner.run(ctxOf(tenant), hours(25));
      }
      await harness.admin("insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, placed_by) values ($1, gen_random_uuid(), '{}'::jsonb, 'Decision 12/QD', 'Investigation', now() - interval '1 day', $2)", [held.tenant, REQUESTER]);
      const due = days(30, hours(25));
      await runner.run(ctxOf(held.tenant), new Date(due.getTime() - 1));
      await runner.run(ctxOf(free.tenant), new Date(due.getTime() - 1));
      expect(mover.purgedSource(free.tenant)).toBe(false);
      await runner.run(ctxOf(held.tenant), due);
      await runner.run(ctxOf(free.tenant), due);
      expect(mover.purgedSource(held.tenant)).toBe(false);
      expect((await find(held.tenant, migrations[0] as string)).sourcePurgedAt).toBeNull();
      expect(mover.purgedSource(free.tenant)).toBe(true);
      expect((await find(free.tenant, migrations[1] as string)).sourcePurgedAt).toEqual(due);
      // Released, the old data goes at the next pass.
      await harness.admin('update machvon.legal_hold set released_at = now() where tenant_id = $1', [held.tenant]);
      await runner.run(ctxOf(held.tenant), days(1, due));
      expect(mover.purgedSource(held.tenant)).toBe(true);
    }, 180_000);
  });

  describe('when a step fails', () => {
    it('leaves the migration where it is with the class of the failure, tries again at the next pass and carries on', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      const runner = runnerFor(mover);
      const migration = await start(tenant, silo);
      mover.failNext('copy', Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 password=secret'), { code: 'ECONNREFUSED' }));
      expect(await runner.run(ctxOf(tenant), NOW)).toEqual({ open: 1, mismatch: 0, failing: 1 });
      const stuck = await find(tenant, migration.id);
      expect(stuck).toMatchObject({ status: 'Copying', lastErrorCode: 'ECONNREFUSED' });
      expect(JSON.stringify(stuck)).not.toContain('secret');
      expect(await runner.run(ctxOf(tenant), minutes(1))).toEqual({ open: 1, mismatch: 0, failing: 0 });
      expect(await find(tenant, migration.id)).toMatchObject({ status: 'AwaitingCutover', lastErrorCode: null });
    }, 120_000);

    it('claims nothing in an environment without a mover: the copy never starts and the failure says so', async () => {
      const { tenant, silo } = await seeded();
      const migration = await start(tenant, silo);
      const pressure = await runnerFor(new UnboundPlacementMover()).run(ctxOf(tenant), NOW);
      expect(pressure).toEqual({ open: 1, mismatch: 0, failing: 1 });
      expect(await find(tenant, migration.id)).toMatchObject({ status: 'Copying', lastErrorCode: 'PLACEMENT_MOVER_UNAVAILABLE', checksumMatch: null });
      expect(await harness.tenantRow(tenant)).toMatchObject({ isolation_mode: 'POOL' });
    }, 120_000);

    it('leaves a migration alone that somebody moved while the step ran, without a failure to show for it', async () => {
      const { tenant, silo } = await seeded();
      const migration = await start(tenant, silo);
      class AbortsWhileSyncing extends MockPlacementMover {
        override async sync(move: MoveRef, source: MoveSource): Promise<void> {
          await super.sync(move, source);
          const row = (await harness.inTenant(tenant, (tx) => store.find(tx, migration.id))) as MigrationRow;
          await harness.inTenant(tenant, (tx) => store.abort(tx, recorder(APPROVER), { migrationId: migration.id, actor: APPROVER, reason: 'The customer asked to stop the promotion.', expectedVersion: row.version }, minutes(2), { targetIntact: async () => true }));
        }
      }
      const runner = runnerFor(new AbortsWhileSyncing());
      await runner.run(ctxOf(tenant), NOW);
      await runner.run(ctxOf(tenant), minutes(1));
      const ended = await find(tenant, migration.id);
      expect(ended).toMatchObject({ status: 'Aborted', lastErrorCode: null });
    }, 120_000);
  });

  describe('rolling back a switched migration', () => {
    it('is possible while the silo holds what the last comparison saw, and refused once it holds something else', async () => {
      const { tenant, silo } = await seeded();
      const mover = new MockPlacementMover();
      const runner = runnerFor(mover);
      const migration = await start(tenant, silo);
      await runner.run(ctxOf(tenant), NOW);
      await approve(tenant, migration.id, minutes(1));
      await runner.run(ctxOf(tenant), minutes(2));
      const switched = await find(tenant, migration.id);
      expect(switched.status).toBe('Switched');
      expect(await targetIntact(mover, switched)).toBe(true);
      mover.tamper({ tenantId: tenant, toPlacementId: silo }, (tables) => void ((tables.find((table) => table.table === 'ai_budget') as TableMeasure).rows += 1));
      expect(await targetIntact(mover, switched)).toBe(false);
      expect(reconcileCopy([], await mover.measureTarget(moveOf(switched))).match).toBe(false);
      expect(await targetIntact(mover, { ...switched, report: null })).toBe(false);
    }, 120_000);
  });

  describe('a copy that differs in a column that is neither key nor money (BR-SAS-05)', () => {
    /** A mover whose copy of the budgets is read from the live rows, the way a real mover reads the silo: a write to those rows is a write to the silo. The rest of the copy is the picture of the stand-in. */
    class LiveCopyMover extends MockPlacementMover {
      override async measureTarget(move: MoveRef): Promise<TableMeasure[]> {
        const picture = await super.measureTarget(move);
        const live = (await harness.tenants.withSnapshot(ctxOf(move.tenantId), (tx) => measureTenantTables(tx))).tables.find((table) => table.table === 'ai_budget');
        return picture.map((table) => (table.table === 'ai_budget' && live !== undefined ? live : table));
      }
    }

    it('AC-ST-SAS-018-3 UAT-AC150: reports a MISMATCH for the table when the copy differs in a text or date column, though rows, keys and money agree', async () => {
      const { tenant } = await seeded();
      const picture = (await harness.tenants.withSnapshot(ctxOf(tenant), (tx) => measureTenantTables(tx))).tables;
      expect(reconcileCopy(picture, picture).match).toBe(true);
      await harness.base.owner(tenant, [["update machvon.ai_budget set period = 'YEAR' where limit_vnd = 1000", []]]);
      const original = (await harness.tenants.withSnapshot(ctxOf(tenant), (tx) => measureTenantTables(tx))).tables;
      const result = reconcileCopy(original, picture);
      expect(result.match).toBe(false);
      expect(result.mismatchedTables).toEqual(['ai_budget']);
      const line = result.tables.find((entry) => entry.table === 'ai_budget');
      expect(line).toMatchObject({ rowsMatch: true, moneyMatch: true, checksumMatch: false });
    });

    it('AC-ST-SAS-018-3: measures the record of the promotion by its key alone, so the steps of the promotion are no change to the copy', async () => {
      const { tenant, silo } = await seeded();
      const migration = await start(tenant, silo);
      const measure = async () => (await harness.tenants.withSnapshot(ctxOf(tenant), (tx) => measureTenantTables(tx))).tables.find((table) => table.table === 'tenant_placement_migration') as TableMeasure;
      const before = await measure();
      expect(before.rows).toBe(1);
      await runnerFor(new MockPlacementMover()).run(ctxOf(tenant), NOW);
      expect((await find(tenant, migration.id)).status).toBe('AwaitingCutover');
      expect(await measure()).toEqual(before);
    }, 120_000);

    it('AC-ST-SAS-018-3 UAT-AC150: refuses to roll back a switched migration once a column that is neither key nor money was updated in the silo', async () => {
      const { tenant, silo } = await seeded();
      const mover = new LiveCopyMover();
      const runner = runnerFor(mover);
      const migration = await start(tenant, silo);
      await runner.run(ctxOf(tenant), NOW);
      await approve(tenant, migration.id, minutes(1));
      await runner.run(ctxOf(tenant), minutes(2));
      const switched = await find(tenant, migration.id);
      expect(switched.status).toBe('Switched');
      expect(await targetIntact(mover, switched)).toBe(true);
      await harness.base.owner(tenant, [["update machvon.ai_budget set period = 'YEAR' where limit_vnd = 1000", []]]);
      expect(await targetIntact(mover, switched)).toBe(false);
      const attempt = harness.inTenant(tenant, (tx) =>
        store.abort(tx, recorder(APPROVER), { migrationId: migration.id, actor: APPROVER, reason: 'The customer asked to go back to the pool.', expectedVersion: switched.version }, minutes(3), { targetIntact: (row) => targetIntact(mover, row) }),
      );
      await expect(attempt).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID', status: 409 });
      expect((await find(tenant, migration.id)).status).toBe('Switched');
    }, 120_000);
  });

  it('visits only the migrations of the tenant it is given', async () => {
    const one = await seeded();
    const two = await seeded();
    const a = await start(one.tenant, one.silo);
    const b = await start(two.tenant, two.silo);
    const mover = new MockPlacementMover();
    await runnerFor(mover).run(ctxOf(one.tenant), NOW);
    expect((await find(one.tenant, a.id)).status).toBe('AwaitingCutover');
    expect((await find(two.tenant, b.id)).status).toBe('Planned');
    expect(mover.calls.every((call) => call.endsWith(one.tenant))).toBe(true);
  }, 120_000);
});
