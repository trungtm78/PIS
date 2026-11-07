import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { todayInVietnam } from '../model';
import { useParcels, useProjectOptions, useUnits } from '../read-hooks';
import { LinkDialog, RegisterDialog, RevealDialog } from './dialogs';
import { useHouseholds } from './hooks';
import { householdStatusLabel, legalBasisLabel, rightKindLabel } from './labels';
import { EMPTY_FILTER, HOUSEHOLD_STATUSES, REQUESTS_PATH, canHandleRequests, canReveal, canWrite, filterHouseholds, isOpenable } from './model';
import type { HouseholdFilter, HouseholdLine, HouseholdStatus } from './model';
import '../lnd.css';

type Dialog = { kind: 'register' } | { kind: 'link'; household: HouseholdLine } | { kind: 'reveal'; household: HouseholdLine };

/**
 * LND-03: the households affected by a land recovery (ST-LND-002). Every personal field is shown masked; the identity number and the telephone number are hidden whole from whoever may not open them, and
 * the one button that opens a household in the clear says that the reading is recorded. A household is registered on a legal basis for processing its data and for as long as the data is kept.
 */
export default function HouseholdScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over, and takes any opened personal data with it.
  return <HouseholdContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function HouseholdContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const projects = useProjectOptions();
  const households = useHouseholds(projectId);
  const parcels = useParcels(projectId);
  const mayWrite = canWrite(permissions, mode);
  const mayReveal = canReveal(permissions);
  const mayRequest = canHandleRequests(permissions, mode);
  const units = useUnits(mayWrite && projectId !== undefined);
  const [filter, setFilter] = useState<HouseholdFilter>(EMPTY_FILTER);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const today = todayInVietnam();
  // A project with no household yet is not an empty screen: the officer still needs the button that registers the first one.
  const state = useScreenState({ isLoading: households.isLoading, error: households.error, data: households.data, isEmpty: () => false });
  const shown = useMemo(() => filterHouseholds(households.data ?? [], filter), [households.data, filter]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.households.page.title')}</h1>
          <p>{t('lnd.households.page.subtitle')}</p>
        </div>
        {mayWrite && projectId !== undefined ? (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'register' })}>
              {t('lnd.households.register.action')}
            </button>
          </div>
        ) : null}
      </div>
      <ContextBar
        items={[
          { label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') },
          { label: t('w2iss.lnd.ctx.project'), value: (projects.data ?? []).find((project) => project.id === projectId)?.code ?? t('w2iss.lnd.ctx.project.none') },
        ]}
      />
      <p className="callout" data-testid="privacy-note">
        {t('lnd.households.privacy.note')}
      </p>
      <FilterPanel>
        <div className="field">
          <label htmlFor="household-project">{t('lnd.households.project.label')}</label>
          <select
            id="household-project"
            value={projectId ?? ''}
            onChange={(event) => {
              setFilter(EMPTY_FILTER);
              setParams(event.target.value === '' ? {} : { project: event.target.value });
            }}
          >
            <option value="">{t('lnd.households.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </FilterPanel>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.households.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void households.refetch()}>
          <FilterPanel applied={[filter.query.trim() !== '', filter.status !== ''].filter(Boolean).length}>
            <form className="lnd-filters" role="search" aria-label={t('lnd.households.filters.title')} onSubmit={(event) => event.preventDefault()}>
              <div className="field">
                <label htmlFor="household-query">{t('lnd.households.query.label')}</label>
                <input id="household-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="household-status">{t('lnd.households.status.label')}</label>
                <select id="household-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as HouseholdFilter['status'] })}>
                  <option value="">{t('lnd.households.status.all')}</option>
                  {HOUSEHOLD_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {householdStatusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </div>
            </form>
          </FilterPanel>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {(households.data ?? []).length === 0 ? t('lnd.households.empty.notice') : t('lnd.households.noMatch.notice')}
            </p>
          ) : (
            <div data-testid="households">
              <HouseholdTable
                households={shown}
                canLink={mayWrite}
                canOpen={mayReveal}
                requestTo={(household) => (mayRequest ? `${REQUESTS_PATH}?project=${projectId}&household=${household.id}` : undefined)}
                onLink={(household) => setDialog({ kind: 'link', household })}
                onReveal={(household) => setDialog({ kind: 'reveal', household })}
              />
            </div>
          )}
        </StateBoundary>
      )}
      {dialog?.kind === 'register' && projectId !== undefined ? <RegisterDialog projectId={projectId} units={units.data ?? []} today={today} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'link' ? <LinkDialog household={dialog.household} parcels={parcels.data ?? []} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'reveal' ? <RevealDialog household={dialog.household} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.households.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const STATUS_TONE: Readonly<Record<HouseholdStatus, 'neutral' | 'info' | 'success' | 'warning'>> = {
  REGISTERED: 'neutral',
  INVENTORIED: 'neutral',
  PLAN_LISTED: 'info',
  COMPENSATED: 'success',
  RESETTLED: 'success',
  CLOSED: 'neutral',
  DISPUTED: 'warning',
};

interface TableProps {
  households: HouseholdLine[];
  canLink: boolean;
  canOpen: boolean;
  /** Where the request of the person is handled, when the caller may handle it. */
  requestTo(household: HouseholdLine): string | undefined;
  onLink(household: HouseholdLine): void;
  onReveal(household: HouseholdLine): void;
}

/** The households as a table: every personal field is the masked one the server sent; the flags (restricted, anonymised, request open) are pills with words. */
function HouseholdTable({ households, canLink, canOpen, requestTo, onLink, onReveal }: TableProps) {
  const { t } = useTranslation();
  const columns: DataTableColumn<HouseholdLine>[] = [
    { key: 'code', header: t('lnd.households.column.code'), pinned: true, render: (household) => <span data-household-id={household.id}>{household.householdCode}</span> },
    { key: 'head', header: t('lnd.households.column.head'), render: (household) => <span data-testid="head">{household.headNameMasked}</span> },
    { key: 'nationalId', header: t('lnd.households.column.nationalId'), render: (household) => <span data-testid="national-id">{household.nationalIdMasked ?? t('lnd.households.nationalId.none')}</span> },
    {
      key: 'parcels',
      header: t('lnd.households.column.parcels'),
      render: (household) => (
        <span data-testid="parcels">
          {household.parcels.length === 0
            ? t('lnd.households.parcels.none')
            : household.parcels.map((parcel) => (
                <span key={parcel.id} className="lnd-line" data-parcel-link={parcel.id}>
                  {t('lnd.households.parcels.line', { code: parcel.parcelCode, right: rightKindLabel(t, parcel.rightKind), share: parcel.sharePct })}
                </span>
              ))}
        </span>
      ),
    },
    {
      key: 'basis',
      header: t('lnd.households.column.basis'),
      render: (household) => (
        <>
          <span data-testid="basis">{legalBasisLabel(t, household.legalBasis)}</span>
          <small className="sub lnd-sub" data-testid="retention">
            {t('lnd.households.retention.line', { until: household.retentionUntil })}
          </small>
        </>
      ),
    },
    {
      key: 'status',
      header: t('lnd.households.column.status'),
      render: (household) => (
        <span className="lnd-chips">
          <span data-testid="status">
            <StatusPill tone={STATUS_TONE[household.status]}>{householdStatusLabel(t, household.status)}</StatusPill>
          </span>
          {household.processingRestricted ? (
            <span data-testid="restricted">
              <StatusPill tone="warning">{t('lnd.households.restricted.badge')}</StatusPill>
            </span>
          ) : null}
          {household.anonymised ? (
            <span data-testid="anonymised">
              <StatusPill tone="warning">{t('lnd.households.anonymised.badge')}</StatusPill>
            </span>
          ) : null}
          {household.dsrOpen ? (
            <span data-testid="dsr-open">
              <StatusPill tone="warning">{t('lnd.households.dsr.open')}</StatusPill>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'action',
      header: t('lnd.households.column.action'),
      render: (household) => {
        const to = requestTo(household);
        return (
          <span className="lnd-row-actions">
            {canLink ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('lnd.households.link.aria', { code: household.householdCode })} onClick={() => onLink(household)}>
                {t('lnd.households.link.action')}
              </button>
            ) : null}
            {to === undefined ? null : (
              <Link className="ui-button ui-button--outline ui-button--small" to={to} aria-label={t('lnd.households.request.aria', { code: household.householdCode })}>
                {t('lnd.households.request.action')}
              </Link>
            )}
            {canOpen && isOpenable(household) ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('lnd.households.reveal.aria', { code: household.householdCode })} onClick={() => onReveal(household)}>
                {t('lnd.households.reveal.action')}
              </button>
            ) : null}
          </span>
        );
      },
    },
  ];
  return <DataTable caption={t('w2iss.lnd.households.aria')} columns={columns} rows={households} rowKey={(household) => household.id} />;
}
