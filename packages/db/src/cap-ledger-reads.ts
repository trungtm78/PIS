import { foldBalance } from '@machvon/kernel';
import type { LedgerColumn } from '@machvon/kernel';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The capital ledger as a caller may read it (ST-CAP-014, CAP 3.4, CAP-21): the entries newest first, a page at a time, and the balance the entries up to a chosen moment add up to. An entry that belongs to a
 * project is read in the scope of the caller over that project; an entry that belongs to no project (the appropriation of a source of capital) only by someone who holds the right on the whole tenant. The ledger is
 * never written here.
 */
export interface CapitalLedgerFilter {
  appropriationId?: string | undefined;
  allocationLineId?: string | undefined;
  projectId?: string | undefined;
  /** Only the entries posted up to this moment (inclusive), as an ISO timestamp with its zone. */
  at?: string | undefined;
}

export interface CapitalLedgerScope {
  /** The scope of the caller over the projects the entries belong to. */
  projects: ScopeBuilder;
  /** The caller holds the right on the whole tenant: they also read the entries that belong to no project. */
  wholeTenant: boolean;
}

export interface CapitalLedgerEntry {
  id: string;
  entryType: string;
  amountVnd: string;
  planYear: number;
  appropriationId: string;
  allocationLineId: string | null;
  project: { id: string; code: string; name: string } | null;
  sourceRefKind: string;
  sourceRefId: string;
  reversalOfId: string | null;
  reason: string | null;
  postedAt: string;
  postedBy: { membershipId: string; displayName: string | null };
}

export interface CapitalLedgerPage {
  lines: CapitalLedgerEntry[];
  /** What the entries of the whole filter, up to the moment, add up to, column by column. */
  balance: Record<LedgerColumn, string>;
  /** How many entries those are. */
  entryCount: number;
  /** The moment the balance is for, to the microsecond the database cut at: the moment asked for, or the start of the read. */
  asOf: string;
}

interface EntrySql {
  id: string;
  entry_type: string;
  amount_vnd: string;
  plan_year: number;
  appropriation_id: string;
  allocation_line_id: string | null;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  source_ref_kind: string;
  source_ref_id: string;
  reversal_of_id: string | null;
  reason: string | null;
  posted_at: string;
  posted_by: string;
  posted_name: string | null;
}

const FROM = `machvon.capital_ledger_entry e
  left join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id
  left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export class CapLedgerReads {
  /** The entries of the filter in the scope of the caller, newest first, one page after the anchor, with the balance of the whole filter. */
  async list(tx: TenantTx, filter: CapitalLedgerFilter, scope: CapitalLedgerScope, page: { limit: number; after: { postedAt: string; id: string } | undefined }): Promise<CapitalLedgerPage> {
    const where = this.where(filter, scope);
    const lines = new Params();
    const sql = where(lines);
    const paging = page.after === undefined ? '' : ` and (e.posted_at, e.id) < (${lines.add(page.after.postedAt)}::timestamptz, ${lines.add(page.after.id)}::uuid)`;
    const rows = await tx.query<EntrySql>(
      `select e.id, e.entry_type, e.amount_vnd::text as amount_vnd, e.plan_year, e.appropriation_id, e.allocation_line_id, e.project_id, p.code as project_code, p.name as project_name,
              e.source_ref_kind, e.source_ref_id, e.reversal_of_id, e.reason, to_char(e.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as posted_at, e.posted_by, d.display_name as posted_name
         from ${FROM}
         left join machvon.tenant_user_directory d on d.tenant_id = e.tenant_id and d.membership_id = e.posted_by
        where ${sql}${paging} order by e.posted_at desc, e.id desc limit ${lines.add(page.limit)}`,
      lines.values,
    );
    const totals = new Params();
    const totalWhere = this.where(filter, scope)(totals);
    const sums = await tx.query<{ entry_type: string; reversed_type: string | null; total: string; entries: string }>(
      `select e.entry_type, original.entry_type as reversed_type, sum(e.amount_vnd)::text as total, count(*)::text as entries
         from ${FROM}
         left join machvon.capital_ledger_entry original on original.tenant_id = e.tenant_id and original.id = e.reversal_of_id
        where ${totalWhere} group by e.entry_type, original.entry_type`,
      totals.values,
    );
    const [moment] = await tx.query<{ as_of: string }>(`select to_char(coalesce($1::timestamptz, now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of`, [filter.at ?? null]);
    return {
      asOf: moment?.as_of ?? '',
      lines: rows.map((row) => ({
        id: row.id,
        entryType: row.entry_type,
        amountVnd: row.amount_vnd,
        planYear: row.plan_year,
        appropriationId: row.appropriation_id,
        allocationLineId: row.allocation_line_id,
        project: row.project_id === null ? null : { id: row.project_id, code: row.project_code ?? '', name: row.project_name ?? '' },
        sourceRefKind: row.source_ref_kind,
        sourceRefId: row.source_ref_id,
        reversalOfId: row.reversal_of_id,
        reason: row.reason,
        postedAt: row.posted_at,
        postedBy: { membershipId: row.posted_by, displayName: row.posted_name },
      })),
      balance: foldBalance(sums.map((sum) => ({ entryType: sum.entry_type, reversedType: sum.reversed_type, amountVnd: sum.total }))),
      entryCount: sums.reduce((count, sum) => count + Number(sum.entries), 0),
    };
  }

  /** The conditions of the filter and of the scope, built over the parameters the caller numbers. */
  private where(filter: CapitalLedgerFilter, scope: CapitalLedgerScope): (params: Params) => string {
    return (params) => {
      const conditions: string[] = [];
      if (filter.appropriationId !== undefined) conditions.push(`e.appropriation_id = ${params.add(filter.appropriationId)}::uuid`);
      if (filter.allocationLineId !== undefined) conditions.push(`e.allocation_line_id = ${params.add(filter.allocationLineId)}::uuid`);
      if (filter.projectId !== undefined) conditions.push(`e.project_id = ${params.add(filter.projectId)}::uuid`);
      if (filter.at !== undefined) conditions.push(`e.posted_at <= ${params.add(filter.at)}::timestamptz`);
      const predicate = scope.projects(params.values.length + 1);
      params.values.push(...predicate.params);
      conditions.push(`(case when e.project_id is null then ${params.add(scope.wholeTenant)}::boolean else (${predicate.sql}) end)`);
      return conditions.join(' and ');
    };
  }
}
