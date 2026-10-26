import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { Field } from '../components';
import '../dis.css';
import { MoneyInput, ReportFacts } from './components';
import { useSaveDraft } from './hooks';
import { basisLabel, reportProblemMessage, volumeProblemMessage } from './labels';
import { BASES, SAVED_PATH, canEdit, describeReport } from './model';
import type { Basis, ReportDetail } from './model';
import { StepFrame } from './StepFrame';
import { progressBody, progressFormOf, validateProgress } from './step-model';
import type { ProgressField, ProgressForm } from './step-model';

/**
 * DIS-03: the volumes of the period (ST-DIS-004, DIS 3 F1 step 3): what was built, accepted, sent to the Treasury and is being prepared, in whole dong, the physical progress in percent, and the basis
 * the cumulative figures are read on. The basis defaults to the year to date, which is marked as awaiting the sign-off of the capital owner (D03, CXN-03). The figures are as of the last day of
 * the period, and are cumulative at that time, never added across weeks.
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

function Editor({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode } = useSession();
  const save = useSaveDraft();
  const [form, setForm] = useState<ProgressForm>(() => progressFormOf(detail));
  const [submitted, setSubmitted] = useState(false);
  const editable = canEdit(permissions, mode, detail.status);
  const problems = validateProgress(form);
  const described = save.isError ? describeReport(save.error) : undefined;

  const set = (field: ProgressField, value: string): void => setForm({ ...form, [field]: value });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!editable || save.isPending || Object.keys(problems).length > 0) return;
    save.mutate({ detail, body: progressBody(detail, form) }, { onSuccess: () => void navigate(`${SAVED_PATH}?report=${detail.id}`) });
  };
  const error = (field: ProgressField): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? volumeProblemMessage(t, problem) : undefined;
  };
  const amount = (field: Exclude<ProgressField, 'percent'>, label: string) => (
    <div className="field" data-field={`volume-${field}`}>
      <label htmlFor={`volume-${field}`}>{label}</label>
      <MoneyInput id={`volume-${field}`} label={label} value={form[field]} disabled={!editable} invalid={error(field) !== undefined} onChange={(value) => set(field, value)} />
      {error(field) === undefined ? null : (
        <small role="alert" className="field-error" id={`volume-${field}-error`}>
          {error(field)}
        </small>
      )}
    </div>
  );

  return (
    <form className="card" onSubmit={submit} noValidate>
      <ReportFacts detail={detail} />
      <p className="sub" data-testid="progress-note">
        {t('dis.progress.note')} {t('dis.progress.asOf.text', { date: detail.period.endDate })}
      </p>
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
      {amount('construction', t('dis.progress.construction.label'))}
      {amount('acceptance', t('dis.progress.acceptance.label'))}
      {amount('treasury', t('dis.progress.treasury.label'))}
      {amount('preparing', t('dis.progress.preparing.label'))}
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
      {form.basis === 'YTD' ? (
        <p className="callout" role="note" data-testid="basis-pending">
          {t('dis.progress.basis.pending')}
        </p>
      ) : null}
      {editable ? (
        <div className="formfooter">
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? t('dis.progress.save.pending') : t('dis.progress.save.action')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
