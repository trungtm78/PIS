import { DomainError, FINANCIAL_RECOMMENDATION_TYPES, defectIsOpen, obstacleIsOpen } from '@machvon/kernel';
import type { ClaimRecord, ClaimState, DefectRecord, FindingRecord, ObstacleRecord, RatingInputs, RegisterContract } from '@machvon/kernel';
import { assemble, pinDay } from './ctr-fact-store.ts';
import type { FactQuery } from './ctr-fact-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The reader of the registers the CA-3 reports are made of (claim-like records, defects, issues, audit findings, confirmed violations). Each is read for the SELECTION of the query: the same scope, filters and ledger
 * right as the other reports, by the one `assemble` the contract fact uses, so a contract the reader may not read is never in a register report. Nothing here reads a frozen snapshot (a register keeps no frozen copy: the
 * reports of the registers are live readings). A selection with more records than the cap is refused (422 REPORT_SELECTION_TOO_LARGE), never cut. Names of tables and columns are constants of this file.
 */

/** The most records of one register a report holds: more than this and the report refuses, so a total is never the total of a part. */
export const REGISTER_ROW_CAP = 20_000;

const TZ = "'Asia/Ho_Chi_Minh'";
const FINANCIAL_SQL = FINANCIAL_RECOMMENDATION_TYPES.map((type) => `'${type}'`).join(', ');
const day = (column: string): string => `(${column} at time zone ${TZ})::date::text`;

interface IdentitySql {
  contract_id: string;
  contract_code: string;
  contract_title: string | null;
  project_code: string;
  contractor_name: string | null;
  unit_name: string;
  contract_status: string;
  ledger_ok: boolean;
}

const identityOf = (row: IdentitySql): RegisterContract => ({
  id: row.contract_id,
  code: row.contract_code,
  title: row.contract_title,
  projectCode: row.project_code,
  contractorName: row.contractor_name,
  unitName: row.unit_name,
  status: row.contract_status,
  ledgerOk: row.ledger_ok === true,
});

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

export interface RegisterReaderContext {
  /** The scope of the reader over the audit engagements (AUD data is CONFIDENTIAL): findings outside it are not found. */
  engagements?: ScopeBuilder | undefined;
}

export class CtrRegisterReader {
  /** The select list that names the contract of a record, and the FROM and WHERE of the selection; the parameters of the selection are numbered from 1 and the caller adds its own after them. */
  private base(query: FactQuery): { identity: string; from: string; where: string; params: unknown[] } {
    const built = assemble(query);
    const identity = `c.id::text as contract_id, c.code as contract_code, c.title as contract_title, p.code as project_code, k.legal_name as contractor_name, ou.name as unit_name, c.contract_status as contract_status, (${built.ledger}) as ledger_ok`;
    return { identity, from: built.from, where: built.where.join(' and '), params: built.params };
  }

  private async rows<T>(tx: TenantTx, query: FactQuery, build: (base: ReturnType<CtrRegisterReader['base']>) => string | { sql: string; extra: unknown[] }): Promise<T[]> {
    if (query.snapshotId !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'snapshot_id');
    await pinDay(tx, query.asOf);
    const base = this.base(query);
    const built = build(base);
    const statement = typeof built === 'string' ? { sql: built, extra: [] as unknown[] } : built;
    const found = await tx.query<T>(statement.sql.replace('$CAP', String(REGISTER_ROW_CAP + 1)), [...base.params, ...statement.extra]);
    if (found.length > REGISTER_ROW_CAP) throw new DomainError('REPORT_SELECTION_TOO_LARGE', 422, 'rows', { extensions: { cap: REGISTER_ROW_CAP } });
    return found;
  }

  /** The non-conformances of the contracts of the selection. */
  async defects(tx: TenantTx, query: FactQuery): Promise<DefectRecord[]> {
    interface Sql extends IdentitySql {
      id: string;
      ncr_no: string;
      title: string | null;
      severity: string;
      status: string;
      detected_on: string | null;
      due_on: string | null;
      closed_on: string | null;
      reopen_count: number | string | null;
      blocks_acceptance: boolean | null;
    }
    const found = await this.rows<Sql>(
      tx,
      query,
      (base) => `select n.id::text as id, coalesce(n.ncr_no, left(n.id::text, 8)) as ncr_no, n.title, n.severity, n.status, n.detected_on::text as detected_on, ${day('n.due_at')} as due_on, ${day('n.closed_at')} as closed_on,
              n.reopen_count, n.blocks_acceptance, ${base.identity}
         from ${base.from} join machvon.quality_nonconformance n on n.tenant_id = c.tenant_id and n.contract_id = c.id
        where ${base.where} order by n.id limit $CAP`,
    );
    return found.map((row) => ({
      id: row.id,
      contract: identityOf(row),
      ncrNo: row.ncr_no,
      title: row.title,
      severity: row.severity,
      status: row.status,
      detectedOn: row.detected_on,
      dueOn: row.due_on,
      closedOn: row.closed_on,
      reopenCount: num(row.reopen_count),
      blocksAcceptance: row.blocks_acceptance === true,
    }));
  }

  /** The issues linked to a contract of the selection (an issue of the project that names no contract is not here: `unlinkedIssues` counts them). */
  async obstacles(tx: TenantTx, query: FactQuery): Promise<ObstacleRecord[]> {
    interface Sql extends IdentitySql {
      id: string;
      code: string;
      title: string | null;
      severity: string;
      status: string;
      source_module: string | null;
      opened_on: string | null;
      due_on: string | null;
      closed_on: string | null;
      escalation_level: number | string | null;
      extension_count: number | string | null;
      reopen_count: number | string | null;
    }
    const found = await this.rows<Sql>(
      tx,
      query,
      (base) => `select i.id::text as id, coalesce(i.code, left(i.id::text, 8)) as code, i.title, i.severity, i.status, i.source_module, ${day('i.opened_at')} as opened_on, ${day('i.due_at')} as due_on, ${day('i.closed_at')} as closed_on,
              i.escalation_level, i.extension_count, i.reopen_count, ${base.identity}
         from ${base.from} join machvon.issue i on i.tenant_id = c.tenant_id and i.contract_id = c.id
        where ${base.where} order by i.id limit $CAP`,
    );
    return found.map((row) => ({
      id: row.id,
      contract: identityOf(row),
      code: row.code,
      title: row.title,
      severity: row.severity,
      status: row.status,
      sourceModule: row.source_module,
      openedOn: row.opened_on,
      dueOn: row.due_on,
      closedOn: row.closed_on,
      escalationLevel: num(row.escalation_level),
      extensionCount: num(row.extension_count),
      reopenCount: num(row.reopen_count),
    }));
  }

  /** How many open issues of the projects of the selection name no contract: the coverage note of the obstacle report (they are real, and not in the report). */
  async unlinkedIssues(tx: TenantTx, query: FactQuery): Promise<number> {
    const found = await this.rows<{ n: string }>(
      tx,
      query,
      (base) => `select count(distinct i.id)::text as n
         from ${base.from} join machvon.issue i on i.tenant_id = c.tenant_id and i.project_id = c.project_id and i.contract_id is null and i.status <> 'CLOSED'
        where ${base.where} limit $CAP`,
    );
    return num(found[0]?.n);
  }

  /**
   * The claim-like records of the selection, in their normal form. Until the claim register of GOV-8 is in the database (its table `contract_claim` maps to `ClaimRecord` with the limitation basis CLAIM_TERM: see
   * docs/ctr-analytics-registers.md) they are the variation events and change orders that were submitted (a draft is not a claim yet; one promoted to the next stage goes on as that record, so it is not counted twice)
   * and the warranty claims.
   */
  async claims(tx: TenantTx, query: FactQuery): Promise<ClaimRecord[]> {
    interface VariationSql extends IdentitySql {
      id: string;
      code: string;
      kind: string | null;
      title: string;
      status: string;
      filed_on: string | null;
      decided_on: string | null;
      claimed: string | null;
      approved: string | null;
      days: number | string | null;
    }
    const variations = await this.rows<VariationSql>(
      tx,
      query,
      (base) => `select r.id::text as id, coalesce(r.code, left(r.id::text, 8)) as code, r.event_kind as kind, left(r.reason, 200) as title, r.status, ${day('r.created_at')} as filed_on, ${day('r.decided_at')} as decided_on,
              coalesce(r.estimated_delta_vnd, r.amount_delta_vnd)::text as claimed, r.approved_delta_vnd::text as approved, r.schedule_impact_days as days, ${base.identity}
         from ${base.from} join machvon.change_request r on r.tenant_id = c.tenant_id and r.contract_id = c.id
        where ${base.where} and r.status in ('SUBMITTED', 'EVALUATED', 'APPROVED', 'REJECTED', 'WITHDRAWN') order by r.id limit $CAP`,
    );
    interface WarrantySql extends IdentitySql {
      id: string;
      code: string;
      title: string;
      status: string;
      filed_on: string | null;
      decided_on: string | null;
      ends_on: string | null;
    }
    const warranties = await this.rows<WarrantySql>(
      tx,
      query,
      (base) => `select w.id::text as id, w.claim_no as code, left(w.defect_description, 200) as title, w.status, w.reported_on::text as filed_on, ${day('w.verified_at')} as decided_on, o.ends_on::text as ends_on, ${base.identity}
         from ${base.from} join machvon.warranty_obligation o on o.tenant_id = c.tenant_id and o.contract_id = c.id join machvon.warranty_claim w on w.tenant_id = o.tenant_id and w.obligation_id = o.id
        where ${base.where} order by w.id limit $CAP`,
    );
    const stateOfVariation = (status: string, claimed: string | null, approved: string | null): ClaimState => {
      if (status === 'APPROVED') return claimed !== null && approved !== null && BigInt(approved) < BigInt(claimed) ? 'PARTLY_GRANTED' : 'GRANTED';
      return status === 'REJECTED' ? 'REJECTED' : status === 'WITHDRAWN' ? 'WITHDRAWN' : 'OPEN';
    };
    const records: ClaimRecord[] = variations.map((row) => {
      const state = stateOfVariation(row.status, row.claimed, row.approved);
      return {
        id: row.id,
        contract: identityOf(row),
        source: 'VARIATION',
        code: row.code,
        kind: row.kind ?? 'OTHER',
        title: row.title,
        state,
        filedOn: row.filed_on,
        decidedOn: state === 'OPEN' ? null : row.decided_on,
        claimedAmountVnd: row.claimed,
        grantedAmountVnd: state === 'GRANTED' || state === 'PARTLY_GRANTED' ? row.approved : null,
        claimedDays: row.days === null ? null : num(row.days),
        grantedDays: state === 'GRANTED' || state === 'PARTLY_GRANTED' ? num(row.days) : null,
        limitation: row.filed_on === null ? null : { basis: 'DECISION_WINDOW', startOn: row.filed_on },
      };
    });
    for (const row of warranties) {
      const decided = row.status === 'VERIFIED' || row.status === 'CLOSED';
      records.push({
        id: row.id,
        contract: identityOf(row),
        source: 'WARRANTY',
        code: row.code,
        kind: 'WARRANTY_DEFECT',
        title: row.title,
        state: decided ? 'GRANTED' : 'OPEN',
        filedOn: row.filed_on,
        decidedOn: decided ? row.decided_on : null,
        claimedAmountVnd: null,
        grantedAmountVnd: null,
        claimedDays: null,
        grantedDays: null,
        limitation: row.ends_on === null ? null : { basis: 'WARRANTY_END', on: row.ends_on },
      });
    }
    return records;
  }

  /** The findings of the audits the reader may see (`engagementScope`) that name a contract of the selection, with what their recommendations asked to recover and what was recovered. The words of a finding are never read. */
  async findings(tx: TenantTx, query: FactQuery, context: RegisterReaderContext): Promise<FindingRecord[]> {
    interface Sql extends IdentitySql {
      id: string;
      finding_code: string;
      category: string;
      severity: string | null;
      engagement_code: string;
      amount: string | null;
      recommended: string;
      recovered: string;
      financial_count: string;
      rec_count: string;
      open_count: string;
      overdue_count: string;
    }
    const scope = context.engagements;
    const found = await this.rows<Sql>(
      tx,
      query,
      (base) => {
        const engagement = scope === undefined ? { sql: 'true', params: [] as unknown[] } : scope(base.params.length + 1);
        return {
          extra: engagement.params,
          sql: `select f.id::text as id, f.finding_code, f.category, f.severity, f.amount_vnd::text as amount, e.engagement_code,
              coalesce(r.recommended, 0)::text as recommended, coalesce(r.recovered, 0)::text as recovered, coalesce(r.financial_count, 0)::text as financial_count,
              coalesce(r.rec_count, 0)::text as rec_count, coalesce(r.open_count, 0)::text as open_count, coalesce(r.overdue_count, 0)::text as overdue_count, ${base.identity}
         from ${base.from}
         join machvon.audit_finding f on f.tenant_id = c.tenant_id and f.contract_id = c.id
         join machvon.audit_conclusion cc on cc.tenant_id = f.tenant_id and cc.id = f.conclusion_id
         join machvon.audit_engagement e on e.tenant_id = cc.tenant_id and e.id = cc.engagement_id
         left join lateral (
           select sum(x.amount_vnd) filter (where x.amount_vnd is not null and x.rec_type in (${FINANCIAL_SQL})) as recommended,
                  sum(x.recovered_vnd) filter (where x.amount_vnd is not null and x.rec_type in (${FINANCIAL_SQL})) as recovered,
                  count(*) filter (where x.amount_vnd is not null and x.rec_type in (${FINANCIAL_SQL})) as financial_count,
                  count(*) as rec_count,
                  count(*) filter (where x.status not in ('CLOSED', 'CANCELLED')) as open_count,
                  count(*) filter (where x.status not in ('CLOSED', 'CANCELLED', 'DISPUTED') and x.is_overdue) as overdue_count
             from machvon.audit_recommendation x where x.tenant_id = f.tenant_id and x.finding_id = f.id
         ) r on true
        where ${base.where} and ${engagement.sql} order by f.id limit $CAP`,
        };
      },
    );
    return found.map((row) => ({
      id: row.id,
      contract: identityOf(row),
      findingCode: row.finding_code,
      category: row.category,
      severity: row.severity,
      engagementCode: row.engagement_code,
      amountVnd: row.amount,
      recommendedVnd: row.recommended,
      recoveredVnd: row.recovered,
      financialRecommendationCount: num(row.financial_count),
      recommendationCount: num(row.rec_count),
      openRecommendationCount: num(row.open_count),
      overdueRecommendationCount: num(row.overdue_count),
    }));
  }

  /** The confirmed violations of the contracts of the selection (a violation that was only recorded is not a fact against the contractor). */
  async violations(tx: TenantTx, query: FactQuery): Promise<Map<string, Array<{ kind: string; severity: string }>>> {
    const found = await this.rows<{ contract_id: string; kind: string; severity: string }>(
      tx,
      query,
      (base) => `select c.id::text as contract_id, v.violation_kind as kind, v.severity
         from ${base.from} join machvon.contractor_violation v on v.tenant_id = c.tenant_id and v.contract_id = c.id and v.status = 'CONFIRMED'
        where ${base.where} order by v.id limit $CAP`,
    );
    const byContract = new Map<string, Array<{ kind: string; severity: string }>>();
    for (const row of found) byContract.set(row.contract_id, [...(byContract.get(row.contract_id) ?? []), { kind: row.kind, severity: row.severity }]);
    return byContract;
  }

  /** The latest stored proposal of each contract of the selection (not a withdrawn one) and the latest approved evaluation, for the rating report. */
  async ratingState(
    tx: TenantTx,
    query: FactQuery,
  ): Promise<{ proposals: Map<string, { id: string; state: string; kind: string; periodLabel: string; responseDueAt: string | null; respondedAt: string | null }>; official: Map<string, { rating: string; overallScore: string }> }> {
    const proposals = await this.rows<{ contract_id: string; id: string; state: string; kind: string; period_label: string; due: string | null; responded: string | null }>(
      tx,
      query,
      (base) => `select distinct on (c.id) c.id::text as contract_id, q.id::text as id, q.state, q.evaluation_kind as kind, q.period_label,
              to_char(q.response_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due, to_char(q.responded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as responded
         from ${base.from} join machvon.contract_rating_proposal q on q.tenant_id = c.tenant_id and q.contract_id = c.id and q.state <> 'WITHDRAWN'
        where ${base.where} order by c.id, q.created_at desc, q.id desc limit $CAP`,
    );
    const official = await this.rows<{ contract_id: string; rating: string; overall: string }>(
      tx,
      query,
      (base) => `select distinct on (c.id) c.id::text as contract_id, e.rating, e.overall_score::text as overall
         from ${base.from} join machvon.contractor_performance e on e.tenant_id = c.tenant_id and e.contract_id = c.id and e.status = 'APPROVED'
        where ${base.where} order by c.id, e.approved_at desc nulls last, e.id desc limit $CAP`,
    );
    return {
      proposals: new Map(proposals.map((row) => [row.contract_id, { id: row.id, state: row.state, kind: row.kind, periodLabel: row.period_label, responseDueAt: row.due, respondedAt: row.responded }])),
      official: new Map(official.map((row) => [row.contract_id, { rating: row.rating, overallScore: row.overall }])),
    };
  }
}

/** The inputs of a rating from a fact and the registers of its contract (the same figures the report and the proposal command read, so they agree). */
export function ratingInputsOf(args: {
  asOf: string;
  fact: { contractStatus: string; signedOn: string | null; completedOn: string | null; terminatedOn: string | null; acceptedVnd: string; requestedVnd: string; paidVnd: string; guaranteeRequiredVnd: string | null; guaranteeValidVnd: string | null };
  daysLate: { value: number | null; reason: string | null };
  defects: readonly DefectRecord[];
  obstacles: readonly ObstacleRecord[];
  violations: ReadonlyArray<{ kind: string; severity: string }>;
  findings: readonly FindingRecord[];
}): RatingInputs {
  const { fact } = args;
  const financial = args.findings.filter((finding) => finding.financialRecommendationCount > 0);
  return {
    asOf: args.asOf,
    contractStatus: fact.contractStatus,
    signedOn: fact.signedOn,
    endedOn: fact.completedOn ?? fact.terminatedOn,
    acceptedVnd: fact.acceptedVnd,
    requestedVnd: fact.requestedVnd,
    paidVnd: fact.paidVnd,
    daysLate: args.daysLate.value,
    daysLateReason: args.daysLate.reason,
    guaranteeRequiredVnd: fact.guaranteeRequiredVnd,
    guaranteeValidVnd: fact.guaranteeValidVnd,
    defects: args.defects.map((defect) => ({ severity: defect.severity, status: defect.status, reopenCount: defect.reopenCount })),
    obstacles: args.obstacles.map((one) => ({ open: obstacleIsOpen(one.status), overdue: obstacleIsOpen(one.status) && one.dueOn !== null && one.dueOn < args.asOf, escalated: one.escalationLevel > 0 })),
    violations: [...args.violations],
    auditRecommendedVnd: financial.reduce((acc, finding) => acc + BigInt(finding.recommendedVnd), 0n).toString(),
    auditRecoveredVnd: financial.reduce((acc, finding) => acc + BigInt(finding.recoveredVnd), 0n).toString(),
    auditFinancialCount: financial.reduce((acc, finding) => acc + finding.financialRecommendationCount, 0),
  };
}

export { defectIsOpen };
