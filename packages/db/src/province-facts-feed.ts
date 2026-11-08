import { createHash } from 'node:crypto';
import { feedFactsToProvinceFacts } from '@machvon/kernel';
import type { OurProjectRef, ProvinceFacts, ProvinceFactsRequest } from '@machvon/kernel';
import { ProvinceFactsReader as FeedFactsReader } from './finance-feed-reader.ts';
import type { ProvinceFactsReader } from './province-facts.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The link between FEED-1 and BAN-1 (docs/committee-workspace.md): a `ProvinceFactsReader` that answers from the records of the feed of the Finance Department app. Where the
 * latest frozen snapshot of the Disbursement module is missing, the committee workspace stands on this reader instead of an empty province. The records are folded by the feed
 * reader (the latest statement of a thing wins; the generator counts only in its current epoch), our project is found by the code the feed maps to, and the pure function of
 * the kernel (`feedFactsToProvinceFacts`) makes the facts. Read only: this reader writes nothing and every row stays under row-level security.
 */

interface OurProjectSql {
  id: string;
  code: string;
  name: string;
  status: string;
  unit_id: string;
  unit_name: string;
  total: string;
}

/** A stable identifier (UUID shaped) made from a text: the same feed code gives the same id on every read. */
export function stableId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class FeedProvinceFactsReader implements ProvinceFactsReader {
  private readonly source = new FeedFactsReader();

  async read(tx: TenantTx, request: ProvinceFactsRequest): Promise<ProvinceFacts> {
    const fiscalYear = Number(request.asOf.slice(0, 4));
    const facts = await this.source.projects(tx, { fiscalYear, asOf: request.asOf });
    const codes = [...new Set(facts.map((fact) => fact.ourProjectCode).filter((code): code is string => code !== null))];
    const rows =
      codes.length === 0
        ? []
        : await tx.query<OurProjectSql>(
            `select p.id, p.code, p.name, p.status, coalesce(p.investor_unit_id, p.owner_unit_id) as unit_id, u.name as unit_name, p.total_investment_vnd::text as total
               from machvon.project p join machvon.organization_unit u on u.tenant_id = p.tenant_id and u.id = coalesce(p.investor_unit_id, p.owner_unit_id)
              where p.code = any($1::text[])`,
            [codes],
          );
    const ours = new Map<string, OurProjectRef>(rows.map((row) => [row.code, { id: row.id, name: row.name, status: row.status, investorUnitId: row.unit_id, investorName: row.unit_name, totalInvestmentVnd: row.total }]));
    const delivered = await tx.query<{ at: string | null }>(`select max(created_at)::text as at from machvon.finance_feed_run where records_written > 0`);
    return feedFactsToProvinceFacts({ facts, ours, asOf: request.asOf, fiscalYear, reference: `feed:${fiscalYear}`, lastDeliveredAt: delivered[0]?.at ?? null, idOf: stableId });
  }
}

/**
 * The reader the committee workspace uses by default: the frozen snapshot first (the official figure, with the comparison to the year before), the feed when there is no snapshot
 * on or before the day. A snapshot with no project at all counts as none.
 */
export class SnapshotOrFeedFactsReader implements ProvinceFactsReader {
  constructor(
    private readonly snapshot: ProvinceFactsReader,
    private readonly feed: ProvinceFactsReader,
  ) {}

  async read(tx: TenantTx, request: ProvinceFactsRequest): Promise<ProvinceFacts> {
    const official = await this.snapshot.read(tx, request);
    if (official.projects.length > 0 || official.lines.length > 0) return official;
    const fed = await this.feed.read(tx, request);
    return fed.projects.length > 0 || fed.lines.length > 0 ? fed : official;
  }
}
