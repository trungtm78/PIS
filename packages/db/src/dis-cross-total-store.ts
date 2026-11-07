import { DomainError, UNMATCHED_FUND, crossTotal, keyGaps, sumKeys } from '@machvon/kernel';
import type { CrossTotalDimension, CrossTotalKey, CrossTotalResult, DimensionTotal, KeyGap } from '@machvon/kernel';
import { normalizeUuid } from './file-import-item-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const CROSS_TOTAL_RESOURCE = 'cross_total_check';
export const CROSS_TOTAL_EVENT = 'dis.cross_total.checked.v1';
/** The code of the alert type of a check that did not agree. */
export const CROSS_TOTAL_ALERT_TYPE = 'CROSS_TOTAL_MISMATCH';
/** How many keys of each dimension are kept as the evidence of a check (the largest by size); the totals are always of all of them. */
export const CROSS_TOTAL_KEEP_KEYS = 20;

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const VN = "(t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date";
const SIGNED = "case when t.reversal_of_id is not null then -t.amount_vnd else t.amount_vnd end";

export type CrossTotalOrigin = 'FREEZE_GATE' | 'MANUAL';

/** What the three ways of adding up the disbursed money said for a snapshot, with the evidence of the disagreement. */
export interface CrossTotalView {
  id: string | null;
  snapshotId: string;
  periodId: string | null;
  fiscalYear: number;
  treasuryCutoffDate: string;
  /** From the first day of the fiscal year, to the cutoff: the window the ledger was read over. */
  windowFrom: string;
  published: boolean;
  totals: Record<CrossTotalDimension, string>;
  disagreeing: CrossTotalDimension[];
  agreeing: CrossTotalDimension[];
  /** For a disagreeing dimension, its total less the reference of the two that agree (null when no two agree). */
  offsetVnd: Partial<Record<CrossTotalDimension, string | null>>;
  /** Money of the Treasury that no fund could be found for (inside the fund total, shown apart as `UNMATCHED`). */
  unattributedFundVnd: string;
  keys: Record<CrossTotalDimension, { keyCount: number; top: CrossTotalKey[]; source: string }>;
  /** The projects on which the unit view (the snapshot) and the project view (the ledger) differ, largest gap first. */
  projectGaps: KeyGap[];
  origin: CrossTotalOrigin | null;
  createdBy: string | null;
  createdAt: string | null;
}

interface CheckSql {
  id: string;
  snapshot_id: string;
  period_id: string | null;
  fiscal_year: number;
  treasury_cutoff_date: string;
  published: boolean;
  total_unit_vnd: string;
  total_fund_vnd: string;
  total_project_vnd: string;
  disagreeing: CrossTotalDimension[];
  agreeing: CrossTotalDimension[];
  unattributed_fund_vnd: string;
  detail: { window_from: string; offset_vnd: Partial<Record<CrossTotalDimension, string | null>>; keys: CrossTotalView['keys']; project_gaps: KeyGap[] };
  origin: CrossTotalOrigin;
  created_by: string;
  created_at: string;
}

const CHECK_COLUMNS = `c.id, c.snapshot_id, c.period_id, c.fiscal_year, c.treasury_cutoff_date::text as treasury_cutoff_date, c.published, c.total_unit_vnd::text as total_unit_vnd, c.total_fund_vnd::text as total_fund_vnd,
  c.total_project_vnd::text as total_project_vnd, c.disagreeing, c.agreeing, c.unattributed_fund_vnd::text as unattributed_fund_vnd, c.detail, c.origin, c.created_by, to_char(c.created_at at time zone 'UTC', ${ISO}) as created_at`;

const toView = (row: CheckSql): CrossTotalView => ({
  id: row.id,
  snapshotId: row.snapshot_id,
  periodId: row.period_id,
  fiscalYear: row.fiscal_year,
  treasuryCutoffDate: row.treasury_cutoff_date,
  windowFrom: row.detail.window_from,
  published: row.published,
  totals: { UNIT: row.total_unit_vnd, FUND: row.total_fund_vnd, PROJECT: row.total_project_vnd },
  disagreeing: row.disagreeing,
  agreeing: row.agreeing,
  offsetVnd: row.detail.offset_vnd,
  unattributedFundVnd: row.unattributed_fund_vnd,
  keys: row.detail.keys,
  projectGaps: row.detail.project_gaps,
  origin: row.origin,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const largest = (keys: readonly CrossTotalKey[]): CrossTotalKey[] =>
  [...keys].sort((a, b) => {
    const x = BigInt(a.vnd) < 0n ? -BigInt(a.vnd) : BigInt(a.vnd);
    const y = BigInt(b.vnd) < 0n ? -BigInt(b.vnd) : BigInt(b.vnd);
    return x === y ? a.key.localeCompare(b.key) : x < y ? 1 : -1;
  }).slice(0, CROSS_TOTAL_KEEP_KEYS);

/**
 * The cross-total control (G4-5): the disbursed money of a period snapshot added up three ways must be one number to the dong, or the indicator is not published. By unit: the lines of the snapshot as they were built. By project
 * and by fund: the ledger of the Treasury now, from the first day of the fiscal year to the cutoff of the snapshot, a refund taking off, by project and by the fund of the allocation line the transaction (or the payment it is matched
 * to) names; money that no fund can be found for is its own key `UNMATCHED`, inside the total and shown apart. A snapshot built before a late transaction or a refund therefore disagrees with the ledger and must be built again; a ledger
 * that loses a key on the way to a fund disagrees with the projects. Which dimension disagrees, by how much and on which projects is kept with the check. Every check is written and never changed.
 */
export class DisCrossTotalStore {
  /** Reads the three totals now and judges them; writes nothing. */
  async compute(tx: TenantTx, snapshotId: string): Promise<Omit<CrossTotalView, 'id' | 'origin' | 'createdBy' | 'createdAt'>> {
    const id = normalizeUuid(snapshotId, 'snapshot_id');
    const [snapshot] = await tx.query<{ period_id: string; treasury_cutoff_date: string; fiscal_year: number }>(
      `select s.period_id, s.treasury_cutoff_date::text as treasury_cutoff_date, rp.fiscal_year
         from machvon.period_snapshot s join machvon.reporting_period rp on rp.tenant_id = s.tenant_id and rp.id = s.period_id where s.id = $1::uuid`,
      [id],
    );
    if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const from = `${snapshot.fiscal_year}-01-01`;
    const unitRows = await tx.query<{ key: string; label: string | null; vnd: string }>(
      `select l.unit_id::text as key, max(u.code) as label, coalesce(sum(l.disbursed_treasury_vnd), 0)::text as vnd
         from machvon.period_snapshot_line l left join machvon.organization_unit u on u.tenant_id = l.tenant_id and u.id = l.unit_id
        where l.snapshot_id = $1::uuid group by l.unit_id`,
      [id],
    );
    const snapshotByProject = await tx.query<{ key: string; label: string | null; vnd: string }>(
      `select l.project_id::text as key, max(p.code) as label, coalesce(sum(l.disbursed_treasury_vnd), 0)::text as vnd
         from machvon.period_snapshot_line l join machvon.project p on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.snapshot_id = $1::uuid group by l.project_id`,
      [id],
    );
    const projectRows = await tx.query<{ key: string; label: string | null; vnd: string }>(
      `select t.project_id::text as key, max(p.code) as label, sum(${SIGNED})::text as vnd
         from machvon.treasury_transaction t join machvon.project p on p.tenant_id = t.tenant_id and p.id = t.project_id
        where ${VN} between $1::date and $2::date group by t.project_id`,
      [from, snapshot.treasury_cutoff_date],
    );
    const fundRows = await tx.query<{ key: string; label: string | null; vnd: string }>(
      `select coalesce(fv.code, '${UNMATCHED_FUND}') as key, max(fv.label) as label, sum(${SIGNED})::text as vnd
         from machvon.treasury_transaction t
         left join machvon.payment_request pr on pr.tenant_id = t.tenant_id and pr.id = t.payment_request_id
         left join machvon.allocation_line al on al.tenant_id = t.tenant_id and al.id = coalesce(t.allocation_line_id, pr.allocation_line_id)
         left join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
        where ${VN} between $1::date and $2::date group by coalesce(fv.code, '${UNMATCHED_FUND}')`,
      [from, snapshot.treasury_cutoff_date],
    );
    const unit: CrossTotalKey[] = unitRows;
    const project: CrossTotalKey[] = projectRows;
    const fund: CrossTotalKey[] = fundRows;
    const dimensions: Record<CrossTotalDimension, DimensionTotal> = {
      UNIT: { totalVnd: sumKeys(unit), keys: unit, source: 'period_snapshot_line.disbursed_treasury_vnd' },
      FUND: { totalVnd: sumKeys(fund), keys: fund, source: 'treasury_transaction by allocation_line.fund_source_version' },
      PROJECT: { totalVnd: sumKeys(project), keys: project, source: 'treasury_transaction by project' },
    };
    const verdict: CrossTotalResult = crossTotal(dimensions);
    const keysOf = (dimension: CrossTotalDimension): CrossTotalView['keys'][CrossTotalDimension] => ({ keyCount: dimensions[dimension].keys.length, top: largest(dimensions[dimension].keys), source: dimensions[dimension].source });
    return {
      snapshotId: id,
      periodId: snapshot.period_id,
      fiscalYear: snapshot.fiscal_year,
      treasuryCutoffDate: snapshot.treasury_cutoff_date,
      windowFrom: from,
      published: verdict.published,
      totals: verdict.totals,
      disagreeing: verdict.disagreeing,
      agreeing: verdict.agreeing,
      offsetVnd: verdict.offsetVnd,
      unattributedFundVnd: fund.find((entry) => entry.key === UNMATCHED_FUND)?.vnd ?? '0',
      keys: { UNIT: keysOf('UNIT'), FUND: keysOf('FUND'), PROJECT: keysOf('PROJECT') },
      projectGaps: keyGaps(snapshotByProject, project, CROSS_TOTAL_KEEP_KEYS),
    };
  }

  /** Reads the three totals now, writes the check as one row (never changed) and answers it. */
  async evaluate(tx: TenantTx, snapshotId: string, actor: string, origin: CrossTotalOrigin): Promise<CrossTotalView> {
    const computed = await this.compute(tx, snapshotId);
    const detail = { window_from: computed.windowFrom, offset_vnd: computed.offsetVnd, keys: computed.keys, project_gaps: computed.projectGaps };
    const [row] = await tx.query<CheckSql>(
      `with inserted as (
         insert into machvon.cross_total_check
           (tenant_id, id, snapshot_id, period_id, fiscal_year, treasury_cutoff_date, published, total_unit_vnd, total_fund_vnd, total_project_vnd, disagreeing, agreeing, unattributed_fund_vnd, detail, origin, created_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::int, $4::date, $5::boolean, $6::numeric, $7::numeric, $8::numeric, $9::text[], $10::text[], $11::numeric, $12::jsonb, $13, $14::uuid)
         returning *)
       select ${CHECK_COLUMNS} from inserted c`,
      [
        computed.snapshotId,
        computed.periodId,
        computed.fiscalYear,
        computed.treasuryCutoffDate,
        computed.published,
        computed.totals.UNIT,
        computed.totals.FUND,
        computed.totals.PROJECT,
        computed.disagreeing,
        computed.agreeing,
        computed.unattributedFundVnd,
        JSON.stringify(detail),
        origin,
        actor,
      ],
    );
    if (row === undefined) throw new Error('a cross-total check vanished after it was written');
    return toView(row);
  }

  /** The checks that were written for a snapshot, the latest first. */
  async history(tx: TenantTx, snapshotId: string, limit = 20): Promise<CrossTotalView[]> {
    const rows = await tx.query<CheckSql>(`select ${CHECK_COLUMNS} from machvon.cross_total_check c where c.snapshot_id = $1::uuid order by c.created_at desc, c.id desc limit $2::int`, [normalizeUuid(snapshotId, 'snapshot_id'), limit]);
    return rows.map(toView);
  }

  /** The latest check of a snapshot, or undefined when nobody checked it yet. */
  async latest(tx: TenantTx, snapshotId: string): Promise<CrossTotalView | undefined> {
    return (await this.history(tx, snapshotId, 1))[0];
  }
}

/** The members of the audit row and of the event of a check: totals and names of dimensions, never a name of a person. */
export function crossTotalRecord(view: CrossTotalView, tenantId: string, actor: string, occurredAt: Date) {
  const facts = {
    snapshot_id: view.snapshotId,
    published: view.published,
    total_unit_vnd: view.totals.UNIT,
    total_fund_vnd: view.totals.FUND,
    total_project_vnd: view.totals.PROJECT,
    disagreeing: view.disagreeing,
    unattributed_fund_vnd: view.unattributedFundVnd,
    origin: view.origin,
  };
  return {
    audit: { action: 'dis.cross_total_checked', resourceType: CROSS_TOTAL_RESOURCE, resourceId: view.id as string, classification: 'CONFIDENTIAL' as const, diff: { ...facts, cross_total_check_id: view.id } },
    event: {
      aggregateType: CROSS_TOTAL_RESOURCE,
      aggregateId: view.id as string,
      aggregateVersion: 1,
      type: CROSS_TOTAL_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: tenantId, cross_total_check_id: view.id, ...facts, alert_type: view.published ? null : CROSS_TOTAL_ALERT_TYPE, actor_id: actor, occurred_at: occurredAt.toISOString() },
      eventKey: `${CROSS_TOTAL_RESOURCE}:${view.id}`,
    },
  };
}
