import { createHash } from 'node:crypto';
import { DomainError, advanceIssue, assertAcceptable, assertDeliverable, assertLineage, nextIssueOf, versionConflict } from '@machvon/kernel';
import type { FormPeriod, FormPeriodKind, IssueAction, IssuedCopyMarks, IssuedCopyRef, IssueState, LayoutStatus, ReportDataSourceKind, ReportFileFormat, ReportLayout, NarrativeBlock, SnapshotRevisionRef } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * The store of the report engine (RPT-1 part 2, docs/report-engine.md): layouts and files by hash, the drafts that walk DRAFT, CHECKED, APPROVED, ISSUED, the insert-only issued copies of a series (R17) and the
 * delivery log (R17, R18). The rules are the kernel's (`advanceIssue`, `nextIssueOf`, `assertDeliverable`); the database keeps them as well with constraints and triggers, so a caller that skips the store cannot
 * break them. Every method takes the transaction of the command or the read it belongs to.
 */

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const UNIQUE_VIOLATION = '23505';

/** An advisory lock on one series for the length of the transaction, so two people cannot issue or deliver the same series at once. */
async function lockSeries(tx: TenantTx, layoutCode: string, periodCode: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || '|report|' || $1 || '|' || $2, 0))`, [layoutCode, periodCode]);
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// ---- layouts and files -----------------------------------------------------------------------------------------------------------------------

export interface ReportLayoutRow {
  id: string;
  code: string;
  version: string;
  name: string;
  status: LayoutStatus;
  edition: 'public' | 'enterprise';
  formRef: string | null;
  receiver: string;
  periodKind: FormPeriodKind;
  dataSource: ReportDataSourceKind;
  layout: ReportLayout;
  narrative: NarrativeBlock[] | null;
  templateSha256: string;
  narrativeTemplateSha256: string | null;
  registeredBy: string;
  createdAt: string;
}

interface LayoutSql {
  id: string;
  code: string;
  version: string;
  name: string;
  status: LayoutStatus;
  edition: 'public' | 'enterprise';
  form_ref: string | null;
  receiver: string;
  period_kind: FormPeriodKind;
  data_source: ReportDataSourceKind;
  layout: ReportLayout;
  narrative: NarrativeBlock[] | null;
  template_sha256: string;
  narrative_template_sha256: string | null;
  registered_by: string;
  created_at: string;
}

const LAYOUT_SELECT = `select id, code, version, name, status, edition, form_ref, receiver, period_kind, data_source, layout, narrative, template_sha256, narrative_template_sha256, registered_by,
  to_char(created_at at time zone 'UTC', ${ISO}) as created_at from machvon.report_layout`;

const layoutOf = (row: LayoutSql): ReportLayoutRow => ({
  id: row.id,
  code: row.code,
  version: row.version,
  name: row.name,
  status: row.status,
  edition: row.edition,
  formRef: row.form_ref,
  receiver: row.receiver,
  periodKind: row.period_kind,
  dataSource: row.data_source,
  layout: row.layout,
  narrative: row.narrative,
  templateSha256: row.template_sha256,
  narrativeTemplateSha256: row.narrative_template_sha256,
  registeredBy: row.registered_by,
  createdAt: row.created_at,
});

export interface RegisterLayoutInput {
  layout: ReportLayout;
  narrative: readonly NarrativeBlock[] | null;
  edition: 'public' | 'enterprise';
  receiver: string;
  periodKind: FormPeriodKind;
  dataSource: ReportDataSourceKind;
  xlsx: Uint8Array;
  docx: Uint8Array | null;
}

// ---- drafts and copies -----------------------------------------------------------------------------------------------------------------------

export interface ReportDraftRow {
  id: string;
  layoutId: string;
  layoutCode: string;
  layoutVersion: string;
  periodCode: string;
  period: FormPeriod;
  state: IssueState;
  baseRevision: number;
  reason: string | null;
  xlsxSha256: string;
  docxSha256: string | null;
  packageSha256: string;
  dataSource: ReportDataSourceKind;
  snapshotRef: SnapshotRevisionRef | null;
  marks: IssuedCopyMarks;
  gridIssues: Array<{ ref: string; code: string; detail: string | null }>;
  preparedBy: string;
  checkedBy: string | null;
  checkedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  issueId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface DraftSql {
  id: string;
  layout_id: string;
  layout_code: string;
  layout_version: string;
  period_code: string;
  period: FormPeriod;
  state: IssueState;
  base_revision: number;
  reason: string | null;
  xlsx_sha256: string;
  docx_sha256: string | null;
  package_sha256: string;
  data_source: ReportDataSourceKind;
  snapshot_ref: SnapshotRevisionRef | null;
  marks: IssuedCopyMarks;
  grid_issues: ReportDraftRow['gridIssues'];
  prepared_by: string;
  checked_by: string | null;
  checked_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  issue_id: string | null;
  version: string;
  created_at: string;
  updated_at: string;
}

const DRAFT_SELECT = `select id, layout_id, layout_code, layout_version, period_code, period, state, base_revision, reason, xlsx_sha256, docx_sha256, package_sha256, data_source, snapshot_ref, marks, grid_issues,
  prepared_by, checked_by, to_char(checked_at at time zone 'UTC', ${ISO}) as checked_at, approved_by, to_char(approved_at at time zone 'UTC', ${ISO}) as approved_at, issue_id, version::text as version,
  to_char(created_at at time zone 'UTC', ${ISO}) as created_at, to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at from machvon.report_draft`;

const draftOf = (row: DraftSql): ReportDraftRow => ({
  id: row.id,
  layoutId: row.layout_id,
  layoutCode: row.layout_code,
  layoutVersion: row.layout_version,
  periodCode: row.period_code,
  period: row.period,
  state: row.state,
  baseRevision: row.base_revision,
  reason: row.reason,
  xlsxSha256: row.xlsx_sha256,
  docxSha256: row.docx_sha256,
  packageSha256: row.package_sha256,
  dataSource: row.data_source,
  snapshotRef: row.snapshot_ref,
  marks: row.marks,
  gridIssues: row.grid_issues,
  preparedBy: row.prepared_by,
  checkedBy: row.checked_by,
  checkedAt: row.checked_at,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  issueId: row.issue_id,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface NewDraft {
  layout: ReportLayoutRow;
  period: FormPeriod;
  periodCode: string;
  baseRevision: number;
  reason: string | null;
  xlsxSha256: string;
  docxSha256: string | null;
  packageSha256: string;
  dataSource: ReportDataSourceKind;
  snapshotRef: SnapshotRevisionRef | null;
  marks: IssuedCopyMarks;
  gridIssues: ReportDraftRow['gridIssues'];
  preview: unknown;
  preparedBy: string;
}

export interface ReportIssueRow {
  id: string;
  layoutId: string;
  layoutCode: string;
  layoutVersion: string;
  periodCode: string;
  period: FormPeriod;
  revision: number;
  supersedesId: string | null;
  reason: string | null;
  draftId: string;
  sha256: string;
  xlsxSha256: string;
  docxSha256: string | null;
  xlsxName: string;
  docxName: string | null;
  dataSource: ReportDataSourceKind;
  snapshotRef: SnapshotRevisionRef | null;
  formStatus: LayoutStatus;
  demoMark: string | null;
  countsAsAccepted: boolean;
  gridIssues: ReportDraftRow['gridIssues'];
  preparedBy: string;
  checkedBy: string;
  approvedBy: string;
  issuedBy: string;
  issuedAt: string;
}

interface IssueSql {
  id: string;
  layout_id: string;
  layout_code: string;
  layout_version: string;
  period_code: string;
  period: FormPeriod;
  revision: number;
  supersedes_id: string | null;
  reason: string | null;
  draft_id: string;
  sha256: string;
  xlsx_sha256: string;
  docx_sha256: string | null;
  xlsx_name: string;
  docx_name: string | null;
  data_source: ReportDataSourceKind;
  snapshot_ref: SnapshotRevisionRef | null;
  form_status: LayoutStatus;
  demo_mark: string | null;
  counts_as_accepted: boolean;
  grid_issues: ReportDraftRow['gridIssues'];
  prepared_by: string;
  checked_by: string;
  approved_by: string;
  issued_by: string;
  issued_at: string;
}

const ISSUE_SELECT = `select id, layout_id, layout_code, layout_version, period_code, period, revision, supersedes_id, reason, draft_id, sha256, xlsx_sha256, docx_sha256, xlsx_name, docx_name, data_source, snapshot_ref,
  form_status, demo_mark, counts_as_accepted, grid_issues, prepared_by, checked_by, approved_by, issued_by, to_char(issued_at at time zone 'UTC', ${ISO}) as issued_at from machvon.report_issue`;

const issueOf = (row: IssueSql): ReportIssueRow => ({
  id: row.id,
  layoutId: row.layout_id,
  layoutCode: row.layout_code,
  layoutVersion: row.layout_version,
  periodCode: row.period_code,
  period: row.period,
  revision: row.revision,
  supersedesId: row.supersedes_id,
  reason: row.reason,
  draftId: row.draft_id,
  sha256: row.sha256,
  xlsxSha256: row.xlsx_sha256,
  docxSha256: row.docx_sha256,
  xlsxName: row.xlsx_name,
  docxName: row.docx_name,
  dataSource: row.data_source,
  snapshotRef: row.snapshot_ref,
  formStatus: row.form_status,
  demoMark: row.demo_mark,
  countsAsAccepted: row.counts_as_accepted,
  gridIssues: row.grid_issues,
  preparedBy: row.prepared_by,
  checkedBy: row.checked_by,
  approvedBy: row.approved_by,
  issuedBy: row.issued_by,
  issuedAt: row.issued_at,
});

/** What the kernel's rules read of a stored copy. */
export const copyRefOf = (row: ReportIssueRow): IssuedCopyRef => ({
  id: row.id,
  orgId: '',
  layoutCode: row.layoutCode,
  layoutVersion: row.layoutVersion,
  period: row.periodCode,
  revision: row.revision,
  supersedes: row.supersedesId,
  sha256: row.sha256,
  snapshot: row.snapshotRef,
  marks: { formStatus: row.formStatus, demoMark: row.demoMark },
});

export interface ReportDeliveryRow {
  id: string;
  issueId: string;
  layoutCode: string;
  periodCode: string;
  revision: number;
  sha256: string;
  receiver: string;
  channel: string;
  event: 'DELIVERED' | 'ACCEPTED' | 'REJECTED';
  reference: string | null;
  note: string | null;
  countsAsAccepted: boolean;
  recordedBy: string;
  occurredAt: string;
}

interface DeliverySql {
  id: string;
  issue_id: string;
  layout_code: string;
  period_code: string;
  revision: number;
  sha256: string;
  receiver: string;
  channel: string;
  event: 'DELIVERED' | 'ACCEPTED' | 'REJECTED';
  reference: string | null;
  note: string | null;
  counts_as_accepted: boolean;
  recorded_by: string;
  occurred_at: string;
}

const DELIVERY_SELECT = `select id, issue_id, layout_code, period_code, revision, sha256, receiver, channel, event, reference, note, counts_as_accepted, recorded_by,
  to_char(occurred_at at time zone 'UTC', ${ISO}) as occurred_at from machvon.report_delivery`;

const deliveryOf = (row: DeliverySql): ReportDeliveryRow => ({
  id: row.id,
  issueId: row.issue_id,
  layoutCode: row.layout_code,
  periodCode: row.period_code,
  revision: row.revision,
  sha256: row.sha256,
  receiver: row.receiver,
  channel: row.channel,
  event: row.event,
  reference: row.reference,
  note: row.note,
  countsAsAccepted: row.counts_as_accepted,
  recordedBy: row.recorded_by,
  occurredAt: row.occurred_at,
});

export interface DraftFilter {
  layoutCode?: string | undefined;
  state?: IssueState | undefined;
  limit: number;
}

export interface IssueFilter {
  layoutCode?: string | undefined;
  periodCode?: string | undefined;
  demo?: boolean | undefined;
  /** Only the head of each series (the copies nothing replaced). */
  headsOnly?: boolean | undefined;
  limit: number;
}

export interface IssueRequest {
  draft: ReportDraftRow;
  issuedBy: string;
  /** The names of the files of the copy: the revision is only known once the series is locked, so the caller gives the rule, not the names. */
  names: (revision: number) => { xlsx: string; docx: string | null };
}

export class ReportStore {
  // ---- files ---------------------------------------------------------------------------------------------------------------------------------

  /** Keeps a template file once per hash; returns the hash. The database checks that the hash is the file's own. */
  async putTemplate(tx: TenantTx, format: ReportFileFormat, bytes: Uint8Array, by: string): Promise<string> {
    const sha = sha256Of(bytes);
    await tx.query(
      `insert into machvon.report_template_file (tenant_id, sha256, format, size_bytes, content, created_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5)
       on conflict (tenant_id, sha256) do nothing`,
      [sha, format, bytes.length, Buffer.from(bytes), by],
    );
    return sha;
  }

  /** Keeps a generated file once per hash; returns the hash. */
  async putOutput(tx: TenantTx, format: ReportFileFormat, bytes: Uint8Array, by: string): Promise<string> {
    const sha = sha256Of(bytes);
    await tx.query(
      `insert into machvon.report_output_file (tenant_id, sha256, format, size_bytes, content, created_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5)
       on conflict (tenant_id, sha256) do nothing`,
      [sha, format, bytes.length, Buffer.from(bytes), by],
    );
    return sha;
  }

  /** The sizes of generated files by hash (for the file lists of drafts and copies). */
  async outputSizes(tx: TenantTx, hashes: readonly string[]): Promise<Map<string, number>> {
    if (hashes.length === 0) return new Map();
    const rows = await tx.query<{ sha256: string; size_bytes: number }>('select sha256, size_bytes from machvon.report_output_file where sha256 = any($1::text[])', [[...new Set(hashes)]]);
    return new Map(rows.map((row) => [row.sha256, row.size_bytes]));
  }

  /** The newest revision issued for each of the given series, keyed `layout|period`. */
  async headRevisions(tx: TenantTx, series: ReadonlyArray<{ layoutCode: string; periodCode: string }>): Promise<Map<string, number>> {
    if (series.length === 0) return new Map();
    const rows = await tx.query<{ layout_code: string; period_code: string; head: number }>(
      `select i.layout_code, i.period_code, max(i.revision) as head from machvon.report_issue i
        where (i.layout_code, i.period_code) in (select * from unnest($1::text[], $2::text[])) group by i.layout_code, i.period_code`,
      [series.map((one) => one.layoutCode), series.map((one) => one.periodCode)],
    );
    return new Map(rows.map((row) => [`${row.layout_code}|${row.period_code}`, row.head]));
  }

  async layoutsByIds(tx: TenantTx, ids: readonly string[]): Promise<Map<string, ReportLayoutRow>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.query<LayoutSql>(`${LAYOUT_SELECT} where id = any($1::uuid[])`, [[...new Set(ids)]]);
    return new Map(rows.map((row) => [row.id, layoutOf(row)]));
  }

  async templateBytes(tx: TenantTx, sha256: string): Promise<Uint8Array | undefined> {
    const rows = await tx.query<{ content: Buffer }>('select content from machvon.report_template_file where sha256 = $1', [sha256]);
    return rows[0] === undefined ? undefined : new Uint8Array(rows[0].content);
  }

  async outputBytes(tx: TenantTx, sha256: string): Promise<{ bytes: Uint8Array; format: ReportFileFormat } | undefined> {
    const rows = await tx.query<{ content: Buffer; format: ReportFileFormat }>('select content, format from machvon.report_output_file where sha256 = $1', [sha256]);
    return rows[0] === undefined ? undefined : { bytes: new Uint8Array(rows[0].content), format: rows[0].format };
  }

  // ---- layouts -------------------------------------------------------------------------------------------------------------------------------

  /** A layout version registered for the tenant: the same (code, version) is the same row, and a version is never changed (a second call returns the row that is there). */
  async registerLayout(tx: TenantTx, input: RegisterLayoutInput, by: string): Promise<{ row: ReportLayoutRow; created: boolean }> {
    const existing = await this.findLayout(tx, input.layout.code, input.layout.version);
    if (existing !== undefined) return { row: existing, created: false };
    const templateSha = await this.putTemplate(tx, 'XLSX', input.xlsx, by);
    const narrativeSha = input.docx === null ? null : await this.putTemplate(tx, 'DOCX', input.docx, by);
    try {
      const rows = await tx.query<LayoutSql>(
        `insert into machvon.report_layout (tenant_id, code, version, name, status, edition, form_ref, receiver, period_kind, data_source, layout, narrative, template_sha256, narrative_template_sha256, registered_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
         returning id, code, version, name, status, edition, form_ref, receiver, period_kind, data_source, layout, narrative, template_sha256, narrative_template_sha256, registered_by, to_char(created_at at time zone 'UTC', ${ISO}) as created_at`,
        [
          input.layout.code,
          input.layout.version,
          input.layout.name,
          input.layout.status,
          input.edition,
          input.layout.formRef,
          input.receiver,
          input.periodKind,
          input.dataSource,
          JSON.stringify(input.layout),
          input.narrative === null ? null : JSON.stringify(input.narrative),
          templateSha,
          narrativeSha,
          by,
        ],
      );
      return { row: layoutOf(rows[0] as LayoutSql), created: true };
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      const raced = await this.findLayout(tx, input.layout.code, input.layout.version);
      if (raced === undefined) throw error;
      return { row: raced, created: false };
    }
  }

  /** The layout of a code at a version, or the newest version when none is named. */
  async findLayout(tx: TenantTx, code: string, version?: string): Promise<ReportLayoutRow | undefined> {
    const rows =
      version === undefined
        ? await tx.query<LayoutSql>(`${LAYOUT_SELECT} where code = $1 order by created_at desc, id desc limit 1`, [code])
        : await tx.query<LayoutSql>(`${LAYOUT_SELECT} where code = $1 and version = $2`, [code, version]);
    return rows[0] === undefined ? undefined : layoutOf(rows[0]);
  }

  async getLayout(tx: TenantTx, id: string): Promise<ReportLayoutRow | undefined> {
    const rows = await tx.query<LayoutSql>(`${LAYOUT_SELECT} where id = $1`, [id]);
    return rows[0] === undefined ? undefined : layoutOf(rows[0]);
  }

  /** The newest version of every layout the tenant has registered. */
  async listLayouts(tx: TenantTx): Promise<ReportLayoutRow[]> {
    const rows = await tx.query<LayoutSql>(`${LAYOUT_SELECT} where (code, created_at) in (select code, max(created_at) from machvon.report_layout group by code) order by code`);
    return rows.map(layoutOf);
  }

  // ---- series --------------------------------------------------------------------------------------------------------------------------------

  /** The issued copies of one series, oldest first. */
  async series(tx: TenantTx, layoutCode: string, periodCode: string): Promise<ReportIssueRow[]> {
    const rows = await tx.query<IssueSql>(`${ISSUE_SELECT} where layout_code = $1 and period_code = $2 order by revision`, [layoutCode, periodCode]);
    return rows.map(issueOf);
  }

  /** The newest revision issued for the series, or 0. */
  async headRevision(tx: TenantTx, layoutCode: string, periodCode: string): Promise<number> {
    const rows = await tx.query<{ head: number | null }>('select max(revision) as head from machvon.report_issue where layout_code = $1 and period_code = $2', [layoutCode, periodCode]);
    return rows[0]?.head ?? 0;
  }

  /** The revision of a DIS snapshot: 1 for the first one, one more for each snapshot that replaced a snapshot (the chain of `supersedes_id`). */
  async snapshotRevision(tx: TenantTx, snapshotId: string): Promise<number> {
    const rows = await tx.query<{ revision: string }>(
      `with recursive chain as (select id, supersedes_id, 1 as depth from machvon.period_snapshot where id = $1
         union all select s.id, s.supersedes_id, c.depth + 1 from machvon.period_snapshot s join chain c on s.id = c.supersedes_id where c.depth < 1000)
       select coalesce(max(depth), 1)::text as revision from chain`,
      [snapshotId],
    );
    return Number(rows[0]?.revision ?? '1');
  }

  // ---- drafts --------------------------------------------------------------------------------------------------------------------------------

  /** A draft with the same files for the same series that nobody has issued yet: generating twice the same thing does not make two drafts. */
  async openDraftWith(tx: TenantTx, layoutCode: string, periodCode: string, packageSha256: string): Promise<ReportDraftRow | undefined> {
    const rows = await tx.query<DraftSql>(`${DRAFT_SELECT} where layout_code = $1 and period_code = $2 and package_sha256 = $3 and state <> 'ISSUED' order by created_at desc limit 1`, [layoutCode, periodCode, packageSha256]);
    return rows[0] === undefined ? undefined : draftOf(rows[0]);
  }

  async insertDraft(tx: TenantTx, input: NewDraft): Promise<ReportDraftRow> {
    const rows = await tx.query<DraftSql>(
      `insert into machvon.report_draft (tenant_id, layout_id, layout_code, layout_version, period_code, period, base_revision, reason, xlsx_sha256, docx_sha256, package_sha256, data_source, snapshot_ref, marks, grid_issues,
         preview, prepared_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16)
       returning id`,
      [
        input.layout.id,
        input.layout.code,
        input.layout.version,
        input.periodCode,
        JSON.stringify(input.period),
        input.baseRevision,
        input.reason,
        input.xlsxSha256,
        input.docxSha256,
        input.packageSha256,
        input.dataSource,
        input.snapshotRef === null ? null : JSON.stringify(input.snapshotRef),
        JSON.stringify(input.marks),
        JSON.stringify(input.gridIssues),
        JSON.stringify(input.preview),
        input.preparedBy,
      ],
    );
    const made = await this.findDraft(tx, (rows[0] as { id: string }).id);
    return made as ReportDraftRow;
  }

  async findDraft(tx: TenantTx, id: string, lock = false): Promise<ReportDraftRow | undefined> {
    const rows = await tx.query<DraftSql>(`${DRAFT_SELECT} where id = $1${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : draftOf(rows[0]);
  }

  async draftPreview(tx: TenantTx, id: string): Promise<unknown> {
    const rows = await tx.query<{ preview: unknown }>('select preview from machvon.report_draft where id = $1', [id]);
    return rows[0]?.preview;
  }

  async listDrafts(tx: TenantTx, filter: DraftFilter): Promise<ReportDraftRow[]> {
    const rows = await tx.query<DraftSql>(`${DRAFT_SELECT} where ($1::text is null or layout_code = $1) and ($2::text is null or state = $2) order by created_at desc, id desc limit $3`, [filter.layoutCode ?? null, filter.state ?? null, filter.limit]);
    return rows.map(draftOf);
  }

  /**
   * One step of a draft: CHECK, APPROVE or ISSUE-ready is decided by the kernel's state machine (the checker is not the preparer, the approver is neither). The draft must be at the version the caller saw
   * (VERSION_CONFLICT); the step must be the next one (REPORT_STATE_INVALID). `ISSUE` is not done here: it is `issue`, which also writes the copy.
   */
  async step(tx: TenantTx, id: string, expectedVersion: number, action: Exclude<IssueAction, 'ISSUE'>, actor: string): Promise<{ before: ReportDraftRow; row: ReportDraftRow }> {
    const before = await this.findDraft(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'draft');
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const next = advanceIssue({ state: before.state, actors: { preparer: before.preparedBy, checker: before.checkedBy, approver: before.approvedBy } }, action, actor);
    if (action === 'CHECK') await tx.query(`update machvon.report_draft set state = $2, checked_by = $3, checked_at = now(), version = version + 1, updated_at = now() where id = $1`, [id, next.state, actor]);
    else await tx.query(`update machvon.report_draft set state = $2, approved_by = $3, approved_at = now(), version = version + 1, updated_at = now() where id = $1`, [id, next.state, actor]);
    const row = (await this.findDraft(tx, id)) as ReportDraftRow;
    return { before, row };
  }

  // ---- issuing -------------------------------------------------------------------------------------------------------------------------------

  /**
   * Issues the approved draft: the approver issues it (advanceIssue ISSUE), the series is locked, the revision comes from `nextIssueOf` (a repeat of the head's bytes is a DUPLICATE and writes nothing), a draft made
   * before the head moved is REPORT_OUT_OF_DATE, and the copy is written insert-only with the draft marked ISSUED. Returns the copy and whether it is new.
   */
  async issue(tx: TenantTx, request: IssueRequest, expectedVersion: number): Promise<{ row: ReportIssueRow; outcome: 'NEW' | 'DUPLICATE'; draft: ReportDraftRow }> {
    const locked = await this.findDraft(tx, request.draft.id, true);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'draft');
    if (locked.version !== expectedVersion) throw versionConflict(locked.version);
    advanceIssue({ state: locked.state, actors: { preparer: locked.preparedBy, checker: locked.checkedBy, approver: locked.approvedBy } }, 'ISSUE', request.issuedBy);
    await lockSeries(tx, locked.layoutCode, locked.periodCode);
    const series = await this.series(tx, locked.layoutCode, locked.periodCode);
    const refs = series.map(copyRefOf);
    const head = assertLineage(refs);
    const next = nextIssueOf(refs, locked.packageSha256, locked.reason);
    if (next.outcome === 'DUPLICATE') {
      // The same bytes are already the head: the draft is not issued a second time; the answer is the copy that exists.
      return { row: series[series.length - 1] as ReportIssueRow, outcome: 'DUPLICATE', draft: locked };
    }
    const headRevision = head?.revision ?? 0;
    if (locked.baseRevision !== headRevision) throw new DomainError('REPORT_OUT_OF_DATE', 409, 'revision', { extensions: { current_revision: headRevision } });
    const names = request.names(next.revision);
    const inserted = await tx.query<IssueSql>(
      `insert into machvon.report_issue (tenant_id, layout_id, layout_code, layout_version, period_code, period, revision, supersedes_id, reason, draft_id, sha256, xlsx_sha256, docx_sha256, xlsx_name, docx_name,
         data_source, snapshot_ref, form_status, demo_mark, counts_as_accepted, grid_issues, prepared_by, checked_by, approved_by, issued_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20::jsonb, $21, $22, $23, $24)
       returning id`,
      [
        locked.layoutId,
        locked.layoutCode,
        locked.layoutVersion,
        locked.periodCode,
        JSON.stringify(locked.period),
        next.revision,
        next.supersedes,
        next.revision === 1 ? null : locked.reason,
        locked.id,
        locked.packageSha256,
        locked.xlsxSha256,
        locked.docxSha256,
        names.xlsx,
        names.docx,
        locked.dataSource,
        locked.snapshotRef === null ? null : JSON.stringify(locked.snapshotRef),
        locked.marks.formStatus,
        locked.marks.demoMark,
        locked.marks.formStatus !== 'DEMO',
        JSON.stringify(locked.gridIssues),
        locked.preparedBy,
        locked.checkedBy,
        locked.approvedBy,
        request.issuedBy,
      ],
    );
    const issueId = (inserted[0] as { id: string }).id;
    await tx.query(`update machvon.report_draft set state = 'ISSUED', issue_id = $2, version = version + 1, updated_at = now() where id = $1`, [locked.id, issueId]);
    const row = (await this.findIssue(tx, issueId)) as ReportIssueRow;
    const draft = (await this.findDraft(tx, locked.id)) as ReportDraftRow;
    return { row, outcome: 'NEW', draft };
  }

  async findIssue(tx: TenantTx, id: string): Promise<ReportIssueRow | undefined> {
    const rows = await tx.query<IssueSql>(`${ISSUE_SELECT} where id = $1`, [id]);
    return rows[0] === undefined ? undefined : issueOf(rows[0]);
  }

  async listIssues(tx: TenantTx, filter: IssueFilter): Promise<ReportIssueRow[]> {
    const rows = await tx.query<IssueSql>(
      `${ISSUE_SELECT} i where ($1::text is null or i.layout_code = $1) and ($2::text is null or i.period_code = $2) and ($3::boolean is null or (i.form_status = 'DEMO') = $3)
         and (not $4::boolean or not exists (select 1 from machvon.report_issue n where n.layout_code = i.layout_code and n.period_code = i.period_code and n.revision > i.revision))
       order by i.issued_at desc, i.id desc limit $5`,
      [filter.layoutCode ?? null, filter.periodCode ?? null, filter.demo ?? null, filter.headsOnly === true, filter.limit],
    );
    return rows.map(issueOf);
  }

  /** The newest revision of the series of a copy, which says whether the copy is current or superseded. */
  async headOf(tx: TenantTx, copy: ReportIssueRow): Promise<ReportIssueRow> {
    const series = await this.series(tx, copy.layoutCode, copy.periodCode);
    return series[series.length - 1] ?? copy;
  }

  // ---- deliveries ----------------------------------------------------------------------------------------------------------------------------

  async deliveriesOf(tx: TenantTx, issueId: string): Promise<ReportDeliveryRow[]> {
    const rows = await tx.query<DeliverySql>(`${DELIVERY_SELECT} where issue_id = $1 order by occurred_at, id`, [issueId]);
    return rows.map(deliveryOf);
  }

  async listDeliveries(tx: TenantTx, filter: { layoutCode?: string | undefined; receiver?: string | undefined; limit: number }): Promise<ReportDeliveryRow[]> {
    const rows = await tx.query<DeliverySql>(`${DELIVERY_SELECT} where ($1::text is null or layout_code = $1) and ($2::text is null or receiver = $2) order by occurred_at desc, id desc limit $3`, [filter.layoutCode ?? null, filter.receiver ?? null, filter.limit]);
    return rows.map(deliveryOf);
  }

  /** The newest copy of the series that this receiver accepted, or undefined: what R17 compares a delivery with. A copy made on a DEMO form is never one (the database never records it). */
  async acceptedCopy(tx: TenantTx, layoutCode: string, periodCode: string, receiver: string): Promise<ReportIssueRow | undefined> {
    const rows = await tx.query<IssueSql>(
      `${ISSUE_SELECT} i where i.layout_code = $1 and i.period_code = $2 and exists (select 1 from machvon.report_delivery d where d.issue_id = i.id and d.receiver = $3 and d.event = 'ACCEPTED') order by i.revision desc limit 1`,
      [layoutCode, periodCode, receiver],
    );
    return rows[0] === undefined ? undefined : issueOf(rows[0]);
  }

  /**
   * Records the delivery of a copy to a receiver. The series is locked; the kernel decides (`assertDeliverable`): a copy a later revision replaced, or older than what the receiver accepted, is REPORT_OUT_OF_DATE with the
   * current revision; the same copy delivered to the same receiver again is ALREADY_DELIVERED (the unique key gives the same answer under a race). Nothing is written when it is refused.
   */
  async deliver(tx: TenantTx, copy: ReportIssueRow, input: { receiver: string; channel: string; reference: string | null; note: string | null; by: string }): Promise<ReportDeliveryRow> {
    await lockSeries(tx, copy.layoutCode, copy.periodCode);
    const head = await this.headOf(tx, copy);
    const accepted = await this.acceptedCopy(tx, copy.layoutCode, copy.periodCode, input.receiver);
    const verdict = assertDeliverable(copyRefOf(copy), copyRefOf(head), accepted === undefined ? null : copyRefOf(accepted));
    if (verdict === 'ALREADY_DELIVERED') throw new DomainError('ALREADY_DELIVERED', 409, 'receiver');
    return this.insertDelivery(tx, copy, 'DELIVERED', input);
  }

  /** Records the receiver's answer to a delivered copy; a copy made on a DEMO form is never accepted (TEMPLATE_UNCONFIRMED, `demo_not_acceptable`, decided by the kernel before the database is asked). */
  async answer(tx: TenantTx, copy: ReportIssueRow, event: 'ACCEPTED' | 'REJECTED', input: { receiver: string; channel: string; reference: string | null; note: string | null; by: string }): Promise<ReportDeliveryRow> {
    if (event === 'ACCEPTED') assertAcceptable(copyRefOf(copy));
    await lockSeries(tx, copy.layoutCode, copy.periodCode);
    const delivered = (await this.deliveriesOf(tx, copy.id)).some((row) => row.receiver === input.receiver && row.event === 'DELIVERED');
    if (!delivered) throw new DomainError('REPORT_STATE_INVALID', 409, 'not_delivered');
    return this.insertDelivery(tx, copy, event, input);
  }

  private async insertDelivery(tx: TenantTx, copy: ReportIssueRow, event: ReportDeliveryRow['event'], input: { receiver: string; channel: string; reference: string | null; note: string | null; by: string }): Promise<ReportDeliveryRow> {
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.report_delivery (tenant_id, issue_id, layout_code, period_code, revision, sha256, receiver, channel, event, reference, note, counts_as_accepted, recorded_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [copy.id, copy.layoutCode, copy.periodCode, copy.revision, copy.sha256, input.receiver, input.channel, event, input.reference, input.note, copy.countsAsAccepted, input.by],
      );
      const found = await tx.query<DeliverySql>(`${DELIVERY_SELECT} where id = $1`, [(rows[0] as { id: string }).id]);
      return deliveryOf(found[0] as DeliverySql);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError(event === 'DELIVERED' ? 'ALREADY_DELIVERED' : 'REPORT_STATE_INVALID', 409, 'receiver');
      throw error;
    }
  }
}
