import type { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const EXCLUSION_VIOLATION = '23P01';

/** The two tables of MNE that keep dated revisions of a code: the report forms and the obligation rules. */
export type MneRevisionTableName = 'mne_report_form' | 'mne_obligation_rule';

export interface RevisionPeriod {
  from: string;
  /** Exclusive: the first day the revision no longer applies; null while it is open-ended. */
  until: string | null;
}

/** A published revision that a successor takes over from. */
export interface ClosedRevision {
  id: string;
  revision: number;
  effectiveUntil: string;
}

interface PublishedRow {
  id: string;
  revision: number;
  effective_from: string;
  effective_until: string | null;
}

/**
 * The effective-dating rules that the report forms and the obligation rules share (BR-MNE-01, BR-MNE-02): the revisions of one code
 * never overlap, a revision is numbered by the store, and an open-ended revision is taken over by a successor that starts after it
 * (the earlier one is retired on the day the successor begins). Any other overlap is refused. The table and column names are
 * constants of the two stores, never input; the exclusion constraint of the table has the last word when two writers race.
 */
export class MneRevisionTable {
  private readonly table: MneRevisionTableName;
  private readonly codeColumn: 'form_code' | 'rule_code';
  private readonly overlap: () => DomainError;

  constructor(table: MneRevisionTableName, codeColumn: 'form_code' | 'rule_code', overlap: () => DomainError) {
    this.table = table;
    this.codeColumn = codeColumn;
    this.overlap = overlap;
  }

  /** Writers of one code take turns; the lock lasts until the end of the transaction. */
  async lockCode(tx: TenantTx, code: string): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('mne:' || $1::text || ':' || current_setting('app.tenant_id') || ':' || $2::text, 0))", [this.table, code]);
  }

  async nextRevision(tx: TenantTx, code: string): Promise<number> {
    const rows = await tx.query<{ revision: number | null }>(`select max(revision) as revision from machvon.${this.table} where ${this.codeColumn} = $1`, [code]);
    return (rows[0]?.revision ?? 0) + 1;
  }

  /**
   * The published revisions that the period would take over from. Throws the overlap error when the period meets a revision that cannot
   * be taken over: a closed period, a revision that starts on or after the new start, or any revision when the new period is closed.
   */
  async predecessors(tx: TenantTx, code: string, excludeId: string | null, period: RevisionPeriod): Promise<PublishedRow[]> {
    const overlapping = await tx.query<PublishedRow>(
      `select id, revision, effective_from::text as effective_from, effective_until::text as effective_until from machvon.${this.table}
        where ${this.codeColumn} = $1 and status <> 'DRAFT' and ($2::uuid is null or id <> $2::uuid)
          and daterange(effective_from, effective_until, '[)') && daterange($3::date, $4::date, '[)')
        order by effective_from for update`,
      [code, excludeId, period.from, period.until],
    );
    const blocked = overlapping.some((earlier) => earlier.effective_until !== null || earlier.effective_from >= period.from);
    if (blocked || (period.until !== null && overlapping.length > 0)) throw this.overlap();
    return overlapping;
  }

  /** Retires the revisions that the successor takes over from, on the day it starts. */
  async retire(tx: TenantTx, earlier: readonly PublishedRow[], on: string, actor: string): Promise<ClosedRevision[]> {
    const closed: ClosedRevision[] = [];
    for (const row of earlier) {
      await tx.query(
        `update machvon.${this.table} set status = 'RETIRED', effective_until = $2::date, retired_at = now(), updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
        [row.id, on, actor],
      );
      closed.push({ id: row.id, revision: row.revision, effectiveUntil: on });
    }
    return closed;
  }

  /** The answer of the exclusion constraint is the overlap error; any other failure is not ours to name. */
  asOverlap(error: unknown): unknown {
    return (error as { code?: string }).code === EXCLUSION_VIOLATION ? this.overlap() : error;
  }
}
