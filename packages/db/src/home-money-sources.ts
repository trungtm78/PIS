import { eacControl, openRiskExpectedValue, reserveCover } from '@machvon/kernel';
import type { OpenRisk } from '@machvon/kernel';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, base, reach } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { MoneyPolicyReader } from './money-policy-reader.ts';

/** The contracts that count in the estimate at completion: signed and not cancelled (the same set as `CONTRACT_PRICES_EAC`). */
const COUNTED_CONTRACTS = "('SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED', 'CLOSED')";
const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

/**
 * The money control as a source of the alert centre (governance deepening, lane B2). Three conditions, each read from the tables of its module in the scope of the reader and each with its owner, its expected action and its
 * consequence (the consequence is in `CONSEQUENCES`; the owner of an item is the leader accountable for the project, as for the other sources of a project):
 *  - `EAC_EXCEEDS_TMDT` (URGENT, G1-6): the estimate at completion of a project is above its approved total investment by more than the tolerance of the policy; expected action: ask for the adjustment of the investment decision.
 *  - `RESERVE_BELOW_RISK_EV` (ACTION, G1-7): the contingency of a project is below the expected value of its open risks; expected action: refill the contingency, close or accept a risk, or ask for the management reserve.
 *  - `ADVANCE_EXCEEDS_REMAINING` (URGENT, G1-11): a contract owes more advance than the payments left to pay can recover; expected action: recover outside the payments or amend the contract.
 * Thresholds are read through the policy reader (`CONTRACT_AVC`, `RESERVE_POLICY`), never written here.
 */
export class HomeMoneySources {
  private readonly money: MoneyPolicyReader;

  constructor(money: MoneyPolicyReader = new MoneyPolicyReader()) {
    this.money = money;
  }

  /** The three conditions in one list. A failure of one is the failure of the source: the store names the source as unavailable and never turns it into no work. */
  async items(context: SourceContext): Promise<SourceRow[]> {
    return [...(await this.eacExceeds(context)), ...(await this.reservesBelowRisk(context)), ...(await this.advancesExceedRemaining(context))];
  }

  async eacExceeds(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'MONEY_CONTROL', id: "('eac:' || p.id::text)", tenant: 'p', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; code: string; total: string; eac: string }>(
      `select p.id, p.code, p.total_investment_vnd::text as total,
              (coalesce((select sum(c.contract_value_vnd) from machvon.contract c where c.tenant_id = p.tenant_id and c.project_id = p.id and c.status in ${COUNTED_CONTRACTS}), 0)
               + coalesce((select sum(case when r.status = 'EVALUATED' and r.stage = 'CO' then greatest(coalesce(r.evaluated_delta_vnd, 0), 0)
                                           when r.status = 'APPROVED' and rv.status = 'PENDING_EFFECTIVE' then greatest(coalesce(r.approved_delta_vnd, 0), 0) else 0 end)
                             from machvon.change_request r
                             join machvon.contract c2 on c2.tenant_id = r.tenant_id and c2.id = r.contract_id
                             left join machvon.contract_revision rv on rv.tenant_id = r.tenant_id and rv.id = r.resulting_revision_id
                            where c2.tenant_id = p.tenant_id and c2.project_id = p.id and c2.status in ${COUNTED_CONTRACTS}), 0))::text as eac
         from machvon.project p
         left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where ${visible}
        order by p.code, p.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const reading = await this.money.get(context.tx, 'CONTRACT_AVC', context.today);
    const items: SourceRow[] = [];
    for (const row of rows) {
      const control = eacControl(row.eac, row.total, reading.params.eacAlertAbovePct);
      if (!control.raisesAlert) continue;
      items.push({
        ...base('EAC_EXCEEDS_TMDT'),
        id: `eac:${row.id}`,
        dueOn: null,
        originalDueOn: null,
        title: `Dự báo hoàn thành vượt tổng mức đầu tư · ${row.code}`,
        subtitle: label(row.code, `vượt ${control.overByVnd} đồng${control.overPct === null ? '' : ` (${control.overPct}%)`}`),
        status: 'OVER',
        severity: severityOf('MONEY_CONTROL', 'EAC_EXCEEDS_TMDT', context.rules),
        consequence: CONSEQUENCES.EAC_EXCEEDS_TMDT ?? null,
        causeKey: row.id,
        target: { screen: 'CAP-22', id: row.id },
      });
    }
    return items;
  }

  async reservesBelowRisk(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'MONEY_CONTROL', id: "('reserve:' || p.id::text)", tenant: 'p', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; code: string; balance: string; scaled: string }>(
      `select p.id, p.code, f.balance_vnd::text as balance,
              coalesce((select floor(sum(x.probability_pct * x.cost_impact_vnd) / 100)
                          from machvon.risk_exposure x join machvon.project_risk r on r.tenant_id = x.tenant_id and r.id = x.risk_id
                         where x.tenant_id = p.tenant_id and x.project_id = p.id and r.status in ('OPEN', 'MITIGATING', 'ESCALATED')), 0)::text as scaled
         from machvon.reserve_fund f
         join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id
         left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where f.kind = 'CONTINGENCY' and ${visible}
        order by p.code, p.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const reading = await this.money.get(context.tx, 'RESERVE_POLICY', context.today);
    const items: SourceRow[] = [];
    for (const row of rows) {
      const risks: OpenRisk[] = [{ probabilityPct: '100', costImpactVnd: row.scaled }];
      const cover = reserveCover(row.balance, openRiskExpectedValue(risks), reading.params.coverAlertBelowPct);
      if (cover.covered) continue;
      items.push({
        ...base('RESERVE_BELOW_RISK_EV'),
        id: `reserve:${row.id}`,
        dueOn: null,
        originalDueOn: null,
        title: `Dự phòng thấp hơn giá trị kỳ vọng của rủi ro · ${row.code}`,
        subtitle: label(row.code, `còn ${cover.balanceVnd} đồng, kỳ vọng ${cover.expectedValueVnd} đồng, thiếu ${cover.shortfallVnd} đồng`),
        status: 'BELOW',
        severity: severityOf('MONEY_CONTROL', 'RESERVE_BELOW_RISK_EV', context.rules),
        consequence: CONSEQUENCES.RESERVE_BELOW_RISK_EV ?? null,
        causeKey: row.id,
        target: { screen: 'PRJ-22', id: row.id },
      });
    }
    return items;
  }

  async advancesExceedRemaining(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'MONEY_CONTROL', id: "('advance:' || c.id::text)", tenant: 'c', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; code: string; project_code: string | null; outstanding: string; remaining: string }>(
      `select c.id, c.code, p.code as project_code, (c.advance_paid_vnd - c.advance_recovered_vnd)::text as outstanding, greatest(c.contract_value_vnd - c.requested_total_vnd, 0)::text as remaining
         from machvon.contract c
         ${PROJECT_JOINS('c', 'c.project_id')}
        where c.status in ('ACTIVE', 'SUSPENDED', 'COMPLETED') and (c.advance_paid_vnd - c.advance_recovered_vnd) > greatest(c.contract_value_vnd - c.requested_total_vnd, 0) and ${visible}
        order by c.code, c.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row) => ({
      ...base('ADVANCE_EXCEEDS_REMAINING'),
      id: `advance:${row.id}`,
      dueOn: null,
      originalDueOn: null,
      title: `Dư nợ tạm ứng lớn hơn giá trị còn lại phải thanh toán · ${row.code}`,
      subtitle: label(row.project_code, `dư nợ ${row.outstanding} đồng, còn thanh toán ${row.remaining} đồng`),
      status: 'EXCEEDS',
      severity: severityOf('MONEY_CONTROL', 'ADVANCE_EXCEEDS_REMAINING', context.rules),
      consequence: CONSEQUENCES.ADVANCE_EXCEEDS_REMAINING ?? null,
      causeKey: row.id,
      target: { screen: 'PAY-18', id: row.id },
    }));
  }
}
