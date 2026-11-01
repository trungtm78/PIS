import { createHash, randomUUID } from 'node:crypto';
import { BiDatasetStore, BiExportStore, BiQueryStore, assertFilter } from '@machvon/db';
import type { BiExportJobRow, TenantTx } from '@machvon/db';
import { BI_DIMENSION_LABELS, BI_EXPORT_ROW_CAP, BI_EXPORT_TTL_DAYS, DomainError, PDF_ROW_CAP, activeGrants, buildBiExportDocument, csvOf, figureOf, holdsPermission, xlsxOf } from '@machvon/kernel';
import type { BiExportFormat, EffectiveAccess, TenantContext } from '@machvon/kernel';
import type { FileService } from '../files/file.service';
import { pdfOf } from '../dis/export-pdf';
import { DATASET_CODE, EXPORT_PERMISSION, FILTER_FIELDS, QUERY_PERMISSION } from './query-engine';
export { EXPORT_PERMISSION };
import type { BiQueryEngine } from './query-engine';

/** The kind of the object key the files of the exports are stored under. */
export const EXPORT_KIND = 'bi_export';
const MEDIA_TYPE: Readonly<Record<BiExportFormat, string>> = { CSV: 'text/csv', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', PDF: 'application/pdf' };
const OPERATORS: readonly string[] = ['eq', 'in', 'gte', 'lte'];

/** What an export asks: a certified metric, cut by at most one dimension, narrowed by filters; the snapshot is named, or the period, or neither (the latest frozen version). */
export interface ExportSpec {
  metricId: string;
  dimension: string | undefined;
  filters: Array<{ field: string; operator: 'eq' | 'in' | 'gte' | 'lte'; value: unknown }>;
  snapshotId: string | undefined;
  asOfPeriod: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The spec of a request or of a schedule, as the contract leaves it (an object): anything outside what a query takes is 422 naming the field. */
export function parseExportSpec(raw: unknown, asOfPeriod: string | undefined, snapshotId: string | undefined): ExportSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('query_spec');
  const spec = raw as Record<string, unknown>;
  const allowed = new Set(['metric_version_id', 'dimensions', 'filters', 'as_of_period', 'snapshot_id']);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) throw invalid(`query_spec.${key}`);
  if (typeof spec.metric_version_id !== 'string' || !UUID.test(spec.metric_version_id)) throw invalid('query_spec.metric_version_id');
  const dimensions = spec.dimensions ?? [];
  if (!Array.isArray(dimensions) || dimensions.length > 1 || dimensions.some((item) => typeof item !== 'string' || !FILTER_FIELDS.has(item))) throw invalid('query_spec.dimensions');
  const filters = spec.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 20) throw invalid('query_spec.filters');
  const parsed = filters.map((item, index): ExportSpec['filters'][number] => {
    const filter = item as Record<string, unknown> | null;
    if (
      typeof filter !== 'object' ||
      filter === null ||
      typeof filter.field !== 'string' ||
      !FILTER_FIELDS.has(filter.field) ||
      typeof filter.operator !== 'string' ||
      !OPERATORS.includes(filter.operator) ||
      !('value' in filter)
    )
      throw invalid(`query_spec.filters[${index}]`);
    const parsed: ExportSpec['filters'][number] = { field: filter.field, operator: filter.operator as ExportSpec['filters'][number]['operator'], value: filter.value };
    // The values are judged as the query judges them (an id, a list that is not empty, no order over ids): a schedule is kept and run later, and one that could never run is refused now.
    assertFilter(parsed);
    return parsed;
  });
  const inner = { period: spec.as_of_period, snapshot: spec.snapshot_id };
  if (inner.period !== undefined && (typeof inner.period !== 'string' || inner.period.length < 4 || inner.period.length > 20)) throw invalid('query_spec.as_of_period');
  if (inner.snapshot !== undefined && (typeof inner.snapshot !== 'string' || !UUID.test(inner.snapshot))) throw invalid('query_spec.snapshot_id');
  return {
    metricId: spec.metric_version_id.toLowerCase(),
    dimension: dimensions[0] as string | undefined,
    filters: parsed,
    snapshotId: ((snapshotId ?? inner.snapshot) as string | undefined)?.toLowerCase(),
    asOfPeriod: asOfPeriod ?? (inner.period as string | undefined),
  };
}

/** Whether the person holds the permission through any grant that is in force now (and their membership is active). */
export function holdsNow(access: EffectiveAccess, permission: string, now: Date): boolean {
  return access.membershipActive && activeGrants(access, now).some((grant) => holdsPermission(new Set(grant.permissions), permission));
}

export interface RunInput {
  /** The person the file is for: the scope is theirs, as it is now. */
  subject: string;
  access: EffectiveAccess;
  requestedBy: string;
  scheduleId: string | null;
  spec: ExportSpec;
  format: BiExportFormat;
  now: Date;
  /** A run no person waits for (a schedule): an error after the job was made ends it as FAILED and the run goes on; a request that someone waits for answers the error and keeps nothing. */
  lenient: boolean;
  /** The text the query spec is kept as in the job (what was asked, as it was asked). */
  querySpec: Record<string, unknown>;
}

/** A failure that comes from the database (it carries a SQLSTATE): the transaction that met it may not go on. */
export const isDatabaseError = (error: unknown): boolean => typeof (error as { code?: unknown } | null)?.code === 'string' && /^[0-9A-Z]{5}$/.test((error as { code: string }).code);

export type Outcome = { kind: 'READY'; job: BiExportJobRow } | { kind: 'ENDED'; job: BiExportJobRow; error: DomainError };

const refusal = (code: string, status: number): DomainError => new DomainError(code, status);

/**
 * One export job for one person (ST-BI-008, BI 3 F7): the right is judged now and the scope is theirs as it is now (a person who lost the right gets a DENIED job and no file, and the data of an older scope is never
 * written), the answer is read in full up to the cap of the format (a larger one is refused, never cut), and the file says what the figures are in its header. The job is the record, whatever the end: READY with its
 * file, its digest and when it expires, DENIED with the reason, or FAILED.
 */
export class BiExportRunner {
  private readonly store = new BiExportStore();
  private readonly queries = new BiQueryStore();
  private readonly datasets = new BiDatasetStore();

  constructor(
    private readonly engine: BiQueryEngine,
    private readonly files: Pick<FileService, 'storeGenerated' | 'remove'>,
  ) {}

  /** The version of the dataset the export reads: the one named, the latest frozen of the period, or the latest frozen of all. */
  private async resolveVersion(tx: TenantTx, spec: ExportSpec): Promise<string> {
    const found =
      spec.snapshotId ?? (spec.asOfPeriod === undefined ? (await this.queries.latestFrozenVersion(tx, DATASET_CODE))?.versionId : await this.queries.latestSnapshotOfPeriod(tx, spec.asOfPeriod));
    if (found === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 422, 'snapshot_id');
    return found;
  }

  async run(tx: TenantTx, tenant: TenantContext, input: RunInput): Promise<Outcome> {
    const { spec, now } = input;
    const versionId = await this.resolveVersion(tx, spec);
    const version = await this.queries.versionOfSnapshot(tx, DATASET_CODE, versionId);
    if (version === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 422, 'snapshot_id');
    // A snapshot that is named and a period that is named are the same period.
    if (spec.snapshotId !== undefined && spec.asOfPeriod !== undefined && version.periodCode !== spec.asOfPeriod) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_period');
    const cap = input.format === 'PDF' ? PDF_ROW_CAP : BI_EXPORT_ROW_CAP;
    const jobId = randomUUID();
    const scopeHash = await this.engine.exportScopeHash(tx, input.subject, input.access, version.datasetId, now);
    const make = (scopeDescription: string): Promise<BiExportJobRow> =>
      this.store.createJob(tx, jobId, {
        requestedBy: input.requestedBy,
        subjectUserId: input.subject,
        scheduleId: input.scheduleId,
        querySpec: input.querySpec,
        asOfPeriod: version.periodCode,
        datasetVersionId: version.datasetVersionId,
        scopeHash,
        scopeDescription,
        format: input.format,
        rowCap: cap,
      });
    const ended = async (status: 'DENIED' | 'FAILED', code: string, httpStatus: number): Promise<Outcome> => {
      const job = await this.store.markEnded(tx, jobId, status, code);
      return { kind: 'ENDED', job, error: refusal(code, httpStatus) };
    };
    // The right is judged as it is now, for the person the file is for: the export and the query, over some scope; the job is made first, so that whatever follows is a record.
    const holds = holdsNow(input.access, EXPORT_PERMISSION, now) && holdsNow(input.access, QUERY_PERMISSION, now);
    const scopeDescription = !holds ? 'Không có quyền' : this.engine.exportableProjects(input.access, now)(1).sql === 'true' ? 'Toàn tỉnh' : 'Theo phạm vi được cấp của người nhận';
    await make(scopeDescription);
    await this.store.markRunning(tx, jobId);
    if (!holds) return ended('DENIED', 'SCOPE_DENIED', 403);
    try {
      // A schedule asks for the revision of the metric it was made with, as a dashboard does: a newer revision that replaced it does not stop the schedule (one that was withdrawn does); a request that someone makes now needs a certified one.
      const reading = await this.engine.read(tx, input.subject, input.access, spec.metricId, version.datasetVersionId, now, input.scheduleId !== null);
      if (reading.denied !== undefined) return ended('DENIED', reading.denied, 403);
      const { value: read } = reading;
      // A dataset that is confidential or personal is exported only where a policy allows it; no policy says so yet, so it is not exported.
      const dataset = await this.datasets.find(tx, version.datasetId);
      if (dataset !== undefined && (dataset.classification === 'CONFIDENTIAL' || dataset.classification === 'PERSONAL')) return ended('DENIED', 'CLASSIFICATION_EXPORT_DENIED', 403);
      this.engine.assertDimensions(read, [...(spec.dimension === undefined ? [] : [spec.dimension]), ...spec.filters.map((filter) => filter.field)]);
      const answer = await this.engine.answerAll(tx, read, spec.dimension, spec.filters as never, input.access, now, cap);
      if (answer.rows.length > cap) return ended('DENIED', 'EXPORT_ROW_CAP_EXCEEDED', 422);
      const figures = answer.rows.map((row) => ({ key: row.key, label: row.label, ...figureOf(read.plan, row) }));
      const total = figureOf(read.plan, answer.total);
      const document = buildBiExportDocument({
        metricCode: read.metricCode,
        metricRevision: read.metricRevision,
        unit: read.unit,
        dimension: spec.dimension === undefined ? undefined : { code: spec.dimension, label: BI_DIMENSION_LABELS[spec.dimension] ?? spec.dimension },
        asOfPeriod: read.version.periodCode,
        datasetVersionId: read.version.datasetVersionId,
        scopeDescription,
        generatedAt: now,
        rows: figures.map((figure) => ({ key: figure.key, label: figure.label, value: figure.value, numerator: figure.numerator, denominator: figure.denominator, nullReason: figure.nullReason })),
        total: { value: total.value, numerator: total.numerator, denominator: total.denominator, nullReason: total.nullReason },
      });
      const bytes: Uint8Array = input.format === 'CSV' ? new Uint8Array(Buffer.from(csvOf(document), 'utf8')) : input.format === 'XLSX' ? xlsxOf(document) : await pdfOf(document, { stamp: now });
      const key = await this.files.storeGenerated(tenant, EXPORT_KIND, jobId, bytes, MEDIA_TYPE[input.format]);
      const expires = new Date(now.getTime() + BI_EXPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
      let job: BiExportJobRow;
      try {
        job = await this.store.markReady(tx, jobId, { rowCount: answer.rows.length, fileObjectKey: key, fileSha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: expires });
      } catch (error) {
        // The job did not take the file: the file is not left behind with nothing that names it.
        await this.files.remove(tenant, key).catch(() => false);
        throw error;
      }
      return { kind: 'READY', job };
    } catch (error) {
      // A run no person waits for ends as a record: a refusal of the domain by its code, and a failure of the platform (the renderer, the object store) as `EXPORT_FAILED`. A failure of the database is not caught here: the transaction is no longer usable.
      if (input.lenient && error instanceof DomainError) return ended('FAILED', error.code, error.status);
      if (input.lenient && !isDatabaseError(error)) return ended('FAILED', 'EXPORT_FAILED', 500);
      throw error;
    }
  }
}
