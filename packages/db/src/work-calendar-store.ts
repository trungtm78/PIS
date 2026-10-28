import { DomainError, versionConflict } from '@machvon/kernel';
import type { Holiday, WorkCalendarContent, WorkCalendarSource } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type WorkCalendarStatus = 'Draft' | 'Published' | 'Superseded';

export interface WorkCalendarRow {
  id: string;
  content: WorkCalendarContent;
  revision: number;
  status: WorkCalendarStatus;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: string | null;
  version: number;
}

interface Row {
  id: string;
  calendar_code: string;
  year: number;
  revision: number;
  working_days: number[];
  holidays: Holiday[];
  compensated_workdays: string[];
  legal_basis_ref: string;
  status: WorkCalendarStatus;
  created_by: string;
  published_by: string | null;
  published_at: string | null;
  version: string;
}

const COLUMNS = `id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by,
  published_by, published_at::text as published_at, version::text as version`;

/** The ordering key of the last row of a page. */
export interface WorkCalendarAnchor {
  code: string;
  id: string;
}

const CURSOR_KEY = /^(\d{4})\|([A-Za-z0-9][A-Za-z0-9_.-]*)\|(\d{1,9})$/;

/** The ordering key a page cursor carries for a version. */
export const calendarCursorKey = (row: WorkCalendarRow): string => `${row.content.year}|${row.content.calendar_code}|${row.revision}`;

/** How many years from the first one a deadline may run through; the same bound addWorkingTime scans. */
const YEARS_AHEAD = 3;

function toRow(row: Row): WorkCalendarRow {
  return {
    id: row.id,
    content: {
      calendar_code: row.calendar_code,
      year: row.year,
      working_days: row.working_days,
      holidays: row.holidays,
      compensated_workdays: row.compensated_workdays,
      legal_basis_ref: row.legal_basis_ref,
    },
    revision: row.revision,
    status: row.status,
    createdBy: row.created_by,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    version: Number(row.version),
  };
}

// Revisions of one calendar year are numbered and published one writer at a time; the lock lasts until the end of the transaction.
async function lockCalendarYear(tx: TenantTx, purpose: 'draft' | 'publish', calendarCode: string, year: number): Promise<void> {
  await tx.query(
    `select pg_advisory_xact_lock(hashtextextended($1::text || ':' || coalesce(current_setting('app.tenant_id', true), '') || ':' || $2::text || ':' || $3::text, 0))`,
    [`work_calendar_${purpose}`, calendarCode, year],
  );
}

/**
 * Working calendar versions (ST-ADM-010, ADM 3.8): one year of one calendar per version, a draft written by one
 * administrator and published later, the published version of a (calendar, year) being the one deadlines are counted by.
 * A published version never changes; publishing the next revision supersedes it in the same transaction. Every query runs
 * inside the caller's tenant transaction, so row-level security keeps tenants apart.
 */
export class WorkCalendarStore {
  /** Creates the next draft revision of a calendar year, numbered without gaps even when drafts are made in parallel. */
  async createDraft(tx: TenantTx, content: WorkCalendarContent, createdBy: string): Promise<{ id: string; revision: number; version: number }> {
    await lockCalendarYear(tx, 'draft', content.calendar_code, content.year);
    const rows = await tx.query<{ id: string; revision: number }>(
      `insert into machvon.work_calendar_version
         (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1, $2::int,
         (select coalesce(max(revision), 0) + 1 from machvon.work_calendar_version where calendar_code = $1 and year = $2::int),
         $3::jsonb, $4::jsonb, $5::jsonb, $6, 'Draft', $7::uuid, 1)
       returning id, revision`,
      [
        content.calendar_code,
        content.year,
        JSON.stringify(content.working_days),
        JSON.stringify(content.holidays),
        JSON.stringify(content.compensated_workdays ?? []),
        content.legal_basis_ref,
        createdBy,
      ],
    );
    const created = rows[0] as { id: string; revision: number };
    return { id: created.id, revision: created.revision, version: 1 };
  }

  async find(tx: TenantTx, id: string): Promise<WorkCalendarRow | undefined> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.work_calendar_version where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * Keyset page of the versions, newest year first, then the calendar code and the revision, all descending. The ordering key of a
   * page is `<year>|<calendar code>|<revision>`; the caller asks for one more row than it shows.
   */
  async list(tx: TenantTx, request: { limit: number; after: WorkCalendarAnchor | undefined }): Promise<WorkCalendarRow[]> {
    const { after } = request;
    const key = after === undefined ? undefined : CURSOR_KEY.exec(after.code);
    if (after !== undefined && key === null) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.work_calendar_version
        where ($1::int is null or (year, calendar_code, revision, id) < ($1::int, $2::text, $3::int, $4::uuid))
        order by year desc, calendar_code desc, revision desc, id desc
        limit $5`,
      [key?.[1] ?? null, key?.[2] ?? null, key?.[3] ?? null, after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /**
   * Locks a draft for publishing. One that is not there is 404, one that is no longer a draft is 409
   * STAGE_TRANSITION_DENIED (whatever version was sent), a stale version is 409 VERSION_CONFLICT.
   */
  async lockDraft(tx: TenantTx, id: string, expectedVersion: number): Promise<WorkCalendarRow> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.work_calendar_version where id = $1::uuid for update`, [id]);
    const draft = rows[0] === undefined ? undefined : toRow(rows[0]);
    if (draft === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (draft.status !== 'Draft') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (draft.version !== expectedVersion) throw versionConflict(draft.version);
    return draft;
  }

  /**
   * Publishes a locked draft. The version in force for the same calendar year until now becomes Superseded in the same
   * transaction, so at no moment are two versions in force; the lock makes a second publication wait for the first and
   * supersede it instead of failing on the one-Published-per-calendar-year index.
   */
  async publish(tx: TenantTx, draft: WorkCalendarRow, publishedBy: string): Promise<{ version: number; supersededId: string | undefined }> {
    await lockCalendarYear(tx, 'publish', draft.content.calendar_code, draft.content.year);
    // A draft written before a revision that is or was in force would take that revision's holidays back without anyone saying so.
    const newer = await tx.query<{ id: string }>(
      `select id from machvon.work_calendar_version where calendar_code = $1 and year = $2::int and revision > $3::int and status in ('Published', 'Superseded') limit 1`,
      [draft.content.calendar_code, draft.content.year, draft.revision],
    );
    if (newer.length > 0) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'revision');
    const superseded = await tx.query<{ id: string }>(
      `update machvon.work_calendar_version set status = 'Superseded', version = version + 1
        where calendar_code = $1 and year = $2::int and status = 'Published' returning id`,
      [draft.content.calendar_code, draft.content.year],
    );
    const rows = await tx.query<{ version: string }>(
      `update machvon.work_calendar_version
          set status = 'Published', published_by = $2::uuid, published_at = now(), version = version + 1
        where id = $1::uuid returning version::text as version`,
      [draft.id, publishedBy],
    );
    return { version: Number((rows[0] as { version: string }).version), supersededId: superseded[0]?.id };
  }

  /** The version in force for one year of a calendar, or undefined when none is published. */
  async published(tx: TenantTx, calendarCode: string, year: number): Promise<WorkCalendarRow | undefined> {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.work_calendar_version where calendar_code = $1 and year = $2::int and status = 'Published'`,
      [calendarCode, year],
    );
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * The published versions of a calendar from a year on, as the set `addWorkingTime` counts by (XM-ADM-01): a module that
   * stores a deadline calls it with the year of the start. A year without a published version is absent from the set, and a
   * deadline that needs it is refused rather than guessed.
   */
  async source(tx: TenantTx, calendarCode: string, fromYear: number, toYear: number = fromYear + YEARS_AHEAD): Promise<WorkCalendarSource> {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.work_calendar_version
        where calendar_code = $1 and status = 'Published' and year between $2::int and $3::int`,
      [calendarCode, fromYear, Math.max(toYear, fromYear)],
    );
    const byYear = new Map(rows.map((row) => [row.year, toRow(row).content]));
    return { forYear: (year) => byYear.get(year) };
  }
}
