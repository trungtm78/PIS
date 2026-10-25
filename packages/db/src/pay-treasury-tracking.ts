import { DomainError } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_PAGE = 200;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** What PAY-09 shows of one project: the requests with the Treasury, the payments it confirmed, those not yet matched and the differences that wait. */
export interface TreasuryTrackingRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  sent: { count: number; amountVnd: string };
  settled: { count: number; amountVnd: string };
  confirmed: { count: number; amountVnd: string };
  unmatched: number;
  differences: { count: number; differenceVnd: string };
  lastConfirmedAt: string | null;
  lastImportAt: string | null;
}

interface TrackingSql {
  id: string;
  code: string;
  name: string;
  sent_count: string;
  sent_amount: string;
  settled_count: string;
  settled_amount: string;
  confirmed_count: string;
  confirmed_amount: string;
  unmatched: string;
  difference_count: string;
  difference_amount: string;
  last_confirmed_at: string | null;
  last_import_at: string | null;
}

/**
 * Where the projects stand with the Treasury (ST-PAY-007, PAY-09): counted from the rows of PAY at the moment of the read, for the projects in the scope of the caller that have anything with the
 * Treasury, in the order of their codes. A project with nothing sent, confirmed or in difference is not listed.
 */
export class PayTreasuryTracking {
  async list(tx: TenantTx, scope: ScopeBuilder, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<TreasuryTrackingRow[]> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_PAGE + 1) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    // The cursor is the code of the project and its id; a code is text, so only the id is held to be an identifier.
    if (request.after !== undefined) assertCursorCode(request.after.code);
    const predicate = scope(3);
    const rows = await tx.query<TrackingSql>(
      `select p.id, p.code, p.name, sent.c::text as sent_count, sent.a::text as sent_amount, settled.c::text as settled_count, settled.a::text as settled_amount,
              tr.c::text as confirmed_count, tr.a::text as confirmed_amount, tr.u::text as unmatched, di.c::text as difference_count, di.a::text as difference_amount,
              to_char(tr.m at time zone 'UTC', ${ISO}) as last_confirmed_at, to_char(im.m at time zone 'UTC', ${ISO}) as last_import_at
         from ${SCOPE_FROM}
         cross join lateral (select count(*) as c, coalesce(sum(pr.net_vnd), 0) as a from machvon.payment_request pr where pr.tenant_id = p.tenant_id and pr.project_id = p.id and pr.status = 'SENT_TREASURY') sent
         cross join lateral (select count(*) as c, coalesce(sum(pr.net_vnd), 0) as a from machvon.payment_request pr where pr.tenant_id = p.tenant_id and pr.project_id = p.id and pr.status = 'SETTLED') settled
         cross join lateral (select count(*) as c, coalesce(sum(t.amount_vnd), 0) as a, max(t.confirmed_at) as m, count(*) filter (where t.match_status = 'UNMATCHED') as u
                               from machvon.treasury_transaction t where t.tenant_id = p.tenant_id and t.project_id = p.id and t.direction = 'PAYMENT') tr
         cross join lateral (select count(*) as c, coalesce(sum(ri.difference_vnd), 0) as a from machvon.reconciliation_item ri where ri.tenant_id = p.tenant_id and ri.project_id = p.id and ri.status in ('OPEN', 'EXPLAINED')) di
         cross join lateral (select max(i.imported_at) as m from machvon.treasury_transaction t join machvon.treasury_import i on i.tenant_id = t.tenant_id and i.id = t.import_id
                              where t.tenant_id = p.tenant_id and t.project_id = p.id) im
        where sent.c + settled.c + tr.c + di.c > 0 and ($1::text is null or (p.code, p.id) > ($1::text, $2::uuid)) and ${predicate.sql}
        order by p.code, p.id limit ${request.limit}`,
      [request.after?.code ?? null, request.after?.id ?? null, ...predicate.params],
    );
    return rows.map((row) => ({
      projectId: row.id,
      projectCode: row.code,
      projectName: row.name,
      sent: { count: Number(row.sent_count), amountVnd: row.sent_amount },
      settled: { count: Number(row.settled_count), amountVnd: row.settled_amount },
      confirmed: { count: Number(row.confirmed_count), amountVnd: row.confirmed_amount },
      unmatched: Number(row.unmatched),
      differences: { count: Number(row.difference_count), differenceVnd: row.difference_amount },
      lastConfirmedAt: row.last_confirmed_at,
      lastImportAt: row.last_import_at,
    }));
  }
}

function assertCursorCode(code: string): void {
  if (code.length === 0 || code.length > 200) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
}
