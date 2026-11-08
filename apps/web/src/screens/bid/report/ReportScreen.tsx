import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useComparison } from '../compare/hooks';
import { CreatePanel } from './CreatePanel';
import { ReportCard } from './ReportCard';
import { useReport, useReports, useSignOff } from './hooks';
import { REPORT_PERMISSION, candidatesOf, canAct, comparePath, declarationPath, holds, isConfirmation, maySign, readFailure, signBody, withDissentDraft, withoutDissentDraft } from './model';
import type { DissentDrafts, Report } from './model';
import './report.css';
import '../bid.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BID-13: the evaluation report of a package and its sign-off (ST-BID-012, BID 3 F6, BR-BID-03/09). A member of the evaluation team makes the report from analyses whose findings the experts all decided; it freezes
 * what they decided (never what the model said) with the conclusion of the team. Every member signs, with the dissent they hold in their own words; the signature that leaves nobody to wait for asks DOC to issue the
 * minutes, and the report is issued only when DOC says so. Nothing here ranks the proposals or names a winner: the award is decided by someone with the authority.
 */
export default function ReportScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The reports, what was typed and the signatures belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [search] = useSearchParams();
  const packageId = search.get('package') ?? '';
  const allowed = holds(permissions, REPORT_PERMISSION);
  const mayMake = canAct(permissions, mode) && packageId !== '';
  const openedId = UUID.test(search.get('report') ?? '') ? (search.get('report') ?? '').toLowerCase() : '';
  // A link to one report shows that report alone when no package is chosen.
  const single = openedId !== '' && packageId === '';
  const list = useReports(packageId, allowed);
  const opened = useReport(openedId, allowed && single);
  const read = single ? opened : list;
  const comparison = useComparison(packageId, '', mayMake);
  const comparisonState = useScreenState({ isLoading: comparison.isLoading, error: comparison.error, data: comparison.data, isEmpty: () => false });
  const sign = useSignOff();
  const [drafts, setDrafts] = useState<DissentDrafts>({});
  const failure = readFailure(read.error);
  // A caller with no report is not an empty screen for the evaluation team: the form that makes one stays where it is, outside the boundary.
  const state = useScreenState({ isLoading: read.isLoading, error: failure === undefined ? read.error : undefined, data: read.data, isEmpty: (data) => (data as Report[]).length === 0 });
  const reports = read.data ?? [];
  const packageCode = reports[0]?.package.code ?? comparison.data?.packageCode ?? '';
  const send = (report: Report): void =>
    sign.mutate({ report, body: signBody(isConfirmation(report, tenant?.membershipId) ? '' : (drafts[report.id] ?? '')) }, { onSuccess: () => setDrafts((current) => withoutDissentDraft(current, report.id)) });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.report.page.title')}</h1>
          <p>{t('bid.report.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={allowed ? 'default' : 'denied'}>
        {packageId === '' && !single ? (
          <p className="callout" role="note" data-testid="choose-package">
            {t('bid.report.package.hint')}
          </p>
        ) : failure === 'undeclared' ? (
          <p className="callout warning" role="alert" data-testid="undeclared">
            {t('bid.report.undeclared.notice')}{' '}
            <Link to={declarationPath(packageId)} data-testid="link-declare">
              {t('bid.report.undeclared.link')}
            </Link>
          </p>
        ) : (
          <>
            {mayMake ? (
              <StateBoundary state={comparisonState} onRetry={() => void comparison.refetch()}>
                <CreatePanel packageId={packageId} packageCode={packageCode} criteriaVersionId={comparison.data?.criteriaVersionId ?? ''} candidates={candidatesOf(comparison.data)} />
              </StateBoundary>
            ) : null}
            {single ? (
              <p className="callout" role="note" data-testid="opened-report">
                {t('bid.report.opened.notice')}
              </p>
            ) : null}
            <p className="sub">
              <Link to={comparePath(packageId === '' ? (reports[0]?.package.id ?? '') : packageId)} data-testid="link-compare">
                {t('bid.report.compare.link')}
              </Link>
            </p>
            <StateBoundary state={state} onRetry={() => void read.refetch()}>
              <div data-testid="reports">
                {reports.map((report) => (
                  <ReportCard
                    key={report.id}
                    report={report}
                    signable={maySign(report, permissions, mode)}
                    confirmation={isConfirmation(report, tenant?.membershipId)}
                    dissent={drafts[report.id] ?? ''}
                    pending={sign.isPending && sign.variables?.report.id === report.id}
                    busy={sign.isPending && sign.variables?.report.id !== report.id}
                    refusal={sign.isError && sign.variables?.report.id === report.id ? sign.error : undefined}
                    onDissent={(value) => setDrafts((current) => withDissentDraft(current, report.id, value))}
                    onSign={() => send(report)}
                  />
                ))}
              </div>
            </StateBoundary>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.report.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
