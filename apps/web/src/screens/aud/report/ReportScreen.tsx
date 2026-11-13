import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../aud.css';
import { EngagementPicker } from '../conclusion/components';
import { useConclusions } from '../conclusion/hooks';
import { currentOf, formatVnd } from '../conclusion/model';
import type { ConclusionLine } from '../conclusion/model';
import { useEngagement } from '../hooks';
import { engagementStatusLabel } from '../labels';
import { ENGAGEMENT_PATH } from '../model';
import type { EngagementDetail } from '../model';
import { RateText } from '../recovery/components';
import { RECOVERY_PATH } from '../recovery/model';
import { CloseDialog, RequestDialog } from './dialogs';
import { useReports } from './hooks';
import { rejectReasonLabel, reportStatusLabel } from './labels';
import { canCloseEngagement, canRequestReport, reportable, shortHash } from './model';
import type { ReportLine } from './model';

const NONE = '—';

type Dialog = 'request' | 'close';

/**
 * AUD-10: the report of the results of the recommendations that DOC issues, and the closure of the engagement (ST-AUD-005, AUD 3.6). Each report shows the figures frozen on the day it was
 * asked for, the hash of the payload DOC was asked to issue, where DOC has got to and who approved it. An engagement is closed when no recommendation is open and DOC issued a report of each
 * conclusion that stands; the server says which is missing. The data are confidential: an engagement outside the scope of the caller is not found.
 */
export default function ReportScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The reports and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  // An empty choice (`engagement=`) is none: the person asked to see no engagement.
  const engagementId = params.get('engagement') || undefined;
  const engagement = useEngagement(engagementId);
  const reports = useReports(engagementId);
  const conclusions = useConclusions(engagementId);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const missing = engagement.error instanceof ApiError && engagement.error.status === 404;
  const loaded = useScreenState({
    isLoading: engagement.isLoading || reports.isLoading,
    error: missing ? undefined : (engagement.error ?? reports.error),
    data: engagement.data,
    isEmpty: (data) => data === undefined,
  });
  // An engagement that is not found is told as empty: whoever asked cannot tell one of another scope from one that is not there. With none chosen there is nothing to load.
  const state: ScreenState = engagementId === undefined ? 'default' : missing ? 'empty' : loaded;
  const detail = engagement.data;
  const followed = detail !== undefined && reportable(detail);
  const mayRequest = followed && canRequestReport(permissions, mode);
  const mayClose = followed && canCloseEngagement(permissions, mode);
  const close = (): void => setDialog(undefined);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.report.page.title')}</h1>
          <p>{t('aud.report.page.subtitle')}</p>
        </div>
        {mayRequest || mayClose ? (
          <div className="actions">
            {mayRequest ? (
              <button type="button" className="primary" onClick={() => setDialog('request')}>
                {t('aud.report.request.action')}
              </button>
            ) : null}
            {mayClose ? (
              <button type="button" onClick={() => setDialog('close')}>
                {t('aud.closure.action')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="report-rule">
        {t('aud.report.rule.note')}
      </p>
      <EngagementPicker selected={engagementId} preferred={(status) => reportable({ status })} />
      <StateBoundary state={state} onRetry={() => void Promise.all([engagement.refetch(), reports.refetch()])}>
        {detail === undefined ? (
          <>
            <p className="muted" data-testid="report-choose">
              {t('aud.report.choose.text')}
            </p>
            {/* The columns of the reports of an engagement, with none until one is chosen. */}
            <Reports reports={[]} />
          </>
        ) : (
          <>
            <Engagement detail={detail} conclusion={currentOf(conclusions.data ?? [])} />
            <Reports reports={reports.data ?? []} />
          </>
        )}
      </StateBoundary>
      {detail !== undefined && dialog === 'request' ? <RequestDialog engagement={detail} conclusions={conclusions.data ?? []} onClose={close} /> : null}
      {detail !== undefined && dialog === 'close' ? <CloseDialog engagement={detail} onClose={close} /> : null}
      <p className="prototype-note">{t('aud.report.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Engagement({ detail, conclusion }: { detail: EngagementDetail; conclusion: ConclusionLine | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="report-engagement">
      <h2>{`${detail.code} · ${detail.title}`}</h2>
      <dl className="aud-facts">
        <dt>{t('aud.report.engagement.status')}</dt>
        <dd>
          <span className="aud-badge">{engagementStatusLabel(t, detail.status)}</span>
        </dd>
        <dt>{t('aud.report.engagement.dueOn')}</dt>
        <dd data-testid="report-due">{conclusion?.reportDueOn ?? NONE}</dd>
        <dt>{t('aud.report.engagement.closedOn')}</dt>
        <dd data-testid="closed-on">{detail.closedOn ?? NONE}</dd>
      </dl>
      <p className="aud-links">
        <Link to={`${ENGAGEMENT_PATH}?engagement=${detail.id}`}>{t('aud.report.engagement.file.link')}</Link>
        <Link to={`${RECOVERY_PATH}?engagement=${detail.id}`}>{t('aud.report.engagement.ledger.link')}</Link>
      </p>
      {detail.status === 'FOLLOW_UP' ? (
        <p className="muted" data-testid="closure-rule">
          {t('aud.closure.rule.note')}
        </p>
      ) : null}
    </div>
  );
}

function Reports({ reports }: { reports: readonly ReportLine[] }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <h2>{t('aud.report.list.title')}</h2>
      {/* The columns of a report stand before the first one is asked for: what it will freeze is said by them. */}
      <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('aud.report.col.asOfDate')}</th>
                <th>{t('aud.report.col.conclusion')}</th>
                <th>{t('aud.report.col.summaryFigures')}</th>
                <th>{t('aud.report.col.payloadHash')}</th>
                <th>{t('aud.report.col.docStatus')}</th>
                <th>{t('aud.report.col.document')}</th>
                <th>{t('aud.report.col.people')}</th>
              </tr>
            </thead>
            <tbody>
              {reports.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted" data-testid="no-reports">
                    {t('aud.report.list.none')}
                  </td>
                </tr>
              ) : null}
              {reports.map((report) => (
                <tr key={report.id} data-report-id={report.id}>
                  <td>
                    <strong>{report.asOfDate}</strong>
                    <div className="sub">{t('aud.report.revision', { revision: report.revision })}</div>
                  </td>
                  <td>{report.conclusionSymbol ?? NONE}</td>
                  <td>
                    <Figures report={report} />
                  </td>
                  <td>
                    <code title={report.payloadSha256}>{shortHash(report.payloadSha256)}</code>
                  </td>
                  <td>
                    <span className={report.status === 'REJECTED' ? 'aud-badge warning' : 'aud-badge'}>{reportStatusLabel(t, report.status)}</span>
                    {report.rejectCode === null ? null : (
                      <div className="sub" title={report.rejectCode} data-testid="reject-reason">
                        {rejectReasonLabel(t, report.rejectCode)}
                      </div>
                    )}
                    {report.issuedAt === null ? null : <div className="sub">{report.issuedAt.slice(0, 10)}</div>}
                  </td>
                  <td>{report.documentId === null ? NONE : <code title={report.documentId}>{shortHash(report.documentId)}</code>}</td>
                  <td>
                    <div>{t('aud.report.people.requested', { name: report.requestedBy.displayName === '' ? report.requestedBy.id : report.requestedBy.displayName })}</div>
                    <div className="sub" data-testid="approver">
                      {report.approvedBy === null
                        ? report.status === 'ISSUED'
                          ? t('aud.report.people.unrecorded')
                          : t('aud.report.people.pending')
                        : t('aud.report.people.approved', { name: report.approvedBy.displayName === '' ? report.approvedBy.id : report.approvedBy.displayName })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </div>
  );
}

/** The figures frozen with the report: counts by group, the money, and the two rates each with its numerator and denominator. */
function Figures({ report }: { report: ReportLine }) {
  const { t } = useTranslation();
  const totals = report.totals;
  return (
    <div data-testid="report-figures">
      <div data-testid="figures-counts">{t('aud.report.figures.counts', { closed: totals.closed, inProgress: totals.inProgress, open: totals.open, disputed: totals.disputed, total: totals.total })}</div>
      <div data-testid="figures-money">
        {t('aud.report.figures.money', { amount: formatVnd(totals.amountVnd), recovered: formatVnd(totals.recoveredVnd), remaining: formatVnd(totals.remainingVnd) })}
      </div>
      <div>
        {t('aud.report.figures.moneyRate')}: <RateText rate={totals.moneyRate} testId="report-rate-money" />
      </div>
      <div>
        {t('aud.report.figures.countRate')}: <RateText rate={totals.countRate} testId="report-rate-count" />
      </div>
    </div>
  );
}
