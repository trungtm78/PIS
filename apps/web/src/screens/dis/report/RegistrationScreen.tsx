import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import '../dis.css';
import { MoneyInput, ReportFacts } from './components';
import { useSaveDraft } from './hooks';
import { cellLabel, cellProblemMessage, reportProblemMessage } from './labels';
import { CELLS, SAVED_PATH, canEdit, cellId, describeReport, takesCtmtqg } from './model';
import type { CellKey, ReportDetail } from './model';
import { formatVnd } from './money';
import { StepFrame } from './StepFrame';
import { nextMonthOf, registrationBody, registrationFieldId, registrationFormOf, registrationTotals, remainingOf, validateRegistration } from './step-model';
import type { RegistrationForm } from './step-model';

/**
 * DIS-05: the registration for next month (ST-DIS-004, DIS 3 F1 step 5): what the project expects to disburse next month in each of the six cells, with the CTMTQG inside the year plan and the
 * carried-over plan on a row of its own and never added to the total. Each cell shows what the plan allocated, what was disbursed so far and what is left.
 */
export default function RegistrationScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  return (
    <StepFrame
      key={tenantId ?? 'none'}
      route={route}
      current="registration"
      texts={{
        back: t('dis.registration.back.link'),
        title: t('dis.registration.page.title'),
        subtitle: t('dis.registration.page.subtitle'),
        choose: t('dis.registration.choose.text'),
        footer: t('dis.registration.footer.reference', { id: route.id, req: route.req ?? '' }),
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
  const [form, setForm] = useState<RegistrationForm>(() => registrationFormOf(detail));
  const [submitted, setSubmitted] = useState(false);
  const editable = canEdit(permissions, mode, detail.status);
  const problems = validateRegistration(form);
  const totals = registrationTotals(form);
  const described = save.isError ? describeReport(save.error) : undefined;
  const month = nextMonthOf(detail.period.endDate);

  const setEntry = (key: CellKey, field: 'nextMonth' | 'ctmtqg', value: string): void => {
    const entry = form.cells[cellId(key)] ?? { nextMonth: '', ctmtqg: '' };
    setForm({ cells: { ...form.cells, [cellId(key)]: { ...entry, [field]: value } } });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!editable || save.isPending || Object.keys(problems).length > 0) return;
    save.mutate({ detail, body: registrationBody(detail, form) }, { onSuccess: () => void navigate(`${SAVED_PATH}?report=${detail.id}`) });
  };
  const error = (key: CellKey, field: 'nextMonth' | 'ctmtqg'): string | undefined => {
    const problem = problems[registrationFieldId(key, field)];
    if (submitted && problem !== undefined) return cellProblemMessage(t, problem);
    return described?.field === `${cellId(key)}.${field === 'nextMonth' ? 'nextMonth' : 'nextCtmtqg'}` ? reportProblemMessage(t, described.problem) : undefined;
  };

  return (
    <form className="card" onSubmit={submit} noValidate>
      <ReportFacts detail={detail} />
      {month === undefined ? null : (
        <p className="sub" data-testid="registration-month">
          {t('dis.registration.month.text', { month: month.month, year: month.year })}
        </p>
      )}
      {editable ? null : (
        <p className="callout" role="status" data-testid="readonly-note">
          {detail.status === 'DRAFT' ? t('dis.registration.denied.note') : t('dis.registration.readonly.note')}
        </p>
      )}
      {described === undefined || described.field !== undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {reportProblemMessage(t, described.problem)}
        </p>
      )}
      <div className="tablewrap">
        <table className="table dis-matrix" aria-label={t('dis.registration.matrix.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('dis.registration.col.source')}</th>
              <th scope="col" className="num">
                {t('dis.registration.col.allocated')}
              </th>
              <th scope="col" className="num">
                {t('dis.registration.col.reached')}
              </th>
              <th scope="col" className="num">
                {t('dis.registration.col.remaining')}
              </th>
              <th scope="col" className="num">
                {t('dis.registration.col.registered')}
              </th>
            </tr>
          </thead>
          <tbody>
            {CELLS.map((key) => {
              const cell = detail.cells.find((entry) => entry.bucket === key.bucket && entry.level === key.level);
              const entry = form.cells[cellId(key)] ?? { nextMonth: '', ctmtqg: '' };
              const label = cellLabel(t, key);
              const nextError = error(key, 'nextMonth');
              const subsetError = error(key, 'ctmtqg');
              return [
                <tr key={cellId(key)} data-cell={cellId(key)}>
                  <th scope="row">{label}</th>
                  <td className="num" data-testid={`allocated-${cellId(key)}`}>
                    {formatVnd(cell?.allocatedVnd ?? '0')}
                  </td>
                  <td className="num" data-testid={`reached-${cellId(key)}`}>
                    {formatVnd(cell?.cumulativeVnd ?? '0')}
                  </td>
                  <td className="num" data-testid={`remaining-${cellId(key)}`}>
                    {formatVnd(remainingOf(cell?.allocatedVnd ?? '0', cell?.cumulativeVnd ?? '0'))}
                  </td>
                  <td className="num">
                    <MoneyInput id={`next-${cellId(key)}`} label={t('dis.registration.cell.aria', { cell: label })} value={entry.nextMonth} disabled={!editable} invalid={nextError !== undefined} onChange={(value) => setEntry(key, 'nextMonth', value)} />
                    {nextError === undefined ? null : (
                      <small role="alert" className="field-error" id={`next-${cellId(key)}-error`}>
                        {nextError}
                      </small>
                    )}
                  </td>
                </tr>,
                takesCtmtqg(key.bucket) ? (
                  <tr key={`${cellId(key)}-ctmtqg`} className="dis-subrow" data-cell={`${cellId(key)}:ctmtqg`}>
                    <th scope="row">{t('dis.registration.ctmtqg.label')}</th>
                    <td colSpan={3} className="sub">
                      {t('dis.registration.ctmtqg.note')}
                    </td>
                    <td className="num">
                      <MoneyInput id={`next-ctmtqg-${cellId(key)}`} label={t('dis.registration.ctmtqg.aria', { cell: label })} value={entry.ctmtqg} disabled={!editable} invalid={subsetError !== undefined} onChange={(value) => setEntry(key, 'ctmtqg', value)} />
                      {subsetError === undefined ? null : (
                        <small role="alert" className="field-error" id={`next-ctmtqg-${cellId(key)}-error`}>
                          {subsetError}
                        </small>
                      )}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('dis.registration.total.label')}</th>
              <td className="num" data-testid="total-allocated">
                {formatVnd(detail.totals.allocatedVnd)}
              </td>
              <td className="num" data-testid="total-reached">
                {formatVnd(detail.totals.cumulativeVnd)}
              </td>
              <td className="num" data-testid="total-remaining">
                {formatVnd(remainingOf(detail.totals.allocatedVnd, detail.totals.cumulativeVnd))}
              </td>
              <td className="num" data-testid="total-registered">
                {formatVnd(totals.nextMonthVnd)}
              </td>
            </tr>
            <tr className="dis-subrow">
              <th scope="row">{t('dis.registration.ctmtqgTotal.label')}</th>
              <td colSpan={3} className="sub">
                {t('dis.registration.ctmtqg.note')}
              </td>
              <td className="num" data-testid="total-registered-ctmtqg">
                {formatVnd(totals.ctmtqgVnd)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {editable ? (
        <div className="formfooter">
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? t('dis.registration.save.pending') : t('dis.registration.save.action')}
          </button>
        </div>
      ) : null}
    </form>
  );
}
