import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { useMemberOptions } from '../../prj/accountability-reads';
import { FigureInfo, ProblemBanner } from '../components';
import { formProblemText, roleWord } from '../labels';
import { dayText, describeProblem } from '../model';
import type { Assignment } from '../model';
import { useAssign, useAssignments } from './hooks';
import { EMPTY_FORM, MAX_ASSIGNMENT_REASON, MAX_SHARE, MIN_SHARE, ROLES, assignmentBody, checkLedger, validateForm } from './model';
import type { AssignmentForm, FormField } from './model';

export interface AssignmentLedgerProps {
  taskId: string;
  /** The server's `can_assign` of the task: the form is shown only when it is true (and the session is not read-only). */
  canAssign: boolean;
}

const NEVER_EMPTY = (): boolean => false;

function periodText(t: ReturnType<typeof useTranslation>['t'], item: Assignment): string {
  return item.valid_to === null ? t('pwf.ledger.period.open', { from: dayText(item.valid_from) }) : `${dayText(item.valid_from)} – ${dayText(item.valid_to)}`;
}

/** PWF-16: who is assigned to a task, in which role, over which days and with which share (the ledger), and the form that adds an assignment. A part of PWF-04 and a screen of its own. */
export function AssignmentLedger({ taskId, canAssign }: AssignmentLedgerProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const query = useAssignments(taskId);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data, isEmpty: NEVER_EMPTY });
  const items = query.data?.items ?? [];
  const columns: DataTableColumn<Assignment>[] = [
    { key: 'person', header: t('pwf.ledger.col.person'), render: (item) => item.display_name },
    { key: 'role', header: t('pwf.ledger.col.role'), render: (item) => roleWord(t, item.role) },
    { key: 'period', header: t('pwf.ledger.col.period'), render: (item) => periodText(t, item) },
    { key: 'share', header: t('pwf.ledger.col.share'), align: 'right', render: (item) => `${item.share_pct}%` },
    { key: 'reason', header: t('pwf.ledger.col.reason'), render: (item) => item.reason },
  ];
  return (
    <SectionCard
      title={t('pwf.ledger.section.title')}
      actions={<FigureInfo name={t('pwf.ledger.share.name')} formula={t('pwf.ledger.share.formula')} source={t('pwf.ledger.share.source')} asOf={query.data?.as_of} version={t('pwf.ledger.share.version')} />}
    >
      <div data-testid="ledger">
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {items.length === 0 ? (
            <p className="pwf-hint" role="status" data-testid="ledger-empty">
              {t('pwf.ledger.empty.text')}
            </p>
          ) : (
            <div className="pwf-free">
              <DataTable columns={columns} rows={items} rowKey={(item) => item.id} caption={t('pwf.ledger.table.caption')} />
            </div>
          )}
        </StateBoundary>
        {canAssign && mode !== 'READ_ONLY' ? (
          <details className="pwf-inline-fold" data-testid="assign-fold">
            <summary>{t('pwf.ledger.form.title')}</summary>
            <AssignForm taskId={taskId} ledger={items} />
          </details>
        ) : null}
      </div>
    </SectionCard>
  );
}

const ERROR_LIMITS: Readonly<Record<FormField, { min?: number; max?: number }>> = {
  membershipId: {},
  validFrom: {},
  validTo: {},
  sharePct: { min: MIN_SHARE, max: MAX_SHARE },
  reason: { min: 1, max: MAX_ASSIGNMENT_REASON },
};

function AssignForm({ taskId, ledger }: { taskId: string; ledger: readonly Assignment[] }) {
  const { t } = useTranslation();
  const assign = useAssign();
  const members = useMemberOptions(true);
  const [form, setForm] = useState<AssignmentForm>(EMPTY_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const problems = validateForm(form);
  const check = useMemo(() => checkLedger(ledger, form), [ledger, form]);
  const refused = assign.isError ? describeProblem(assign.error) : undefined;
  const options = members.data ?? [];

  const change = (patch: Partial<AssignmentForm>): void => {
    setSaved(false);
    setForm({ ...form, ...patch });
  };
  const error = (field: FormField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemText(t, problem, ERROR_LIMITS[field]) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (assign.isPending || Object.keys(problems).length > 0) return;
    assign.mutate(
      { taskId, body: assignmentBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_FORM);
          setSubmitted(false);
          setSaved(true);
        },
      },
    );
  };
  const describedBy = (field: FormField, id: string): string | undefined => (error(field) === undefined ? undefined : `${id}-error`);
  const invalid = (field: FormField): true | undefined => (error(field) === undefined ? undefined : true);

  return (
    <form className="pwf-assign" onSubmit={submit} noValidate aria-label={t('pwf.ledger.form.title')} data-testid="assign-form">
      {refused === undefined ? null : <ProblemBanner problem={refused} />}
      {saved ? (
        <p className="callout" role="status" data-testid="assign-saved">
          {t('pwf.ledger.saved.notice')}
        </p>
      ) : null}
      {check.overlap ? (
        <p className="callout warning" role="status" data-testid="warn-overlap">
          {t('pwf.ledger.warn.overlap.text')}
        </p>
      ) : null}
      {check.overShare ? (
        <p className="callout warning" role="status" data-testid="warn-share">
          {t('pwf.ledger.warn.share.text')}
        </p>
      ) : null}
      <div className="pwf-filters">
        <div className="pwf-field">
          <label htmlFor="assign-member">{t('pwf.ledger.field.member.label')}</label>
          {options.length > 0 ? (
            <select id="assign-member" data-testid="field-member" value={form.membershipId} aria-invalid={invalid('membershipId')} aria-describedby={describedBy('membershipId', 'assign-member')} onChange={(event) => change({ membershipId: event.target.value })}>
              <option value="">{t('pwf.ledger.member.placeholder')}</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input id="assign-member" data-testid="field-member" value={form.membershipId} aria-invalid={invalid('membershipId')} aria-describedby={describedBy('membershipId', 'assign-member')} onChange={(event) => change({ membershipId: event.target.value })} />
          )}
          {error('membershipId') === undefined ? null : (
            <span className="pwf-field__error" id="assign-member-error" data-testid="error-member">
              {error('membershipId')}
            </span>
          )}
        </div>
        <div className="pwf-field">
          <label htmlFor="assign-role">{t('pwf.ledger.field.role.label')}</label>
          <select id="assign-role" data-testid="field-role" value={form.role} onChange={(event) => change({ role: ROLES.find((role) => role === event.target.value) ?? 'RESPONSIBLE' })}>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {roleWord(t, role)}
              </option>
            ))}
          </select>
        </div>
        <div className="pwf-field">
          <label htmlFor="assign-from">{t('pwf.ledger.field.from.label')}</label>
          <input id="assign-from" type="date" data-testid="field-from" value={form.validFrom} aria-invalid={invalid('validFrom')} aria-describedby={describedBy('validFrom', 'assign-from')} onChange={(event) => change({ validFrom: event.target.value })} />
          {error('validFrom') === undefined ? null : (
            <span className="pwf-field__error" id="assign-from-error" data-testid="error-from">
              {error('validFrom')}
            </span>
          )}
        </div>
        <div className="pwf-field">
          <label htmlFor="assign-to">{t('pwf.ledger.field.to.label')}</label>
          <input id="assign-to" type="date" data-testid="field-to" value={form.validTo} aria-invalid={invalid('validTo')} aria-describedby={describedBy('validTo', 'assign-to')} onChange={(event) => change({ validTo: event.target.value })} />
          {error('validTo') === undefined ? null : (
            <span className="pwf-field__error" id="assign-to-error" data-testid="error-to">
              {error('validTo')}
            </span>
          )}
        </div>
        <div className="pwf-field">
          <label htmlFor="assign-share">{t('pwf.ledger.field.share.label')}</label>
          <input id="assign-share" inputMode="numeric" data-testid="field-share" value={form.sharePct} aria-invalid={invalid('sharePct')} aria-describedby={describedBy('sharePct', 'assign-share')} onChange={(event) => change({ sharePct: event.target.value })} />
          {error('sharePct') === undefined ? null : (
            <span className="pwf-field__error" id="assign-share-error" data-testid="error-share">
              {error('sharePct')}
            </span>
          )}
        </div>
        <div className="pwf-field pwf-field--wide">
          <label htmlFor="assign-reason">{t('pwf.ledger.field.reason.label')}</label>
          <textarea id="assign-reason" rows={2} data-testid="field-reason" value={form.reason} aria-invalid={invalid('reason')} aria-describedby={describedBy('reason', 'assign-reason')} onChange={(event) => change({ reason: event.target.value })} />
          {error('reason') === undefined ? null : (
            <span className="pwf-field__error" id="assign-reason-error" data-testid="error-reason">
              {error('reason')}
            </span>
          )}
        </div>
      </div>
      <div className="pwf-actions">
        <button type="submit" className="ui-button ui-button--primary" data-testid="save" disabled={assign.isPending}>
          {t('pwf.ledger.save.action')}
        </button>
      </div>
    </form>
  );
}
