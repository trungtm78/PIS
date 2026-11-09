import { BidWorkflowReads, GovernancePolicyPort, ReportCrosscheckStore } from '@machvon/db';
import type { ReportCandidateRow, ReportCrosscheckExplanationRow, ReportDraftRow, TenantDatabase, TenantTx } from '@machvon/db';
import { PERMISSIONS } from '@machvon/contracts';
import {
  CROSSCHECK_DEFAULT_CODE,
  CROSSCHECK_RULE_TYPE,
  DomainError,
  ROLE_PERIOD_KIND,
  SNAPSHOT_ROLE,
  compareReports,
  crosscheckFamily,
  crosscheckPolicyOf,
  figureSetOf,
  gateOf,
  periodCode,
  roleOfLayout,
} from '@machvon/kernel';
import type { CrosscheckFinding, CrosscheckPolicy, CrosscheckReport, CrosscheckResult, EffectiveAccess, FillSource, FormPeriod, GateDecision, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { REPORT_FORMS, layoutReadable } from './form-registry';

/**
 * The comparison of the reports of one period before release (ENT-4a, docs/report-crosscheck.md), on the API side. The rules are the kernel's (`compareReports`, `gateOf`) and the numbers of the rule are the governance
 * rule `REPORT_CROSSCHECK`; this module only gathers what is compared: for each form that plays a part and each period of the family (the quarter and its months) the head issued copy, else the newest open draft, with the
 * figures it was filled with; and, for each period, the frozen snapshot read through the provider of the forms (the one reader, R21). It writes nothing except the figure set of a draft (at generation) and the evidence of a
 * release. A report the caller may not read (a guarded form) is left out, never shown.
 */

const policyPort = new GovernancePolicyPort();
const store = new ReportCrosscheckStore();
const people = new BidWorkflowReads();

export interface CrosscheckContext {
  database: TenantDatabase;
  tenant: TenantContext;
  access: EffectiveAccess;
  tx: TenantTx;
  now: Date;
  /** The Vietnam day of `now`. */
  today: string;
}

export interface LoadedRule {
  code: string;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  formula: string;
  origin: string | null;
  asOf: string | null;
  policy: CrosscheckPolicy;
}

export interface CrosscheckRun {
  period: FormPeriod;
  rule: LoadedRule;
  reports: CrosscheckReport[];
  candidates: ReportCandidateRow[];
  result: CrosscheckResult;
  explanations: Map<string, ReportCrosscheckExplanationRow>;
}

/** The rule in force on `today`: the version a tenant approved, else the built-in starting values (UNVERIFIED). */
export async function loadCrosscheckRule(tx: TenantTx, today: string): Promise<LoadedRule> {
  const resolved = await policyPort.get(tx, CROSSCHECK_RULE_TYPE, CROSSCHECK_DEFAULT_CODE, today);
  if (resolved === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'crosscheck_rule');
  return {
    code: resolved.code,
    version: resolved.version,
    source: resolved.source,
    unverified: resolved.unverified,
    formula: resolved.provenance?.formula ?? '',
    origin: resolved.provenance?.source ?? null,
    asOf: resolved.provenance?.asOf ?? null,
    policy: crosscheckPolicyOf(resolved.params),
  };
}

/** Records the figures a draft was filled with, when the form plays a part in the comparison. A form that plays none costs nothing. */
export async function recordFigureSetOf(tx: TenantTx, today: string, draftId: string, layoutCode: string, data: FillSource): Promise<void> {
  const rule = await loadCrosscheckRule(tx, today);
  if (roleOfLayout(rule.policy, layoutCode) === undefined) return;
  await store.recordFigureSet(tx, draftId, figureSetOf(data, rule.policy));
}

/** The frozen snapshot of a period as the one reader gives it, as a report of the comparison; nothing when the form of the role has no snapshot provider or the period has no frozen snapshot. */
async function snapshotReportOf(context: CrosscheckContext, policy: CrosscheckPolicy, period: FormPeriod): Promise<CrosscheckReport | undefined> {
  for (const [role, layoutCode] of Object.entries(policy.layoutOf)) {
    if (ROLE_PERIOD_KIND[role as keyof typeof ROLE_PERIOD_KIND] !== period.kind || layoutCode === undefined) continue;
    const bundle = REPORT_FORMS.get(layoutCode);
    const provider = bundle?.snapshotProvider === undefined || bundle.snapshotProvider === null ? undefined : REPORT_FORMS.provider(bundle.snapshotProvider);
    if (bundle === undefined || provider === undefined) continue;
    const loaded = await provider.load({ database: context.database, tenant: context.tenant, access: context.access, now: context.now, today: context.today, period, layout: bundle.layout });
    if (loaded.snapshot === null) return undefined;
    return {
      ref: { kind: 'SNAPSHOT', id: loaded.snapshot.snapshotId, revision: loaded.snapshot.revision },
      role: SNAPSHOT_ROLE,
      layoutCode: 'SNAPSHOT',
      period,
      dataSource: 'LIVE',
      preparedBy: null,
      snapshot: { snapshotId: loaded.snapshot.snapshotId, revision: loaded.snapshot.revision, asOf: loaded.snapshot.cutoff ?? null },
      set: figureSetOf(loaded.data as FillSource, policy),
    };
  }
  return undefined;
}

/**
 * Gathers the reports of the family of `period` and compares them. `pinned` is the draft about to be released: it stands for its own form and period. The caller has checked the permission over the whole tenant.
 */
export async function runCrosscheck(context: CrosscheckContext, period: FormPeriod, pinned?: string): Promise<CrosscheckRun> {
  const family = crosscheckFamily(period);
  if (family.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  const rule = await loadCrosscheckRule(context.tx, context.today);
  const { policy } = rule;
  const layoutCodes = Object.values(policy.layoutOf).filter((one): one is string => one !== undefined);
  const candidates = (await store.candidates(context.tx, layoutCodes, family.map(periodCode), pinned)).filter((one) => layoutReadable(context.access, one.layoutCode));
  const sets = await store.figureSets(context.tx, candidates.map((one) => one.draftId));
  const reports: CrosscheckReport[] = [];
  const kept: ReportCandidateRow[] = [];
  for (const one of candidates) {
    const role = roleOfLayout(policy, one.layoutCode);
    if (role === undefined || ROLE_PERIOD_KIND[role] !== one.period.kind) continue;
    kept.push(one);
    reports.push({
      ref: { kind: one.kind, id: one.id, revision: one.revision },
      role,
      layoutCode: one.layoutCode,
      period: one.period,
      dataSource: one.dataSource,
      preparedBy: one.preparedBy,
      snapshot: one.snapshotRef === null ? null : { snapshotId: one.snapshotRef.snapshotId, revision: one.snapshotRef.revision, asOf: one.snapshotRef.cutoff ?? null },
      set: sets.get(one.draftId)?.set ?? null,
    });
  }
  const seen = new Set<string>();
  for (const one of kept) {
    const key = periodCode(one.period);
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = await snapshotReportOf(context, policy, one.period);
    if (snapshot !== undefined) reports.push(snapshot);
  }
  const result = compareReports(period, reports, policy);
  const explanations = new Map((await store.explanations(context.tx, { fingerprints: result.findings.map((finding) => finding.fingerprint) })).map((row) => [row.fingerprint, row]));
  return { period, rule, reports, candidates: kept, result, explanations };
}

export interface ReleaseCheck {
  run: CrosscheckRun;
  decision: GateDecision;
}

/**
 * What a release of `draft` must clear. Null when the form plays no part in the comparison (or its period is not a month or a quarter): the release goes as it always did. A finding that involves the draft, is BLOCKING
 * and has no explanation of its fingerprint stops it.
 */
export async function releaseCheckOf(context: CrosscheckContext, draft: Pick<ReportDraftRow, 'id' | 'layoutCode' | 'period'>): Promise<ReleaseCheck | null> {
  const rule = await loadCrosscheckRule(context.tx, context.today);
  const role = roleOfLayout(rule.policy, draft.layoutCode);
  if (role === undefined || ROLE_PERIOD_KIND[role] !== draft.period.kind || crosscheckFamily(draft.period).length === 0) return null;
  const run = await runCrosscheck(context, draft.period, draft.id);
  const explained = new Set(run.explanations.keys());
  return { run, decision: gateOf(run.result, draft.id, explained) };
}

/** The part of a finding that goes into the answer that blocks a release: what to look at, not the words of anybody. */
export const blockingSummaryOf = (findings: readonly CrosscheckFinding[]): Array<{ rule_id: string; code: string; fingerprint: string; difference: string }> =>
  findings.slice(0, 20).map((one) => ({ rule_id: one.ruleId, code: one.code, fingerprint: one.fingerprint, difference: one.difference }));

// -- the answers -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const canExplain = (access: EffectiveAccess): boolean => holdsOnWholeTenant(access, PERMISSIONS.explainCrosscheckFinding);

export async function explanationDtos(tx: TenantTx, rows: readonly ReportCrosscheckExplanationRow[]): Promise<Schemas['RptCrosscheckExplanation'][]> {
  const names = await people.names(tx, rows.map((row) => row.explainedBy));
  return rows.map((row) => ({
    id: row.id,
    fingerprint: row.fingerprint,
    rule_id: row.ruleId,
    figure_code: row.figureCode,
    period_code: row.periodCode,
    severity: row.severity,
    involves: row.involves,
    reason: row.reason,
    explained_by: row.explainedBy,
    explained_by_name: names.get(row.explainedBy) ?? null,
    created_at: row.createdAt,
  }));
}

/** The comparison as the screen reads it; with `draftId` it also says which findings stop that draft and whether the gate would pass. */
export async function crosscheckDto(context: CrosscheckContext, run: CrosscheckRun, draftId?: string): Promise<Schemas['RptCrosscheck']> {
  const mayExplain = canExplain(context.access);
  const me = context.tenant.membershipId;
  const dtos = await explanationDtos(context.tx, [...run.explanations.values()]);
  const byFingerprint = new Map(dtos.map((one) => [one.fingerprint, one]));
  const findings = run.result.findings.map((one): Schemas['RptCrosscheckFinding'] => {
    const explanation = byFingerprint.get(one.fingerprint) ?? null;
    return {
      rule_id: one.ruleId,
      rule_name: one.ruleName,
      severity: one.severity,
      code: one.code,
      period_code: one.periodCode,
      formula: one.formula,
      expected: one.expected,
      actual: one.actual,
      difference: one.difference,
      tolerance: one.tolerance,
      unit: one.unit,
      terms: one.terms.map((term) => ({ role: term.role, layout_code: term.layoutCode, ref: { kind: term.ref.kind, id: term.ref.id, revision: term.ref.revision }, period_code: term.periodCode, code: term.code, row_key: term.rowKey, value: term.value, source: term.source, as_of: term.asOf })),
      units: one.units,
      involves: one.involves,
      path: one.path.map((step) => ('layoutCode' in step ? { step: step.step, layout_code: step.layoutCode, ...('ref' in step ? { ref: step.ref } : {}), ...('periodCode' in step ? { period_code: step.periodCode } : {}), ...('rows' in step ? { rows: step.rows } : {}) } : { step: step.step })),
      fingerprint: one.fingerprint,
      status: explanation === null ? 'OPEN' : 'EXPLAINED',
      explanation,
      ...(draftId === undefined ? {} : { blocks_release: one.severity === 'BLOCKING' && explanation === null && one.involves.includes(draftId) }),
      can_explain: mayExplain && !one.authors.includes(me),
    };
  });
  const decision = draftId === undefined ? undefined : gateOf(run.result, draftId, new Set(run.explanations.keys()));
  return {
    period_code: run.result.periodCode,
    rule: { code: run.rule.code, version: run.rule.version, source: run.rule.source, unverified: run.rule.unverified, formula: run.rule.formula, origin: run.rule.origin, as_of: run.rule.asOf },
    reports: run.reports.map((one) => ({
      role: one.role,
      layout_code: one.layoutCode,
      ref: { kind: one.ref.kind, id: one.ref.id, revision: one.ref.revision },
      period_code: periodCode(one.period),
      state: run.candidates.find((candidate) => candidate.id === one.ref.id)?.state ?? null,
      data_source: one.dataSource,
      has_figures: one.set !== null,
      snapshot_id: one.snapshot?.snapshotId ?? null,
      snapshot_revision: one.snapshot?.revision ?? null,
    })),
    findings,
    skipped: run.result.skipped.map((one) => ({ rule_id: one.ruleId, reason: one.reason, role: one.role, layout_code: one.layoutCode, period_code: one.periodCode, code: one.code, text: one.text })),
    coverage: { reports: run.result.coverage.reports, usable: run.result.coverage.usable, rules_run: run.result.coverage.rulesRun, comparisons: run.result.coverage.comparisons, skipped: run.result.coverage.skipped },
    sha256: run.result.sha256,
    gate:
      draftId === undefined || decision === undefined
        ? null
        : { draft_id: draftId, blocking_open: decision.blocking.length, blocking_explained: decision.explained.length, warnings: decision.warnings.length, passed: decision.passed },
    can_explain: mayExplain,
    as_of: context.now.toISOString(),
  };
}
