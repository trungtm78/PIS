import { randomUUID } from 'node:crypto';
import { FEED_POLICY_DEFAULTS, feedGeneratorMove, feedGeneratorParamsOf, fileSha256, generateFeedRecords, validateFeedRecords } from '@machvon/kernel';
import type { FeedGeneratorParams } from '@machvon/kernel';
import { FeedImportAdapter } from '../src/finance-feed-import';
import { FeedDifferenceStore, FeedMappingStore } from '../src/finance-feed-mapping-store';
import { ProvinceFactsReader } from '../src/finance-feed-reader';
import { emptyProvinceFacts } from '../src/province-facts';
import { FeedProvinceFactsReader, SnapshotOrFeedFactsReader } from '../src/province-facts-feed';
import { FeedConnectionStore, FeedRecordStore, feedStateOf, storedGeneratorParams } from '../src/finance-feed-store';
import { previewFileImport } from '../src/file-import-preview';
import { FileImportStore } from '../src/file-import-store';
import type { TenantTx } from '../src/tenant-database';
import { seedBidPackage } from './support/bid-proposal-fixtures';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const connection = new FeedConnectionStore();
const records = new FeedRecordStore();
const mappings = new FeedMappingStore();
const differences = new FeedDifferenceStore();
const reader = new ProvinceFactsReader();
const imports = new FileImportStore();
const LOADER = 1;
const CHECKER = 2;
const THIRD = 3;
const NOW = new Date('2026-11-08T03:00:00Z');
const REASON = 'A reason of enough length.';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = LOADER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const bytes = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

const PROJECT_HEADER = 'feed_project_code,as_of,project_name,sector_code,district_code,investor_code,our_project_code';
const PLAN_HEADER = 'feed_project_code,fiscal_year,fund_code,plan_amount,as_of';
const DISBURSEMENT_HEADER = 'feed_project_code,fiscal_year,month,fund_code,disbursed_month,disbursed_cumulative,reported_on,as_of';

async function apply(kind: 'PROJECT' | 'PLAN' | 'DISBURSEMENT' | 'MILESTONE', file: Uint8Array, member = LOADER) {
  const adapter = new FeedImportAdapter(kind, { actor: memberId(member), now: NOW });
  const result = await as(
    (tx) => imports.run(tx, { adapter, bytes: file, fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`, expectedSha256: fileSha256(file), importedBy: memberId(member), fallbackOwnerId: memberId(member), correlationId: randomUUID(), cursorScope: 'DEFAULT', now: NOW }),
    member,
  );
  return { result, adapter };
}

const PARAMS: FeedGeneratorParams = { seed: 7, fiscalYear: 2026, currentMonth: 9, projectCount: 12, lateUnits: 2, delayedPct: 25, aheadPct: 15, discrepancies: 3 };

describe('the feed of the Finance Department (FEED-1)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      for (const member of [LOADER, CHECKER, THIRD]) await harness.seedMembership(tenant, member, 1);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the connection', () => {
    it('shows a tenant that never used it as on, with the generator stopped, never received, and writes nothing to show it', async () => {
      const row = await as((tx) => connection.current(tx));
      expect(row).toMatchObject({ id: null, connectorCode: 'fin.sotaichinh', enabled: true, layoutVersion: 'WORKING-ASSUMPTION-FIN-2026.1', generatorState: 'STOPPED', generatorEpoch: 0, version: 1 });
      const health = await as((tx) => connection.health(tx, NOW, row));
      expect(health.health).toMatchObject({ status: 'NEVER_RECEIVED', ageHours: null, alert: null, acceptance: 'PENDING_EXTERNAL' });
      expect(health.freshness).toMatchObject({ source: 'DEFAULT', unverified: true, params: { max_age_hours: 48, warn_after_hours: 24 } });
      expect(health.policy.params).toEqual(FEED_POLICY_DEFAULTS);
      expect((await owner('select 1 from machvon.finance_feed_connection')).length).toBe(0);
    });

    it('is given to the tenant once: the switch, the registry entry (Draft, PROPOSED) and four positions', async () => {
      const first = await as((tx) => connection.ensure(tx, memberId(LOADER)));
      expect(first.created).toBe(true);
      const second = await as((tx) => connection.ensure(tx, memberId(THIRD)));
      expect(second.created).toBe(false);
      expect(second.row.id).toBe(first.row.id);
      expect(await owner('select status, adapter_status, mode from machvon.integration_connector where connector_code = $1', ['fin.sotaichinh'])).toEqual([{ status: 'Draft', adapter_status: 'PROPOSED', mode: 'FILE_IMPORT' }]);
      expect((await as((tx) => connection.positions(tx))).map((position) => [position.kind, position.cursorStatus])).toEqual([['PROJECT', 'ACTIVE'], ['PLAN', 'ACTIVE'], ['DISBURSEMENT', 'ACTIVE'], ['MILESTONE', 'ACTIVE']]);
    });

    it('is switched off with a reason and a version, and says who did it in an event nobody can change', async () => {
      const current = await as((tx) => connection.current(tx));
      expect((await refusal(as((tx) => connection.setState(tx, 99, { enabled: false, reason: REASON }, memberId(LOADER))))).code).toBe('VERSION_CONFLICT');
      expect((await refusal(as((tx) => connection.setState(tx, current.version, { enabled: false, reason: 'short' }, memberId(LOADER))))).detail).toBe('reason');
      const done = await as((tx) => connection.setState(tx, current.version, { enabled: false, reason: REASON }, memberId(LOADER)));
      expect([done.row.enabled, done.row.version, done.row.stateReason]).toEqual([false, current.version + 1, REASON]);
      expect((await as((tx) => connection.events(tx, 5))).map((event) => event.action)).toEqual(['DISABLED', 'CREATED']);
      expect(await databaseRefusal(owner('update machvon.finance_feed_connection_event set reason = $1', ['changed again here']))).toMatch(/append-only/);
      expect(await databaseRefusal(owner('update machvon.finance_feed_connection set enabled = true'))).toMatch(/switched on or off with a reason/);
      const back = await as((tx) => connection.setState(tx, done.row.version, { enabled: true, reason: REASON }, memberId(CHECKER)));
      expect(back.row.enabled).toBe(true);
    });

    it('is not seen by another tenant', async () => {
      expect((await as((tx) => connection.current(tx), LOADER, TENANT_B)).id).toBeNull();
    });
  });

  describe('a file: dry run, apply once, the same file again, and the record store', () => {
    const project = bytes(PROJECT_HEADER, 'F-100,2026-01-10,Road one,GT,D01,CDT-1,', 'F-101,2026-01-10,Road two,YT,D02,CDT-2,', 'F-102,2026-01-10,Bridge,GT,D03,CDT-1,');
    const plan = bytes(PLAN_HEADER, 'F-100,2026,NSTW,1000000,2026-01-20', 'F-101,2026,NSDP,500000,2026-01-20', 'F-102,2026,NSTW,700000,2026-01-20');
    const disbursement = bytes(
      DISBURSEMENT_HEADER,
      'F-100,2026,1,NSTW,100000,100000,2026-02-03,2026-02-03',
      'F-100,2026,2,NSTW,200000,300000,2026-03-03,2026-03-03',
      'F-101,2026,1,NSDP,50000,50000,2026-02-08,2026-02-08',
      'F-102,2026,1,NSTW,70000,70000,2026-02-04,2026-02-04',
      'F-102,2026,13,NSTW,1,1,2026-02-04,2026-02-04',
    );

    it('previews a file row by row without writing anything', async () => {
      const adapter = new FeedImportAdapter('DISBURSEMENT', { actor: memberId(LOADER), now: NOW });
      const preview = await as((tx) => previewFileImport(tx, adapter, disbursement, { maxRows: 5000 }));
      expect(preview.counts).toMatchObject({ total: 5, valid: 4, errors: 1 });
      expect(preview.rows.find((row) => row.status === 'ERROR')).toMatchObject({ code: 'MONTH_INVALID', field: 'month' });
      expect((await owner('select 1 from machvon.finance_feed_record')).length).toBe(0);
    });

    it('applies the three files once each, keeping every valid row as an append-only record under its import', async () => {
      for (const [kind, file] of [['PROJECT', project], ['PLAN', plan], ['DISBURSEMENT', disbursement]] as const) {
        const { result, adapter } = await apply(kind, file);
        expect(result.outcome).toBe('APPLIED');
        expect(adapter.written.records).toBe(kind === 'DISBURSEMENT' ? 4 : 3);
        await as((tx) => records.writeFileRun(tx, { kind, layoutVersion: 'WORKING-ASSUMPTION-FIN-2026.1', fileSha256: fileSha256(file), importId: result.importId, counts: { total: result.counts.total, written: result.counts.applied, skipped: result.counts.duplicate + result.counts.conflict, rejected: result.counts.quarantined }, asOfLatest: adapter.written.asOfLatest }, memberId(LOADER)));
      }
      expect((await owner<{ n: string }>("select count(*)::text as n from machvon.finance_feed_record where channel = 'FILE' and import_id is not null"))[0]?.n).toBe('10');
      expect(await databaseRefusal(owner('delete from machvon.finance_feed_record'))).toMatch(/append-only/);
      expect(await databaseRefusal(owner("update machvon.finance_feed_record set feed_project_code = 'X'"))).toMatch(/append-only/);
      expect(await databaseRefusal(owner('delete from machvon.finance_feed_run'))).toMatch(/append-only/);
    });

    it('says "already applied" for the same file again and holds one run per file', async () => {
      const { result } = await apply('DISBURSEMENT', disbursement);
      expect(result.outcome).toBe('ALREADY_IMPORTED');
      expect(await databaseRefusal(owner("insert into machvon.finance_feed_run (tenant_id, kind, channel, layout_version, file_sha256, file_import_id, records_total, records_written, imported_by) select tenant_id, kind, channel, layout_version, file_sha256, file_import_id, 1, 1, imported_by from machvon.finance_feed_run where kind = 'PLAN'"))).toMatch(/finance_feed_run_file_uq|duplicate key/);
      const runs = await as((tx) => connection.listRuns(tx, { limit: 10, after: undefined }));
      expect(runs.map((run) => [run.channel, run.kind, run.counts.written])).toEqual(expect.arrayContaining([['FILE', 'PROJECT', 3], ['FILE', 'DISBURSEMENT', 4]]));
      const current = await as((tx) => connection.current(tx));
      expect((await as((tx) => connection.health(tx, new Date(), current))).lastRunAt).not.toBeNull();
    });

    it('reads the facts by sector, district, fund and month through the reader', async () => {
      const bySector = await as((tx) => reader.facts(tx, { fiscalYear: 2026 }, 'sector'));
      expect(bySector.groups.map((group) => [group.key, group.plan, group.disbursed])).toEqual([['GT', '1700000', '370000'], ['YT', '500000', '50000']]);
      expect(bySector.channels).toEqual(['FILE']);
      const byMonth = await as((tx) => reader.facts(tx, { fiscalYear: 2026 }, 'month'));
      expect(byMonth.groups.slice(0, 2).map((group) => [group.disbursed, group.cumulative])).toEqual([['220000', '220000'], ['200000', '420000']]);
      const quality = await as((tx) => reader.quality(tx, { fiscalYear: 2026, month: 1, today: '2026-02-20', policy: FEED_POLICY_DEFAULTS }));
      expect(quality.completeness).toMatchObject({ numerator: 2, denominator: 2, pct: '100.00' });
      // CDT-2 reported on 2026-02-08, after the due day (2026-02-05).
      expect(quality.timeliness).toMatchObject({ numerator: 1, denominator: 2, pct: '50.00' });
      expect(quality.units.map((unit) => [unit.investorCode, unit.status])).toEqual([['CDT-1', 'REPORTED_ON_TIME'], ['CDT-2', 'REPORTED_LATE']]);
      const later = await as((tx) => reader.quality(tx, { fiscalYear: 2026, month: 3, today: '2026-04-20', policy: FEED_POLICY_DEFAULTS }));
      expect(later.lateUnits.map((unit) => unit.investorCode)).toEqual(['CDT-1', 'CDT-2']);
    });

    it('is not seen by another tenant', async () => {
      expect((await as((tx) => reader.facts(tx, { fiscalYear: 2026 }, 'sector'), LOADER, TENANT_B)).groups).toEqual([]);
    });
  });

  describe('the generator through the same store', () => {
    it('starts, writes its records under a run and an epoch, repeats nothing on a tick and replaces them on a reseed', async () => {
      const current = await as((tx) => connection.current(tx));
      const start = feedGeneratorMove(feedStateOf(current), { action: 'START', reason: REASON, body: { seed: 7, fiscal_year: 2026, current_month: 9, project_count: 12, late_units: 2, discrepancies: 3 }, today: '2026-11-08', stored: null });
      const started = await as((tx) => connection.applyGenerator(tx, current.version, { action: 'START', decision: start, anchors: undefined }, memberId(LOADER)));
      expect([started.row.generatorState, started.row.generatorEpoch]).toEqual(['RUNNING', 1]);
      const params = storedGeneratorParams(started.row, '2026-11-08') as FeedGeneratorParams;
      const batch = generateFeedRecords(params);
      expect(validateFeedRecords(batch).rejected).toEqual([]);
      const first = await as((tx) => records.writeRun(tx, { channel: 'GENERATOR', kind: null, action: 'GENERATOR_START', layoutVersion: 'WORKING-ASSUMPTION-FIN-2026.1', records: batch, rejected: 0, epoch: 1, seed: params.seed }, memberId(LOADER)));
      expect(first.written).toBe(batch.length);
      const again = await as((tx) => records.writeRun(tx, { channel: 'GENERATOR', kind: null, action: 'GENERATOR_TICK', layoutVersion: 'WORKING-ASSUMPTION-FIN-2026.1', records: batch, rejected: 0, epoch: 1, seed: params.seed }, memberId(LOADER)));
      expect([again.written, again.skipped]).toEqual([0, batch.length]);
      const generated = await as((tx) => reader.facts(tx, { fiscalYear: 2026 }, 'sector'));
      expect(generated.channels).toEqual(['FILE', 'GENERATOR']);
      expect(generated.totals.projects).toBe(15);

      const tick = feedGeneratorMove(feedStateOf(started.row), { action: 'TICK', reason: REASON, body: {}, today: '2026-11-08', stored: params });
      const ticked = await as((tx) => connection.applyGenerator(tx, started.row.version, { action: 'TICK', decision: tick, anchors: undefined }, memberId(LOADER)));
      const next = generateFeedRecords(storedGeneratorParams(ticked.row, '2026-11-08') as FeedGeneratorParams);
      const added = await as((tx) => records.writeRun(tx, { channel: 'GENERATOR', kind: null, action: 'GENERATOR_TICK', layoutVersion: 'WORKING-ASSUMPTION-FIN-2026.1', records: next, rejected: 0, epoch: 1, seed: params.seed }, memberId(LOADER)));
      expect(added.written).toBeGreaterThan(0);
      expect(added.written).toBeLessThan(next.length);

      const reseed = feedGeneratorMove(feedStateOf(ticked.row), { action: 'RESEED', reason: REASON, body: { seed: 8 }, today: '2026-11-08', stored: storedGeneratorParams(ticked.row, '2026-11-08') });
      const reseeded = await as((tx) => connection.applyGenerator(tx, ticked.row.version, { action: 'RESEED', decision: reseed, anchors: undefined }, memberId(LOADER)));
      expect(reseeded.row.generatorEpoch).toBe(2);
      // The records of the epoch before are no longer read: only the file's three projects remain until the new epoch is written.
      expect((await as((tx) => reader.facts(tx, { fiscalYear: 2026 }, 'sector'))).totals.projects).toBe(3);
      expect(await databaseRefusal(owner('update machvon.finance_feed_connection set generator_epoch = 0'))).toMatch(/only goes up/);
    });

    it('keeps the generator the same on every start from the same parameters', () => {
      expect(generateFeedRecords(feedGeneratorParamsOf({ seed: 7 }, '2026-11-08'))).toEqual(generateFeedRecords(feedGeneratorParamsOf({ seed: 7 }, '2026-11-08')));
      expect(PARAMS.seed).toBe(7);
    });
  });

  describe('the codes of the feed on the crosswalk: proposed by one person, approved by another', () => {
    let ours: { projectId: string; projectCode: string };

    beforeAll(async () => {
      ours = await seedBidPackage(harness);
      const file = bytes(PROJECT_HEADER, `F-200,2026-01-10,Mapped road,GT,D01,CDT-9,${ours.projectCode}`, 'F-201,2026-01-10,Unknown ours,GT,D01,CDT-9,NO-SUCH-PROJECT');
      const { result, adapter } = await apply('PROJECT', file);
      expect(result.outcome).toBe('APPLIED');
      expect(adapter.written).toMatchObject({ records: 2, proposals: 1, differences: 1 });
    });

    it('proposes the exact mapping from the record that names our code and opens a difference for the code that is not ours', async () => {
      const list = await as((tx) => mappings.list(tx, {}, { limit: 10, after: undefined }));
      expect(list.map((row) => [row.externalCode, row.ourCode, row.status, row.matchMethod])).toEqual([['F-200', ours.projectCode, 'PROPOSED', 'IMPORT']]);
      const items = await owner<{ code: string }>("select code from machvon.file_import_reconciliation_item where connector_code = 'FIN_PROJECT_FILE'");
      expect(items.map((item) => item.code)).toEqual(['FEED_OUR_CODE_UNKNOWN']);
      expect((await as((tx) => mappings.unmapped(tx, 0, 50))).items.map((item) => item.feedProjectCode)).toEqual(expect.arrayContaining(['F-101', 'F-102', 'F-201']));
    });

    it('is approved by someone other than the maker and then the same code cannot go to another project', async () => {
      const [row] = await as((tx) => mappings.list(tx, { status: 'PROPOSED' }, { limit: 10, after: undefined }));
      if (row === undefined) throw new Error('no mapping');
      expect((await refusal(as((tx) => mappings.decide(tx, row.id, row.version, { move: 'APPROVE', reason: REASON }, memberId(LOADER), NOW), LOADER))).code).toBe('SELF_APPROVAL_DENIED');
      const done = await as((tx) => mappings.decide(tx, row.id, row.version, { move: 'APPROVE', reason: REASON }, memberId(CHECKER), NOW), CHECKER);
      expect([done.row.status, done.row.approvedBy]).toEqual(['ACTIVE', memberId(CHECKER)]);
      const other = await seedBidPackage(harness);
      expect((await refusal(as((tx) => mappings.propose(tx, { ourCode: other.projectCode, externalCode: 'F-200', validFrom: null, validUntil: null, method: 'MANUAL', reason: REASON }, memberId(THIRD), NOW), THIRD))).code).toBe('CROSSWALK_DUPLICATE');
      expect((await refusal(as((tx) => mappings.propose(tx, { ourCode: other.projectCode, externalCode: 'NOT-SENT', validFrom: null, validUntil: null, method: 'MANUAL', reason: REASON }, memberId(THIRD), NOW), THIRD))).detail).toBe('external_code');
      expect((await as((tx) => mappings.counts(tx))).ACTIVE).toBe(1);
    });
  });

  describe('the differences against our own figures: an owner, a resolution, never a maker', () => {
    let ours: { projectId: string; projectCode: string };
    const FILE_PLAN = bytes(PLAN_HEADER, 'F-300,2026,NSTW,1000000,2026-01-20');
    const FILE_DISB = bytes(DISBURSEMENT_HEADER, 'F-300,2026,1,NSTW,400000,400000,2026-02-03,2026-02-03');

    beforeAll(async () => {
      ours = await seedBidPackage(harness);
      await apply('PROJECT', bytes(PROJECT_HEADER, `F-300,2026-01-10,Compared road,GT,D01,CDT-9,${ours.projectCode}`));
      await apply('PLAN', FILE_PLAN);
      await apply('DISBURSEMENT', FILE_DISB);
      const [row] = await as((tx) => mappings.list(tx, { q: 'F-300' }, { limit: 5, after: undefined }));
      if (row === undefined) throw new Error('no mapping');
      await as((tx) => mappings.decide(tx, row.id, row.version, { move: 'APPROVE', reason: REASON }, memberId(CHECKER), NOW), CHECKER);
      const id = randomUUID();
      await harness.owner(TENANT_A, [
        [
          `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, source_kind, provider_event_id, direction)
           values ($1, $2, $3, $4, 'TREASURY', 300000, '2026-03-01T03:00:00Z', repeat('d', 64), 'CALLBACK_MOCK', $4, 'PAYMENT')`,
          [TENANT_A, id, ours.projectId, `EXT-${id}`],
        ],
      ]);
    });

    it('compares the mapped project with the Treasury and opens an item for the figure that differs and for the plan we lack', async () => {
      const result = await as((tx) => differences.reconcile(tx, { fiscalYear: 2026, epoch: 0, policy: FEED_POLICY_DEFAULTS, ownerId: memberId(THIRD), actor: memberId(THIRD), now: NOW }), THIRD);
      expect(result.opened.map((row) => [row.field, row.kind, row.large, row.feed, row.ours, row.delta]).sort()).toEqual([
        ['DISBURSED_VS_TREASURY', 'VALUE_MISMATCH', true, '400000', '300000', '100000'],
        ['PLAN_VS_DIS', 'MISSING_OURS', true, '1000000', null, null],
      ]);
      expect(result.opened[0]?.makerIds).toContain(memberId(LOADER));
      expect(result.opened.every((row) => row.ownerId === memberId(THIRD))).toBe(true);
      const again = await as((tx) => differences.reconcile(tx, { fiscalYear: 2026, epoch: 0, policy: FEED_POLICY_DEFAULTS, ownerId: memberId(THIRD), actor: memberId(THIRD), now: NOW }), THIRD);
      expect([again.opened.length, again.existing]).toEqual([0, 2]);
      expect((await as((tx) => differences.counts(tx, 2026))).openLarge).toBe(2);
      // One population: the figures of the latest run that differ over the figures that run compared, however many times the same figures were reconciled and whatever was settled since.
      const rate = (await as((tx) => reader.quality(tx, { fiscalYear: 2026, month: 1, today: '2026-02-20', policy: FEED_POLICY_DEFAULTS }))).discrepancy;
      expect([rate.numerator, rate.denominator]).toEqual([2, 2]);
      expect(rate.pct).toBe('100.00');
    });

    it('does not compare through a mapping that is not yet in force', async () => {
      const later = await seedBidPackage(harness);
      await apply('PROJECT', bytes(PROJECT_HEADER, 'F-500,2026-01-10,Not yet in force,GT,D01,CDT-9,'));
      await apply('PLAN', bytes(PLAN_HEADER, 'F-500,2026,NSTW,900000,2026-01-20'));
      const proposed = await as((tx) => mappings.propose(tx, { ourCode: later.projectCode, externalCode: 'F-500', validFrom: '2099-01-01', validUntil: null, method: 'MANUAL', reason: REASON }, memberId(LOADER), NOW), LOADER);
      await as((tx) => mappings.decide(tx, proposed.row.id, proposed.row.version, { move: 'APPROVE', reason: REASON }, memberId(CHECKER), NOW), CHECKER);
      const result = await as((tx) => differences.reconcile(tx, { fiscalYear: 2026, epoch: 0, policy: FEED_POLICY_DEFAULTS, ownerId: memberId(THIRD), actor: memberId(THIRD), now: NOW }), THIRD);
      expect(result.opened.filter((row) => row.feedProjectCode === 'F-500')).toEqual([]);
    });

    it('does not open an item for an owner who is a maker, and names the project', async () => {
      const result = await as((tx) => differences.reconcile(tx, { fiscalYear: 2026, epoch: 0, policy: FEED_POLICY_DEFAULTS, ownerId: memberId(LOADER), actor: memberId(LOADER), now: NOW }));
      expect(result.skippedOwnerIsMaker).toEqual(['F-300']);
      expect(await databaseRefusal(owner("update machvon.finance_feed_difference set owner_id = maker_ids[1] where maker_ids <> '{}'"))).toMatch(/do not change|owner/);
    });

    it('is settled by a person who is not a maker, once, with a reason of the length the kind needs', async () => {
      const [open] = await as((tx) => differences.list(tx, { state: 'OPEN', q: 'F-300' }, { limit: 5, after: undefined }));
      if (open === undefined) throw new Error('no item');
      expect((await refusal(as((tx) => differences.resolve(tx, open.id, open.version, { kind: 'KEEP_OURS', reason: 'Ours is right, checked.' }, memberId(LOADER), NOW), LOADER))).code).toBe('SELF_APPROVAL_DENIED');
      expect((await refusal(as((tx) => differences.resolve(tx, open.id, open.version, { kind: 'DISPUTE', reason: 'The feed is wrong and we tell them.' }, memberId(THIRD), NOW), THIRD))).detail).toBe('evidence_ref');
      expect((await refusal(as((tx) => differences.resolve(tx, open.id, 99, { kind: 'KEEP_OURS', reason: 'Ours is right, checked.' }, memberId(THIRD), NOW), THIRD))).code).toBe('VERSION_CONFLICT');
      const done = await as((tx) => differences.resolve(tx, open.id, open.version, { kind: 'ACCEPT_FEED', reason: 'The Treasury will catch up.' }, memberId(THIRD), NOW), THIRD);
      expect([done.row.state, done.row.resolutionKind, done.row.resolvedBy]).toEqual(['RESOLVED', 'ACCEPT_FEED', memberId(THIRD)]);
      expect((await refusal(as((tx) => differences.resolve(tx, open.id, done.row.version, { kind: 'KEEP_OURS', reason: 'Once more with feeling.' }, memberId(THIRD), NOW), THIRD))).code).toBe('FEED_DIFFERENCE_STATE_INVALID');
      expect(await databaseRefusal(owner("update machvon.finance_feed_difference set resolution_reason = 'edited after the fact' where state = 'RESOLVED'"))).toMatch(/final/);
    });

    it('is not seen by another tenant', async () => {
      expect(await as((tx) => differences.list(tx, {}, { limit: 5, after: undefined }), LOADER, TENANT_B)).toEqual([]);
    });
  });

  describe('the committee workspace stands on the feed where there is no frozen snapshot (FEED-1 to BAN-1)', () => {
    it('gives the province facts from the records of the feed: our project by the code the feed maps to, the others by their feed code, money in whole dong', async () => {
      const ours = await seedBidPackage(harness);
      await apply('PROJECT', bytes(PROJECT_HEADER, `F-700,2026-01-10,Province road,GT,D01,CDT-7,${ours.projectCode}`, 'F-701,2026-01-10,Province school,GD,D02,CDT-8,'));
      await apply('PLAN', bytes(PLAN_HEADER, 'F-700,2026,NSTW,2000000000,2026-01-20', 'F-701,2026,NSDP,500000000,2026-01-20'));
      await apply('DISBURSEMENT', bytes(DISBURSEMENT_HEADER, 'F-700,2026,3,NSTW,800000000,800000000,2026-04-03,2026-04-03'));
      const facts = await as((tx) => new FeedProvinceFactsReader().read(tx, { asOf: '2026-11-08' }));
      expect(facts.feed).toMatchObject({ basis: 'CORE_LIVE', reference: 'feed:2026' });
      const road = facts.projects.find((project) => project.code === ours.projectCode);
      const school = facts.projects.find((project) => project.code === 'F-701');
      expect(road?.projectId).toBe(ours.projectId);
      expect(school?.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(facts.lines.find((line) => line.projectId === ours.projectId)).toMatchObject({ fundSourceCode: 'NSTW', planVnd: '2000000000', disbursedVnd: '800000000' });
      expect(facts.lines.find((line) => line.projectId === school?.projectId)).toMatchObject({ fundSourceCode: 'NSDP', planVnd: '500000000', disbursedVnd: null });
    });

    it('is not seen by another tenant', async () => {
      const facts = await as((tx) => new FeedProvinceFactsReader().read(tx, { asOf: '2026-11-08' }), LOADER, TENANT_B);
      expect(facts.projects).toEqual([]);
    });

    it('is the second choice: the snapshot answers when it holds facts, the feed when it holds none', async () => {
      const withSnapshot = { ...emptyProvinceFacts('2026-10-31'), projects: [{ projectId: 'p', code: 'P', name: 'P', status: 'IMPLEMENTATION', investorUnitId: 'u', investorName: 'U', sectorCode: 'S', sectorName: 'S', districtCode: 'D', districtName: 'D', totalInvestmentVnd: '1', eacVnd: null, delayDays: null, stalledDays: null, stalledStep: null, lastReportedOn: null }] };
      const feed = new FeedProvinceFactsReader();
      expect((await as((tx) => new SnapshotOrFeedFactsReader({ read: async () => withSnapshot }, feed).read(tx, { asOf: '2026-11-08' }))).feed.basis).toBe('DIS_SNAPSHOT');
      const fed = await as((tx) => new SnapshotOrFeedFactsReader({ read: async (_tx, request) => emptyProvinceFacts(request.asOf) }, feed).read(tx, { asOf: '2026-11-08' }));
      expect(fed.feed.basis).toBe('CORE_LIVE');
      expect(fed.projects.length).toBeGreaterThan(0);
    });
  });
});
