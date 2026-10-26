import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, Field } from '../components';
import '../dis.css';
import { MoneyInput } from './components';
import { useReport, useSaveReport } from './hooks';
import { basisLabel, cellLabel, cellProblemMessage, formProblemMessage, reportProblemMessage, reportStatusLabel } from './labels';
import { BASES, CELLS, REPORTS_PATH, SAVED_PATH, canEdit, cellId, deltaOf, describeReport, fieldId, formOf, hasFall, hasProblems, takesCtmtqg, totalsOf, validateFunding } from './model';
import type { Basis, CellKey, FundingForm, ReportDetail } from './model';
import { formatVnd } from './money';

/**
 * DIS-04: the entry of the cumulative disbursement in the six cells of the form (the year plan, the carried-over plan and every other source, each by the central and the local budget), with the
 * CTMTQG inside the first two shown on a row of its own and never added to the total (BR-DIS-01). Each cell shows what the plan allocated to it and what the period before had reached, and the
 * change since; a cell that fell has to be explained when the report is handed in (BR-DIS-03). A report that was handed in is read here and not edited (ST-DIS-003, DIS 3 F1).
 */
export default function ReportEditScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <ReportEditContent key={tenantId ?? 'none'} route={route} />;
}

function ReportEditContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const reportId = params.get('report') ?? undefined;
  const report = useReport(reportId);
  const missing = report.error instanceof ApiError && report.error.status === 404;
  const loaded = useScreenState({ isLoading: report.isLoading, error: missing ? undefined : report.error, data: report.data, isEmpty: (data) => data === undefined });
  // A report that is not found is told as empty: whoever asked cannot tell one of another scope from one that is not there. With none chosen there is nothing to load.
  const state: ScreenState = reportId === undefined ? 'default' : missing ? 'empty' : loaded;
  const detail = report.data;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={REPORTS_PATH}>{t('dis.reportEdit.back.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.reportEdit.page.title')}</h1>
          <p>{t('dis.reportEdit.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void report.refetch()}>
        {detail === undefined ? (
          <p className="muted" data-testid="report-choose">
            {t('dis.reportEdit.choose.text')}
          </p>
        ) : (
          // The entries belong to one version of the report: a save or a reload starts the form over from what the server holds.
          <Editor key={`${detail.id}:${detail.version}`} detail={detail} />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.reportEdit.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Editor({ detail }: { detail: ReportDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode } = useSession();
  const save = useSaveReport();
  const [form, setForm] = useState<FundingForm>(() => formOf(detail));
  const [submitted, setSubmitted] = useState(false);
  const editable = canEdit(permissions, mode, detail.status);
  const problems = validateFunding(form);
  const totals = totalsOf(form);
  const fell = hasFall(detail, form);
  const described = save.isError ? describeReport(save.error) : undefined;

  const setCell = (key: CellKey, field: 'cumulative' | 'ctmtqg', value: string): void => {
    const entry = form.cells[cellId(key)] ?? { cumulative: '', ctmtqg: '' };
    setForm({ ...form, cells: { ...form.cells, [cellId(key)]: { ...entry, [field]: value } } });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!editable || save.isPending || hasProblems(problems)) return;
    save.mutate({ detail, form }, { onSuccess: () => void navigate(`${SAVED_PATH}?report=${detail.id}`) });
  };
  const cellError = (key: CellKey, field: 'cumulative' | 'ctmtqg'): string | undefined => {
    const problem = problems.cells[fieldId(key, field)];
    if (submitted && problem !== undefined) return cellProblemMessage(t, problem);
    return described?.field === fieldId(key, field) ? reportProblemMessage(t, described.problem) : undefined;
  };

  return (
    <form className="card" onSubmit={submit} noValidate>
      <dl className="aud-facts" data-testid="report-facts">
        <dt>{t('dis.reportEdit.project.label')}</dt>
        <dd data-testid="fact-project">{`${detail.project.code} · ${detail.project.name}`}</dd>
        <dt>{t('dis.reportEdit.period.label')}</dt>
        <dd data-testid="fact-period">{t('dis.reportEdit.period.value', { code: detail.period.code, start: detail.period.startDate, end: detail.period.endDate })}</dd>
        <dt>{t('dis.reportEdit.plan.label')}</dt>
        <dd data-testid="fact-plan">{t('dis.reportEdit.plan.value', { year: detail.planVersion.fiscalYear, revision: detail.planVersion.revision })}</dd>
        <dt>{t('dis.reportEdit.status.label')}</dt>
        <dd>
          <span className="pill gray" data-testid="fact-status">
            {reportStatusLabel(t, detail.status)}
          </span>{' '}
          {t('dis.reportEdit.revision.value', { revision: detail.revision })}
        </dd>
      </dl>
      {editable ? null : (
        <p className="callout" role="status" data-testid="readonly-note">
          {detail.status === 'DRAFT' ? t('dis.reportEdit.denied.note') : t('dis.reportEdit.readonly.note')}
        </p>
      )}
      {described === undefined || described.field !== undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {reportProblemMessage(t, described.problem)}
        </p>
      )}
      <Field id="report-basis" label={t('dis.reportEdit.basis.label')} error={undefined} hint={t('dis.reportEdit.basis.help')}>
        <select id="report-basis" value={form.basis} disabled={!editable} onChange={(event) => setForm({ ...form, basis: event.target.value as Basis })}>
          {BASES.map((item) => (
            <option key={item} value={item}>
              {basisLabel(t, item)}
            </option>
          ))}
        </select>
      </Field>
      <div className="tablewrap">
        <table className="table dis-matrix" aria-label={t('dis.reportEdit.matrix.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('dis.reportEdit.col.source')}</th>
              <th scope="col" className="num">
                {t('dis.reportEdit.col.allocated')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportEdit.col.previous')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportEdit.col.cumulative')}
              </th>
              <th scope="col" className="num">
                {t('dis.reportEdit.col.change')}
              </th>
            </tr>
          </thead>
          <tbody>
            {CELLS.map((key) => {
              const cell = detail.cells.find((entry) => entry.bucket === key.bucket && entry.level === key.level);
              const entry = form.cells[cellId(key)] ?? { cumulative: '', ctmtqg: '' };
              const delta = deltaOf(cell?.previousCumulativeVnd ?? null, entry.cumulative);
              const label = cellLabel(t, key);
              return [
                <tr key={cellId(key)} data-cell={cellId(key)}>
                  <th scope="row">{label}</th>
                  <td className="num" data-testid={`allocated-${cellId(key)}`}>
                    {formatVnd(cell?.allocatedVnd ?? '0')}
                  </td>
                  <td className="num" data-testid={`previous-${cellId(key)}`}>
                    {cell?.previousCumulativeVnd == null ? t('dis.reportEdit.none.text') : formatVnd(cell.previousCumulativeVnd)}
                  </td>
                  <td className="num">
                    <MoneyInput id={`cell-${cellId(key)}`} label={t('dis.reportEdit.cell.aria', { cell: label })} value={entry.cumulative} disabled={!editable} invalid={cellError(key, 'cumulative') !== undefined} onChange={(value) => setCell(key, 'cumulative', value)} />
                    <CellError id={`cell-${cellId(key)}`} message={cellError(key, 'cumulative')} />
                  </td>
                  <td className={delta !== null && delta.startsWith('-') ? 'num dis-fall' : 'num'} data-testid={`delta-${cellId(key)}`}>
                    {delta === null ? t('dis.reportEdit.none.text') : formatVnd(delta)}
                  </td>
                </tr>,
                takesCtmtqg(key.bucket) ? (
                  <tr key={`${cellId(key)}-ctmtqg`} className="dis-subrow" data-cell={`${cellId(key)}:ctmtqg`}>
                    <th scope="row">{t('dis.reportEdit.ctmtqg.label')}</th>
                    <td colSpan={2} className="sub">
                      {t('dis.reportEdit.ctmtqg.note')}
                    </td>
                    <td className="num">
                      <MoneyInput
                        id={`ctmtqg-${cellId(key)}`}
                        label={t('dis.reportEdit.ctmtqg.aria', { cell: label })}
                        value={entry.ctmtqg}
                        disabled={!editable}
                        invalid={cellError(key, 'ctmtqg') !== undefined}
                        onChange={(value) => setCell(key, 'ctmtqg', value)}
                      />
                      <CellError id={`ctmtqg-${cellId(key)}`} message={cellError(key, 'ctmtqg')} />
                    </td>
                    <td />
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('dis.reportEdit.total.label')}</th>
              <td className="num" data-testid="total-allocated">
                {formatVnd(detail.totals.allocatedVnd)}
              </td>
              <td />
              <td className="num" data-testid="total-cumulative">
                {formatVnd(totals.cumulativeVnd)}
              </td>
              <td />
            </tr>
            <tr className="dis-subrow">
              <th scope="row">{t('dis.reportEdit.ctmtqgTotal.label')}</th>
              <td colSpan={2} className="sub">
                {t('dis.reportEdit.ctmtqg.note')}
              </td>
              <td className="num" data-testid="total-ctmtqg">
                {formatVnd(totals.ctmtqgVnd)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {fell || form.explanation !== '' ? (
        <>
          {fell ? (
            <p className="callout warning" role="status" data-testid="fall-note">
              {t('dis.reportEdit.fall.note')}
            </p>
          ) : null}
          <Field
            id="report-explanation"
            label={t('dis.reportEdit.explanation.label')}
            error={submitted && problems.explanation !== undefined ? formProblemMessage(t, problems.explanation) : undefined}
            hint={t('dis.reportEdit.explanation.help')}
          >
            <textarea id="report-explanation" rows={3} value={form.explanation} disabled={!editable} onChange={(event) => setForm({ ...form, explanation: event.target.value })} />
          </Field>
        </>
      ) : null}
      {editable ? (
        <div className="formfooter">
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? t('dis.reportEdit.save.pending') : t('dis.reportEdit.save.action')}
          </button>
        </div>
      ) : null}
    </form>
  );
}

function CellError({ id, message }: { id: string; message: string | undefined }) {
  return message === undefined ? null : (
    <small role="alert" className="field-error" id={`${id}-error`}>
      {message}
    </small>
  );
}
