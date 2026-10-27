import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmationLabel, Field } from './components';
import { useDecideReport, useObligations, useReport, useRequestIssue } from './hooks';
import { docStageLabel, reportProblemMessage, reportStatusLabel } from './labels';
import { vietnamToday, yearsAround } from './model';
import { DOC_STAGES, describeReportProblem, docStageOf, hasReason, isOwnReport, mayDecide, mayRequestIssue, shown } from './report-model';
import type { ReportStatus, ReportView } from './types';
import './mne.css';

type Done = 'approved' | 'returned' | 'requested';

/** The reports that are in the hands of a reviewer: waiting for a decision, approved and waiting to be issued, with DOC, or issued. */
const REVIEW_STATUSES: readonly ReportStatus[] = ['IN_REVIEW', 'APPROVED', 'ISSUING', 'ISSUED'];

/** MNE-05: review, approval and issue of a monitoring report: the content, the decision with its reason, the request to the document engine and the live state of the document. */
export default function ApprovalScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ApprovalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ApprovalContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const reportId = params.get('report') ?? '';
  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.approval.page.title')}</h1>
          <p>{t('mne.approval.page.subtitle')}</p>
        </div>
        {reportId === '' ? null : (
          <button type="button" className="btn" onClick={() => setParams({})}>
            {t('mne.approval.back')}
          </button>
        )}
      </div>
      {reportId === '' ? <ReviewPicker onOpen={(id) => setParams({ report: id })} /> : <ReviewEditor id={reportId} />}
    </section>
  );
}

function ReviewPicker({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const list = useObligations({ year, status: '' });
  const items = useMemo(() => (list.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => REVIEW_STATUSES.includes(item.status)), [list.data]);
  // A page that holds nothing for a reviewer is not the end of the list: the next one is read until there is something to show or nothing more to read.
  const searching = items.length === 0 && list.hasNextPage === true;
  useEffect(() => {
    if (searching && !list.isFetchingNextPage && list.error === null) void list.fetchNextPage();
  }, [searching, list.isFetchingNextPage, list.error, list]);
  const state = useScreenState({ isLoading: list.isLoading || searching, error: list.error, data: list.data === undefined ? undefined : items });
  return (
    <div className="card">
      <h2>{t('mne.approval.picker.title')}</h2>
      <p className="sub">{t('mne.approval.picker.help')}</p>
      <div className="mne-filters">
        <Field id="approval-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
          <select id="approval-year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {yearsAround(today, [year]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('mne.report.picker.column.period')}</th>
                <th scope="col">{t('mne.report.picker.column.unit')}</th>
                <th scope="col">{t('mne.report.picker.column.form')}</th>
                <th scope="col">{t('mne.report.picker.column.due')}</th>
                <th scope="col">{t('mne.report.picker.column.status')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.reportId} data-report-id={item.reportId}>
                  <td>{item.periodLabel}</td>
                  <td>
                    {item.unitCode} <span className="sub">{item.unitName}</span>
                  </td>
                  <td>
                    {item.formCode} <span className="sub">{item.formTitle}</span>
                  </td>
                  <td>{item.dueDate}</td>
                  <td>{reportStatusLabel(t, item.status)}</td>
                  <td>
                    <button type="button" className="btn" onClick={() => onOpen(item.reportId)}>
                      {t('mne.approval.picker.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.hasNextPage ? (
          <div className="mne-actions">
            <button type="button" className="btn" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('mne.calendar.more.action')}
            </button>
          </div>
        ) : null}
      </StateBoundary>
    </div>
  );
}

interface Actions {
  busy: boolean;
  failure: Error | undefined;
  decide: (report: ReportView, decision: 'approve' | 'return', reason: string) => void;
  requestIssue: (report: ReportView) => void;
}

function ReviewEditor({ id }: { id: string }) {
  const query = useReport(id, { live: true });
  const decide = useDecideReport();
  const issue = useRequestIssue();
  const [done, setDone] = useState<Done | undefined>(undefined);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data });
  // The mutations live here, not in the body: a decision moves the version, which starts the body over, and its answer must go on being seen.
  const actions: Actions = {
    busy: decide.isPending || issue.isPending,
    failure: decide.isError ? decide.error : issue.isError ? issue.error : undefined,
    decide: (report, decision, reason) => {
      setDone(undefined);
      issue.reset();
      decide.mutate({ id: report.id, version: report.version, decision, reason: reason.trim() }, { onSuccess: () => setDone(decision === 'approve' ? 'approved' : 'returned') });
    },
    requestIssue: (report) => {
      setDone(undefined);
      decide.reset();
      issue.mutate({ id: report.id, version: report.version }, { onSuccess: () => setDone('requested') });
    },
  };
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      {query.data === undefined ? null : <ReviewBody key={`${query.data.id}:${query.data.version}`} report={query.data} done={done} actions={actions} />}
    </StateBoundary>
  );
}

function ReviewBody({ report, done, actions }: { report: ReportView; done: Done | undefined; actions: Actions }) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const frozen = mode === 'READ_ONLY';
  const memberId = tenant?.membershipId;
  const canDecide = mayDecide(report, permissions, frozen, memberId);
  const canIssue = mayRequestIssue(report, permissions, frozen);
  const [reason, setReason] = useState('');
  const [reasonShort, setReasonShort] = useState(false);
  const problem = actions.failure === undefined ? undefined : describeReportProblem(actions.failure);
  const labelOf = (key: string): string => report.fields.find((field) => field.key === key)?.label ?? key;
  const stage = docStageOf(report.documentState);

  const decide = (decision: 'approve' | 'return'): void => {
    if (!hasReason(reason)) {
      setReasonShort(true);
      return;
    }
    setReasonShort(false);
    actions.decide(report, decision, reason);
  };

  return (
    <div className="card" data-report-status={report.status}>
      <div className="mne-badges">
        <strong>{report.formTitle}</strong>
        <span className="pill" data-testid="report-status">
          {reportStatusLabel(t, report.status)}
        </span>
        <ConfirmationLabel awaiting={report.awaitingConfirmation} cxnRefs={report.cxnRefs} />
      </div>
      <p className="sub">{t('mne.report.header.form', { code: report.formCode, revision: report.formRevision })}</p>
      <p className="sub">{t('mne.report.header.unit', { unit: `${report.unitCode} ${report.unitName}` })}</p>
      <p className="sub">{t('mne.report.header.period', { period: report.periodLabel, due: report.dueDate })}</p>
      <p data-testid="report-snapshot">{report.asOfDate === null ? t('mne.report.header.noSnapshot') : t('mne.report.header.snapshot', { date: report.asOfDate })}</p>
      {report.watermarkText === null ? null : <p className="callout">{report.watermarkText}</p>}

      <h2>{t('mne.approval.cells.title')}</h2>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('mne.report.column.field')}</th>
              <th scope="col">{t('mne.report.column.value')}</th>
            </tr>
          </thead>
          <tbody>
            {report.fields.map((field) => (
              <tr key={field.key} data-field={field.key}>
                <th scope="row">{field.label}</th>
                <td data-testid={`value-${field.key}`}>{shown(field) ?? t('mne.report.field.empty')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.decision === null ? null : (
        <p className="sub" data-testid="decision-record">
          {t('mne.approval.decision.record', { reason: report.decision.reason ?? '' })}
        </p>
      )}

      {report.status === 'IN_REVIEW' ? (
        <div className="card" aria-label={t('mne.approval.decision.title')}>
          <h2>{t('mne.approval.decision.title')}</h2>
          {isOwnReport(report, memberId) ? (
            <p className="callout warning" role="status" data-testid="decision-own">
              {t('mne.approval.decision.own')}
            </p>
          ) : null}
          {canDecide ? (
            <>
              <Field id="decision-reason" label={t('mne.approval.decision.reason.label')} error={reasonShort ? t('mne.approval.decision.reason.short') : undefined} hint={t('mne.approval.decision.reason.hint')}>
                <textarea id="decision-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <div className="mne-actions">
                <button type="button" className="btn" disabled={actions.busy} onClick={() => decide('return')}>
                  {t('mne.approval.decision.return')}
                </button>
                <button type="button" className="btn primary" disabled={actions.busy} onClick={() => decide('approve')}>
                  {t('mne.approval.decision.approve')}
                </button>
              </div>
            </>
          ) : isOwnReport(report, memberId) ? null : (
            <p className="callout warning" role="status" data-testid="approval-readonly">
              {frozen ? t('mne.approval.notice.frozen') : t('mne.approval.notice.readonly')}
            </p>
          )}
        </div>
      ) : null}

      {report.status === 'APPROVED' || report.status === 'ISSUING' || report.status === 'ISSUED' ? (
        <div className="card" aria-label={t('mne.approval.issue.title')}>
          <h2>{t('mne.approval.issue.title')}</h2>
          {report.payloadSha256 === null ? null : (
            <p className="sub" data-testid="issue-hash">
              {t('mne.approval.issue.hash', { hash: report.payloadSha256 })}
            </p>
          )}
          {report.status === 'ISSUING' ? (
            <p className="callout" role="status" data-testid="issue-waiting">
              {t('mne.approval.issue.waiting')}
            </p>
          ) : null}
          {report.status === 'ISSUED' && report.docDocumentId !== null ? (
            <p className="callout" role="status" data-testid="issue-done">
              {t('mne.approval.issue.done', { document: report.docDocumentId })}
            </p>
          ) : null}
          {report.recalledAt === null ? null : (
            <p className="callout warning" role="alert" data-testid="issue-recalled">
              {t('mne.approval.issue.recalled', { date: report.recalledAt.slice(0, 10) })}
            </p>
          )}
          {canIssue ? (
            <div className="mne-actions">
              <button type="button" className="btn primary" disabled={actions.busy} onClick={() => actions.requestIssue(report)}>
                {t('mne.approval.issue.action')}
              </button>
            </div>
          ) : report.status === 'APPROVED' ? (
            <p className="callout warning" role="status" data-testid="approval-readonly">
              {frozen ? t('mne.approval.notice.frozen') : t('mne.approval.notice.readonly')}
            </p>
          ) : null}
        </div>
      ) : null}

      <div aria-label={t('mne.approval.timeline.title')} role="group">
        <h2>{t('mne.approval.timeline.title')}</h2>
        {stage === 'none' || stage === 'withdrawn' ? (
          <p className="sub" data-testid="doc-stage" data-stage={stage}>
            {docStageLabel(t, stage)}
          </p>
        ) : (
          <ol className="mne-badges" data-testid="doc-stage" data-stage={stage}>
            {DOC_STAGES.map((step) => (
              <li key={step} className={step === stage ? 'pill' : 'sub'} aria-current={step === stage ? 'step' : undefined} data-step={step}>
                {docStageLabel(t, step)}
              </li>
            ))}
          </ol>
        )}
      </div>

      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="approval-done">
          {done === 'approved' ? t('mne.approval.decision.approved') : done === 'returned' ? t('mne.approval.decision.returned') : t('mne.approval.issue.requested')}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="report-problem">
          {reportProblemMessage(t, problem, labelOf)}
        </p>
      )}
    </div>
  );
}
