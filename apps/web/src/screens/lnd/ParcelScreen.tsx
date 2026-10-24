import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { NoticeDialog, ParcelDialog, SectionDialog } from './components';
import { ImportPanel } from './ImportPanel';
import { landUseLabel, noticeStateLabel, parcelStatusLabel, timerLabel } from './labels';
import { EMPTY_FILTER, PARCEL_STATUSES, canManage, canRecordNotice, filterParcels, noticeState, todayInVietnam } from './model';
import type { ParcelFilter, ParcelLine } from './model';
import { useParcels, useProjectOptions, useSections, useUnits } from './read-hooks';
import './lnd.css';

type Dialog = { kind: 'parcel' } | { kind: 'section' } | { kind: 'notice'; parcel: ParcelLine };

/**
 * LND-02: the parcels of a project and the notice of recovery that starts their timer (ST-LND-001). A parcel is a piece of land and nothing more:
 * the list has a column for the code, the unit that answers for it, the land use, the areas and the notice, and none for a person. The timer says how many
 * days the notice lasts, from which rule and on what legal basis, and while the confirmation of that rule has not arrived it says so.
 */
export default function ParcelScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ParcelContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ParcelContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const projects = useProjectOptions();
  const parcels = useParcels(projectId);
  const sections = useSections(projectId);
  const mayManage = canManage(permissions, mode);
  const units = useUnits(mayManage && projectId !== undefined);
  const [filter, setFilter] = useState<ParcelFilter>(EMPTY_FILTER);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const today = todayInVietnam();
  // A project with no parcel yet is not an empty screen: the officer still needs the filters, the import and the button that declares the first one.
  const state = useScreenState({ isLoading: parcels.isLoading, error: parcels.error, data: parcels.data, isEmpty: () => false });
  const shown = useMemo(() => filterParcels(parcels.data ?? [], filter), [parcels.data, filter]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.parcels.page.title')}</h1>
          <p>{t('lnd.parcels.page.subtitle')}</p>
        </div>
        {mayManage && projectId !== undefined ? (
          <div className="actions">
            <button type="button" onClick={() => setDialog({ kind: 'section' })}>
              {t('lnd.parcels.section.action')}
            </button>
            <button type="button" className="primary" onClick={() => setDialog({ kind: 'parcel' })}>
              {t('lnd.parcels.create.action')}
            </button>
          </div>
        ) : null}
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.parcels.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="lnd-project">{t('lnd.parcels.project.label')}</label>
          <select
            id="lnd-project"
            value={projectId ?? ''}
            onChange={(event) => {
              setFilter(EMPTY_FILTER);
              setParams(event.target.value === '' ? {} : { project: event.target.value });
            }}
          >
            <option value="">{t('lnd.parcels.project.choose')}</option>
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
          {t('lnd.parcels.project.notice')}
        </p>
      ) : (
        <>
          <ImportPanel projectId={projectId} canImport={mayManage} />
          <StateBoundary state={state} onRetry={() => void parcels.refetch()}>
            <div className="card">
              <form className="lnd-filters" role="search" aria-label={t('lnd.parcels.filters.title')} onSubmit={(event) => event.preventDefault()}>
                <div className="field">
                  <label htmlFor="lnd-query">{t('lnd.parcels.query.label')}</label>
                  <input id="lnd-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="lnd-status">{t('lnd.parcels.status.label')}</label>
                  <select id="lnd-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as ParcelFilter['status'] })}>
                    <option value="">{t('lnd.parcels.status.all')}</option>
                    {PARCEL_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {parcelStatusLabel(t, status)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="lnd-section">{t('lnd.parcels.section.label')}</label>
                  <select id="lnd-section" value={filter.sectionId} onChange={(event) => setFilter({ ...filter, sectionId: event.target.value })}>
                    <option value="">{t('lnd.parcels.section.all')}</option>
                    {(sections.data ?? []).map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.code}
                      </option>
                    ))}
                  </select>
                </div>
              </form>
              {shown.length === 0 ? (
                <p className="callout" role="status" data-testid="no-match">
                  {(parcels.data ?? []).length === 0 ? t('lnd.parcels.empty.notice') : t('lnd.parcels.noMatch.notice')}
                </p>
              ) : (
                <table className="table" data-testid="parcels">
                  <thead>
                    <tr>
                      <th scope="col">{t('lnd.parcels.column.code')}</th>
                      <th scope="col">{t('lnd.parcels.column.unit')}</th>
                      <th scope="col">{t('lnd.parcels.column.landUse')}</th>
                      <th scope="col">{t('lnd.parcels.column.area')}</th>
                      <th scope="col">{t('lnd.parcels.column.affected')}</th>
                      <th scope="col">{t('lnd.parcels.column.notice')}</th>
                      <th scope="col">{t('lnd.parcels.column.status')}</th>
                      <th scope="col">{t('lnd.parcels.column.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((parcel) => (
                      <ParcelRow key={parcel.id} parcel={parcel} today={today} canNotice={canRecordNotice(parcel, permissions, mode)} onNotice={() => setDialog({ kind: 'notice', parcel })} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </StateBoundary>
        </>
      )}
      {dialog?.kind === 'parcel' && projectId !== undefined ? <ParcelDialog projectId={projectId} units={units.data ?? []} sections={sections.data ?? []} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'section' && projectId !== undefined ? <SectionDialog projectId={projectId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'notice' ? <NoticeDialog parcel={dialog.parcel} today={today} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.parcels.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ParcelRow({ parcel, today, canNotice, onNotice }: { parcel: ParcelLine; today: string; canNotice: boolean; onNotice(): void }) {
  const { t } = useTranslation();
  const deadline = parcel.deadline;
  return (
    <tr data-parcel-id={parcel.id}>
      <th scope="row">{parcel.parcelCode}</th>
      <td>{parcel.ownerUnitName}</td>
      <td>{landUseLabel(t, parcel.landUseGroup)}</td>
      <td className="lnd-numeric">{parcel.areaTotalM2}</td>
      <td className="lnd-numeric">{parcel.areaAffectedM2}</td>
      <td data-testid="notice">
        {deadline === null ? (
          noticeStateLabel(t, { kind: 'NONE' })
        ) : (
          <>
            <span>{t('lnd.parcels.notice.line', { on: parcel.recoveryNoticeOn ?? deadline.startedOn, days: deadline.daysApplied, due: deadline.dueOn })}</span>
            <br />
            <span className="lnd-badge" data-testid="notice-state">
              {noticeStateLabel(t, noticeState(parcel, today))}
            </span>
            <br />
            <small className="sub" data-testid="notice-basis">
              {`${timerLabel(t, deadline.timerCode)}${deadline.legalBasis === null ? '' : ` · ${deadline.legalBasis}`}`}
            </small>
            {deadline.awaitingConfirmation ? (
              <span className="lnd-badge warning" data-testid="notice-awaiting">
                {t('lnd.parcels.notice.awaiting', { cxn: deadline.cxn ?? '' })}
              </span>
            ) : null}
          </>
        )}
      </td>
      <td>
        <span className="lnd-badge" data-testid="status">
          {parcelStatusLabel(t, parcel.status)}
        </span>
      </td>
      <td>
        {canNotice ? (
          <button type="button" className="button" aria-label={t('lnd.parcels.notice.aria', { code: parcel.parcelCode })} onClick={onNotice}>
            {t('lnd.parcels.notice.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
