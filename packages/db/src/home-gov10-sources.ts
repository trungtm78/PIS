import {
  ANOMALY_RULE_TYPE,
  CONTRACT_CLOCK_RULE_TYPE,
  DATA_FRESHNESS_RULE_TYPE,
  DOC_REVIEW_RULE_TYPE,
  advanceWhileOpen,
  contractClockDefaults,
  contractClockFindings,
  dataFreshnessDefaults,
  dataFreshnessFacet,
  docReviewDefaults,
  docReviewFacet,
  message,
  paymentClockDefaults,
  paymentClockParams,
  periodEndRush,
  periodEndWindowStart,
  repeatedReallocation,
} from '@machvon/kernel';
import type { AnomalyParams, ContractClockParams, DataFreshnessParams, DocReviewParams, RuleParams } from '@machvon/kernel';
import { LATEST_RUN_JOIN, QUALITY_BADGE_SQL } from './dgv-dataset-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { AUDIENCE_PERMISSIONS } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, addDays, base, reach, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permission of the data steward, who sees every dataset that is not fresh on the whole tenant (the owner and the steward of a dataset see theirs). */
export const DATA_STEWARD_PERMISSION = 'data.catalog.manage';
/** How many days after the window of the end of the plan year opens a rush of payments is still shown. */
export const PERIOD_END_SHOWN_DAYS = 120;
/** How far back a payment of an advance is looked at for the rule that a new advance needs the old one recovered. */
export const ADVANCE_LOOKBACK_DAYS = 180;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

/**
 * Reads a rule through the governance port and builds its params with the parser of the lane; a rule that is missing or does not read falls back to the built-in defaults, so that one broken rule never hides an alert
 * (the source is still named in the unavailable list when its own query fails).
 */
async function ruleParams<T>(port: GovernancePolicyPort, context: SourceContext, type: string, code: string, fallback: () => T, read: (params: RuleParams) => T): Promise<T> {
  const resolved = await port.get(context.tx, type, code, context.today);
  if (resolved === undefined) return fallback();
  try {
    return read(resolved.params);
  } catch {
    return fallback();
  }
}

const numberOf = (params: RuleParams, key: string, fallback: number): number => (typeof params[key] === 'number' ? (params[key] as number) : fallback);
const wordOf = (params: RuleParams, key: string, fallback: string): string => (typeof params[key] === 'string' ? (params[key] as string) : fallback);

/**
 * The sources that GOV-10 adds to the alert centre (roadmap G2-12): the clocks of a contract (`CONTRACT_CLOCK`), the review of a document that is due (`DOC_REVIEW`), a dataset that is not fresh (`DATA_FRESHNESS`) and the
 * anomalies of the money (`ANOMALY`, for the auditors). Each item is computed when the list is read from the table of its module, in the scope of the reader, with the numbers of the governance rules; there is nothing
 * to run and nothing that can fall behind. A source whose query fails is rolled back by the store and named as unavailable: it is never shown as "no work".
 */
export class HomeGov10Sources {
  private readonly port = new GovernancePolicyPort();

  /** A running contract whose end is near or has passed, and one that has accepted work nobody asked payment for within the payment clock. */
  async contractClock(context: SourceContext): Promise<SourceRow[]> {
    const end = await ruleParams<ContractClockParams>(this.port, context, CONTRACT_CLOCK_RULE_TYPE, 'DEFAULT', contractClockDefaults, (params) => ({ end_warning_days: numberOf(params, 'end_warning_days', 30), end_urgent_days: numberOf(params, 'end_urgent_days', 7) }));
    const payment = await ruleParams<number>(this.port, context, 'CONTRACT_PAYMENT_CLOCK', 'DEFAULT', () => paymentClockDefaults().acceptance_to_request_days, (params) => paymentClockParams(params).acceptance_to_request_days);
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'CONTRACT_CLOCK', id: 'c.id::text', tenant: 'c', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; code: string; contract_status: string; due: string | null; extension_days: number; completed_on: string | null; accepted: string | null; requested: string | null; last_acceptance_on: string | null; project_code: string | null }>(
      `select c.id, c.code, c.contract_status, c.original_due_date::text as due, c.approved_extension_days as extension_days, c.completed_on::text as completed_on,
              c.accepted_vnd::text as accepted, c.requested_vnd::text as requested, c.last_acceptance_on::text as last_acceptance_on, p.code as project_code
         from machvon.contract_fact c
         ${PROJECT_JOINS('c', 'c.project_id')}
        where c.contract_status = 'ACTIVE' and ${visible}
          and ((c.original_due_date is not null and c.completed_on is null and (c.original_due_date + c.approved_extension_days) <= (${today}::date + ${Math.trunc(end.end_warning_days)}))
            or (c.last_acceptance_on is not null and c.accepted_vnd > c.requested_vnd and (c.last_acceptance_on + ${Math.trunc(payment)}) < ${today}::date))
        order by c.original_due_date nulls last, c.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const items: SourceRow[] = [];
    for (const row of rows) {
      const findings = contractClockFindings(
        { contractStatus: row.contract_status, dueDate: row.due, extensionDays: row.extension_days, completedOn: row.completed_on, acceptedVnd: row.accepted, requestedVnd: row.requested, lastAcceptanceOn: row.last_acceptance_on },
        context.today,
        end,
        payment,
      );
      for (const finding of findings) {
        const ended = finding.facet === 'END_PASSED';
        const near = finding.facet === 'END_NEAR';
        const kind = finding.facet === 'PAYMENT_UNREQUESTED' ? 'CONTRACT_PAYMENT_UNREQUESTED' : 'CONTRACT_END_NEAR';
        const facet = near && finding.severity === 'URGENT' ? 'END_NEAR_URGENT' : finding.facet;
        const days = String(Math.abs(finding.daysLeft));
        items.push({
          ...base(kind),
          id: `${row.id}:${finding.facet === 'PAYMENT_UNREQUESTED' ? 'payment' : 'end'}`,
          dueOn: finding.dueOn,
          originalDueOn: finding.dueOn,
          title: message(ended ? 'home.source.contract.end_passed_title' : near ? 'home.source.contract.end_near_title' : 'home.source.contract.payment_title', { code: row.code }),
          subtitle: label(row.project_code, message(ended ? 'home.source.contract.end_passed_detail' : near ? 'home.source.contract.end_near_detail' : 'home.source.contract.payment_detail', { days, day: finding.facet === 'PAYMENT_UNREQUESTED' ? (row.last_acceptance_on ?? finding.dueOn) : finding.dueOn })),
          status: finding.facet,
          severity: severityOf('CONTRACT_CLOCK', facet, context.rules),
          consequence: CONSEQUENCES[kind] ?? null,
          causeKey: `contract:${row.id}`,
          startedAt: startOfDay(addDays(finding.dueOn, finding.facet === 'PAYMENT_UNREQUESTED' ? 0 : -end.end_warning_days)),
          target: { screen: 'CTR-03', id: row.id },
        });
      }
    }
    return items;
  }

  /** A document that waits for review (in review, or submitted) and whose review day is near or past; the signer and the drafter see it, and so does whoever may read the unit that drafts it. */
  async docReview(context: SourceContext): Promise<SourceRow[]> {
    const rule = await ruleParams<DocReviewParams>(this.port, context, DOC_REVIEW_RULE_TYPE, 'DEFAULT', docReviewDefaults, (params) => ({ warning_days: numberOf(params, 'warning_days', 2) }));
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'DOC_REVIEW', id: 'o.id::text', tenant: 'o', responsible: ['o.signer_user_id', 'o.drafter_user_id'], unit: true });
    const rows = await context.tx.query<{ id: string; status: string; review_due_on: string; label: string; unit_code: string | null }>(
      `select o.id, o.status, o.review_due_on::text as review_due_on, coalesce(d.symbol, d.title) as label, u.code as unit_code
         from machvon.outgoing_document o join machvon.document d on d.tenant_id = o.tenant_id and d.id = o.document_id
         ${PROJECT_JOINS('o', 'null::uuid')}
         left join machvon.organization_unit u on u.tenant_id = o.tenant_id and u.id = o.drafting_unit_id
        where o.status in ('IN_REVIEW', 'SUBMITTED') and o.review_due_on is not null and o.review_due_on <= (${today}::date + ${Math.trunc(rule.warning_days)}) and ${visible}
        order by o.review_due_on, o.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const items: SourceRow[] = [];
    for (const row of rows) {
      const facet = docReviewFacet(row.review_due_on, context.today, rule);
      if (facet === null) continue;
      items.push({
        ...base('DOC_REVIEW_OVERDUE'),
        id: row.id,
        dueOn: row.review_due_on,
        originalDueOn: row.review_due_on,
        title: message('home.source.doc_review.title', { code: row.label }),
        subtitle: label(row.unit_code, facet === 'OVERDUE' ? message('home.source.doc_review.detail_overdue', { days: String(daysBetween(row.review_due_on, context.today)), day: row.review_due_on }) : message('home.source.doc_review.detail_soon', { day: row.review_due_on })),
        status: row.status,
        severity: severityOf('DOC_REVIEW', facet, context.rules),
        consequence: CONSEQUENCES.DOC_REVIEW_OVERDUE ?? null,
        causeKey: `doc:${row.id}`,
        startedAt: startOfDay(row.review_due_on),
        target: { screen: 'DOC-02', id: row.id },
      });
    }
    return items;
  }

  /** A dataset whose last quality run is older than the freshness it promises (the badge STALE of BR-DGV-04), or a critical one never assessed: to its owner and steward, and to the data steward of the tenant. */
  async dataFreshness(context: SourceContext): Promise<SourceRow[]> {
    const rule = await ruleParams<DataFreshnessParams>(this.port, context, DATA_FRESHNESS_RULE_TYPE, 'DEFAULT', dataFreshnessDefaults, (params) => ({
      stale_severity: wordOf(params, 'stale_severity', 'ACTION') as DataFreshnessParams['stale_severity'],
      flag_never_assessed_critical: params.flag_never_assessed_critical !== false,
    }));
    const steward = context.holds?.(DATA_STEWARD_PERMISSION, true) === true;
    const rows = await context.tx.query<{ id: string; dataset_code: string; title: string; is_critical: boolean; owner: string | null; steward: string | null; badge: string; last_run_at: string | null; slo_seconds: string }>(
      `select d.id, d.dataset_code, d.title, d.is_critical, d.owner_user_id::text as owner, d.steward_user_id::text as steward, ${QUALITY_BADGE_SQL} as badge,
              to_char(run.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_run_at, d.freshness_slo_seconds::text as slo_seconds
         from machvon.dataset d ${LATEST_RUN_JOIN}
        where d.status = 'ACTIVE' and (${QUALITY_BADGE_SQL} = 'STALE' or (${QUALITY_BADGE_SQL} = 'NOT_ASSESSED' and d.is_critical))
        order by d.dataset_code, d.id limit ${SOURCE_LIMIT}`,
    );
    const items: SourceRow[] = [];
    for (const row of rows) {
      if (!steward && row.owner !== context.membershipId && row.steward !== context.membershipId) continue;
      const facet = dataFreshnessFacet(row.badge, row.is_critical, rule);
      if (facet === null) continue;
      const stale = facet === 'STALE';
      const lastRun = row.last_run_at;
      items.push({
        ...base('DATA_STALE'),
        id: row.id,
        dueOn: context.today,
        originalDueOn: lastRun === null ? context.today : new Date(Date.parse(lastRun) + Number(row.slo_seconds) * 1000).toISOString().slice(0, 10),
        title: message(stale ? 'home.source.data.stale_title' : 'home.source.data.never_title', { code: row.dataset_code }),
        subtitle: label(row.title, stale ? message('home.source.data.stale_detail') : null),
        status: row.badge,
        severity: severityOf('DATA_FRESHNESS', stale ? `STALE_${rule.stale_severity}` : 'NEVER_ASSESSED', context.rules),
        consequence: CONSEQUENCES.DATA_STALE ?? null,
        causeKey: `dataset:${row.id}`,
        startedAt: lastRun === null ? null : new Date(Date.parse(lastRun) + Number(row.slo_seconds) * 1000).toISOString(),
        target: { screen: 'DGV-04', id: row.id },
      });
    }
    return items;
  }

  /** The deterministic checks of the money (B4); a hint for the auditors to look at, never a conclusion. Each code is a rule of `ANOMALY_RULE` that can be switched off or tuned by the tenant. */
  async anomalies(context: SourceContext): Promise<SourceRow[]> {
    const holds = context.holds?.(AUDIENCE_PERMISSIONS.governanceAlerts, false) === true;
    const read = async (code: string, fallback: AnomalyParams): Promise<AnomalyParams> => {
      const resolved = await this.port.get(context.tx, ANOMALY_RULE_TYPE, code, context.today);
      if (resolved === undefined) return fallback;
      const p = resolved.params;
      return {
        indicator: wordOf(p, 'indicator', fallback.indicator),
        severity: wordOf(p, 'severity', fallback.severity) as AnomalyParams['severity'],
        enabled: p.enabled !== false,
        ...(typeof p.window_days === 'number' ? { window_days: p.window_days } : {}),
        ...(typeof p.threshold_pct === 'number' ? { threshold_pct: p.threshold_pct } : {}),
        ...(typeof p.threshold_count === 'number' ? { threshold_count: p.threshold_count } : {}),
        ...(typeof p.min_amount_vnd === 'string' ? { min_amount_vnd: p.min_amount_vnd } : {}),
      };
    };
    const rush = await read('PERIOD_END_RUSH', { indicator: 'PERIOD_END_RUSH', window_days: 10, threshold_pct: 50, min_amount_vnd: '1000000000', severity: 'WATCH', enabled: true });
    const open = await read('ADVANCE_WHILE_OPEN', { indicator: 'ADVANCE_WHILE_OPEN', min_amount_vnd: '1', severity: 'ACTION', enabled: true });
    const repeated = await read('REPEATED_REALLOCATION', { indicator: 'REPEATED_REALLOCATION', window_days: 365, threshold_count: 3, severity: 'WATCH', enabled: true });
    const items: SourceRow[] = [];
    if (rush.enabled) items.push(...(await this.periodEnd(context, rush, holds)));
    if (open.enabled) items.push(...(await this.advances(context, open, holds)));
    if (repeated.enabled) items.push(...(await this.reallocations(context, repeated, holds)));
    return items;
  }

  private async periodEnd(context: SourceContext, rule: AnomalyParams, audience: boolean): Promise<SourceRow[]> {
    const windowDays = rule.window_days ?? 10;
    const year = Number(context.today.slice(0, 4));
    const items: SourceRow[] = [];
    for (const planYear of [year - 1, year]) {
      const opens = periodEndWindowStart(planYear, windowDays);
      if (context.today < opens || daysBetween(opens, context.today) > PERIOD_END_SHOWN_DAYS) continue;
      const params = new Params();
      const yearParam = params.add(planYear);
      const windowStart = params.add(opens);
      const visible = reach(params, context, { source: 'ANOMALY', id: `('rush:' || c.id::text || ':' || ${yearParam}::text)`, tenant: 'c', responsible: [], unit: false, audience });
      const rows = await context.tx.query<{ contract_id: string; code: string; in_window: string; in_year: string; project_code: string | null }>(
        `select c.id as contract_id, c.code, coalesce(sum(pr.net_vnd) filter (where pr.treasury_submitted_on >= ${windowStart}::date), 0)::text as in_window, sum(pr.net_vnd)::text as in_year, p.code as project_code
           from machvon.payment_request pr join machvon.contract c on c.tenant_id = pr.tenant_id and c.id = pr.contract_id
           ${PROJECT_JOINS('c', 'c.project_id')}
          where pr.status in ('SENT_TREASURY', 'SETTLED') and pr.request_kind <> 'ADVANCE' and pr.treasury_submitted_on is not null and pr.plan_year = ${yearParam}::int and ${visible}
          group by c.id, c.code, p.code
          order by c.code limit ${SOURCE_LIMIT}`,
        params.values,
      );
      for (const row of rows) {
        const found = periodEndRush({ paidInWindowVnd: row.in_window, paidInYearVnd: row.in_year }, rule);
        if (found === null) continue;
        items.push({
          ...base('ANOMALY_SIGNAL'),
          id: `rush:${row.contract_id}:${planYear}`,
          dueOn: null,
          originalDueOn: null,
          title: message('home.source.anomaly.period_end_title', { code: row.code }),
          subtitle: label(row.project_code, message('home.source.anomaly.period_end_detail', { share: found.share.toFixed(0), year: String(planYear), days: String(windowDays) })),
          status: 'SIGNAL',
          severity: severityOf('ANOMALY', `SIGNAL_${rule.severity}`, context.rules),
          consequence: CONSEQUENCES.ANOMALY_SIGNAL ?? null,
          causeKey: `contract:${row.contract_id}`,
          startedAt: startOfDay(opens),
          target: { screen: 'CTR-03', id: row.contract_id },
        });
      }
    }
    return items;
  }

  private async advances(context: SourceContext, rule: AnomalyParams, audience: boolean): Promise<SourceRow[]> {
    const params = new Params();
    const since = params.add(addDays(context.today, -ADVANCE_LOOKBACK_DAYS));
    const visible = reach(params, context, { source: 'ANOMALY', id: `('advance:' || a2.id::text)`, tenant: 'a2', responsible: [], unit: false, audience });
    const rows = await context.tx.query<{ id: string; contract_id: string; code: string; paid_on: string; earlier_open: string; project_code: string | null }>(
      `select a2.id, a2.contract_id, c.code, a2.paid_on::text as paid_on, e.open_vnd::text as earlier_open, p.code as project_code
         from machvon.contract_advance a2 join machvon.contract c on c.tenant_id = a2.tenant_id and c.id = a2.contract_id
         ${PROJECT_JOINS('c', 'c.project_id')}
         cross join lateral (select coalesce(sum(a1.outstanding_vnd), 0) as open_vnd from machvon.contract_advance a1
                              where a1.tenant_id = a2.tenant_id and a1.contract_id = a2.contract_id and a1.tranche_no < a2.tranche_no and a1.outstanding_vnd > 0) e
        where a2.paid_on is not null and a2.paid_vnd > 0 and a2.paid_on >= ${since}::date and e.open_vnd > 0 and ${visible}
        order by a2.paid_on desc, a2.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows
      .filter((row) => advanceWhileOpen(row.earlier_open, rule))
      .map((row) => ({
        ...base('ANOMALY_SIGNAL'),
        id: `advance:${row.id}`,
        dueOn: null,
        originalDueOn: null,
        title: message('home.source.anomaly.advance_title', { code: row.code }),
        subtitle: label(row.project_code, message('home.source.anomaly.advance_detail')),
        status: 'SIGNAL',
        severity: severityOf('ANOMALY', `SIGNAL_${rule.severity}`, context.rules),
        consequence: CONSEQUENCES.ANOMALY_SIGNAL ?? null,
        causeKey: `contract:${row.contract_id}`,
        startedAt: startOfDay(row.paid_on),
        target: { screen: 'PAY-12', id: row.id },
      }));
  }

  private async reallocations(context: SourceContext, rule: AnomalyParams, audience: boolean): Promise<SourceRow[]> {
    const windowDays = rule.window_days ?? 365;
    const params = new Params();
    const since = params.add(addDays(context.today, -windowDays));
    const visible = reach(params, context, { source: 'ANOMALY', id: `('realloc:' || r.scope_unit_id::text || ':' || r.plan_year::text)`, tenant: 'r', responsible: [], unit: true, audience });
    const rows = await context.tx.query<{ unit_id: string; plan_year: number; n: string; unit_code: string | null; latest_id: string; first_on: string }>(
      `select r.scope_unit_id as unit_id, r.plan_year, count(*)::text as n, u.code as unit_code, (array_agg(r.id order by r.decided_at desc, r.id))[1] as latest_id, min(r.decided_at)::date::text as first_on
         from machvon.reallocation_proposal r
         ${PROJECT_JOINS('r', 'null::uuid')}
         join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.scope_unit_id
        where r.status = 'APPLIED' and r.decided_at >= ${since}::date and ${visible}
        group by r.scope_unit_id, r.plan_year, u.code
        order by u.code, r.plan_year limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows
      .filter((row) => repeatedReallocation(Number(row.n), rule))
      .map((row) => ({
        ...base('ANOMALY_SIGNAL'),
        id: `realloc:${row.unit_id}:${row.plan_year}`,
        dueOn: null,
        originalDueOn: null,
        title: message('home.source.anomaly.realloc_title', { unit: row.unit_code ?? '', year: String(row.plan_year) }),
        subtitle: message('home.source.anomaly.realloc_detail', { count: row.n, days: String(windowDays) }),
        status: 'SIGNAL',
        severity: severityOf('ANOMALY', `SIGNAL_${rule.severity}`, context.rules),
        consequence: CONSEQUENCES.ANOMALY_SIGNAL ?? null,
        causeKey: `realloc:${row.unit_id}:${row.plan_year}`,
        startedAt: startOfDay(row.first_on),
        target: { screen: 'CAP-07', id: row.latest_id },
      }));
  }
}
