import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { AuditLine, ReadonlyStat, SectionCard, StickyActions } from '../../../ui';
import { Field } from '../components';
import '../dis.css';
import { ErrorSummary, StatusStrip } from './entry-parts';
import type { SummaryItem } from './entry-parts';
import { MoneyInput, ReportFacts } from './components';
import { useSaveDraft } from './hooks';
import { basisLabel, reportProblemMessage, volumeProblemMessage } from './labels';
import { BASES, EDIT_PATH, REPORTS_PATH, SAVED_PATH, canEdit, describeReport } from './model';
import type { Basis, ReportDetail } from './model';
import { formatVnd } from './money';
import { StepFrame } from './StepFrame';
import { progressBody, progressFormOf, validateProgress } from './step-model';
import type { ProgressField, ProgressForm } from './step-model';
import { dueMoment } from './weekly-model';

/**
 * DIS-03: the volumes of the period (ST-DIS-004, DIS 3 F1 step 3): what was built, accepted, sent to the Treasury and is being prepared, in whole dong, the physical progress in percent, and the basis
 * the cumulative figures are read on. The basis defaults to the year to date, which is marked as awaiting the sign-off of the capital owner (D03, CXN-03). The figures are as of the last day of
 * the period, and are cumulative at that time, never added across weeks. On top, the strip of the report (state, deadline, what to do first); the errors are told in the field and gathered at the top.
 */
export default function ProgressScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  return (
    <StepFrame
      key={tenantId ?? 'none'}
      route={route}
      current="progress"
      texts={{
        back: t('dis.progress.back.link'),
        title: t('dis.progress.page.title'),
        subtitle: t('dis.progress.page.subtitle'),
        choose: t('dis.progress.choose.text'),
        footer: t('dis.progress.footer.reference', { id: route.id, req: route.req ?? '' }),
      }}
    >
      {(detail) => <Editor key={`${detail.id}:${detail.version}`} detail={detail} />}
    </StepFrame>
  );
}

const AMOUNT_FIELDS = ['construction', 'acceptance', 'treasury', 'preparing'] as const;

function Editor({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode } = useSession();
  const save = useSaveDraft();
  const [form, setForm] = useState<ProgressForm>(() => progressFormOf(detail));
  const [attempt, setAttempt] = useState(0);
  const submitted = attempt > 0;
  const editable = canEdit(permissions, mode, detail.status);
  const problems = validateProgress(form);
  const described = save.isError ? describeReport(save.error) : undefined;

  const set = (field: ProgressField, value: string): void => setForm({ ...form, [field]: value });
  const onSave = (event: FormEvent): void => {
    event.preventDefault();
    setAttempt(attempt + 1);
    if (!editable || save.isPending || Object.keys(problems).length > 0) return;
    save.mutate({ detail, body: progressBody(detail, form) }, { onSuccess: () => void navigate(`${SAVED_PATH}?report=${detail.id}`) });
  };
  const error = (field: ProgressField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? volumeProblemMessage(t, problem) : undefined;
  };
  const labelOf = (field: ProgressField): string => {
    switch (field) {
      case 'construction':
        return t('dis.progress.construction.label');
      case 'acceptance':
        return t('dis.progress.acceptance.label');
      case 'treasury':
        return t('dis.progress.treasury.label');
      case 'preparing':
        return t('dis.progress.preparing.label');
      case 'percent':
        return t('dis.progress.percent.label');
    }
  };
  const amount = (field: Exclude<ProgressField, 'percent'>) => (
    <div className="field" data-field={`volume-${field}`}>
      <label htmlFor={`volume-${field}`}>{labelOf(field)}</label>
      <MoneyInput id={`volume-${field}`} label={labelOf(field)} value={form[field]} disabled={!editable} invalid={error(field) !== undefined} onChange={(value) => set(field, value)} />
      {error(field) === undefined ? null : (
        <small role="alert" className="field-error" id={`volume-${field}-error`}>
          {error(field)}
        </small>
      )}
    </div>
  );
  const summary: SummaryItem[] = [];
  for (const field of [...AMOUNT_FIELDS, 'percent'] as const) {
    const message = error(field);
    if (message !== undefined) summary.push({ target: `volume-${field}`, message: `${labelOf(field)}: ${message}` });
  }
  const back = (
    <Link className="ui-button ui-button--outline" to={REPORTS_PATH}>
      {t('dis.wr.back.action')}
    </Link>
  );
  const next = (
    <Link className="ui-button ui-button--outline" to={`${EDIT_PATH}?report=${detail.id}`}>
      {t('dis.wr.progress.next.action')}
    </Link>
  );

  return (
    <form onSubmit={onSave} noValidate className="dis-wr-stack" aria-label={t('dis.progress.page.title')}>
      <StatusStrip detail={detail} />
      <ErrorSummary items={summary} attempt={attempt} />
      {editable ? null : (
        <p className="callout" role="status" data-testid="readonly-note">
          {detail.status === 'DRAFT' ? t('dis.progress.denied.note') : t('dis.progress.readonly.note')}
        </p>
      )}
      {described === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {reportProblemMessage(t, described.problem)}
        </p>
      )}
      <SectionCard title={t('dis.wr.section.info')}>
        <ReportFacts detail={detail} />
      </SectionCard>
      <SectionCard title={t('dis.wr.section.volumes')} unit={t('dis.wr.unit')}>
        <div className="dis-wr-stack">
          <div className="dis-wr-stats">
            <ReadonlyStat label={t('dis.wr.stat.asOf')} value={detail.period.endDate} sub={t('dis.wr.stat.asOf.sub')} />
            <ReadonlyStat label={t('dis.wr.stat.cumulativeFunds')} value={formatVnd(detail.totals.cumulativeVnd)} sub={t('dis.wr.stat.cumulativeFunds.sub')} tone="info" />
          </div>
          <p className="sub" data-testid="progress-note">
            {t('dis.progress.note')} {t('dis.progress.asOf.text', { date: detail.period.endDate })}
          </p>
          <div className="dis-wr-grid">
            {amount('construction')}
            {amount('acceptance')}
            {amount('treasury')}
            {amount('preparing')}
            <Field id="volume-percent" label={t('dis.progress.percent.label')} error={error('percent')} hint={t('dis.progress.percent.help')}>
              <input id="volume-percent" inputMode="decimal" autoComplete="off" className="num" disabled={!editable} value={form.percent} onChange={(event) => set('percent', event.target.value)} />
            </Field>
            <Field id="volume-basis" label={t('dis.reportEdit.basis.label')} error={undefined} hint={t('dis.reportEdit.basis.help')}>
              <select id="volume-basis" value={form.basis} disabled={!editable} onChange={(event) => setForm({ ...form, basis: event.target.value as Basis })}>
                {BASES.map((item) => (
                  <option key={item} value={item}>
                    {basisLabel(t, item)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {form.basis === 'YTD' ? (
            <p className="callout" role="note" data-testid="basis-pending">
              {t('dis.progress.basis.pending')}
            </p>
          ) : null}
        </div>
      </SectionCard>
      <AuditLine items={[{ label: t('dis.wr.audit.revision'), value: t('dis.reportEdit.revision.value', { revision: detail.revision }) }, ...(detail.updatedAt === null ? [] : [{ label: t('dis.wr.audit.updated'), value: dueMoment(detail.updatedAt) }])]} />
      {editable ? (
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={save.isPending}>
              {save.isPending ? t('dis.progress.save.pending') : t('dis.progress.save.action')}
            </button>
          }
          secondary={[back, next]}
        />
      ) : (
        <StickyActions primary={back} />
      )}
    </form>
  );
}
