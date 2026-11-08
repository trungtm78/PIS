import { AnalyticsGovernanceStore, CommitteeAlertStore, CommitteeDecisionStore, CommitteeDirectiveReader, CommitteePolicyReader, CoreProvinceFactsReader, DirectivePolicyReader, GovernancePolicyPort } from '@machvon/db';
import type { AttentionDecisionRow, CommitteeAlertRow, DirectiveTracker, ProvinceFactsReader, TenantTx } from '@machvon/db';
import { addDirectiveDays, buildWorkspace, filterFacts, rankAttention } from '@machvon/kernel';
import type { AttentionItem, CommitteePolicyReading, CommitteeWorkspace, FactsFilter, KpiDefinition, ProvinceFacts } from '@machvon/kernel';
import { figureOf } from '../home/figures';
import type { Figure } from '../home/figures';

/**
 * The one reading of the committee workspace (lane BAN-1): the facts through the port, the policy of the rule `COMMITTEE_POLICY`, the pure rules of the kernel, the directives of the steering meetings and the figures of
 * the register with their "i". The screens, the phone card, the PWA card and the meeting pack read this and nothing else, so one indicator is one number on every channel.
 */
export interface CommitteeRead {
  today: string;
  facts: ProvinceFacts;
  /** The facts of the week before, or null when the same snapshot answers (there is no earlier week to compare). */
  previous: ProvinceFacts | null;
  policy: CommitteePolicyReading;
  workspace: CommitteeWorkspace;
  tracker: DirectiveTracker;
  figures: Figure[];
  definitions: Map<string, KpiDefinition>;
  escalateAfterDays: number;
  /** Every project of the attention list (not cut at the size of the policy), with the latest decision of the Ban. */
  attention: Array<AttentionItem & { decision: AttentionDecisionRow | null }>;
}

export interface CommitteeReadRequest {
  /** The day the figures are wanted for: the latest frozen snapshot on or before it. */
  asOf: string;
  filter?: FactsFilter;
}

const DAY_OF_WEEK = 7;

export class CommitteeWorkspaceService {
  private readonly policies = new CommitteePolicyReader();
  private readonly directives = new CommitteeDirectiveReader();
  private readonly directivePolicy = new DirectivePolicyReader();
  private readonly decisions = new CommitteeDecisionStore();
  private readonly register = new AnalyticsGovernanceStore();
  readonly alerts = new CommitteeAlertStore();

  constructor(private readonly reader: ProvinceFactsReader = new CoreProvinceFactsReader()) {}

  /** Reads everything one screen of the workspace needs inside the transaction of the caller. */
  async read(tx: TenantTx, request: CommitteeReadRequest): Promise<CommitteeRead> {
    const today = request.asOf;
    const policy = await this.policies.get(tx, today);
    const whole = await this.reader.read(tx, { asOf: today });
    const earlier = await this.reader.read(tx, { asOf: addDirectiveDays(whole.asOf, -DAY_OF_WEEK) });
    const facts = filterFacts(whole, request.filter ?? {});
    const previousFacts = earlier.feed.reference === null || earlier.feed.reference === whole.feed.reference ? null : filterFacts(earlier, request.filter ?? {});
    const directivePolicy = (await this.directivePolicy.get(tx, today)).params;
    const tracker = await this.directives.tracker(tx, today, directivePolicy);
    const workspace = buildWorkspace(facts, previousFacts, policy.params, tracker.units);
    const ranked = rankAttention(facts, policy.params, { all: true });
    const latest = await this.decisions.latest(tx, ranked.items.map((item) => item.projectId));
    const definitions = await this.register.kpiDefinitions(tx, today);
    const certifications = await this.register.kpiCertifications(tx, definitions.values());
    const figures = this.figures(workspace, tracker, definitions, certifications, today);
    return {
      today,
      facts,
      previous: previousFacts,
      policy,
      workspace,
      tracker,
      figures,
      definitions,
      escalateAfterDays: directivePolicy.escalateAfterOverdueDays,
      attention: ranked.items.map((item) => ({ ...item, decision: latest.get(item.projectId) ?? null })),
    };
  }

  /** The alerts as stored (open and acknowledged) beside the types' owner, expected action and consequence from the registry of alert types. */
  async alertTypes(tx: TenantTx, day: string): Promise<Map<string, { owner: string | null; expectedAction: string | null; consequence: string | null; responseHours: number | null }>> {
    const types = await new GovernancePolicyPort().getAll(tx, 'ALERT_TYPE', day);
    const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
    return new Map(types.filter((one) => one.code.startsWith('COMMITTEE_')).map((one) => [one.code, { owner: text(one.params.owner), expectedAction: text(one.params.expected_action), consequence: text(one.params.consequence), responseHours: typeof one.params.response_hours === 'number' ? one.params.response_hours : null }]));
  }

  async storedAlerts(tx: TenantTx, status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'LIVE'): Promise<CommitteeAlertRow[]> {
    return this.alerts.list(tx, status);
  }

  private figures(workspace: CommitteeWorkspace, tracker: DirectiveTracker, definitions: Map<string, KpiDefinition>, certifications: Awaited<ReturnType<AnalyticsGovernanceStore['kpiCertifications']>>, today: string): Figure[] {
    const province = workspace.province;
    const noData = province.planVnd === '0' ? 'ZERO_DENOMINATOR' : 'NO_DATA';
    const at = { asOf: workspace.asOf, snapshotId: workspace.feed.reference, today };
    const nowAt = { asOf: today, snapshotId: null, today };
    const count = (value: number): string => String(value);
    const make = (code: string, value: string | null, numerator: string | null, denominator: string | null, nullReason: string | null, unit: 'PERCENT' | 'VND' | 'COUNT', when = at): Figure =>
      figureOf({ code, value, numerator, denominator, nullReason: value === null ? (nullReason ?? 'NO_DATA') : null, unit, formula: definitions.get(code)?.formula ?? '', definitionStatus: 'PROPOSED_PENDING_SIGNOFF' }, definitions.get(code), certifications.get(code), when);
    const lastYear = province.lastYearVnd;
    return [
      make('COMMITTEE_PLAN_TOTAL', workspace.feed.empty ? null : province.planVnd, province.planVnd, null, 'NO_DATA', 'VND'),
      make('COMMITTEE_DISBURSED', province.disbursedVnd, province.disbursedVnd, null, 'NO_DATA', 'VND'),
      make('COMMITTEE_DISBURSEMENT_RATE', province.ratePct, province.disbursedVnd, province.planVnd, noData, 'PERCENT'),
      make('COMMITTEE_DISBURSED_LAST_YEAR', lastYear, lastYear, null, 'NO_DATA', 'VND'),
      make('COMMITTEE_GAP_VS_CURVE', province.gapPoints, province.gapPoints, null, noData, 'PERCENT'),
      make('COMMITTEE_OUTLOOK_LOW', province.outlook.lowVnd, province.outlook.lowVnd, null, province.outlook.reason, 'VND'),
      make('COMMITTEE_OUTLOOK_HIGH', province.outlook.highVnd, province.outlook.highVnd, null, province.outlook.reason, 'VND'),
      make('COMMITTEE_ATTENTION_PROJECTS', workspace.feed.empty ? null : count(workspace.attentionTotal), count(workspace.attentionTotal), null, 'NO_DATA', 'COUNT', nowAt),
      make('COMMITTEE_UNITS_NOT_REPORTING', workspace.units.length === 0 ? null : count(workspace.units.filter((unit) => unit.notReporting).length), null, null, 'NO_DATA', 'COUNT', nowAt),
      make('COMMITTEE_DIRECTIVES_OVERDUE', count(tracker.totals.overdue), count(tracker.totals.overdue), null, null, 'COUNT', nowAt),
    ];
  }
}

