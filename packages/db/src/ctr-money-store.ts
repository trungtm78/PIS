import { DomainError, GUARANTEE_LADDER_KEYS, RETENTION_LADDER_KEYS, evmCurveOf, evmOfContracts, ladderOf, tierSplitOf } from '@machvon/kernel';
import type { B1PolicyReader, EvmCurve, EvmFacts, EvmLinkFact, EvmProjectFact, EvmReading, EvmSetup, ExposureLadders, ExposureRow, PaymentClockParams, PaymentTiming, TierDelta, TierSplit } from '@machvon/kernel';
import { DEFAULT_B1_READER, b1PolicyOf } from './b1-policy-reader.ts';
import { assemble, pinDay } from './ctr-fact-store.ts';
import type { FactQuery } from './ctr-fact-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The reader of what the money reports of the contract portfolio (CA-2) need beyond the row of `contract_fact`: the earned value of the contracts that are linked to a package of their project, the payment requests inside
 * their clock, the changes by tier, and the retention and guarantee that fall due. Each is read for the SELECTION of the query (the same scope, filters and ledger right as the report) and for the contracts of a page, by
 * statements that name no table or column from a caller. Nothing here reads a frozen snapshot: what the snapshot does not hold the report says it does not hold (NOT_IN_SNAPSHOT).
 */

const TZ = "'Asia/Ho_Chi_Minh'";
/** The contracts of a selection that carry a package: more than this and the report refuses (422 REPORT_SELECTION_TOO_LARGE) rather than answer a part of it; narrow the filter. */
export const EVM_SELECTION_CAP = 5000;
/** The ladders and the "coming due" figures look this far ahead of the as-of day. */
const NEAR = 30;
const FAR = 90;

export interface EvmPolicyView {
  version: string;
  source: 'RULE' | 'BUILT_IN';
  eacMethod: string;
  amberBelow: number;
  redBelow: number;
}

export interface EvmRead {
  reading: EvmReading;
  facts: EvmFacts;
  setup: EvmSetup;
  policy: EvmPolicyView;
  /** Contracts of the selection that the reader may see the ledger of, and of them the ones with a package link. */
  selection: { visible: number; linked: number };
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The ids of a selection as a sub-select (the scope of the reader, the filters, and, when asked, the ledger right), with the parameters it uses numbered from 1. */
function selectionOf(query: FactQuery, withLedger: boolean): { sql: string; params: unknown[] } {
  const built = assemble(query, withLedger);
  const where = withLedger ? [...built.where, `(${built.ledger})`] : built.where;
  return { sql: `select c.id from ${built.from} where ${where.join(' and ')}`, params: built.params };
}

export class CtrMoneyStore {
  private readonly policy: B1PolicyReader<TenantTx>;

  constructor(policy: B1PolicyReader<TenantTx> = DEFAULT_B1_READER) {
    this.policy = policy;
  }

  // ---- earned value ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * The earned value of every contract of the selection that carries a package of its project, and the sums, on the as-of day. Only the contracts whose ledger the reader may see are read: the earned value is made of the
   * accepted work and the certified payments. A selection with more linked contracts than the cap is refused, never cut.
   */
  async evm(tx: TenantTx, query: FactQuery): Promise<EvmRead> {
    if (query.snapshotId !== undefined) throw invalid('snapshot_id');
    await pinDay(tx, query.asOf);
    const policy = await b1PolicyOf(this.policy, tx, 'EVM_POLICY', query.asOf);
    const setup: EvmSetup = { asOf: query.asOf, method: policy.params.eacMethod, policy: { amberBelow: policy.params.amberBelow, redBelow: policy.params.redBelow } };
    const policyView: EvmPolicyView = { version: policy.version, source: policy.version === 'built-in:1' ? 'BUILT_IN' : 'RULE', eacMethod: policy.params.eacMethod, amberBelow: policy.params.amberBelow, redBelow: policy.params.redBelow };
    const built = assemble(query);
    const where = `${built.where.join(' and ')} and (${built.ledger})`;
    const counted = await tx.query<{ visible: string; linked: string }>(
      `select count(*)::text as visible,
              (count(*) filter (where exists (select 1 from machvon.project_component_contract pcc where pcc.tenant_id = c.tenant_id and pcc.contract_id = c.id and pcc.ended_at is null)))::text as linked
         from ${built.from} where ${where}`,
      built.params,
    );
    const visible = Number(counted[0]?.visible ?? 0);
    const linked = Number(counted[0]?.linked ?? 0);
    const empty: EvmFacts = { acceptances: [], payments: [] };
    if (linked > EVM_SELECTION_CAP) throw new DomainError('REPORT_SELECTION_TOO_LARGE', 422, 'rows', { extensions: { cap: EVM_SELECTION_CAP, linked } });
    if (linked === 0) return { reading: evmOfContracts({ links: [], projects: [], facts: empty, unlinkedContracts: visible, setup }), facts: empty, setup, policy: policyView, selection: { visible, linked } };
    const links = await tx.query<{ contract_id: string; project_id: string; component_id: string; value_vnd: string }>(
      `select c.id::text as contract_id, c.project_id::text as project_id, pcc.component_id::text as component_id, c.contract_value_vnd::text as value_vnd
         from ${built.from}
         join machvon.project_component_contract pcc on pcc.tenant_id = c.tenant_id and pcc.contract_id = c.id and pcc.ended_at is null
        where ${where} order by c.id`,
      built.params,
    );
    const linkFacts: EvmLinkFact[] = links.map((row) => ({ contractId: row.contract_id, projectId: row.project_id, componentId: row.component_id, valueVnd: row.value_vnd }));
    const projectIds = [...new Set(linkFacts.map((link) => link.projectId))];
    const contractIds = linkFacts.map((link) => link.contractId);
    const components = await tx.query<{ project_id: string; id: string; parent: string | null }>('select project_id::text as project_id, id::text as id, parent_component_id::text as parent from machvon.project_component where project_id = any($1::uuid[])', [projectIds]);
    const lines = await tx.query<{ project_id: string; version: number; key: string; code: string; name: string; bac: string; planned_start: string; planned_finish: string }>(
      `select b.project_id::text as project_id, b.version, l.component_id::text as key, l.code, l.name, l.bac_vnd::text as bac, l.planned_start::text as planned_start, l.planned_finish::text as planned_finish
         from machvon.project_baseline b join machvon.project_baseline_line l on l.tenant_id = b.tenant_id and l.baseline_id = b.id
        where b.project_id = any($1::uuid[]) order by b.project_id, b.version, l.code`,
      [projectIds],
    );
    const projects: EvmProjectFact[] = projectIds.map((projectId) => {
      const own = lines.filter((line) => line.project_id === projectId);
      const versions = [...new Set(own.map((line) => Number(line.version)))].sort((a, b) => a - b);
      return {
        projectId,
        parents: new Map(components.filter((row) => row.project_id === projectId).map((row) => [row.id, row.parent] as const)),
        versions: versions.map((version) => ({
          version,
          lines: own.filter((line) => Number(line.version) === version).map((line) => ({ key: line.key, code: line.code, name: line.name, bacVnd: line.bac, plannedStart: line.planned_start, plannedFinish: line.planned_finish })),
        })),
      };
    });
    const acceptances = await tx.query<{ contract_id: string; day: string; amount: string }>(
      `select a.contract_id::text as contract_id, (a.approved_at at time zone ${TZ})::date::text as day, a.accepted_amount_vnd::text as amount
         from machvon.acceptance a where a.contract_id = any($1::uuid[]) and a.status = 'APPROVED' and a.approved_at is not null`,
      [contractIds],
    );
    const payments = await tx.query<{ contract_id: string; day: string; reversed_day: string | null; gross: string }>(
      `select pr.contract_id::text as contract_id, (pr.verified_at at time zone ${TZ})::date::text as day, (pr.reversed_at at time zone ${TZ})::date::text as reversed_day, pr.gross_vnd::text as gross
         from machvon.payment_request pr
        where pr.contract_id = any($1::uuid[]) and pr.status in ('VERIFIED', 'SENT_TREASURY', 'SETTLED', 'REVERSED') and pr.request_kind <> 'ADVANCE' and pr.verified_at is not null`,
      [contractIds],
    );
    const facts: EvmFacts = {
      acceptances: acceptances.map((row) => ({ contractId: row.contract_id, day: row.day, amountVnd: row.amount })),
      payments: payments.map((row) => ({ contractId: row.contract_id, day: row.day, reversedDay: row.reversed_day, grossVnd: row.gross })),
    };
    const reading = evmOfContracts({ links: linkFacts, projects, facts, unlinkedContracts: Math.max(0, visible - linked), setup });
    return { reading, facts, setup, policy: policyView, selection: { visible, linked } };
  }

  /** The S-curve of the selection, from the same reading as the table: the plan by the baseline in force and by version 0, the earned value and the cost up to the day. */
  async curve(tx: TenantTx, query: FactQuery): Promise<{ read: EvmRead; curve: EvmCurve }> {
    const read = await this.evm(tx, query);
    return { read, curve: evmCurveOf(read.reading, read.facts, query.asOf) };
  }

  // ---- payment requests inside their clock -----------------------------------------------------------------------------------------------------------

  /**
   * How many payment requests were judged against the clock and how many were inside it: for the contracts of the page, and for the whole selection (those whose ledger the reader may see). A request is judged by the same two steps
   * the view \`contract_fact\` takes its worst days from, so a contract is late on its clock exactly when one of its requests is.
   */
  async timing(tx: TenantTx, query: FactQuery, clock: PaymentClockParams, pageIds: readonly string[]): Promise<{ perContract: Map<string, PaymentTiming>; total: PaymentTiming }> {
    if (query.snapshotId !== undefined) throw invalid('snapshot_id');
    await pinDay(tx, query.asOf);
    const judged = (idsSql: string, first: number): string => `
      select x.contract_id, count(*) filter (where x.judged)::int as judged, (count(*) filter (where x.judged and not x.late))::int as on_time
        from (
          select pr.contract_id::text as contract_id,
                 (s1.d is not null or s2.d is not null) as judged,
                 (coalesce(s1.d > $${first}::int, false) or coalesce(s2.d > $${first + 1}::int, false)) as late
            from machvon.payment_request pr
            left join machvon.acceptance a on a.tenant_id = pr.tenant_id and a.id = pr.acceptance_id
            cross join lateral (select case when pr.request_kind <> 'ADVANCE' and pr.status in ('SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'SETTLED') and a.approved_at is not null and pr.submitted_at is not null
                                            then (pr.submitted_at at time zone ${TZ})::date - (a.approved_at at time zone ${TZ})::date end as d) s1
            cross join lateral (select case when pr.status in ('SENT_TREASURY', 'SETTLED') and pr.treasury_submitted_on is not null and pr.submitted_at is not null
                                            then pr.treasury_submitted_on - (pr.submitted_at at time zone ${TZ})::date end as d) s2
           where pr.contract_id in (${idsSql})
        ) x group by x.contract_id`;
    const perContract = new Map<string, PaymentTiming>();
    if (pageIds.length > 0) {
      const rows = await tx.query<{ contract_id: string; judged: number; on_time: number }>(judged('select unnest($1::uuid[])', 2), [pageIds, clock.acceptance_to_request_days, clock.request_to_treasury_days]);
      for (const row of rows) perContract.set(row.contract_id, { judged: Number(row.judged), onTime: Number(row.on_time) });
    }
    const selection = selectionOf(query, true);
    const rows = await tx.query<{ contract_id: string; judged: number; on_time: number }>(judged(selection.sql, selection.params.length + 1), [...selection.params, clock.acceptance_to_request_days, clock.request_to_treasury_days]);
    const total = rows.reduce<PaymentTiming>((acc, row) => ({ judged: acc.judged + Number(row.judged), onTime: acc.onTime + Number(row.on_time) }), { judged: 0, onTime: 0 });
    return { perContract, total };
  }

  // ---- the changes by tier ---------------------------------------------------------------------------------------------------------------------------

  /** The approved changes cut by tier: of each contract of the page and of the whole selection, with the original value of the selection (the denominator of every tier). */
  async tiers(tx: TenantTx, query: FactQuery, pageIds: readonly string[]): Promise<{ perContract: Map<string, TierDelta[]>; total: TierDelta[]; split: TierSplit }> {
    if (query.snapshotId !== undefined) throw invalid('snapshot_id');
    await pinDay(tx, query.asOf);
    const perContract = new Map<string, TierDelta[]>();
    if (pageIds.length > 0) {
      const rows = await tx.query<{ contract_id: string; tier: number | null; n: number; delta: string; max_pct: string | null }>(
        `select q.contract_id::text as contract_id, q.tier, count(*)::int as n, coalesce(sum(q.approved_delta_vnd), 0)::text as delta, max(q.cumulative_variation_pct)::text as max_pct
           from machvon.change_request q where q.status = 'APPROVED' and q.contract_id = any($1::uuid[]) group by q.contract_id, q.tier`,
        [pageIds],
      );
      for (const row of rows) perContract.set(row.contract_id, [...(perContract.get(row.contract_id) ?? []), { tier: row.tier === null ? null : Number(row.tier), count: Number(row.n), deltaVnd: row.delta, maxCumulativePct: row.max_pct }]);
    }
    const selection = selectionOf(query, false);
    const totalRows = await tx.query<{ tier: number | null; n: number; delta: string; max_pct: string | null }>(
      `select q.tier, count(*)::int as n, coalesce(sum(q.approved_delta_vnd), 0)::text as delta, max(q.cumulative_variation_pct)::text as max_pct
         from machvon.change_request q where q.status = 'APPROVED' and q.contract_id in (${selection.sql}) group by q.tier`,
      selection.params,
    );
    const total: TierDelta[] = totalRows.map((row) => ({ tier: row.tier === null ? null : Number(row.tier), count: Number(row.n), deltaVnd: row.delta, maxCumulativePct: row.max_pct }));
    const built = assemble(query, false);
    const original = await tx.query<{ original: string }>(`select coalesce(sum(c.original_value_vnd), 0)::text as original from ${built.from} where ${built.where.join(' and ')}`, built.params);
    return { perContract, total, split: tierSplitOf(total, original[0]?.original ?? '0') };
  }

  // ---- retention and guarantee that fall due ------------------------------------------------------------------------------------------------------

  /**
   * What the contracts of the page have coming due (retention that may be released now, guarantee in force that lapses within 90 days) and the ladders of the whole selection: the retention held cut by the day it may be
   * released (the contracts whose ledger the reader may see), the guarantees on the register cut by the day they lapse. The coming-due figures of the totals are read off the ladders, so a total and its ladder are one number.
   */
  async exposure(tx: TenantTx, query: FactQuery, pageIds: readonly string[]): Promise<{ perContract: Map<string, ExposureRow>; ladders: ExposureLadders; totals: { retentionDueNowVnd: string; guaranteeExpiringVnd: string } }> {
    if (query.snapshotId !== undefined) throw invalid('snapshot_id');
    await pinDay(tx, query.asOf);
    const perContract = new Map<string, ExposureRow>();
    if (pageIds.length > 0) {
      const holds = await tx.query<{ contract_id: string; due: string }>(
        `select h.contract_id::text as contract_id, sum(h.held_vnd - h.released_vnd)::text as due
           from machvon.retention_hold h
          where h.contract_id = any($1::uuid[]) and h.status in ('HELD', 'PARTIALLY_RELEASED') and h.release_not_before is not null and h.release_not_before <= $2::date group by h.contract_id`,
        [pageIds, query.asOf],
      );
      const guarantees = await tx.query<{ contract_id: string; expiring: string }>(
        `select g.contract_id::text as contract_id, sum(g.amount_vnd)::text as expiring
           from machvon.guarantee g
          where g.contract_id = any($1::uuid[]) and g.status = 'ACTIVE' and (g.valid_from is null or g.valid_from <= $2::date)
            and (g.expires_at at time zone ${TZ})::date >= $2::date and (g.expires_at at time zone ${TZ})::date <= $2::date + ${FAR}
          group by g.contract_id`,
        [pageIds, query.asOf],
      );
      for (const row of holds) perContract.set(row.contract_id, { retentionDueNowVnd: row.due, guaranteeExpiringVnd: null });
      for (const row of guarantees) perContract.set(row.contract_id, { retentionDueNowVnd: perContract.get(row.contract_id)?.retentionDueNowVnd ?? null, guaranteeExpiringVnd: row.expiring });
    }
    const ledgerSelection = selectionOf(query, true);
    const retentionRows = await tx.query<{ key: string; n: number; amount: string }>(
      `select case when h.release_not_before is null then 'NO_DATE'
                   when h.release_not_before <= $${ledgerSelection.params.length + 1}::date then 'DUE_NOW'
                   when h.release_not_before <= $${ledgerSelection.params.length + 1}::date + ${NEAR} then 'WITHIN_30'
                   when h.release_not_before <= $${ledgerSelection.params.length + 1}::date + ${FAR} then 'WITHIN_90'
                   else 'LATER' end as key,
              count(*)::int as n, coalesce(sum(h.held_vnd - h.released_vnd), 0)::text as amount
         from machvon.retention_hold h
        where h.status in ('HELD', 'PARTIALLY_RELEASED') and h.contract_id in (${ledgerSelection.sql}) group by 1`,
      [...ledgerSelection.params, query.asOf],
    );
    const plain = selectionOf(query, false);
    const guaranteeRows = await tx.query<{ key: string; n: number; amount: string }>(
      `select case when (g.expires_at at time zone ${TZ})::date < $${plain.params.length + 1}::date then 'LAPSED'
                   when (g.expires_at at time zone ${TZ})::date <= $${plain.params.length + 1}::date + ${NEAR} then 'WITHIN_30'
                   when (g.expires_at at time zone ${TZ})::date <= $${plain.params.length + 1}::date + ${FAR} then 'WITHIN_90'
                   else 'LATER' end as key,
              count(*)::int as n, coalesce(sum(g.amount_vnd), 0)::text as amount
         from machvon.guarantee g
        where g.status = 'ACTIVE' and (g.valid_from is null or g.valid_from <= $${plain.params.length + 1}::date) and g.contract_id in (${plain.sql}) group by 1`,
      [...plain.params, query.asOf],
    );
    const ladders: ExposureLadders = {
      retention: ladderOf(RETENTION_LADDER_KEYS, retentionRows.map((row) => ({ key: row.key, count: Number(row.n), amountVnd: row.amount }))),
      guarantee: ladderOf(GUARANTEE_LADDER_KEYS, guaranteeRows.map((row) => ({ key: row.key, count: Number(row.n), amountVnd: row.amount }))),
    };
    const amount = (ladder: ExposureLadders['retention'], key: string): bigint => BigInt(ladder.find((group) => group.key === key)?.amountVnd ?? '0');
    return {
      perContract,
      ladders,
      totals: { retentionDueNowVnd: amount(ladders.retention, 'DUE_NOW').toString(), guaranteeExpiringVnd: (amount(ladders.guarantee, 'WITHIN_30') + amount(ladders.guarantee, 'WITHIN_90')).toString() },
    };
  }
}

