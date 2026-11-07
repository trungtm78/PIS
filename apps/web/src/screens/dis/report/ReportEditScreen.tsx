import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { AuditLine, ConfirmDialog, FundMatrix, ReadonlyStat, SectionCard, StickyActions } from '../../../ui';
import type { FundGroup } from '../../../ui';
import { BackLink, Field } from '../components';
import '../dis.css';
import { ErrorSummary, ReceiptCard, StatusStrip, useDeadlineOf } from './entry-parts';
import type { SummaryItem } from './entry-parts';
import { MoneyInput, ReportFacts, StepNav } from './components';
import { useReport, useSaveReport, useSubmitReport } from './hooks';
import { basisLabel, cellLabel, cellProblemMessage, formProblemMessage, reportProblemMessage } from './labels';
import { BASES, CELLS, REPORTS_PATH, SAVED_PATH, canEdit, cellId, deltaOf, describeReport, fieldId, formOf, hasFall, hasProblems, takesCtmtqg, totalsOf, validateFunding } from './model';
import type { Basis, Bucket, CellKey, FundingForm, ReportDetail } from './model';
import { formatVnd, digitsOf } from './money';
import { remainingOf } from './step-model';
import { canSubmit, dueMoment, markedCells, ratioOf, receiptOf } from './weekly-model';
import type { Receipt } from './weekly-model';

/**
 * DIS-04: the entry of the cumulative disbursement in the six cells of the form (the year plan, the carried-over plan and every other source, each by the central and the local budget), with the
 * CTMTQG inside the first two shown in a block of its own and never added to the total (BR-DIS-01). Each cell shows what the plan allocated to it and what the period before had reached, and the
 * change since; a cell that fell has to be explained when the report is handed in (BR-DIS-03). On top, a strip says the state of the report, its deadline and what is to be done first; the errors are
 * told in the field and gathered at the top. The report is handed in from here after a confirmation that names the period and the total, and a receipt follows. A report that was handed in is read
 * here and not edited (ST-DIS-003, DIS 3 F1).
 */
export default function ReportEditScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <ReportEditContent key={tenantId ?? 'none'} route={route} />;
}

/** The version a command answered with, when it says one. */
const versionOf = (answer: unknown): number | undefined => {
  const version = typeof answer === 'object' && answer !== null ? (answer as { resource_version?: unknown }).resource_version : undefined;
  return typeof version === 'number' ? version : undefined;
};

function ReportEditContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const reportId = params.get('report') ?? undefined;
  const report = useReport(reportId);
  const save = useSaveReport();
  const submit = useSubmitReport();
  const [confirming, setConfirming] = useState<FundingForm | undefined>(undefined);
  const [sent, setSent] = useState<{ receipt: Receipt | undefined } | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const missing = report.error instanceof ApiError && report.error.status === 404;
  const loaded = useScreenState({ isLoading: report.isLoading, error: missing ? undefined : report.error, data: report.data, isEmpty: (data) => data === undefined });
  // A report that is not found is told as empty: whoever asked cannot tell one of another scope from one that is not there. With none chosen there is nothing to load.
  const state: ScreenState = reportId === undefined ? 'default' : missing ? 'empty' : loaded;
  const detail = report.data;
  const dueAt = useDeadlineOf(detail?.period.id ?? '');
  const sending = save.isPending || submit.isPending;

  // The report is saved and then handed in under the version the save answered with; the dialog and the receipt live here because the form starts over from the server at every save.
  const send = async (form: FundingForm): Promise<void> => {
    if (detail === undefined) return;
    setFailure(undefined);
    try {
      const saved = await save.mutateAsync({ detail, form });
      const done = await submit.mutateAsync({ detail: { ...detail, version: versionOf(saved) ?? detail.version } });
      setSent({ receipt: receiptOf(done) });
    } catch (error) {
      setFailure(error);
    } finally {
      setConfirming(undefined);
    }
  };
  const refused = failure === undefined ? undefined : describeReport(failure);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={REPORTS_PATH}>{t('dis.reportEdit.back.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.reportEdit.page.title')}</h1>
          <p>{t('dis.reportEdit.page.subtitle')}</p>
        </div>
      </div>
      {detail === undefined ? null : <StepNav reportId={detail.id} current="cells" />}
      <StateBoundary state={state} onRetry={() => void report.refetch()}>
        {detail === undefined ? (
          <p className="muted" data-testid="report-choose">
            {t('dis.reportEdit.choose.text')}
          </p>
        ) : sent !== undefined ? (
          <ReceiptCard detail={detail} receipt={sent.receipt} />
        ) : (
          <>
            {refused === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="send-refusal">
                {reportProblemMessage(t, refused.problem)}
              </p>
            )}
            {/* The entries belong to one version of the report: a save or a reload starts the form over from what the server holds. */}
            <Editor key={`${detail.id}:${detail.version}`} detail={detail} sending={sending} onAskSend={setConfirming} />
          </>
        )}
      </StateBoundary>
      {detail === undefined || confirming === undefined ? null : (
        <ConfirmDialog
          open
          title={t('dis.wr.send.title')}
          context={[
            { label: t('dis.wr.send.project'), value: `${detail.project.code} · ${detail.project.name}` },
            { label: t('dis.wr.send.period'), value: t('dis.reportEdit.period.value', { code: detail.period.code, start: detail.period.startDate, end: detail.period.endDate }) },
            { label: t('dis.wr.send.total'), value: t('dis.wr.send.total.value', { amount: formatVnd(totalsOf(confirming).cumulativeVnd) }) },
            { label: t('dis.wr.send.ctmtqg'), value: t('dis.wr.send.total.value', { amount: formatVnd(totalsOf(confirming).ctmtqgVnd) }) },
            ...(dueAt === undefined ? [] : [{ label: t('dis.wr.send.deadline'), value: dueMoment(dueAt) }]),
          ]}
          confirmLabel={t('dis.wr.send.confirm')}
          cancelLabel={t('dis.wr.send.cancel')}
          pending={sending}
          onConfirm={() => void send(confirming)}
          onCancel={() => setConfirming(undefined)}
        />
      )}
      <p className="prototype-note">{t('dis.reportEdit.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const BUCKET_TITLE: Record<Bucket, string> = { CURRENT_YEAR: 'dis.wr.bucket.year', CARRYOVER: 'dis.wr.bucket.carryover', OTHER: 'dis.wr.bucket.other' };

function Editor({ detail, sending, onAskSend }: { detail: ReportDetail; sending: boolean; onAskSend: (form: FundingForm) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode } = useSession();
  const save = useSaveReport();
  const [form, setForm] = useState<FundingForm>(() => formOf(detail));
  const [attempt, setAttempt] = useState(0);
  const submitted = attempt > 0;
  const editable = canEdit(permissions, mode, detail.status);
  const sendable = canSubmit(permissions, mode, detail.status);
  const problems = validateFunding(form);
  const totals = totalsOf(form);
  const fell = hasFall(detail, form);
  const described = save.isError ? describeReport(save.error) : undefined;
  const marked = markedCells(detail);
  const busy = save.isPending || sending;

  const setCell = (key: CellKey, field: 'cumulative' | 'ctmtqg', value: string): void => {
    const entry = form.cells[cellId(key)] ?? { cumulative: '', ctmtqg: '' };
    setForm({ ...form, cells: { ...form.cells, [cellId(key)]: { ...entry, [field]: value } } });
  };
  const cellError = (key: CellKey, field: 'cumulative' | 'ctmtqg'): string | undefined => {
    const problem = problems.cells[fieldId(key, field)];
    if (submitted && problem !== undefined) return cellProblemMessage(t, problem);
    return described?.field === fieldId(key, field) ? reportProblemMessage(t, described.problem) : undefined;
  };
  const fieldOf = (key: CellKey, field: 'cumulative' | 'ctmtqg'): string => `${field === 'cumulative' ? 'cell' : 'ctmtqg'}-${cellId(key)}`;
  const summary: SummaryItem[] = [];
  for (const key of CELLS) {
    for (const field of ['cumulative', 'ctmtqg'] as const) {
      const message = cellError(key, field);
      if (message !== undefined) summary.push({ target: fieldOf(key, field), message: `${field === 'cumulative' ? cellLabel(t, key) : t('dis.reportEdit.ctmtqg.aria', { cell: cellLabel(t, key) })}: ${message}` });
    }
  }
  if (submitted && problems.explanation !== undefined) summary.push({ target: 'report-explanation', message: `${t('dis.reportEdit.explanation.label')}: ${formProblemMessage(t, problems.explanation)}` });

  const onSave = (event: FormEvent): void => {
    event.preventDefault();
    setAttempt(attempt + 1);
    if (!editable || busy || hasProblems(problems)) return;
    save.mutate({ detail, form }, { onSuccess: () => void navigate(`${SAVED_PATH}?report=${detail.id}`) });
  };
  const askSend = (): void => {
    setAttempt(attempt + 1);
    if (!sendable || busy || hasProblems(problems)) return;
    onAskSend(form);
  };

  const control = (key: CellKey, field: 'cumulative' | 'ctmtqg', label: string) => {
    const entry = form.cells[cellId(key)] ?? { cumulative: '', ctmtqg: '' };
    const message = cellError(key, field);
    const id = fieldOf(key, field);
    return (
      <>
        <MoneyInput id={id} label={label} value={field === 'cumulative' ? entry.cumulative : entry.ctmtqg} disabled={!editable} invalid={message !== undefined} onChange={(value) => setCell(key, field, value)} />
        {message === undefined ? null : (
          <small role="alert" className="field-error" id={`${id}-error`}>
            {message}
          </small>
        )}
      </>
    );
  };
  const cellControl = (key: CellKey) => {
    const cell = detail.cells.find((entry) => entry.bucket === key.bucket && entry.level === key.level);
    const entry = form.cells[cellId(key)] ?? { cumulative: '', ctmtqg: '' };
    const delta = deltaOf(cell?.previousCumulativeVnd ?? null, entry.cumulative);
    const label = cellLabel(t, key);
    return (
      <span className={marked.has(cellId(key)) ? 'dis-wr-cell dis-wr-cell--marked' : 'dis-wr-cell'} data-cell={cellId(key)}>
        {control(key, 'cumulative', t('dis.reportEdit.cell.aria', { cell: label }))}
        {marked.has(cellId(key)) ? <span className="dis-wr-mark">{t('dis.wr.mark.text')}</span> : null}
        <span className="dis-wr-hint">
          {t('dis.reportEdit.col.allocated')}: <span data-testid={`allocated-${cellId(key)}`}>{formatVnd(cell?.allocatedVnd ?? '0')}</span>
        </span>
        <span className="dis-wr-hint">
          {t('dis.reportEdit.col.previous')}: <span data-testid={`previous-${cellId(key)}`}>{cell?.previousCumulativeVnd == null ? t('dis.reportEdit.none.text') : formatVnd(cell.previousCumulativeVnd)}</span>
        </span>
        <span className="dis-wr-hint">
          {t('dis.reportEdit.col.change')}: <span data-testid={`delta-${cellId(key)}`} className={delta !== null && delta.startsWith('-') ? 'dis-fall dis-wr-fall' : undefined}>{delta === null ? t('dis.reportEdit.none.text') : formatVnd(delta)}</span>
        </span>
      </span>
    );
  };
  const groups: FundGroup[] = BUCKET_ORDER.map((bucket) => {
    const central: CellKey = { bucket, level: 'CENTRAL' };
    const local: CellKey = { bucket, level: 'LOCAL' };
    const sum = [central, local].reduce((total, key) => total + BigInt(digitsOf(form.cells[cellId(key)]?.cumulative ?? '') ?? '0'), 0n);
    return {
      title: t(BUCKET_TITLE[bucket]),
      total: formatVnd(sum.toString()),
      cells: [
        { label: t('dis.wr.level.central'), control: cellControl(central) },
        { label: t('dis.wr.level.local'), control: cellControl(local) },
      ],
      programme: takesCtmtqg(bucket)
        ? {
            title: t('dis.reportEdit.ctmtqg.label'),
            cells: [
              { label: t('dis.wr.level.central'), control: control(central, 'ctmtqg', t('dis.reportEdit.ctmtqg.aria', { cell: cellLabel(t, central) })) },
              { label: t('dis.wr.level.local'), control: control(local, 'ctmtqg', t('dis.reportEdit.ctmtqg.aria', { cell: cellLabel(t, local) })) },
            ],
          }
        : 'na',
    };
  });
  const remaining = remainingOf(detail.totals.allocatedVnd, totals.cumulativeVnd);
  const ratio = ratioOf(totals.cumulativeVnd, detail.totals.allocatedVnd);
  const over = remaining.startsWith('-');
  const auditItems = [
    { label: t('dis.wr.audit.revision'), value: t('dis.reportEdit.revision.value', { revision: detail.revision }) },
    ...(detail.updatedAt === null ? [] : [{ label: t('dis.wr.audit.updated'), value: dueMoment(detail.updatedAt) }]),
    ...(detail.submittedBy === null ? [] : [{ label: t('dis.wr.audit.submitted'), value: detail.submittedBy }]),
  ];

  return (
    <form onSubmit={onSave} noValidate className="dis-wr-stack" aria-label={t('dis.reportEdit.matrix.aria')}>
      <StatusStrip detail={detail} />
      <ErrorSummary items={summary} attempt={attempt} />
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
      <SectionCard title={t('dis.wr.section.info')}>
        <ReportFacts detail={detail} />
        <Field id="report-basis" label={t('dis.reportEdit.basis.label')} error={undefined} hint={t('dis.reportEdit.basis.help')}>
          <select id="report-basis" value={form.basis} disabled={!editable} onChange={(event) => setForm({ ...form, basis: event.target.value as Basis })}>
            {BASES.map((item) => (
              <option key={item} value={item}>
                {basisLabel(t, item)}
              </option>
            ))}
          </select>
        </Field>
      </SectionCard>
      <SectionCard title={t('dis.wr.section.funds')} unit={t('dis.wr.unit')}>
        <div className="dis-wr-stack">
          <div className="dis-wr-stats">
            <ReadonlyStat label={t('dis.wr.stat.allocated')} value={formatVnd(detail.totals.allocatedVnd)} sub={t('dis.wr.stat.allocated.sub', { year: detail.planVersion.fiscalYear, revision: detail.planVersion.revision })} />
            <ReadonlyStat label={t('dis.reportEdit.col.cumulative')} value={formatVnd(totals.cumulativeVnd)} sub={t('dis.wr.stat.cumulative.sub', { date: detail.period.endDate })} tone="info" />
            <ReadonlyStat label={t('dis.wr.stat.remaining')} value={formatVnd(remaining)} tone={over ? 'warning' : 'default'} sub={over ? t('dis.wr.stat.remaining.over') : undefined} />
            <ReadonlyStat label={t('dis.wr.stat.ratio')} value={ratio === null ? t('dis.reportEdit.none.text') : `${ratio}%`} tone={over ? 'warning' : 'success'} />
          </div>
          <FundMatrix groups={groups} />
          <div className="dis-wr-total">
            <span>
              {t('dis.reportEdit.total.label')}
              <small>
                {t('dis.reportEdit.col.allocated')}: <span data-testid="total-allocated">{formatVnd(detail.totals.allocatedVnd)}</span>
              </small>
            </span>
            <strong data-testid="total-cumulative">{formatVnd(totals.cumulativeVnd)}</strong>
          </div>
          <div className="dis-wr-total">
            <span>
              {t('dis.reportEdit.ctmtqgTotal.label')}
              <small>{t('dis.reportEdit.ctmtqg.note')}</small>
            </span>
            <strong data-testid="total-ctmtqg">{formatVnd(totals.ctmtqgVnd)}</strong>
          </div>
        </div>
      </SectionCard>
      {fell || form.explanation !== '' ? (
        <SectionCard title={t('dis.wr.section.explanation')}>
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
        </SectionCard>
      ) : null}
      <AuditLine items={auditItems} />
      <FormActions editable={editable} sendable={sendable} busy={busy} saving={save.isPending} onSend={askSend} />
    </form>
  );
}

const BUCKET_ORDER: readonly Bucket[] = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'];

/** The bar at the foot of the form: "Gửi báo cáo" stays whatever the width; "Quay lại" and "Lưu nháp" go to the menu on a phone. */
function FormActions({ editable, sendable, busy, saving, onSend }: { editable: boolean; sendable: boolean; busy: boolean; saving: boolean; onSend: () => void }) {
  const { t } = useTranslation();
  const back = (
    <Link className="ui-button ui-button--outline" to={REPORTS_PATH}>
      {t('dis.wr.back.action')}
    </Link>
  );
  const saveButton = (
    <button type="submit" className={sendable ? 'ui-button ui-button--outline' : 'ui-button ui-button--primary'} disabled={busy}>
      {saving ? t('dis.reportEdit.save.pending') : t('dis.reportEdit.save.action')}
    </button>
  );
  if (!editable) return <StickyActions primary={back} />;
  if (!sendable) return <StickyActions primary={saveButton} secondary={[back]} />;
  return (
    <StickyActions
      primary={
        <button type="button" className="ui-button ui-button--primary" disabled={busy} onClick={onSend}>
          {t('dis.wr.send.action')}
        </button>
      }
      secondary={[back, saveButton]}
    />
  );
}
