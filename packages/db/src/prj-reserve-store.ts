import { randomUUID } from 'node:crypto';
import { DomainError, assertDrawdown, assertNotProposer, openRiskExpectedValue, reserveCover, reserveKindOf, versionConflict, wholeVnd } from '@machvon/kernel';
import type { OpenRisk, ReserveCover, ReserveKind } from '@machvon/kernel';
import { decisionDocument } from './ctr-decision-document.ts';
import { MoneyPolicyReader } from './money-policy-reader.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
/** The statuses of a risk that is still to happen: what the reserve has to carry. */
const LIVE_RISK = "('OPEN', 'MITIGATING', 'ESCALATED')";
const PROJECT_FROM = `machvon.project p
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string | undefined, field: string): string => {
  if (value === undefined || !UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const textOf = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT) throw invalid(field);
  return trimmed;
};

export interface ReserveEntryView {
  id: string;
  entryKind: 'FUND' | 'DRAWDOWN';
  amountVnd: string;
  balanceAfterVnd: string;
  riskId: string | null;
  changeRequestId: string | null;
  drawdownId: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  postedAt: string;
}

export interface DrawdownView {
  id: string;
  fundId: string;
  kind: ReserveKind;
  amountVnd: string;
  riskId: string | null;
  changeRequestId: string | null;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  reason: string;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface ReserveFundView {
  id: string;
  kind: ReserveKind;
  balanceVnd: string;
  version: number;
  entries: ReserveEntryView[];
  openDrawdowns: DrawdownView[];
}

export interface RiskExposureLine {
  riskId: string;
  code: string;
  title: string;
  status: string;
  probabilityPct: string | null;
  costImpactVnd: string | null;
  /** This risk's share of the expected value, floored; null while it has no exposure. */
  expectedValueVnd: string | null;
}

export interface ProjectReserveView {
  projectId: string;
  projectCode: string;
  funds: ReserveFundView[];
  risks: RiskExposureLine[];
  /** Open risks that have no probability and cost yet: the expected value below is a lower bound while there are any. */
  unassessedRiskCount: number;
  expectedValueVnd: string;
  /** The contingency against the expected value of the open risks; null when the project has no contingency fund. */
  contingencyCover: ReserveCover | null;
  policy: { version: number | null; source: 'DEFAULT' | 'RULE'; coverAlertBelowPct: string };
  asOf: string;
}

export interface FundInput {
  kind: string;
  amountVnd: string;
  authorityDocumentVersionId: string | undefined;
  reason: string;
}

export interface DrawdownRequestInput {
  kind: string;
  amountVnd: string;
  riskId?: string | undefined;
  changeRequestId?: string | undefined;
  reason: string;
}

export interface DrawdownDecisionInput {
  decision: string;
  reason: string;
}

export interface ExposureInput {
  probabilityPct: string;
  costImpactVnd: string;
}

/** The result of a command on the reserve: what moved, for the audit row, the event and the answer. */
export interface ReserveCommandResult {
  id: string;
  projectId: string;
  fundId: string;
  kind: ReserveKind;
  version: number;
  status: string;
  amountVnd: string;
  balanceVnd: string;
  riskId: string | null;
  changeRequestId: string | null;
  ledgerEntryId: string | null;
}

interface FundSql {
  id: string;
  kind: ReserveKind;
  balance_vnd: string;
  version: string;
}

interface DrawdownSql {
  id: string;
  fund_id: string;
  kind: ReserveKind;
  project_id: string;
  amount_vnd: string;
  risk_id: string | null;
  change_request_id: string | null;
  status: DrawdownView['status'];
  reason: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  version: string;
}

const DRAWDOWN_SELECT = `select d.id, d.fund_id, f.kind, d.project_id, d.amount_vnd::text as amount_vnd, d.risk_id, d.change_request_id, d.status, d.reason, d.requested_by,
       to_char(d.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as requested_at, d.decided_by, to_char(d.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as decided_at,
       d.decision_reason, d.version::text as version
  from machvon.reserve_drawdown d join machvon.reserve_fund f on f.tenant_id = d.tenant_id and f.id = d.fund_id`;

const toDrawdown = (row: DrawdownSql): DrawdownView => ({
  id: row.id,
  fundId: row.fund_id,
  kind: row.kind,
  amountVnd: row.amount_vnd,
  riskId: row.risk_id,
  changeRequestId: row.change_request_id,
  status: row.status,
  reason: row.reason,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  version: Number(row.version),
});

/**
 * The contingency and the management reserve of a project (governance deepening G1-7, PRJ F04). Two funds that are never mixed: the contingency belongs to the project board and covers the risks
 * that were identified; the management reserve belongs to the level above and covers the ones that were not. A fund is filled on the document that allots it; money leaves it only by a drawdown that
 * is tied to one risk or one change order, asked for by one person and decided by another, and posts an entry of an append-only ledger whose balance the database keeps. The balance is read against the
 * expected value of the open risks (probability times cost): the contingency below it is an alert, not a refusal, because the risk may be accepted.
 */
export class PrjReserveStore {
  private readonly money: MoneyPolicyReader;

  constructor(money: MoneyPolicyReader = new MoneyPolicyReader()) {
    this.money = money;
  }

  /** Fills a fund (creating it on the first filling) on the document that allots the reserve. */
  async fund(tx: TenantTx, projectId: string, input: FundInput, actor: string, scope: ScopeBuilder): Promise<ReserveCommandResult> {
    const kind = reserveKindOf(input.kind);
    if (kind === undefined) throw invalid('kind');
    const amount = wholeVnd(input.amountVnd, 'amount_vnd');
    if (amount === 0n) throw invalid('amount_vnd', 'MUST_BE_POSITIVE');
    const reason = textOf(input.reason, 'reason');
    const id = idOf(projectId, 'id');
    await this.lockProject(tx, id, scope);
    const document = await decisionDocument(tx, input.authorityDocumentVersionId, 'authority_document_version_id');
    let [fund] = await tx.query<FundSql>('select id, kind, balance_vnd::text as balance_vnd, version::text as version from machvon.reserve_fund where project_id = $1::uuid and kind = $2 for update', [id, kind]);
    if (fund === undefined) {
      const fundId = randomUUID();
      await tx.query(`insert into machvon.reserve_fund (tenant_id, id, project_id, kind, created_by) values (${TENANT}, $1::uuid, $2::uuid, $3, $4::uuid)`, [fundId, id, kind, actor]);
      [fund] = await tx.query<FundSql>('select id, kind, balance_vnd::text as balance_vnd, version::text as version from machvon.reserve_fund where id = $1::uuid for update', [fundId]);
    }
    if (fund === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const entryId = randomUUID();
    await tx.query(
      `insert into machvon.reserve_ledger_entry (tenant_id, id, fund_id, project_id, entry_kind, amount_vnd, authority_document_version_id, reason, requested_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, 'FUND', $4::numeric, $5::uuid, $6, $7::uuid)`,
      [entryId, fund.id, id, amount.toString(), document.versionId, reason, actor],
    );
    const [after] = await tx.query<FundSql>('select id, kind, balance_vnd::text as balance_vnd, version::text as version from machvon.reserve_fund where id = $1::uuid', [fund.id]);
    return { id: fund.id, projectId: id, fundId: fund.id, kind, version: Number(after?.version ?? fund.version), status: 'FUNDED', amountVnd: amount.toString(), balanceVnd: after?.balance_vnd ?? '0', riskId: null, changeRequestId: null, ledgerEntryId: entryId };
  }

  /** Asks to draw on a fund for one risk or one change order of the project. */
  async requestDrawdown(tx: TenantTx, projectId: string, input: DrawdownRequestInput, actor: string, scope: ScopeBuilder): Promise<ReserveCommandResult> {
    const kind = reserveKindOf(input.kind);
    if (kind === undefined) throw invalid('kind');
    const reason = textOf(input.reason, 'reason');
    const riskId = input.riskId === undefined ? null : idOf(input.riskId, 'risk_id');
    const changeId = input.changeRequestId === undefined ? null : idOf(input.changeRequestId, 'change_request_id');
    const id = idOf(projectId, 'id');
    await this.lockProject(tx, id, scope);
    const [fund] = await tx.query<FundSql>('select id, kind, balance_vnd::text as balance_vnd, version::text as version from machvon.reserve_fund where project_id = $1::uuid and kind = $2 for update', [id, kind]);
    if (fund === undefined) throw new DomainError('RESERVE_FUND_NOT_FOUND', 422, 'kind', { extensions: { kind } });
    // The link first, so that "neither" or "both" is told as such before the money is looked at.
    const [asked] = await tx.query<{ asked: string }>("select coalesce(sum(amount_vnd), 0)::text as asked from machvon.reserve_drawdown where fund_id = $1::uuid and status = 'REQUESTED'", [fund.id]);
    const free = BigInt(fund.balance_vnd) - BigInt(asked?.asked ?? '0');
    const amount = assertDrawdown({ amountVnd: input.amountVnd, balanceVnd: (free < 0n ? 0n : free).toString(), riskId, changeRequestId: changeId });
    if (riskId !== null) {
      const [risk] = await tx.query<{ status: string }>('select status from machvon.project_risk where id = $1::uuid and project_id = $2::uuid', [riskId, id]);
      if (risk === undefined) throw invalid('risk_id', 'NOT_A_RISK_OF_THE_PROJECT');
      if (!['OPEN', 'MITIGATING', 'ESCALATED'].includes(risk.status)) throw new DomainError('RESERVE_LINK_INVALID', 422, 'risk_id', { extensions: { risk_status: risk.status } });
    }
    if (changeId !== null) {
      const [change] = await tx.query<{ status: string; stage: string }>(
        'select r.status, r.stage from machvon.change_request r join machvon.contract c on c.tenant_id = r.tenant_id and c.id = r.contract_id where r.id = $1::uuid and c.project_id = $2::uuid',
        [changeId, id],
      );
      if (change === undefined) throw invalid('change_request_id', 'NOT_A_CHANGE_OF_THE_PROJECT');
      if (change.stage !== 'CO' || change.status !== 'EVALUATED') throw new DomainError('RESERVE_LINK_INVALID', 422, 'change_request_id', { extensions: { change_status: change.status, stage: change.stage } });
    }
    const drawdownId = randomUUID();
    await tx.query(
      `insert into machvon.reserve_drawdown (tenant_id, id, fund_id, project_id, amount_vnd, risk_id, change_request_id, reason, requested_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::uuid, $6::uuid, $7, $8::uuid)`,
      [drawdownId, fund.id, id, amount.toString(), riskId, changeId, reason, actor],
    );
    return { id: drawdownId, projectId: id, fundId: fund.id, kind, version: 1, status: 'REQUESTED', amountVnd: amount.toString(), balanceVnd: fund.balance_vnd, riskId, changeRequestId: changeId, ledgerEntryId: null };
  }

  /**
   * Decides a drawdown: approved by someone other than whoever asked (403 `SELF_APPROVAL_DENIED`), it posts the entry of the ledger and moves the balance; rejected, it ends with the reason. `authorise`
   * is asked with the kind of the fund, the amount and the project before anything is written, so the management reserve can need a higher authority than the contingency.
   */
  async decideDrawdown(
    tx: TenantTx,
    drawdownId: string,
    expectedVersion: number,
    input: DrawdownDecisionInput,
    actor: string,
    scope: ScopeBuilder,
    authorise: (facts: { kind: ReserveKind; amountVnd: string; projectId: string }) => Promise<void>,
  ): Promise<ReserveCommandResult> {
    const decision = input.decision === 'approve' || input.decision === 'reject' ? input.decision : undefined;
    if (decision === undefined) throw invalid('decision');
    const reason = textOf(input.reason, 'reason');
    const id = idOf(drawdownId, 'id');
    const [peek] = await tx.query<{ project_id: string }>('select project_id from machvon.reserve_drawdown where id = $1::uuid', [id]);
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.lockProject(tx, peek.project_id, scope);
    const [row] = await tx.query<DrawdownSql>(`${DRAWDOWN_SELECT} where d.id = $1::uuid for update of d`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.status !== 'REQUESTED') throw new DomainError('RESERVE_DRAWDOWN_STATE_INVALID', 409, 'status', { extensions: { drawdown_status: row.status } });
    assertNotProposer(actor, [row.requested_by]);
    await authorise({ kind: row.kind, amountVnd: row.amount_vnd, projectId: row.project_id });
    if (decision === 'reject') {
      await tx.query("update machvon.reserve_drawdown set status = 'REJECTED', decided_by = $2::uuid, decided_at = now(), decision_reason = $3, version = version + 1 where id = $1::uuid", [id, actor, reason]);
      return { id, projectId: row.project_id, fundId: row.fund_id, kind: row.kind, version: Number(row.version) + 1, status: 'REJECTED', amountVnd: row.amount_vnd, balanceVnd: (await this.balanceOf(tx, row.fund_id)), riskId: row.risk_id, changeRequestId: row.change_request_id, ledgerEntryId: null };
    }
    // The balance is looked at again under the lock of the fund: what was free when the drawdown was asked for may have been drawn since.
    const [fund] = await tx.query<FundSql>('select id, kind, balance_vnd::text as balance_vnd, version::text as version from machvon.reserve_fund where id = $1::uuid for update', [row.fund_id]);
    assertDrawdown({ amountVnd: row.amount_vnd, balanceVnd: fund?.balance_vnd ?? '0', riskId: row.risk_id, changeRequestId: row.change_request_id });
    const entryId = randomUUID();
    await tx.query(
      `insert into machvon.reserve_ledger_entry (tenant_id, id, fund_id, project_id, entry_kind, amount_vnd, risk_id, change_request_id, drawdown_id, reason, requested_by, approved_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, 'DRAWDOWN', $4::numeric, $5::uuid, $6::uuid, $7::uuid, $8, $9::uuid, $10::uuid)`,
      [entryId, row.fund_id, row.project_id, row.amount_vnd, row.risk_id, row.change_request_id, id, row.reason, row.requested_by, actor],
    );
    await tx.query("update machvon.reserve_drawdown set status = 'APPROVED', decided_by = $2::uuid, decided_at = now(), decision_reason = $3, ledger_entry_id = $4::uuid, version = version + 1 where id = $1::uuid", [id, actor, reason, entryId]);
    return { id, projectId: row.project_id, fundId: row.fund_id, kind: row.kind, version: Number(row.version) + 1, status: 'APPROVED', amountVnd: row.amount_vnd, balanceVnd: await this.balanceOf(tx, row.fund_id), riskId: row.risk_id, changeRequestId: row.change_request_id, ledgerEntryId: entryId };
  }

  /** Sets what a risk would cost and how likely it is: the numbers the expected value is made of. */
  async setExposure(tx: TenantTx, riskId: string, input: ExposureInput, expectedVersion: number | null, actor: string, scope: ScopeBuilder): Promise<{ riskId: string; projectId: string; version: number }> {
    const id = idOf(riskId, 'id');
    if (!/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/.test(input.probabilityPct) || Number(input.probabilityPct) > 100) throw invalid('probability_pct', 'NOT_A_PERCENT');
    const cost = wholeVnd(input.costImpactVnd, 'cost_impact_vnd');
    const [risk] = await tx.query<{ project_id: string; status: string }>('select project_id, status from machvon.project_risk where id = $1::uuid', [id]);
    if (risk === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.lockProject(tx, risk.project_id, scope);
    const [existing] = await tx.query<{ version: string }>('select version::text as version from machvon.risk_exposure where risk_id = $1::uuid for update', [id]);
    if (existing === undefined) {
      if (expectedVersion !== null && expectedVersion !== 0) throw versionConflict(0);
      await tx.query(
        `insert into machvon.risk_exposure (tenant_id, risk_id, project_id, probability_pct, cost_impact_vnd, set_by) values (${TENANT}, $1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::uuid)`,
        [id, risk.project_id, input.probabilityPct, cost.toString(), actor],
      );
      return { riskId: id, projectId: risk.project_id, version: 1 };
    }
    if (expectedVersion !== null && Number(existing.version) !== expectedVersion) throw versionConflict(Number(existing.version));
    await tx.query('update machvon.risk_exposure set probability_pct = $2::numeric, cost_impact_vnd = $3::numeric, set_by = $4::uuid, set_at = now(), version = version + 1 where risk_id = $1::uuid', [id, input.probabilityPct, cost.toString(), actor]);
    return { riskId: id, projectId: risk.project_id, version: Number(existing.version) + 1 };
  }

  /** The reserve of a project in the scope of the caller: the funds with their ledger, the open risks with their exposure and the cover; undefined when the caller does not reach the project. */
  async view(tx: TenantTx, projectId: string, scope: ScopeBuilder, today: string): Promise<ProjectReserveView | undefined> {
    const id = idOf(projectId, 'id');
    const predicate = scope(2);
    const [project] = await tx.query<{ id: string; code: string }>(`select p.id, p.code from ${PROJECT_FROM} where p.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (project === undefined) return undefined;
    const funds = await tx.query<FundSql>('select id, kind, balance_vnd::text as balance_vnd, version::text as version from machvon.reserve_fund where project_id = $1::uuid order by kind', [id]);
    const fundViews: ReserveFundView[] = [];
    for (const fund of funds) {
      const entries = await tx.query<{
        id: string;
        entry_kind: 'FUND' | 'DRAWDOWN';
        amount_vnd: string;
        balance_after_vnd: string;
        risk_id: string | null;
        change_request_id: string | null;
        drawdown_id: string | null;
        reason: string;
        requested_by: string;
        approved_by: string | null;
        posted_at: string;
      }>(
        `select id, entry_kind, amount_vnd::text as amount_vnd, balance_after_vnd::text as balance_after_vnd, risk_id, change_request_id, drawdown_id, reason, requested_by, approved_by,
                to_char(posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as posted_at
           from machvon.reserve_ledger_entry where fund_id = $1::uuid order by posted_at desc, id desc limit 200`,
        [fund.id],
      );
      const open = await tx.query<DrawdownSql>(`${DRAWDOWN_SELECT} where d.fund_id = $1::uuid and d.status = 'REQUESTED' order by d.requested_at, d.id`, [fund.id]);
      fundViews.push({
        id: fund.id,
        kind: fund.kind,
        balanceVnd: fund.balance_vnd,
        version: Number(fund.version),
        entries: entries.map((entry) => ({
          id: entry.id,
          entryKind: entry.entry_kind,
          amountVnd: entry.amount_vnd,
          balanceAfterVnd: entry.balance_after_vnd,
          riskId: entry.risk_id,
          changeRequestId: entry.change_request_id,
          drawdownId: entry.drawdown_id,
          reason: entry.reason,
          requestedBy: entry.requested_by,
          approvedBy: entry.approved_by,
          postedAt: entry.posted_at,
        })),
        openDrawdowns: open.map(toDrawdown),
      });
    }
    const risks = await this.openRisks(tx, id);
    const reading = await this.money.get(tx, 'RESERVE_POLICY', today);
    const assessed = risks.filter((risk): risk is RiskExposureLine & { probabilityPct: string; costImpactVnd: string } => risk.probabilityPct !== null && risk.costImpactVnd !== null);
    const expectedValue = openRiskExpectedValue(assessed.map((risk): OpenRisk => ({ probabilityPct: risk.probabilityPct, costImpactVnd: risk.costImpactVnd })));
    const contingency = fundViews.find((fund) => fund.kind === 'CONTINGENCY');
    return {
      projectId: project.id,
      projectCode: project.code,
      funds: fundViews,
      risks: risks.map((risk) => ({
        ...risk,
        expectedValueVnd: risk.probabilityPct === null || risk.costImpactVnd === null ? null : openRiskExpectedValue([{ probabilityPct: risk.probabilityPct, costImpactVnd: risk.costImpactVnd }]),
      })),
      unassessedRiskCount: risks.length - assessed.length,
      expectedValueVnd: expectedValue,
      contingencyCover: contingency === undefined ? null : reserveCover(contingency.balanceVnd, expectedValue, reading.params.coverAlertBelowPct),
      policy: { version: reading.version, source: reading.source, coverAlertBelowPct: reading.params.coverAlertBelowPct },
      asOf: new Date().toISOString(),
    };
  }

  /** What was approved for a change order from the reserve: the money its increase is paid from. */
  async approvedDrawdownFor(tx: TenantTx, changeRequestId: string): Promise<string> {
    const [row] = await tx.query<{ total: string }>("select coalesce(sum(amount_vnd), 0)::text as total from machvon.reserve_drawdown where change_request_id = $1::uuid and status = 'APPROVED'", [changeRequestId]);
    return row?.total ?? '0';
  }

  private async openRisks(tx: TenantTx, projectId: string): Promise<Array<Omit<RiskExposureLine, 'expectedValueVnd'>>> {
    const rows = await tx.query<{ id: string; code: string; title: string; status: string; probability_pct: string | null; cost_impact_vnd: string | null }>(
      `select r.id, r.code, r.title, r.status, x.probability_pct::text as probability_pct, x.cost_impact_vnd::text as cost_impact_vnd
         from machvon.project_risk r left join machvon.risk_exposure x on x.tenant_id = r.tenant_id and x.risk_id = r.id
        where r.project_id = $1::uuid and r.status in ${LIVE_RISK} order by r.score desc, r.code`,
      [projectId],
    );
    return rows.map((row) => ({ riskId: row.id, code: row.code, title: row.title, status: row.status, probabilityPct: row.probability_pct, costImpactVnd: row.cost_impact_vnd }));
  }

  private async balanceOf(tx: TenantTx, fundId: string): Promise<string> {
    const [row] = await tx.query<{ balance: string }>('select balance_vnd::text as balance from machvon.reserve_fund where id = $1::uuid', [fundId]);
    return row?.balance ?? '0';
  }

  /** The project locked inside the scope of the command; one the caller cannot reach does not exist. */
  private async lockProject(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<void> {
    const predicate = scope(2);
    const [row] = await tx.query<{ id: string }>(`select p.id from ${PROJECT_FROM} where p.id = $1::uuid and ${predicate.sql} for update of p`, [projectId, ...predicate.params]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  }
}
