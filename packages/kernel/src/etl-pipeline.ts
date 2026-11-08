import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
import { hasControlChar } from './control-chars.ts';
import { vietnamDateOf } from './doc-numbering.ts';
import { DomainError } from './errors.ts';
import { batchHashOf } from './connector-protocols.ts';
import type { ExtractBatch, ExtractMode, ExtractRequest, SourceRecord, SourceValue } from './connector-protocols.ts';

/**
 * The ETL pipeline model of the Integration Hub (HUB-1, owner addition 2026-11-08; "CTL" in the brief is read as ETL: extract, transform, load). A pipeline is the same shape for every connector:
 *
 *   EXTRACT   a protocol port gives a batch of records after a watermark (incremental), the whole source (full snapshot) or the changes the source offers (change feed);
 *   VALIDATE  the layout version gate and the schema and rule checks of the connector, per row: a bad row is a REJECT with a stable code, the rest go on;
 *   TRANSFORM a declarative field mapping with a version and an approver (maker is not checker): copy, normalise, convert units, translate codes through the crosswalk;
 *   LOAD      idempotent: a dry run first (nothing is written), then the apply through the connector's own command; a repeated record is a DUPLICATE, never a second write;
 *   REJECTS   the dead-letter list with the reason and the record, kept so that it can be corrected and reprocessed;
 *   RECONCILE counts in and out of every stage, the hash of the batch, and whether they balance;
 *   LINEAGE   source record -> target record, with the mapping and layout versions (the lineage explorer reads it);
 *   SCHEDULE  when a pipeline runs: cron-like, on the working calendar, with backfill windows, a concurrency limit and a rate.
 *
 * The runner is pure: every effect goes through the ports it is given. THE WATERMARK ADVANCES ONLY AFTER A SUCCESSFUL LOAD of a real (not dry) run; a load that fails leaves it where it was, so the next run reads
 * the same records again and the idempotency keys make the second pass harmless.
 */

export const ETL_STAGES = ['EXTRACT', 'VALIDATE', 'TRANSFORM', 'LOAD'] as const;
export type EtlStage = (typeof ETL_STAGES)[number];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Schedule.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ScheduleKind = { kind: 'MANUAL' } | { kind: 'EVERY_HOURS'; hours: number; workingDaysOnly: boolean } | { kind: 'DAILY'; at: string; workingDaysOnly: boolean };

export interface ScheduleSpec {
  when: ScheduleKind;
  /** How far back a backfill may reach, in days; a longer one is refused (a backfill is a deliberate act, not a default). */
  backfillWindowDays: number;
  /** Runs of one pipeline at once. */
  maxConcurrency: number;
  /** Calls to the source per minute; the pacing between calls is 60000 / ratePerMinute milliseconds. */
  ratePerMinute: number;
}

export const MANUAL_SCHEDULE: ScheduleSpec = { when: { kind: 'MANUAL' }, backfillWindowDays: 31, maxConcurrency: 1, ratePerMinute: 60 };

export function assertSchedule(schedule: ScheduleSpec): ScheduleSpec {
  const when = schedule.when;
  if (when.kind === 'EVERY_HOURS' && (!Number.isInteger(when.hours) || when.hours < 1 || when.hours > 744)) throw invalid('schedule.hours');
  if (when.kind === 'DAILY' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(when.at)) throw invalid('schedule.at');
  if (!Number.isInteger(schedule.backfillWindowDays) || schedule.backfillWindowDays < 0 || schedule.backfillWindowDays > 366) throw invalid('schedule.backfill_window_days');
  if (!Number.isInteger(schedule.maxConcurrency) || schedule.maxConcurrency < 1 || schedule.maxConcurrency > 16) throw invalid('schedule.max_concurrency');
  if (!Number.isInteger(schedule.ratePerMinute) || schedule.ratePerMinute < 1 || schedule.ratePerMinute > 6000) throw invalid('schedule.rate_per_minute');
  return schedule;
}

const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;

/** The next time a pipeline is due after `after`, or null for MANUAL. `isWorkingDay` takes a Vietnam calendar day (`YYYY-MM-DD`); a schedule that wants working days moves past the others (at most 31 days). */
export function nextRunAt(schedule: ScheduleSpec, after: Date, isWorkingDay: (day: string) => boolean): Date | null {
  const when = schedule.when;
  if (when.kind === 'MANUAL') return null;
  const workingOnly = when.workingDaysOnly;
  if (when.kind === 'EVERY_HOURS') {
    let candidate = new Date(after.getTime() + when.hours * 3_600_000);
    for (let guard = 0; workingOnly && !isWorkingDay(vietnamDateOf(candidate)) && guard < 31; guard += 1) {
      const dayStart = Math.floor((candidate.getTime() + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
      candidate = new Date(dayStart + DAY_MS);
    }
    return candidate;
  }
  const [hour, minute] = when.at.split(':').map(Number) as [number, number];
  const startOfDay = Math.floor((after.getTime() + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
  for (let offset = 0; offset <= 32; offset += 1) {
    const candidate = new Date(startOfDay + offset * DAY_MS + (hour * 60 + minute) * 60_000);
    if (candidate.getTime() <= after.getTime()) continue;
    if (!workingOnly || isWorkingDay(vietnamDateOf(candidate))) return candidate;
  }
  return null;
}

/** Whether another run may start: fewer than `maxConcurrency` are running. */
export const admitRun = (running: number, schedule: Pick<ScheduleSpec, 'maxConcurrency'>): boolean => running < schedule.maxConcurrency;

/** The pause between two calls to the source so that the rate holds. */
export const paceMillis = (schedule: Pick<ScheduleSpec, 'ratePerMinute'>): number => Math.ceil(60_000 / schedule.ratePerMinute);

/** The windows of a backfill from `fromDay` to `toDay` (inclusive, Vietnam days), each at most `windowDays` long; a backfill reaching further back than the schedule allows is 422 `VALIDATION_FAILED` (`from`). */
export function backfillWindows(input: { fromDay: string; toDay: string; windowDays: number; today: string; schedule: Pick<ScheduleSpec, 'backfillWindowDays'> }): Array<{ from: string; to: string }> {
  const parse = (day: string, field: string): number => {
    const time = Date.parse(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== day) throw invalid(field);
    return time;
  };
  const from = parse(input.fromDay, 'from');
  const to = parse(input.toDay, 'to');
  const today = parse(input.today, 'today');
  if (to < from || to > today) throw invalid('to');
  if ((today - from) / DAY_MS > input.schedule.backfillWindowDays) throw invalid('from');
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > 366) throw invalid('window_days');
  const windows: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start += input.windowDays * DAY_MS) {
    const end = Math.min(start + (input.windowDays - 1) * DAY_MS, to);
    windows.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) });
  }
  return windows;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The pipeline spec (what a descriptor declares) and the mapping (what a tenant approves).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PipelineSpec {
  /** The code inside the connector (the layout it carries is a good one): upper case. */
  code: string;
  name: string;
  /** The protocol that extracts (one of the descriptor's protocols). */
  protocol: string;
  mode: ExtractMode;
  layoutCode: string;
  layoutVersion: string;
  /** What LOAD calls: the name of the connector's own command or store step, shown on the screen ("egp.import.apply"). */
  target: string;
  schedule: ScheduleSpec;
}

export type FieldTransform =
  | { kind: 'COPY' }
  | { kind: 'TRIM' }
  | { kind: 'UPPER' }
  | { kind: 'LOWER' }
  | { kind: 'CONSTANT'; value: string }
  | { kind: 'DAY'; from: 'ISO' | 'DMY' }
  | { kind: 'DECIMAL' }
  /** Unit conversion by an exact factor written as a decimal string ("1000" turns thousands of dong into dong); the result keeps `scale` decimals. */
  | { kind: 'UNIT'; factor: string; scale: number }
  | { kind: 'CROSSWALK'; system: string; type: string; onMissing: 'REJECT' | 'KEEP' };

export interface FieldMapping {
  /** The field of the source record; null for a constant. */
  source: string | null;
  target: string;
  required: boolean;
  transform: FieldTransform;
}

export interface MappingVersion {
  version: string;
  fields: readonly FieldMapping[];
  proposedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

const NAME = /^[a-z][a-z0-9_]{0,59}$/;

/** Judges a mapping as written (422 `VALIDATION_FAILED` naming the field): names, no duplicate target, a transform with what it needs. */
export function assertMappingShape(fields: readonly FieldMapping[]): void {
  if (fields.length === 0 || fields.length > 200) throw invalid('fields');
  const targets = new Set<string>();
  for (const [index, field] of fields.entries()) {
    const at = `fields[${index}]`;
    if (!NAME.test(field.target) || targets.has(field.target)) throw invalid(`${at}.target`);
    targets.add(field.target);
    if (field.transform.kind === 'CONSTANT') {
      if (field.source !== null || field.transform.value.length > 300 || hasControlChar(field.transform.value)) throw invalid(`${at}.transform`);
    } else if (field.source === null || !/^[A-Za-z0-9_]{1,60}$/.test(field.source)) throw invalid(`${at}.source`);
    if (field.transform.kind === 'UNIT' && (!/^\d{1,12}(\.\d{1,6})?$/.test(field.transform.factor) || Number(field.transform.factor) <= 0 || !Number.isInteger(field.transform.scale) || field.transform.scale < 0 || field.transform.scale > 6)) throw invalid(`${at}.transform`);
    if (field.transform.kind === 'CROSSWALK' && (!/^[A-Z][A-Z0-9_]{1,59}$/.test(field.transform.system) || !/^[A-Z][A-Z0-9_]{1,59}$/.test(field.transform.type))) throw invalid(`${at}.transform`);
  }
}

/** A mapping may run only when it is approved by a person other than its proposer (409 `HUB_MAPPING_NOT_APPROVED`; 403 `SELF_APPROVAL_DENIED` when the same person did both, which the store also refuses). */
export function assertMappingApproved(mapping: Pick<MappingVersion, 'proposedBy' | 'approvedBy' | 'approvedAt'>): void {
  if (mapping.approvedBy === null || mapping.approvedAt === null) throw new DomainError('HUB_MAPPING_NOT_APPROVED', 409, 'mapping');
  if (mapping.approvedBy === mapping.proposedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'approver');
}

export interface CrosswalkPort {
  lookup(system: string, type: string, code: string): string | null;
}

export interface FieldIssue {
  field: string;
  code: 'REQUIRED_MISSING' | 'FORMAT_INVALID' | 'CROSSWALK_MISSING';
}

const DMY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayOf(value: string, from: 'ISO' | 'DMY'): string | null {
  let iso: string | null = null;
  if (from === 'ISO' && ISO_DAY.test(value)) iso = value;
  const dmy = from === 'DMY' ? DMY.exec(value) : null;
  if (dmy !== null) iso = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (iso === null) return null;
  const time = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Exact decimal multiplication on strings (no floating point): `value` and `factor` are plain decimals, the result keeps `scale` decimals, rounded half up. */
export function multiplyDecimal(value: string, factor: string, scale: number): string | null {
  const parse = (text: string): { digits: bigint; scale: number; negative: boolean } | null => {
    const match = /^(-?)(\d{1,30})(?:\.(\d{1,12}))?$/.exec(text);
    if (match === null) return null;
    const fraction = match[3] ?? '';
    return { digits: BigInt((match[2] as string) + fraction), scale: fraction.length, negative: match[1] === '-' };
  };
  const a = parse(value);
  const b = parse(factor);
  if (a === null || b === null) return null;
  const product = a.digits * b.digits;
  const productScale = a.scale + b.scale;
  let scaled: bigint;
  if (productScale <= scale) scaled = product * 10n ** BigInt(scale - productScale);
  else {
    const divisor = 10n ** BigInt(productScale - scale);
    scaled = product / divisor + (product % divisor * 2n >= divisor ? 1n : 0n);
  }
  const text = scaled.toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale);
  const fraction = scale === 0 ? '' : `.${text.slice(text.length - scale)}`;
  return `${a.negative && scaled !== 0n ? '-' : ''}${whole}${fraction}`;
}

/** Applies a mapping to one record: the target fields and the issues (a required field missing, a value that does not fit its transform, a code the crosswalk does not know). A row with an issue is a REJECT of TRANSFORM. */
export function applyMapping(mapping: Pick<MappingVersion, 'fields'>, record: SourceRecord, crosswalk: CrosswalkPort): { fields: Record<string, string>; issues: FieldIssue[] } {
  const out: Record<string, string> = {};
  const issues: FieldIssue[] = [];
  for (const field of mapping.fields) {
    const raw: SourceValue | undefined = field.source === null ? undefined : record.fields[field.source];
    const text = raw === undefined || raw === null ? '' : String(raw);
    const transform = field.transform;
    if (transform.kind === 'CONSTANT') {
      out[field.target] = transform.value;
      continue;
    }
    if (text.trim() === '') {
      if (field.required) issues.push({ field: field.target, code: 'REQUIRED_MISSING' });
      continue;
    }
    switch (transform.kind) {
      case 'COPY':
        out[field.target] = text;
        break;
      case 'TRIM':
        out[field.target] = text.trim().replace(/\s+/g, ' ');
        break;
      case 'UPPER':
        out[field.target] = text.trim().toUpperCase();
        break;
      case 'LOWER':
        out[field.target] = text.trim().toLowerCase();
        break;
      case 'DAY': {
        const day = dayOf(text.trim(), transform.from);
        if (day === null) issues.push({ field: field.target, code: 'FORMAT_INVALID' });
        else out[field.target] = day;
        break;
      }
      case 'DECIMAL': {
        const plain = /^-?\d{1,30}(\.\d{1,12})?$/.test(text.trim()) ? text.trim() : null;
        if (plain === null) issues.push({ field: field.target, code: 'FORMAT_INVALID' });
        else out[field.target] = plain;
        break;
      }
      case 'UNIT': {
        const converted = multiplyDecimal(text.trim(), transform.factor, transform.scale);
        if (converted === null) issues.push({ field: field.target, code: 'FORMAT_INVALID' });
        else out[field.target] = converted;
        break;
      }
      case 'CROSSWALK': {
        const translated = crosswalk.lookup(transform.system, transform.type, text.trim());
        if (translated !== null) out[field.target] = translated;
        else if (transform.onMissing === 'KEEP') out[field.target] = text.trim();
        else issues.push({ field: field.target, code: 'CROSSWALK_MISSING' });
        break;
      }
    }
  }
  return { fields: out, issues };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ValidationIssue {
  /** A stable code (no free text: a message can carry data of the other side). */
  code: string;
  field: string | null;
}

export interface LoadItem {
  /** The same record always has the same key: the target applies a key once. */
  idempotencyKey: string;
  sourceRef: string;
  key: string;
  fields: Readonly<Record<string, string>>;
}

export type LoadOutcome = { status: 'APPLIED'; targetRef: string } | { status: 'DUPLICATE'; targetRef: string | null } | { status: 'REJECTED'; code: string };

export interface EtlPorts {
  extract(request: ExtractRequest): Promise<ExtractBatch>;
  /** The connector's schema and rule checks of one record (the layout gate has run before). */
  validate(record: SourceRecord): ValidationIssue[];
  crosswalk: CrosswalkPort;
  /** Applies the items through the connector's own command, or only checks them when `dryRun`. One outcome per item, in order. May throw: that is a failed load. */
  load(items: readonly LoadItem[], options: { dryRun: boolean }): Promise<LoadOutcome[]>;
}

export type RejectStage = 'VALIDATE' | 'TRANSFORM' | 'LOAD';

export interface EtlReject {
  stage: RejectStage;
  code: string;
  field: string | null;
  sourceRef: string;
  key: string;
  line: number | null;
  /** The record as it arrived: what a person corrects before it is reprocessed. */
  record: SourceRecord;
}

export interface LineageEntry {
  sourceRef: string;
  key: string;
  targetRef: string | null;
  status: 'APPLIED' | 'DUPLICATE' | 'WOULD_APPLY';
  mappingVersion: string;
  layoutVersion: string;
  batchSha256: string;
}

export interface StageCount {
  in: number;
  out: number;
  rejected: number;
}

export type EtlOutcome = 'SUCCEEDED' | 'PARTIAL' | 'FAILED';

export interface EtlRun {
  pipeline: string;
  dryRun: boolean;
  outcome: EtlOutcome;
  stages: Record<EtlStage, StageCount>;
  rejects: EtlReject[];
  lineage: LineageEntry[];
  reconcile: { extracted: number; applied: number; duplicate: number; rejected: number; wouldApply: number; batchSha256: string; balanced: boolean };
  watermarkBefore: string | null;
  /** Where the watermark stands after the run: moved only by a real run whose load completed. */
  watermarkAfter: string | null;
  /** The stage that failed the whole run, with a stable code; null when the run completed (rows may still be rejected). */
  failure: { stage: EtlStage; code: string } | null;
  mappingVersion: string;
  layoutVersion: string;
}

const rowHashOf = (fields: Readonly<Record<string, SourceValue>>): string => createHash('sha256').update(canonicalJson(fields)).digest('hex');

/** The key of a record for the target: the pipeline, the key of the record and the hash of its content, so a changed record is a new write and an identical one is a repeat. */
export const idempotencyKeyOf = (pipeline: string, record: Pick<SourceRecord, 'key' | 'fields'>): string => createHash('sha256').update(`${pipeline}\n${record.key}\n${rowHashOf(record.fields)}`).digest('hex');

const codeOf = (error: unknown, fallback: string): string => (error instanceof DomainError ? error.code : fallback);

export interface EtlRunInput {
  spec: Pick<PipelineSpec, 'code' | 'mode' | 'layoutVersion'>;
  mapping: MappingVersion;
  ports: EtlPorts;
  watermark: string | null;
  dryRun: boolean;
  limit?: number;
}

const emptyStages = (): Record<EtlStage, StageCount> => ({ EXTRACT: { in: 0, out: 0, rejected: 0 }, VALIDATE: { in: 0, out: 0, rejected: 0 }, TRANSFORM: { in: 0, out: 0, rejected: 0 }, LOAD: { in: 0, out: 0, rejected: 0 } });

async function processRecords(input: { spec: EtlRunInput['spec']; mapping: MappingVersion; ports: EtlPorts; records: readonly SourceRecord[]; dryRun: boolean; batchSha256: string }, stages: Record<EtlStage, StageCount>): Promise<{ rejects: EtlReject[]; lineage: LineageEntry[]; applied: number; duplicate: number; wouldApply: number; loadRejected: number; loadFailure: string | null }> {
  const rejects: EtlReject[] = [];
  const items: Array<{ item: LoadItem; record: SourceRecord }> = [];
  stages.VALIDATE.in += input.records.length;
  const validated: SourceRecord[] = [];
  for (const record of input.records) {
    const issue = input.ports.validate(record)[0];
    if (issue === undefined) validated.push(record);
    else {
      stages.VALIDATE.rejected += 1;
      rejects.push({ stage: 'VALIDATE', code: issue.code, field: issue.field, sourceRef: record.sourceRef, key: record.key, line: record.line, record });
    }
  }
  stages.VALIDATE.out += validated.length;
  stages.TRANSFORM.in += validated.length;
  for (const record of validated) {
    const mapped = applyMapping(input.mapping, record, input.ports.crosswalk);
    const issue = mapped.issues[0];
    if (issue !== undefined) {
      stages.TRANSFORM.rejected += 1;
      rejects.push({ stage: 'TRANSFORM', code: issue.code, field: issue.field, sourceRef: record.sourceRef, key: record.key, line: record.line, record });
    } else items.push({ item: { idempotencyKey: idempotencyKeyOf(input.spec.code, record), sourceRef: record.sourceRef, key: record.key, fields: mapped.fields }, record });
  }
  stages.TRANSFORM.out += items.length;
  stages.LOAD.in += items.length;
  const lineage: LineageEntry[] = [];
  let applied = 0;
  let duplicate = 0;
  let wouldApply = 0;
  let loadRejected = 0;
  if (items.length === 0) return { rejects, lineage, applied, duplicate, wouldApply, loadRejected, loadFailure: null };
  let outcomes: LoadOutcome[];
  try {
    outcomes = await input.ports.load(items.map((entry) => entry.item), { dryRun: input.dryRun });
  } catch (error) {
    return { rejects, lineage, applied, duplicate, wouldApply, loadRejected, loadFailure: codeOf(error, 'LOAD_FAILED') };
  }
  if (outcomes.length !== items.length) return { rejects, lineage, applied, duplicate, wouldApply, loadRejected, loadFailure: 'LOAD_COUNT_MISMATCH' };
  items.forEach((entry, index) => {
    const outcome = outcomes[index] as LoadOutcome;
    const base = { sourceRef: entry.item.sourceRef, key: entry.item.key, mappingVersion: input.mapping.version, layoutVersion: input.spec.layoutVersion, batchSha256: input.batchSha256 };
    if (outcome.status === 'REJECTED') {
      loadRejected += 1;
      stages.LOAD.rejected += 1;
      rejects.push({ stage: 'LOAD', code: outcome.code, field: null, sourceRef: entry.record.sourceRef, key: entry.record.key, line: entry.record.line, record: entry.record });
      return;
    }
    stages.LOAD.out += 1;
    if (input.dryRun) {
      wouldApply += outcome.status === 'APPLIED' ? 1 : 0;
      duplicate += outcome.status === 'DUPLICATE' ? 1 : 0;
      lineage.push({ ...base, targetRef: null, status: outcome.status === 'APPLIED' ? 'WOULD_APPLY' : 'DUPLICATE' });
    } else if (outcome.status === 'APPLIED') {
      applied += 1;
      lineage.push({ ...base, targetRef: outcome.targetRef, status: 'APPLIED' });
    } else {
      duplicate += 1;
      lineage.push({ ...base, targetRef: outcome.targetRef, status: 'DUPLICATE' });
    }
  });
  return { rejects, lineage, applied, duplicate, wouldApply, loadRejected, loadFailure: null };
}

/**
 * Runs a pipeline once. The mapping must be approved (409 `HUB_MAPPING_NOT_APPROVED`) and the layout version of the spec is the one the source is read under. A failure of EXTRACT or of the LOAD as a whole fails the run
 * (`failure` names the stage and the code) and the watermark stays; a row that fails VALIDATE, TRANSFORM or its own LOAD is a REJECT and the run is PARTIAL, the rest are applied and the watermark moves (the rejects are
 * kept, not lost). A dry run reads, validates, transforms and asks LOAD to check, writes nothing and never moves the watermark.
 */
export async function runEtl(input: EtlRunInput): Promise<EtlRun> {
  assertMappingApproved(input.mapping);
  const stages = emptyStages();
  const base = { pipeline: input.spec.code, dryRun: input.dryRun, mappingVersion: input.mapping.version, layoutVersion: input.spec.layoutVersion, watermarkBefore: input.watermark };
  const failed = (stage: EtlStage, code: string, extra: Partial<EtlRun> = {}): EtlRun => ({
    ...base,
    outcome: 'FAILED',
    stages,
    rejects: [],
    lineage: [],
    reconcile: { extracted: stages.EXTRACT.out, applied: 0, duplicate: 0, rejected: 0, wouldApply: 0, batchSha256: batchHashOf([]), balanced: false },
    watermarkAfter: input.watermark,
    failure: { stage, code },
    ...extra,
  });
  let batch: ExtractBatch;
  try {
    batch = await input.ports.extract({ pipeline: input.spec.code, mode: input.spec.mode, watermark: input.spec.mode === 'FULL_SNAPSHOT' ? null : input.watermark, layoutVersion: input.spec.layoutVersion, ...(input.limit === undefined ? {} : { limit: input.limit }) });
  } catch (error) {
    return failed('EXTRACT', codeOf(error, 'EXTRACT_FAILED'));
  }
  stages.EXTRACT.in = batch.records.length;
  stages.EXTRACT.out = batch.records.length;
  const processed = await processRecords({ spec: input.spec, mapping: input.mapping, ports: input.ports, records: batch.records, dryRun: input.dryRun, batchSha256: batch.batchSha256 }, stages);
  if (processed.loadFailure !== null) return failed('LOAD', processed.loadFailure, { reconcile: { extracted: batch.records.length, applied: 0, duplicate: 0, rejected: processed.rejects.length, wouldApply: 0, batchSha256: batch.batchSha256, balanced: false }, rejects: processed.rejects });
  const rejected = processed.rejects.length;
  const balanced = batch.records.length === rejected + processed.applied + processed.duplicate + processed.wouldApply;
  return {
    ...base,
    outcome: rejected > 0 ? 'PARTIAL' : 'SUCCEEDED',
    stages,
    rejects: processed.rejects,
    lineage: processed.lineage,
    reconcile: { extracted: batch.records.length, applied: processed.applied, duplicate: processed.duplicate, rejected, wouldApply: processed.wouldApply, batchSha256: batch.batchSha256, balanced },
    // Advances only after a real load that completed.
    watermarkAfter: input.dryRun ? input.watermark : batch.nextWatermark ?? input.watermark,
    failure: null,
  };
}

export interface ReprocessResult {
  resolved: Array<{ sourceRef: string; key: string; lineage: LineageEntry }>;
  stillRejected: EtlReject[];
  stages: Record<EtlStage, StageCount>;
  failure: string | null;
}

/**
 * Takes rejects back through VALIDATE, TRANSFORM and LOAD after a person corrected them (`corrections` replaces fields of a record by its `sourceRef`). Does not touch the watermark (the batch it came from was already
 * passed). A record that passes is resolved, with its lineage; one that fails again stays a reject with its new reason; a failed load changes nothing.
 */
export async function reprocessRejects(input: { spec: EtlRunInput['spec']; mapping: MappingVersion; ports: EtlPorts; rejects: readonly EtlReject[]; corrections?: Readonly<Record<string, Readonly<Record<string, SourceValue>>>>; dryRun?: boolean }): Promise<ReprocessResult> {
  assertMappingApproved(input.mapping);
  const stages = emptyStages();
  const records = input.rejects.map((reject) => {
    const correction = input.corrections?.[reject.sourceRef];
    return correction === undefined ? reject.record : { ...reject.record, fields: { ...reject.record.fields, ...correction } };
  });
  const dryRun = input.dryRun ?? false;
  const processed = await processRecords({ spec: input.spec, mapping: input.mapping, ports: input.ports, records, dryRun, batchSha256: batchHashOf(records) }, stages);
  if (processed.loadFailure !== null) return { resolved: [], stillRejected: [...input.rejects], stages, failure: processed.loadFailure };
  const resolved = processed.lineage.map((entry) => ({ sourceRef: entry.sourceRef, key: entry.key, lineage: entry }));
  return { resolved, stillRejected: processed.rejects, stages, failure: null };
}
