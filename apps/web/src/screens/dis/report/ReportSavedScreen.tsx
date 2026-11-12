import { ApiError } from '@machvon/api-client';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../dis.css';
import { BackLink } from '../components';
import { DefaultReportBar } from './components';
import { useReport, useReportChoice } from './hooks';
import { EDIT_PATH, REPORTS_PATH } from './model';
import type { ReportDetail } from './model';
import { formatVnd } from './money';

/**
 * DIS-18: the draft was saved. It says the code of the draft, the period and the project, what the draft adds up to, and the next steps; the focus moves to the heading so that a person who
 * uses a keyboard or a screen reader lands on the answer (ST-DIS-003, UI-DIS-04).
 */
export default function ReportSavedScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <ReportSavedContent key={tenantId ?? 'none'} route={route} />;
}

/** The code of a draft: the project, the period and the number of the revision, which is what a person recognises it by. */
export const draftCodeOf = (detail: ReportDetail): string => `${detail.project.code}/${detail.period.code}/r${detail.revision}`;

function ReportSavedContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  // Opened without a report in the address (the menu), the latest draft is shown, and the selector stays to change it.
  const choice = useReportChoice(true);
  const reportId = choice.reportId;
  const report = useReport(reportId);
  const missing = report.error instanceof ApiError && report.error.status === 404;
  const loaded = useScreenState({ isLoading: report.isLoading, error: missing ? undefined : report.error, data: report.data, isEmpty: (data) => data === undefined });
  const state: ScreenState = choice.isLoading ? 'loading' : reportId === undefined ? 'default' : missing ? 'empty' : loaded;
  const detail = report.data;
  const heading = useRef<HTMLHeadingElement>(null);
  // The heading is the first thing there is to read once the draft is shown: focus goes to it.
  useEffect(() => {
    if (detail !== undefined) heading.current?.focus();
  }, [detail]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={REPORTS_PATH}>{t('dis.reportSaved.back.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title" ref={heading} tabIndex={-1}>
            {t('dis.reportSaved.page.title')}
          </h1>
          <p>{t('dis.reportSaved.page.subtitle')}</p>
        </div>
      </div>
      <DefaultReportBar choice={choice} />
      <StateBoundary state={state} onRetry={() => void report.refetch()}>
        {detail === undefined ? (
          <p className="muted" data-testid="saved-choose">
            {t('dis.reportSaved.choose.text')}
          </p>
        ) : (
          <div className="card">
            <p className="callout" role="status" data-testid="saved-note">
              {t('dis.reportSaved.note')}
            </p>
            <dl className="aud-facts">
              <dt>{t('dis.reportSaved.code.label')}</dt>
              <dd data-testid="saved-code">{draftCodeOf(detail)}</dd>
              <dt>{t('dis.reportSaved.period.label')}</dt>
              <dd data-testid="saved-period">{t('dis.reportEdit.period.value', { code: detail.period.code, start: detail.period.startDate, end: detail.period.endDate })}</dd>
              <dt>{t('dis.reportSaved.project.label')}</dt>
              <dd data-testid="saved-project">{`${detail.project.code} · ${detail.project.name}`}</dd>
              <dt>{t('dis.reportSaved.total.label')}</dt>
              <dd data-testid="saved-total">{t('dis.reportSaved.total.value', { amount: formatVnd(detail.totals.cumulativeVnd), ctmtqg: formatVnd(detail.totals.ctmtqgVnd) })}</dd>
            </dl>
            <p className="actions">
              <Link className="button primary" to={`${EDIT_PATH}?report=${detail.id}`}>
                {t('dis.reportSaved.continue.link')}
              </Link>
              <Link to={REPORTS_PATH}>{t('dis.reportSaved.list.link')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.reportSaved.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
