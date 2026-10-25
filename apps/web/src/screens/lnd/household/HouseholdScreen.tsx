import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { todayInVietnam } from '../model';
import { useParcels, useProjectOptions, useUnits } from '../read-hooks';
import { LinkDialog, RegisterDialog, RevealDialog } from './dialogs';
import { useHouseholds } from './hooks';
import { householdStatusLabel, legalBasisLabel, rightKindLabel } from './labels';
import { EMPTY_FILTER, HOUSEHOLD_STATUSES, REQUESTS_PATH, canHandleRequests, canReveal, canWrite, filterHouseholds, isOpenable } from './model';
import type { HouseholdFilter, HouseholdLine } from './model';
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
  const { permissions, mode } = useSession();
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
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'register' })}>
              {t('lnd.households.register.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.households.privacy.note')}
      </p>
      <div className="card">
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
      </div>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.households.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void households.refetch()}>
          <div className="card">
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
            {shown.length === 0 ? (
              <p className="callout" role="status" data-testid="no-match">
                {(households.data ?? []).length === 0 ? t('lnd.households.empty.notice') : t('lnd.households.noMatch.notice')}
              </p>
            ) : (
              <table className="table" data-testid="households">
                <thead>
                  <tr>
                    <th scope="col">{t('lnd.households.column.code')}</th>
                    <th scope="col">{t('lnd.households.column.head')}</th>
                    <th scope="col">{t('lnd.households.column.nationalId')}</th>
                    <th scope="col">{t('lnd.households.column.parcels')}</th>
                    <th scope="col">{t('lnd.households.column.basis')}</th>
                    <th scope="col">{t('lnd.households.column.status')}</th>
                    <th scope="col">{t('lnd.households.column.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((household) => (
                    <HouseholdRow
                      key={household.id}
                      household={household}
                      canLink={mayWrite}
                      canOpen={mayReveal}
                      requestTo={mayRequest ? `${REQUESTS_PATH}?project=${projectId}&household=${household.id}` : undefined}
                      onLink={() => setDialog({ kind: 'link', household })}
                      onReveal={() => setDialog({ kind: 'reveal', household })}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </StateBoundary>
      )}
      {dialog?.kind === 'register' && projectId !== undefined ? <RegisterDialog projectId={projectId} units={units.data ?? []} today={today} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'link' ? <LinkDialog household={dialog.household} parcels={parcels.data ?? []} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'reveal' ? <RevealDialog household={dialog.household} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.households.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface RowProps {
  household: HouseholdLine;
  canLink: boolean;
  canOpen: boolean;
  /** Where the request of the person is handled, when the caller may handle it. */
  requestTo: string | undefined;
  onLink(): void;
  onReveal(): void;
}

function HouseholdRow({ household, canLink, canOpen, requestTo, onLink, onReveal }: RowProps) {
  const { t } = useTranslation();
  return (
    <tr data-household-id={household.id}>
      <th scope="row">{household.householdCode}</th>
      <td data-testid="head">{household.headNameMasked}</td>
      <td data-testid="national-id">{household.nationalIdMasked ?? t('lnd.households.nationalId.none')}</td>
      <td data-testid="parcels">
        {household.parcels.length === 0
          ? t('lnd.households.parcels.none')
          : household.parcels.map((parcel) => (
              <div key={parcel.id} data-parcel-link={parcel.id}>
                {t('lnd.households.parcels.line', { code: parcel.parcelCode, right: rightKindLabel(t, parcel.rightKind), share: parcel.sharePct })}
              </div>
            ))}
      </td>
      <td>
        <span data-testid="basis">{legalBasisLabel(t, household.legalBasis)}</span>
        <br />
        <small className="sub" data-testid="retention">
          {t('lnd.households.retention.line', { until: household.retentionUntil })}
        </small>
      </td>
      <td>
        <span className="lnd-badge" data-testid="status">
          {householdStatusLabel(t, household.status)}
        </span>
        {household.processingRestricted ? (
          <span className="lnd-badge warning" data-testid="restricted">
            {t('lnd.households.restricted.badge')}
          </span>
        ) : null}
        {household.anonymised ? (
          <span className="lnd-badge warning" data-testid="anonymised">
            {t('lnd.households.anonymised.badge')}
          </span>
        ) : null}
        {household.dsrOpen ? (
          <span className="lnd-badge warning" data-testid="dsr-open">
            {t('lnd.households.dsr.open')}
          </span>
        ) : null}
      </td>
      <td>
        {canLink ? (
          <button type="button" className="button" aria-label={t('lnd.households.link.aria', { code: household.householdCode })} onClick={onLink}>
            {t('lnd.households.link.action')}
          </button>
        ) : null}
        {requestTo === undefined ? null : (
          <Link className="button" to={requestTo} aria-label={t('lnd.households.request.aria', { code: household.householdCode })}>
            {t('lnd.households.request.action')}
          </Link>
        )}
        {canOpen && isOpenable(household) ? (
          <button type="button" className="button" aria-label={t('lnd.households.reveal.aria', { code: household.householdCode })} onClick={onReveal}>
            {t('lnd.households.reveal.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
