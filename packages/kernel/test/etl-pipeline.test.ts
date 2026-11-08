import { DomainError } from '../src/errors';
import {
  FileDropAdapter,
  InMemoryDropFolder,
  MANUAL_SCHEDULE,
  admitRun,
  applyMapping,
  assertMappingApproved,
  assertMappingShape,
  assertSchedule,
  backfillWindows,
  idempotencyKeyOf,
  makeBatch,
  multiplyDecimalText,
  nextRunAt,
  paceMillis,
  reprocessRejects,
  runEtl,
} from '../src/index';
import type { EtlPorts, ExtractBatch, FieldMapping, LoadItem, LoadOutcome, MappingVersion, SourceRecord } from '../src/index';

const record = (key: string, fields: Record<string, string | number | null>, line = 2): SourceRecord => ({ key, sourceRef: `f.csv#${line}`, line, fields });

const FIELDS: FieldMapping[] = [
  { source: 'code', target: 'package_code', required: true, transform: { kind: 'UPPER' } },
  { source: 'amount_k', target: 'amount_vnd', required: true, transform: { kind: 'UNIT', factor: '1000', scale: 0 } },
  { source: 'approved', target: 'approved_on', required: false, transform: { kind: 'DAY', from: 'DMY' } },
  { source: 'unit_code', target: 'unit', required: true, transform: { kind: 'CROSSWALK', system: 'PARTNER', type: 'UNIT', onMissing: 'REJECT' } },
  { source: null, target: 'origin', required: true, transform: { kind: 'CONSTANT', value: 'PARTNER' } },
];

const MAPPING: MappingVersion = { version: 'M1', fields: FIELDS, proposedBy: 'maker', approvedBy: 'checker', approvedAt: '2026-11-08T01:00:00Z' };
const SPEC = { code: 'MAIN', mode: 'INCREMENTAL' as const, layoutVersion: '1.0' };

const GOOD = [record('a1', { code: 'a1', amount_k: '12', approved: '05/01/2026', unit_code: 'U1' }, 2), record('a2', { code: 'a2', amount_k: '3.5', approved: '06/01/2026', unit_code: 'U1' }, 3)];

interface Fake {
  ports: EtlPorts;
  loaded: Map<string, LoadItem>;
  extractRequests: Array<{ watermark: string | null; mode: string }>;
  failLoad: { on: boolean };
  loadCalls: number[];
}

/** A target that applies each idempotency key once (a repeat is a DUPLICATE), like the connector commands do. */
function fake(records: SourceRecord[], nextWatermark: string | null = 'w1', patch: { rejectKeys?: string[]; extractFails?: boolean } = {}): Fake {
  const loaded = new Map<string, LoadItem>();
  const extractRequests: Fake['extractRequests'] = [];
  const failLoad = { on: false };
  const loadCalls: number[] = [];
  const ports: EtlPorts = {
    async extract(request): Promise<ExtractBatch> {
      extractRequests.push({ watermark: request.watermark, mode: request.mode });
      if (patch.extractFails === true) throw new DomainError('HUB_PROTOCOL_UNAVAILABLE', 503);
      return makeBatch(records, nextWatermark);
    },
    validate: (row) => (typeof row.fields.code !== 'string' || row.fields.code === '' ? [{ code: 'CODE_REQUIRED', field: 'code' }] : []),
    crosswalk: { lookup: (system, type, code) => (system === 'PARTNER' && type === 'UNIT' && code === 'U1' ? 'UNIT-ONE' : null) },
    async load(items, options): Promise<LoadOutcome[]> {
      loadCalls.push(items.length);
      if (failLoad.on) throw new Error('database went away');
      return items.map((item): LoadOutcome => {
        if (patch.rejectKeys?.includes(item.key) === true) return { status: 'REJECTED', code: 'TARGET_RULE' };
        const known = loaded.has(item.idempotencyKey);
        if (!options.dryRun && !known) loaded.set(item.idempotencyKey, item);
        return known ? { status: 'DUPLICATE', targetRef: `t:${item.key}` } : { status: 'APPLIED', targetRef: `t:${item.key}` };
      });
    },
  };
  return { ports, loaded, extractRequests, failLoad, loadCalls };
}

describe('the mapping', () => {
  it('copies, normalises, converts units exactly, converts days and translates codes through the crosswalk', () => {
    const mapped = applyMapping(MAPPING, GOOD[1] as SourceRecord, { lookup: () => 'UNIT-ONE' });
    expect(mapped.issues).toEqual([]);
    expect(mapped.fields).toEqual({ package_code: 'A2', amount_vnd: '3500', approved_on: '2026-01-06', unit: 'UNIT-ONE', origin: 'PARTNER' });
  });

  it('reports a missing required field, a bad day, a bad amount and a code the crosswalk does not know', () => {
    const issues = applyMapping(MAPPING, record('x', { code: '', amount_k: 'abc', approved: '31/02/2026', unit_code: 'U9' }), { lookup: () => null }).issues;
    expect(issues).toEqual([
      { field: 'package_code', code: 'REQUIRED_MISSING' },
      { field: 'amount_vnd', code: 'FORMAT_INVALID' },
      { field: 'approved_on', code: 'FORMAT_INVALID' },
      { field: 'unit', code: 'CROSSWALK_MISSING' },
    ]);
    const keep: MappingVersion = { ...MAPPING, fields: [{ source: 'unit_code', target: 'unit', required: true, transform: { kind: 'CROSSWALK', system: 'PARTNER', type: 'UNIT', onMissing: 'KEEP' } }] };
    expect(applyMapping(keep, record('x', { unit_code: 'U9' }), { lookup: () => null }).fields).toEqual({ unit: 'U9' });
  });

  it('multiplies decimals without floating point, rounding half up', () => {
    expect(multiplyDecimalText('12', '1000', 0)).toBe('12000');
    expect(multiplyDecimalText('0.1', '3', 1)).toBe('0.3');
    expect(multiplyDecimalText('1.005', '1', 2)).toBe('1.01');
    expect(multiplyDecimalText('-2.5', '1000', 2)).toBe('-2500.00');
    expect(multiplyDecimalText('x', '1', 0)).toBeNull();
  });

  it('judges the shape of a mapping and refuses to run one nobody else approved', () => {
    expect(() => assertMappingShape(FIELDS)).not.toThrow();
    expect(() => assertMappingShape([])).toThrow(DomainError);
    expect(() => assertMappingShape([FIELDS[0] as FieldMapping, FIELDS[0] as FieldMapping])).toThrow(DomainError);
    expect(() => assertMappingShape([{ source: null, target: 'x', required: true, transform: { kind: 'COPY' } }])).toThrow(DomainError);
    expect(() => assertMappingShape([{ source: 'a', target: 'x', required: true, transform: { kind: 'UNIT', factor: '0', scale: 0 } }])).toThrow(DomainError);
    expect(() => assertMappingApproved(MAPPING)).not.toThrow();
    expect(() => assertMappingApproved({ ...MAPPING, approvedBy: null, approvedAt: null })).toThrow(expect.objectContaining({ code: 'HUB_MAPPING_NOT_APPROVED' }));
    expect(() => assertMappingApproved({ ...MAPPING, approvedBy: 'maker' })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
  });
});

describe('the stage runner', () => {
  it('runs a clean batch: counts per stage, lineage, a balanced reconciliation, and the watermark moves after the load', async () => {
    const target = fake(GOOD);
    const run = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: null, dryRun: false });
    expect(run).toMatchObject({ outcome: 'SUCCEEDED', failure: null, watermarkBefore: null, watermarkAfter: 'w1', mappingVersion: 'M1', layoutVersion: '1.0' });
    expect(run.stages).toEqual({ EXTRACT: { in: 2, out: 2, rejected: 0 }, VALIDATE: { in: 2, out: 2, rejected: 0 }, TRANSFORM: { in: 2, out: 2, rejected: 0 }, LOAD: { in: 2, out: 2, rejected: 0 } });
    expect(run.reconcile).toMatchObject({ extracted: 2, applied: 2, duplicate: 0, rejected: 0, balanced: true });
    expect(run.reconcile.batchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.lineage).toEqual([
      expect.objectContaining({ sourceRef: 'f.csv#2', targetRef: 't:a1', status: 'APPLIED', mappingVersion: 'M1', layoutVersion: '1.0', batchSha256: run.reconcile.batchSha256 }),
      expect.objectContaining({ sourceRef: 'f.csv#3', targetRef: 't:a2', status: 'APPLIED' }),
    ]);
    expect(target.loaded.size).toBe(2);
  });

  it('writes nothing in a dry run, reports what would be applied and does not move the watermark', async () => {
    const target = fake(GOOD);
    const run = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: 'w0', dryRun: true });
    expect(run).toMatchObject({ outcome: 'SUCCEEDED', dryRun: true, watermarkAfter: 'w0' });
    expect(run.reconcile).toMatchObject({ applied: 0, wouldApply: 2, balanced: true });
    expect(run.lineage.map((entry) => entry.status)).toEqual(['WOULD_APPLY', 'WOULD_APPLY']);
    expect(target.loaded.size).toBe(0);
  });

  it('handles a partial failure: bad rows are rejects with their stage and code, the rest are applied, the run is PARTIAL and balances', async () => {
    const rows = [...GOOD, record('b1', { code: '', amount_k: '1', unit_code: 'U1' }, 4), record('b2', { code: 'b2', amount_k: 'zz', unit_code: 'U1' }, 5), record('b3', { code: 'b3', amount_k: '1', unit_code: 'U1' }, 6)];
    const target = fake(rows, 'w2', { rejectKeys: ['b3'] });
    const run = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: null, dryRun: false });
    expect(run.outcome).toBe('PARTIAL');
    expect(run.rejects.map((reject) => [reject.key, reject.stage, reject.code, reject.line])).toEqual([
      ['b1', 'VALIDATE', 'CODE_REQUIRED', 4],
      ['b2', 'TRANSFORM', 'FORMAT_INVALID', 5],
      ['b3', 'LOAD', 'TARGET_RULE', 6],
    ]);
    expect(run.reconcile).toMatchObject({ extracted: 5, applied: 2, rejected: 3, balanced: true });
    expect(run.stages.VALIDATE).toEqual({ in: 5, out: 4, rejected: 1 });
    expect(run.stages.TRANSFORM).toEqual({ in: 4, out: 3, rejected: 1 });
    expect(run.stages.LOAD).toEqual({ in: 3, out: 2, rejected: 1 });
    // The rejects are in the dead-letter list, so the watermark passes the batch.
    expect(run.watermarkAfter).toBe('w2');
  });

  it('leaves the watermark where it was when the load fails, and the retry applies everything once', async () => {
    const target = fake(GOOD);
    target.failLoad.on = true;
    const failed = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: 'w0', dryRun: false });
    expect(failed).toMatchObject({ outcome: 'FAILED', failure: { stage: 'LOAD', code: 'LOAD_FAILED' }, watermarkAfter: 'w0' });
    expect(target.loaded.size).toBe(0);
    target.failLoad.on = false;
    const retry = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: failed.watermarkAfter, dryRun: false });
    expect(retry).toMatchObject({ outcome: 'SUCCEEDED', watermarkAfter: 'w1' });
    expect(retry.reconcile).toMatchObject({ applied: 2, duplicate: 0 });
    expect(target.extractRequests.map((request) => request.watermark)).toEqual(['w0', 'w0']);
  });

  it('fails at EXTRACT with the stable code of the port and keeps the watermark', async () => {
    const run = await runEtl({ spec: SPEC, mapping: MAPPING, ports: fake(GOOD, 'w1', { extractFails: true }).ports, watermark: 'w0', dryRun: false });
    expect(run).toMatchObject({ outcome: 'FAILED', failure: { stage: 'EXTRACT', code: 'HUB_PROTOCOL_UNAVAILABLE' }, watermarkAfter: 'w0' });
  });

  it('replays the same batch harmlessly: every record is a duplicate and nothing is written twice', async () => {
    const target = fake(GOOD);
    await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: null, dryRun: false });
    const replay = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: null, dryRun: false });
    expect(replay.reconcile).toMatchObject({ applied: 0, duplicate: 2, balanced: true });
    expect(replay.outcome).toBe('SUCCEEDED');
    expect(target.loaded.size).toBe(2);
    // A changed record is a new write, an unchanged one is a repeat.
    expect(idempotencyKeyOf('MAIN', GOOD[0] as SourceRecord)).toBe(idempotencyKeyOf('MAIN', { ...(GOOD[0] as SourceRecord) }));
    expect(idempotencyKeyOf('MAIN', GOOD[0] as SourceRecord)).not.toBe(idempotencyKeyOf('MAIN', record('a1', { code: 'a1', amount_k: '13', approved: '05/01/2026', unit_code: 'U1' })));
    expect(idempotencyKeyOf('MAIN', GOOD[0] as SourceRecord)).not.toBe(idempotencyKeyOf('OTHER', GOOD[0] as SourceRecord));
  });

  it('reads a full snapshot from the start whatever the watermark says', async () => {
    const target = fake(GOOD);
    await runEtl({ spec: { ...SPEC, mode: 'FULL_SNAPSHOT' }, mapping: MAPPING, ports: target.ports, watermark: 'w0', dryRun: false });
    expect(target.extractRequests).toEqual([{ watermark: null, mode: 'FULL_SNAPSHOT' }]);
  });

  it('refuses to run with a mapping nobody approved', async () => {
    await expect(runEtl({ spec: SPEC, mapping: { ...MAPPING, approvedBy: null, approvedAt: null }, ports: fake(GOOD).ports, watermark: null, dryRun: false })).rejects.toMatchObject({ code: 'HUB_MAPPING_NOT_APPROVED' });
  });

  it('reprocesses rejects after a person corrected them, without touching the watermark, and keeps the ones that fail again', async () => {
    const rows = [...GOOD, record('b1', { code: '', amount_k: '1', unit_code: 'U1' }, 4), record('b2', { code: 'b2', amount_k: 'zz', unit_code: 'U1' }, 5)];
    const target = fake(rows);
    const run = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: null, dryRun: false });
    expect(run.rejects).toHaveLength(2);
    const second = await reprocessRejects({ spec: SPEC, mapping: MAPPING, ports: target.ports, rejects: run.rejects, corrections: { 'f.csv#4': { code: 'b1' }, 'f.csv#5': { amount_k: 'still wrong' } } });
    expect(second.failure).toBeNull();
    expect(second.resolved.map((entry) => [entry.key, entry.lineage.status, entry.lineage.targetRef])).toEqual([['b1', 'APPLIED', 't:b1']]);
    expect(second.stillRejected.map((reject) => [reject.key, reject.code])).toEqual([['b2', 'FORMAT_INVALID']]);
    expect(target.loaded.size).toBe(3);
    const third = await reprocessRejects({ spec: SPEC, mapping: MAPPING, ports: target.ports, rejects: second.stillRejected, corrections: { 'f.csv#5': { amount_k: '7' } } });
    expect(third.resolved).toHaveLength(1);
    expect(third.stillRejected).toEqual([]);
    expect(target.loaded.size).toBe(4);
  });

  it('leaves the rejects as they are when the load of a reprocess fails', async () => {
    const target = fake([record('b1', { code: '', amount_k: '1', unit_code: 'U1' }, 4)]);
    const run = await runEtl({ spec: SPEC, mapping: MAPPING, ports: target.ports, watermark: null, dryRun: false });
    target.failLoad.on = true;
    const result = await reprocessRejects({ spec: SPEC, mapping: MAPPING, ports: target.ports, rejects: run.rejects, corrections: { 'f.csv#4': { code: 'b1' } } });
    expect(result).toMatchObject({ failure: 'LOAD_FAILED', resolved: [] });
    expect(result.stillRejected).toHaveLength(1);
  });

  it('runs end to end from a drop folder: a failed load keeps the file for the next run and the watermark is the file after success', async () => {
    const folder = new InMemoryDropFolder();
    folder.put('2026-11.csv', 'code,amount_k,approved,unit_code\nx1,5,01/11/2026,U1\nx2,6,02/11/2026,U1\n', 1);
    const adapter = new FileDropAdapter(folder, { format: 'CSV', version: '1.0', keyColumns: ['code'] }, { stablePolls: 1 });
    const target = fake([]);
    const ports: EtlPorts = { ...target.ports, extract: (request) => adapter.extract(request) };
    target.failLoad.on = true;
    const failed = await runEtl({ spec: SPEC, mapping: MAPPING, ports, watermark: null, dryRun: false });
    expect(failed.outcome).toBe('FAILED');
    expect(folder.settled).toEqual([]);
    target.failLoad.on = false;
    const done = await runEtl({ spec: SPEC, mapping: MAPPING, ports, watermark: failed.watermarkAfter, dryRun: false });
    expect(done).toMatchObject({ outcome: 'SUCCEEDED', watermarkAfter: '2026-11.csv' });
    await adapter.confirm();
    expect(folder.settled).toEqual([{ name: '2026-11.csv', outcome: 'PROCESSED' }]);
    expect(target.loaded.size).toBe(2);
  });
});

describe('the schedule', () => {
  const working = (day: string): boolean => !['2026-11-14', '2026-11-15'].includes(day);

  it('judges a schedule and has the manual one', () => {
    expect(() => assertSchedule(MANUAL_SCHEDULE)).not.toThrow();
    expect(() => assertSchedule({ ...MANUAL_SCHEDULE, when: { kind: 'DAILY', at: '25:00', workingDaysOnly: true } })).toThrow(DomainError);
    expect(() => assertSchedule({ ...MANUAL_SCHEDULE, when: { kind: 'EVERY_HOURS', hours: 0, workingDaysOnly: true } })).toThrow(DomainError);
    expect(() => assertSchedule({ ...MANUAL_SCHEDULE, maxConcurrency: 0 })).toThrow(DomainError);
    expect(() => assertSchedule({ ...MANUAL_SCHEDULE, ratePerMinute: 0 })).toThrow(DomainError);
  });

  it('computes the next daily run in Vietnam time and skips days off', () => {
    const daily = { ...MANUAL_SCHEDULE, when: { kind: 'DAILY' as const, at: '06:30', workingDaysOnly: true } };
    expect(nextRunAt(daily, new Date('2026-11-12T00:00:00Z'), working)?.toISOString()).toBe('2026-11-12T23:30:00.000Z');
    // After 06:30 on Friday 2026-11-13 (Vietnam), the next working morning is Monday 2026-11-16.
    expect(nextRunAt(daily, new Date('2026-11-13T00:00:00Z'), working)?.toISOString()).toBe('2026-11-15T23:30:00.000Z');
    expect(nextRunAt({ ...daily, when: { kind: 'DAILY', at: '06:30', workingDaysOnly: false } }, new Date('2026-11-13T00:00:00Z'), working)?.toISOString()).toBe('2026-11-13T23:30:00.000Z');
    expect(nextRunAt(MANUAL_SCHEDULE, NOW_FOR_SCHEDULE, working)).toBeNull();
  });

  it('computes an hourly run and moves a run that lands on a day off to the next working day', () => {
    const hourly = { ...MANUAL_SCHEDULE, when: { kind: 'EVERY_HOURS' as const, hours: 6, workingDaysOnly: true } };
    expect(nextRunAt(hourly, new Date('2026-11-12T00:00:00Z'), working)?.toISOString()).toBe('2026-11-12T06:00:00.000Z');
    expect(nextRunAt(hourly, new Date('2026-11-13T12:00:00Z'), working)?.toISOString()).toBe('2026-11-15T17:00:00.000Z');
  });

  it('limits concurrency, paces the rate and splits a backfill into windows within the allowed reach', () => {
    expect(admitRun(0, { maxConcurrency: 1 })).toBe(true);
    expect(admitRun(1, { maxConcurrency: 1 })).toBe(false);
    expect(paceMillis({ ratePerMinute: 30 })).toBe(2000);
    const windows = backfillWindows({ fromDay: '2026-10-01', toDay: '2026-10-20', windowDays: 7, today: '2026-11-08', schedule: { backfillWindowDays: 60 } });
    expect(windows).toEqual([{ from: '2026-10-01', to: '2026-10-07' }, { from: '2026-10-08', to: '2026-10-14' }, { from: '2026-10-15', to: '2026-10-20' }]);
    expect(() => backfillWindows({ fromDay: '2026-01-01', toDay: '2026-01-05', windowDays: 7, today: '2026-11-08', schedule: { backfillWindowDays: 60 } })).toThrow(DomainError);
    expect(() => backfillWindows({ fromDay: '2026-10-05', toDay: '2026-11-30', windowDays: 7, today: '2026-11-08', schedule: { backfillWindowDays: 60 } })).toThrow(DomainError);
  });
});

const NOW_FOR_SCHEDULE = new Date('2026-11-08T03:00:00Z');
