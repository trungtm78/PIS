import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { formatVnd } from '../report/money';
import '../dis.css';
import { useAcknowledge, useCreateRule, useDismiss, usePublishRule, useRules, useWarnings } from './hooks';
import type { WarningFilter } from './hooks';
import { APPROVE_PERMISSION, EMPTY_RULE_FORM, HANDLE_PERMISSION, MANAGE_PERMISSION, METRICS, SEVERITIES, WARNING_STATUSES, canAcknowledge, canDismiss, describeWarning, fieldOf, holds, reviseForm, validateRule } from './model';
import type { FieldProblem, Metric, RuleField, RuleForm, RuleView, Severity, WarningProblem, WarningView } from './model';

type T = Translator['t'];
const NONE = '—';
const CLOSE_GLYPH = '×';

function problemMessage(t: T, problem: WarningProblem): string {
  switch (problem) {
    case 'unknownMetric':
      return t('dis.warning.problem.unknownMetric');
    case 'selfApproval':
      return t('dis.warning.problem.selfApproval');
    case 'versionConflict':
      return t('dis.warning.problem.versionConflict');
    case 'stateInvalid':
      return t('dis.warning.problem.stateInvalid');
    case 'stageDenied':
      return t('dis.warning.problem.stageDenied');
    case 'validation':
      return t('dis.warning.problem.validation');
    case 'scopeDenied':
      return t('dis.warning.problem.scopeDenied');
    case 'notFound':
      return t('dis.warning.problem.notFound');
    case 'general':
      return t('dis.warning.problem.general');
  }
}

function metricLabel(t: T, metric: Metric): string {
  switch (metric) {
    case 'YTD_RATE_GAP':
      return t('dis.warning.metric.ytdRateGap');
    case 'REPORT_OVERDUE':
      return t('dis.warning.metric.reportOverdue');
    case 'NATIONAL_CODE_MISSING':
      return t('dis.warning.metric.nationalCode');
    case 'PERIOD_DELTA_NEGATIVE':
      return t('dis.warning.metric.negativeDelta');
  }
}

const severityLabel = (t: T, severity: Severity): string => (severity === 'CRITICAL' ? t('dis.warning.severity.critical') : severity === 'WARNING' ? t('dis.warning.severity.warning') : t('dis.warning.severity.info'));
const severityTone = (severity: Severity): 'warn' | 'gray' => (severity === 'INFO' ? 'gray' : 'warn');

function statusLabel(t: T, status: WarningView['status']): string {
  switch (status) {
    case 'OPEN':
      return t('dis.warning.status.open');
    case 'ACKNOWLEDGED':
      return t('dis.warning.status.acknowledged');
    case 'EXPLANATION_REQUESTED':
      return t('dis.warning.status.explanation');
    case 'RESOLVED':
      return t('dis.warning.status.resolved');
    case 'DISMISSED':
      return t('dis.warning.status.dismissed');
  }
}

function ruleStatusLabel(t: T, status: RuleView['status']): string {
  return status === 'DRAFT' ? t('dis.warning.rule.status.draft') : status === 'PUBLISHED' ? t('dis.warning.rule.status.published') : t('dis.warning.rule.status.retired');
}

/** What a rule is set to, in words: the threshold of its metric. */
function thresholdText(t: T, rule: RuleView): string {
  const threshold = rule.threshold;
  switch (rule.metric) {
    case 'YTD_RATE_GAP':
      return threshold.critical_points === undefined
        ? t('dis.warning.threshold.gap', { points: String(threshold.points) })
        : t('dis.warning.threshold.gapCritical', { points: String(threshold.points), critical: String(threshold.critical_points) });
    case 'REPORT_OVERDUE':
      return t('dis.warning.threshold.overdue', { grace: String(threshold.grace_days ?? 0), due: String(threshold.explanation_due_days ?? 3) });
    case 'NATIONAL_CODE_MISSING':
      return t('dis.warning.threshold.nationalCode');
    case 'PERIOD_DELTA_NEGATIVE':
      return t('dis.warning.threshold.negativeDelta');
  }
}

/** What a warning saw, in words: the figures the rule found. */
function observedText(t: T, warning: WarningView): string {
  const seen = warning.observed;
  switch (seen.metric) {
    case 'YTD_RATE_GAP':
      return t('dis.warning.observed.gap', { observed: String(seen.observed_pct), expected: String(seen.expected_pct), gap: String(seen.gap_points) });
    case 'REPORT_OVERDUE':
      return t('dis.warning.observed.overdue', { days: String(seen.days_past_deadline) });
    case 'NATIONAL_CODE_MISSING':
      return t('dis.warning.observed.nationalCode');
    case 'PERIOD_DELTA_NEGATIVE':
      return t('dis.warning.observed.negativeDelta', { delta: typeof seen.delta_vnd === 'string' ? formatVnd(seen.delta_vnd) : NONE });
    default:
      return NONE;
  }
}

function fieldProblem(t: T, problem: FieldProblem | undefined): string | undefined {
  return problem === undefined ? undefined : problem === 'required' ? t('dis.warning.field.required.error') : t('dis.warning.field.invalid.error');
}

/**
 * DIS-20: the early-warning rules and the warnings they open (ST-DIS-012, DIS 3 F7, BR-DIS-13). A rule is data with its legal basis; a change is a new revision, a draft that someone other than its author
 * publishes, with the number of warnings it would open on the latest frozen snapshot shown first. The warnings are one for each rule and project, found again by the next snapshot; a person acknowledges
 * or dismisses one with a reason, and the state is always in words.
 */
export default function WarningScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <WarningContent key={tenantId ?? 'none'} route={route} />;
}

function WarningContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const rules = useRules();
  const [editing, setEditing] = useState<RuleForm | undefined>(undefined);
  const state = useScreenState({ isLoading: rules.isLoading, error: rules.error, data: rules.data, isEmpty: () => false });
  const manage = holds(permissions, MANAGE_PERMISSION, mode);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.warning.page.title')}</h1>
          <p>{t('dis.warning.page.subtitle')}</p>
        </div>
        {manage ? (
          <button type="button" className="primary" onClick={() => setEditing({ ...EMPTY_RULE_FORM })}>
            {t('dis.warning.rule.new.action')}
          </button>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void rules.refetch()}>
        <Rules rules={rules.data ?? []} onRevise={(rule) => setEditing(reviseForm(rule))} manage={manage} approve={holds(permissions, APPROVE_PERMISSION, mode)} />
        {editing === undefined ? null : <RuleEditor key={editing.ruleCode} initial={editing} onClose={() => setEditing(undefined)} />}
        <Warnings handle={holds(permissions, HANDLE_PERMISSION, mode)} ruleCodes={[...new Set((rules.data ?? []).map((rule) => rule.ruleCode))].sort()} />
      </StateBoundary>
      <p className="prototype-note">{t('dis.warning.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Rules({ rules, onRevise, manage, approve }: { rules: RuleView[]; onRevise(rule: RuleView): void; manage: boolean; approve: boolean }) {
  const { t } = useTranslation();
  const publish = usePublishRule();
  const [target, setTarget] = useState<string | undefined>(undefined);
  const refusal = publish.isError ? describeWarning(publish.error) : undefined;
  return (
    <section className="card" aria-labelledby="rules-title">
      <h2 id="rules-title">{t('dis.warning.rules.title')}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="publish-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {rules.length === 0 ? (
        <p className="muted" data-testid="rules-none">
          {t('dis.warning.rules.empty.text')}
        </p>
      ) : (
        <div className="tablewrap">
          <table className="table" aria-label={t('dis.warning.rules.aria')} data-testid="rules">
            <thead>
              <tr>
                <th scope="col">{t('dis.warning.rule.col.rule')}</th>
                <th scope="col">{t('dis.warning.rule.col.metric')}</th>
                <th scope="col">{t('dis.warning.rule.col.threshold')}</th>
                <th scope="col">{t('dis.warning.rule.col.severity')}</th>
                <th scope="col">{t('dis.warning.rule.col.status')}</th>
                <th scope="col">{t('dis.warning.rule.col.preview')}</th>
                <th scope="col">
                  <span className="sr-only">{t('dis.warning.rule.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} data-rule={rule.id} data-status={rule.status}>
                  <td>
                    {rule.ruleCode} · {t('dis.warning.rule.revision', { revision: rule.revision })}
                    <span className="dis-code">{rule.name}</span>
                    <span className="dis-code" title={rule.legalBasis}>
                      {rule.legalBasis}
                    </span>
                  </td>
                  <td>{metricLabel(t, rule.metric)}</td>
                  <td>
                    {thresholdText(t, rule)}
                    {rule.autoExplanation ? <span className="dis-code">{t('dis.warning.rule.autoExplanation')}</span> : null}
                  </td>
                  <td>
                    <span className={`pill ${severityTone(rule.severity)}`}>{severityLabel(t, rule.severity)}</span>
                  </td>
                  <td>
                    <span className={`pill ${rule.status === 'PUBLISHED' ? 'green' : rule.status === 'DRAFT' ? 'warn' : 'gray'}`}>{ruleStatusLabel(t, rule.status)}</span>
                  </td>
                  <td data-testid={`preview-${rule.id}`}>{rule.wouldOpen === null ? NONE : t('dis.warning.rule.preview.text', { count: rule.wouldOpen })}</td>
                  <td>
                    {rule.status === 'DRAFT' && approve ? (
                      <button type="button" disabled={publish.isPending && target === rule.id} onClick={() => (setTarget(rule.id), publish.mutate({ rule }))}>
                        {t('dis.warning.rule.publish.action')}
                      </button>
                    ) : null}{' '}
                    {manage && rule.status !== 'RETIRED' ? (
                      <button type="button" onClick={() => onRevise(rule)}>
                        {t('dis.warning.rule.revise.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RuleEditor({ initial, onClose }: { initial: RuleForm; onClose(): void }) {
  const { t } = useTranslation();
  const create = useCreateRule();
  const [form, setForm] = useState<RuleForm>(initial);
  const [problems, setProblems] = useState<Partial<Record<RuleField, FieldProblem>>>({});
  const refusal = create.isError ? describeWarning(create.error) : undefined;
  const serverField = create.isError ? fieldOf(create.error) : undefined;
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]): void => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateRule(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || create.isPending) return;
    create.mutate(form, { onSuccess: onClose });
  };
  const text = (field: RuleField, key: keyof RuleForm, label: string, extra: { type?: string; hint?: string } = {}) => (
    <Field id={`rule-${field}`} label={label} error={fieldProblem(t, problems[field]) ?? (serverField === field && refusal !== undefined ? problemMessage(t, refusal) : undefined)} {...(extra.hint === undefined ? {} : { hint: extra.hint })}>
      <input id={`rule-${field}`} type={extra.type ?? 'text'} value={String(form[key])} onChange={(event) => set(key, event.target.value as never)} />
    </Field>
  );
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="rule-form-title" data-testid="rule-form">
      <h2 id="rule-form-title">{initial.ruleCode === '' ? t('dis.warning.editor.title.new') : t('dis.warning.editor.title.revise', { code: initial.ruleCode })}</h2>
      <p className="sub">{t('dis.warning.editor.note')}</p>
      {refusal === undefined || serverField !== undefined ? null : (
        <p className="callout warning" role="alert" data-testid="create-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      <div className="formgrid">
        {initial.ruleCode === '' ? text('ruleCode', 'ruleCode', t('dis.warning.field.code.label'), { hint: t('dis.warning.field.code.hint') }) : null}
        {text('name', 'name', t('dis.warning.field.name.label'))}
        <Field id="rule-metric" label={t('dis.warning.field.metric.label')} error={undefined}>
          <select id="rule-metric" value={form.metric} onChange={(event) => set('metric', event.target.value as Metric)}>
            {METRICS.map((metric) => (
              <option key={metric} value={metric}>
                {metricLabel(t, metric)}
              </option>
            ))}
          </select>
        </Field>
        {form.metric === 'YTD_RATE_GAP' ? (
          <>
            {text('points', 'points', t('dis.warning.field.points.label'), { hint: t('dis.warning.field.points.hint') })}
            {text('criticalPoints', 'criticalPoints', t('dis.warning.field.critical.label'), { hint: t('dis.warning.field.critical.hint') })}
          </>
        ) : null}
        {form.metric === 'REPORT_OVERDUE' ? (
          <>
            {text('graceDays', 'graceDays', t('dis.warning.field.grace.label'))}
            {text('explanationDueDays', 'explanationDueDays', t('dis.warning.field.due.label'))}
          </>
        ) : null}
        <Field id="rule-severity" label={t('dis.warning.field.severity.label')} error={undefined}>
          <select id="rule-severity" value={form.severity} onChange={(event) => set('severity', event.target.value as Severity)}>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severityLabel(t, severity)}
              </option>
            ))}
          </select>
        </Field>
        {text('effectiveFrom', 'effectiveFrom', t('dis.warning.field.from.label'), { type: 'date' })}
        {text('effectiveUntil', 'effectiveUntil', t('dis.warning.field.until.label'), { type: 'date' })}
        {text('legalBasis', 'legalBasis', t('dis.warning.field.legal.label'), { hint: t('dis.warning.field.legal.hint') })}
        <label className="dis-radio">
          <input type="checkbox" checked={form.autoExplanation} onChange={(event) => set('autoExplanation', event.target.checked)} />
          {t('dis.warning.field.auto.label')}
        </label>
      </div>
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('dis.warning.dialog.cancel.action')}
        </button>
        <button type="submit" className="primary" disabled={create.isPending}>
          {create.isPending ? t('dis.warning.editor.pending') : t('dis.warning.editor.save.action')}
        </button>
      </div>
    </form>
  );
}

function Warnings({ handle, ruleCodes }: { handle: boolean; ruleCodes: string[] }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<WarningFilter>({ status: '', severity: '', ruleCode: '' });
  const [acting, setActing] = useState<{ warning: WarningView; action: 'acknowledge' | 'dismiss' } | undefined>(undefined);
  const warnings = useWarnings(filter);
  const state = useScreenState({ isLoading: warnings.isLoading, error: warnings.error, data: warnings.data, isEmpty: (data) => (data as { pages: Array<{ items: unknown[] }> }).pages.every((page) => page.items.length === 0) });
  const items = (warnings.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <section className="card" aria-labelledby="warnings-title">
      <h2 id="warnings-title">{t('dis.warning.list.title')}</h2>
      <div className="dis-filters" role="group" aria-label={t('dis.warning.filter.title')}>
        <Field id="warning-status" label={t('dis.warning.filter.status')} error={undefined}>
          <select id="warning-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value })}>
            <option value="">{t('dis.warning.filter.all')}</option>
            {WARNING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(t, status)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="warning-severity" label={t('dis.warning.filter.severity')} error={undefined}>
          <select id="warning-severity" value={filter.severity} onChange={(event) => setFilter({ ...filter, severity: event.target.value })}>
            <option value="">{t('dis.warning.filter.all')}</option>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severityLabel(t, severity)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="warning-rule" label={t('dis.warning.filter.rule')} error={undefined}>
          <select id="warning-rule" value={filter.ruleCode} onChange={(event) => setFilter({ ...filter, ruleCode: event.target.value })}>
            <option value="">{t('dis.warning.filter.all')}</option>
            {ruleCodes.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <StateBoundary state={state} onRetry={() => void warnings.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('dis.warning.list.aria')} data-testid="warnings">
            <thead>
              <tr>
                <th scope="col">{t('dis.warning.col.rule')}</th>
                <th scope="col">{t('dis.warning.col.project')}</th>
                <th scope="col">{t('dis.warning.col.severity')}</th>
                <th scope="col">{t('dis.warning.col.observed')}</th>
                <th scope="col">{t('dis.warning.col.status')}</th>
                <th scope="col">{t('dis.warning.col.opened')}</th>
                <th scope="col">
                  <span className="sr-only">{t('dis.warning.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((warning) => (
                <tr key={warning.id} data-warning={warning.id} data-status={warning.status}>
                  <td>
                    {warning.ruleCode}
                    <span className="dis-code">{warning.ruleName}</span>
                  </td>
                  <td>
                    {warning.projectCode ?? NONE}
                    <span className="dis-code">{warning.projectName}</span>
                  </td>
                  <td>
                    <span className={`pill ${severityTone(warning.severity)}`}>{severityLabel(t, warning.severity)}</span>
                  </td>
                  <td>{observedText(t, warning)}</td>
                  <td>
                    <span className="pill gray">{statusLabel(t, warning.status)}</span>
                    {warning.resolutionReason === null ? null : <span className="dis-code">{warning.resolutionReason === 'AUTO_CLEARED' ? t('dis.warning.resolution.autoCleared') : warning.resolutionReason}</span>}
                  </td>
                  <td>{warning.openedAt.slice(0, 10)}</td>
                  <td>
                    {handle && canAcknowledge(warning) ? (
                      <button type="button" onClick={() => setActing({ warning, action: 'acknowledge' })}>
                        {t('dis.warning.acknowledge.action')}
                      </button>
                    ) : null}{' '}
                    {handle && canDismiss(warning) ? (
                      <button type="button" onClick={() => setActing({ warning, action: 'dismiss' })}>
                        {t('dis.warning.dismiss.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {warnings.hasNextPage ? (
          <p>
            <button type="button" disabled={warnings.isFetchingNextPage} onClick={() => void warnings.fetchNextPage()}>
              {t('dis.warning.list.more.action')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
      {acting === undefined ? null : <ReasonDialog warning={acting.warning} action={acting.action} onClose={() => setActing(undefined)} />}
    </section>
  );
}

/** The reason that a person gives when they acknowledge or dismiss a warning; the audit trail keeps that it was given, the warning keeps the words. */
function ReasonDialog({ warning, action, onClose }: { warning: WarningView; action: 'acknowledge' | 'dismiss'; onClose(): void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const acknowledge = useAcknowledge();
  const dismiss = useDismiss();
  const send = action === 'acknowledge' ? acknowledge : dismiss;
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const refusal = send.isError ? describeWarning(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (send.isPending) return;
    const trimmed = reason.trim();
    const found: FieldProblem | undefined = trimmed === '' ? 'required' : trimmed.length < 5 ? 'invalid' : undefined;
    setProblem(found);
    if (found !== undefined) return;
    send.mutate({ warning, reason: trimmed }, { onSuccess: onClose });
  };
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{action === 'acknowledge' ? t('dis.warning.acknowledge.dialog.title', { rule: warning.ruleCode }) : t('dis.warning.dismiss.dialog.title', { rule: warning.ruleCode })}</strong>
          <button type="button" className="icon-button" aria-label={t('dis.warning.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          <p>{action === 'acknowledge' ? t('dis.warning.acknowledge.dialog.body') : t('dis.warning.dismiss.dialog.body')}</p>
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="action-refusal">
              {problemMessage(t, refusal)}
            </p>
          )}
          <Field id="warning-reason" label={t('dis.warning.field.reason.label')} error={fieldProblem(t, problem)} hint={t('dis.warning.field.reason.hint')}>
            <textarea id="warning-reason" rows={3} value={reason} onChange={(event) => (setReason(event.target.value), setProblem(undefined))} />
          </Field>
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('dis.warning.dialog.cancel.action')}
            </button>
            <button type="submit" className="primary" disabled={send.isPending}>
              {action === 'acknowledge' ? t('dis.warning.acknowledge.confirm.action') : t('dis.warning.dismiss.confirm.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
