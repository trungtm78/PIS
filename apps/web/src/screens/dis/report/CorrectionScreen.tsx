import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { Field } from '../components';
import '../dis.css';
import { ReportFacts, MoneyInput } from './components';
import { DETAIL_PATH, canCorrect, correctionBody, validateReason } from './decision-model';
import type { ReasonProblem } from './decision-model';
import { useCorrect } from './hooks';
import { cellLabel, cellProblemMessage, formProblemMessage, reportProblemMessage } from './labels';
import { CELLS, EDIT_PATH, cellId, deltaOf, describeReport, fieldId, formOf, hasFall, hasProblems, resourceIdOf, takesCtmtqg, totalsOf, validateFunding } from './model';
import type { FundingForm, ReportDetail } from './model';
import { formatVnd } from './money';
import { StepFrame } from './StepFrame';
import type { Translator } from '../../../i18n';

type T = Translator['t'];

function reasonMessage(t: T, problem: ReasonProblem): string {
  switch (problem) {
    case 'required':
      return t('dis.reportCorrection.reason.required.error');
    case 'tooShort':
      return t('dis.reportCorrection.reason.tooShort.error');
    case 'tooLong':
      return t('dis.reportCorrection.reason.tooLong.error');
  }
}

/**
 * DIS-08: the correction of a report (ST-DIS-006, DIS 3 F2): the figures of the revision that is corrected beside the figures of the new one, and the reason, which is required. What was handed in is
 * never edited: the correction is a new revision, a draft that the maker then edits and hands in like any other, and the revision it corrects keeps what it said.
 */
export default function CorrectionScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  return (
    <StepFrame
      key={tenantId ?? 'none'}
      route={route}
      texts={{
        back: t('dis.reportCorrection.back.link'),
        title: t('dis.reportCorrection.page.title'),
        subtitle: t('dis.reportCorrection.page.subtitle'),
        choose: t('dis.reportCorrection.choose.text'),
        footer: t('dis.reportCorrection.footer.reference', { id: route.id, req: route.req ?? '' }),
      }}
    >
      {(detail) => <Correction key={detail.id} detail={detail} />}
    </StepFrame>
  );
}

function Correction({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const navigate = useNavigate();
  const correct = useCorrect();
  const [reason, setReason] = useState('');
  const [form, setForm] = useState<FundingForm>(() => formOf(detail));
  const [submitted, setSubmitted] = useState(false);
  const allowed = canCorrect(permissions, mode, detail.status);
  const problems = validateFunding(form);
  const reasonProblem = validateReason(reason);
  const fall = hasFall(detail, form);
  const refusal = correct.isError ? describeReport(correct.error) : undefined;
  const totals = totalsOf(form);

  if (!allowed) {
    return (
      <div className="card">
        <ReportFacts detail={detail} />
        <p className="callout warning" role="status" data-testid="correction-not-allowed">
          {t('dis.reportCorrection.notAllowed.text')}
        </p>
        <p>
          <Link to={`${DETAIL_PATH}?report=${detail.id}`}>{t('dis.reportCorrection.detail.link')}</Link>
        </p>
      </div>
    );
  }

  const setCell = (id: string, field: 'cumulative' | 'ctmtqg', value: string): void => setForm({ ...form, cells: { ...form.cells, [id]: { ...(form.cells[id] ?? { cumulative: '', ctmtqg: '' }), [field]: value } } });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (correct.isPending || reasonProblem !== undefined || hasProblems(problems)) return;
    correct.mutate(
      { detail, body: correctionBody(detail, { reason, funding: form }) },
      {
        onSuccess: (done) => {
          const made = resourceIdOf(done);
          if (made !== undefined) void navigate(`${EDIT_PATH}?report=${made}`);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="screen-title" data-testid="correction-form">
      <ReportFacts detail={detail} />
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="correction-refusal">
          {reportProblemMessage(t, refusal.problem)}{' '}
          {refusal.existingId === undefined ? null : <Link to={`${EDIT_PATH}?report=${refusal.existingId}`}>{t('dis.reportCorrection.pending.link')}</Link>}
        </p>
      )}
      <Field id="correction-reason" label={t('dis.reportCorrection.reason.label')} hint={t('dis.reportCorrection.reason.hint')} error={submitted && reasonProblem !== undefined ? reasonMessage(t, reasonProblem) : undefined}>
        <textarea id="correction-reason" rows={3} value={reason} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)} />
      </Field>
      <div className="tablewrap">
        <table className="table dis-matrix" aria-label={t('dis.reportCorrection.cells.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('dis.reportCorrection.cells.col.source')}</th>
              <th scope="col" className="num">
                {t('dis.reportCorrection.cells.col.previous')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportCorrection.cells.col.new')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportCorrection.cells.col.ctmtqg')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportCorrection.cells.col.change')}
              </th>
            </tr>
          </thead>
          <tbody>
            {CELLS.map((key) => {
              const id = cellId(key);
              const kept = detail.cells.find((cell) => cell.bucket === key.bucket && cell.level === key.level);
              const entry = form.cells[id] ?? { cumulative: '', ctmtqg: '' };
              const cumulativeProblem = problems.cells[fieldId(key, 'cumulative')];
              const ctmtqgProblem = problems.cells[fieldId(key, 'ctmtqg')];
              const change = deltaOf(kept?.previousCumulativeVnd ?? null, entry.cumulative);
              return (
                <tr key={id}>
                  <th scope="row">{cellLabel(t, key)}</th>
                  <td className="num" data-testid={`previous-${id}`}>
                    {formatVnd(kept?.cumulativeVnd ?? '0')}
                  </td>
                  <td className="num">
                    <MoneyInput id={fieldId(key, 'cumulative')} label={t('dis.reportCorrection.cells.cumulative.label', { cell: cellLabel(t, key) })} value={entry.cumulative} invalid={submitted && cumulativeProblem !== undefined} onChange={(value) => setCell(id, 'cumulative', value)} />
                    {submitted && cumulativeProblem !== undefined ? (
                      <small role="alert" className="field-error" id={`${fieldId(key, 'cumulative')}-error`}>
                        {cellProblemMessage(t, cumulativeProblem)}
                      </small>
                    ) : null}
                  </td>
                  <td className="num">
                    {takesCtmtqg(key.bucket) ? (
                      <MoneyInput id={fieldId(key, 'ctmtqg')} label={t('dis.reportCorrection.cells.ctmtqg.label', { cell: cellLabel(t, key) })} value={entry.ctmtqg} invalid={submitted && ctmtqgProblem !== undefined} onChange={(value) => setCell(id, 'ctmtqg', value)} />
                    ) : (
                      t('dis.reportEdit.none.text')
                    )}
                    {submitted && ctmtqgProblem !== undefined ? (
                      <small role="alert" className="field-error" id={`${fieldId(key, 'ctmtqg')}-error`}>
                        {cellProblemMessage(t, ctmtqgProblem)}
                      </small>
                    ) : null}
                  </td>
                  <td className={change?.startsWith('-') === true ? 'num dis-fall' : 'num'} data-testid={`change-${id}`}>
                    {change === null ? t('dis.reportEdit.none.text') : formatVnd(change)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('dis.reportCorrection.cells.total.label')}</th>
              <td className="num" data-testid="previous-total">
                {formatVnd(detail.totals.cumulativeVnd)}
              </td>
              <td className="num" data-testid="new-total">
                {formatVnd(totals.cumulativeVnd)}
              </td>
              <td className="num">{formatVnd(totals.ctmtqgVnd)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {fall ? (
        <Field id="correction-explanation" label={t('dis.reportCorrection.explanation.label')} hint={t('dis.reportCorrection.explanation.hint')} error={submitted && problems.explanation !== undefined ? formProblemMessage(t, problems.explanation) : undefined}>
          <textarea id="correction-explanation" rows={3} value={form.explanation} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, explanation: event.target.value })} />
        </Field>
      ) : null}
      <div className="formfooter">
        <button type="submit" disabled={correct.isPending}>
          {correct.isPending ? t('dis.reportCorrection.submit.pending') : t('dis.reportCorrection.submit.action')}
        </button>
        <Link to={`${DETAIL_PATH}?report=${detail.id}`}>{t('dis.reportCorrection.cancel.action')}</Link>
      </div>
    </form>
  );
}
