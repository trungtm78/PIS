import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { NoticeDialog, ParcelDialog, SectionDialog } from './components';
import { ImportPanel } from './ImportPanel';
import { landUseLabel, noticeStateLabel, parcelStatusLabel, timerLabel } from './labels';
import { EMPTY_FILTER, PARCEL_STATUSES, canManage, canRecordNotice, filterParcels, noticeState, todayInVietnam } from './model';
import type { NoticeState, ParcelFilter, ParcelLine, ParcelStatus } from './model';
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
  const { permissions, mode, tenant } = useSession();
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
            <button type="button" className="ui-button ui-button--outline" onClick={() => setDialog({ kind: 'section' })}>
              {t('lnd.parcels.section.action')}
            </button>
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'parcel' })}>
              {t('lnd.parcels.create.action')}
            </button>
          </div>
        ) : null}
      </div>
      <ContextBar
        items={[
          { label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') },
          { label: t('w2iss.lnd.ctx.project'), value: (projects.data ?? []).find((project) => project.id === projectId)?.code ?? t('w2iss.lnd.ctx.project.none') },
        ]}
        unit={t('w2iss.lnd.unit')}
      />
      <p className="callout" data-testid="privacy-note">
        {t('lnd.parcels.privacy.note')}
      </p>
      <FilterPanel>
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
      </FilterPanel>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.parcels.project.notice')}
        </p>
      ) : (
        <>
          <ImportPanel projectId={projectId} canImport={mayManage} />
          <StateBoundary state={state} onRetry={() => void parcels.refetch()}>
            <FilterPanel applied={[filter.query.trim() !== '', filter.status !== '', filter.sectionId !== ''].filter(Boolean).length}>
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
            </FilterPanel>
            {shown.length === 0 ? (
              <p className="callout" role="status" data-testid="no-match">
                {(parcels.data ?? []).length === 0 ? t('lnd.parcels.empty.notice') : t('lnd.parcels.noMatch.notice')}
              </p>
            ) : (
              <div data-testid="parcels">
                <ParcelTable parcels={shown} today={today} canNotice={(parcel) => canRecordNotice(parcel, permissions, mode)} onNotice={(parcel) => setDialog({ kind: 'notice', parcel })} />
              </div>
            )}
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

const PARCEL_TONE: Readonly<Record<ParcelStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  SURVEYED: 'neutral',
  INVENTORIED: 'neutral',
  PLAN_DRAFTED: 'info',
  PLAN_POSTED: 'info',
  PLAN_APPROVED: 'info',
  PAID: 'success',
  HANDED_OVER: 'success',
  DISPUTED: 'warning',
  ENFORCEMENT: 'danger',
};

const NOTICE_TONE: Readonly<Record<NoticeState['kind'], 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  NONE: 'neutral',
  RUNNING: 'info',
  ELAPSED: 'warning',
  SATISFIED: 'success',
  BREACHED: 'danger',
  CANCELLED: 'neutral',
};

interface ParcelTableProps {
  parcels: ParcelLine[];
  today: string;
  canNotice(parcel: ParcelLine): boolean;
  onNotice(parcel: ParcelLine): void;
}

/** The parcels as a table: the code, the unit, the land use, the two areas (right aligned, in square metres), the notice with its state and legal basis, the status and the action. */
function ParcelTable({ parcels, today, canNotice, onNotice }: ParcelTableProps) {
  const { t } = useTranslation();
  const columns: DataTableColumn<ParcelLine>[] = [
    { key: 'code', header: t('lnd.parcels.column.code'), pinned: true, render: (parcel) => parcel.parcelCode },
    { key: 'unit', header: t('lnd.parcels.column.unit'), render: (parcel) => parcel.ownerUnitName },
    { key: 'landUse', header: t('lnd.parcels.column.landUse'), render: (parcel) => landUseLabel(t, parcel.landUseGroup) },
    { key: 'area', header: t('lnd.parcels.column.area'), align: 'right', render: (parcel) => parcel.areaTotalM2 },
    { key: 'affected', header: t('lnd.parcels.column.affected'), align: 'right', render: (parcel) => parcel.areaAffectedM2 },
    {
      key: 'notice',
      header: t('lnd.parcels.column.notice'),
      render: (parcel) => {
        const deadline = parcel.deadline;
        return (
          <span data-testid="notice">
            {deadline === null ? (
              noticeStateLabel(t, { kind: 'NONE' })
            ) : (
              <>
                <span>{t('lnd.parcels.notice.line', { on: parcel.recoveryNoticeOn ?? deadline.startedOn, days: deadline.daysApplied, due: deadline.dueOn })}</span>
                <span className="lnd-chips">
                  <span data-testid="notice-state">
                    <StatusPill tone={NOTICE_TONE[noticeState(parcel, today).kind]}>{noticeStateLabel(t, noticeState(parcel, today))}</StatusPill>
                  </span>
                  {deadline.awaitingConfirmation ? (
                    <span data-testid="notice-awaiting">
                      <StatusPill tone="warning">{t('lnd.parcels.notice.awaiting', { cxn: deadline.cxn ?? '' })}</StatusPill>
                    </span>
                  ) : null}
                </span>
                <small className="sub lnd-sub" data-testid="notice-basis">
                  {`${timerLabel(t, deadline.timerCode)}${deadline.legalBasis === null ? '' : ` · ${deadline.legalBasis}`}`}
                </small>
              </>
            )}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: t('lnd.parcels.column.status'),
      render: (parcel) => (
        <span data-testid="status">
          <StatusPill tone={PARCEL_TONE[parcel.status]}>{parcelStatusLabel(t, parcel.status)}</StatusPill>
        </span>
      ),
    },
    {
      key: 'action',
      header: t('lnd.parcels.column.action'),
      render: (parcel) =>
        canNotice(parcel) ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('lnd.parcels.notice.aria', { code: parcel.parcelCode })} onClick={() => onNotice(parcel)}>
            {t('lnd.parcels.notice.action')}
          </button>
        ) : null,
    },
  ];
  return <DataTable caption={t('w2iss.lnd.parcels.aria')} columns={columns} rows={parcels} rowKey={(parcel) => parcel.id} rowAttrs={(parcel) => ({ 'data-parcel-id': parcel.id })} />;
}
