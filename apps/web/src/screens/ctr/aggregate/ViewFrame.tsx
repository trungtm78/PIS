import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, DefaultContractBar, StatusBadge } from '../components';
import { LIST_PATH, workspaceLink } from '../model';
import type { ContractView } from '../model';
import type { ViewScope } from './hooks';
import { ASSET_PATH, DIARY_PATH, HANDOVER_PATH, QUALITY_PATH, SETTLEMENT_PATH, WARRANTY_PATH, seesFinancials, viewLink } from './model';
import '../ctr.css';

/** A link from a view to the screen of the module that owns what the view shows. */
export interface Owner {
  /** The id of the screen of the owner (QMS-01). */
  id: string;
  to: string;
}

export interface Loaded<T> {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  refetch(): unknown;
}

export interface Shown<T> {
  contract: ContractView;
  data: T;
  /** False for a guest contractor: the financial columns are not drawn at all. */
  financial: boolean;
}

export interface ViewFrameProps<T> extends ScreenProps {
  title: string;
  subtitle: string;
  /** The module that owns the data (QMS, AST, PAY), named in the notice that the view is read-only. */
  module: string;
  scope: ViewScope;
  loaded: Loaded<T>;
  isEmpty(data: T): boolean;
  owners: readonly Owner[];
  children(shown: Shown<T>): ReactNode;
}

/** The six views side by side: a contract officer moves between them without going back to the workspace. */
function ViewTabs({ contractId, current }: { contractId: string; current: string }) {
  const { t } = useTranslation();
  const tabs = [
    { id: 'CTR-09', path: DIARY_PATH, label: t('ctr.diaryView.page.title') },
    { id: 'CTR-11', path: QUALITY_PATH, label: t('ctr.qualityView.page.title') },
    { id: 'CTR-15', path: HANDOVER_PATH, label: t('ctr.handoverView.page.title') },
    { id: 'CTR-16', path: WARRANTY_PATH, label: t('ctr.warrantyView.page.title') },
    { id: 'CTR-17', path: SETTLEMENT_PATH, label: t('ctr.settlementView.page.title') },
    { id: 'CTR-18', path: ASSET_PATH, label: t('ctr.assetView.page.title') },
  ];
  return (
    <nav aria-label={t('ctr.view.nav.label')} className="ctr-row-actions" data-testid="view-tabs">
      {tabs.map((tab) => (
        <Link key={tab.id} className="button" to={viewLink(tab.path, contractId)} aria-current={tab.id === current ? 'page' : undefined} data-view={tab.id}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * What the six aggregation views of a contract have in common (ST-CTR-017, CTR section 7): the contract in the heading, the notice that the data is the owner's and is shown here to read, the
 * links to the screens of the owner, and the standard states. The caller who does not hold the read of the owner is told it is denied; a guest contractor is shown the view without the
 * financial columns, which `financial` tells the view to leave out.
 */
export function ViewFrame<T>({ route, title, subtitle, module, scope, loaded, isEmpty, owners, children }: ViewFrameProps<T>) {
  const { t } = useTranslation();
  const { contractId, contract } = scope;
  const read = useScreenState({
    isLoading: contract.isLoading || loaded.isLoading,
    error: contract.error ?? loaded.error,
    // A contract that is not there for the caller is shown as an empty view, not as a view of nothing.
    data: contract.data === null ? null : loaded.data,
    isEmpty: (data) => data === null || isEmpty(data as T),
  });
  const state = scope.mayRead ? read : 'denied';
  const shown = contract.data !== null && contract.data !== undefined && loaded.data !== undefined ? { contract: contract.data, data: loaded.data } : undefined;
  const financial = shown !== undefined && seesFinancials(shown.contract);
  const retry = (): void => {
    void contract.refetch();
    void loaded.refetch();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={contractId === null ? LIST_PATH : workspaceLink(contractId)}>{contractId === null ? t('ctr.back.list.link') : t('ctr.view.back.workspace')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
          {contract.data === null || contract.data === undefined ? null : (
            <p>
              <strong data-testid="contract-code">{contract.data.code}</strong> · {contract.data.title ?? ''} <StatusBadge status={contract.data.status} />
            </p>
          )}
        </div>
      </div>
      <DefaultContractBar choice={scope.choice} />
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('ctr.view.none.notice')} <Link to={LIST_PATH}>{t('ctr.view.none.link')}</Link>
        </p>
      ) : (
        <>
          <ViewTabs contractId={contractId} current={route.id} />
          <StateBoundary state={state} onRetry={retry}>
            {shown === undefined ? null : (
              <>
                <p className="callout" role="status" data-testid="read-only">
                  {t('ctr.view.readonly.notice', { module })}{' '}
                  {owners.map((owner) => (
                    <Link key={owner.id} className="button" to={owner.to} data-testid={`owner-${owner.id}`}>
                      {t('ctr.view.owner.open', { id: owner.id })}
                    </Link>
                  ))}
                </p>
                {financial ? null : (
                  <p className="callout" role="status" data-testid="guest-notice">
                    {t('ctr.view.guest.notice')}
                  </p>
                )}
                {children({ ...shown, financial })}
              </>
            )}
          </StateBoundary>
        </>
      )}
      <p className="prototype-note">{t('ctr.view.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
