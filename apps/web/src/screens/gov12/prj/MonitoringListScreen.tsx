import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { useMonitoringFiles, useOpenFile } from './prjHooks';
import { dayText, hasRight, refusalKey, word } from './prjModel';
import type { FileListItem } from './prjModel';
import { NoticePill, Pager, Provenance } from './prjParts';
import './prj.css';

const SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DETAIL_PATH = '/prj/prj-31';

/**
 * PRJ-30, the community monitoring files (G4-8, Law 58/2024 articles 78-79, numbers not confirmed): for each project the day the duty to notify began, the deadline of the notice (that day plus the days of the rule at that
 * time, never moved by a later change of the rule), the state of the notice and the feedback of the community that waits or is late. The investor opens a file for a project from here.
 */
export default function MonitoringListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OpenDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const open = useOpenFile();
  const [project, setProject] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('prj.monList.open.title')}
      context={[{ label: t('prj.monList.open.effect'), value: t('prj.monList.open.effect.value') }]}
      confirmLabel={t('prj.monList.open.confirm')}
      cancelLabel={t('prj.monList.open.cancel')}
      pending={open.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        if (!UUID.test(project.trim())) {
          setError(t('prj.common.error.validationFailed'));
          return;
        }
        open.mutate(
          { projectId: project.trim().toLowerCase() },
          {
            onSuccess: () => onClose(),
            onError: (failure) => setError(t(`prj.common.error.${refusalKey(failure)}`)),
          },
        );
      }}
    >
      <label className="prj-inline">
        {t('prj.monList.open.project')}
        <input type="text" value={project} data-testid="open-project" onChange={(event) => { setError(undefined); setProject(event.target.value); }} />
      </label>
    </ConfirmDialog>
  );
}

function ListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [status, setStatus] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [offset, setOffset] = useState(0);
  const [opening, setOpening] = useState(false);
  const query = useMonitoringFiles(status === 'ALL' ? undefined : status, offset, SIZE);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  const refreshFailed = query.isError && data !== undefined;
  const canManage = hasRight(permissions, 'project.monitoring.manage') && mode !== 'READ_ONLY';
  const asOf = data === undefined ? '' : dayText(data.as_of);
  const owner = tenant?.name ?? '–';

  const columns: DataTableColumn<FileListItem>[] = [
    {
      key: 'project',
      header: t('prj.monList.col.project'),
      pinned: true,
      render: (file) => (
        <>
          <Link to={`${DETAIL_PATH}?file=${file.id}`} data-testid={`file-${file.id}`}>
            <strong>{file.project_code ?? file.project_id}</strong>
          </Link>
          <div>{file.project_name ?? ''}</div>
        </>
      ),
    },
    { key: 'trigger', header: t('prj.monList.col.trigger'), render: (file) => (file.trigger === null ? t('prj.monList.noTrigger') : `${t(`prj.mon.trigger.${word(file.trigger.kind)}`)}: ${dayText(file.trigger.on)}`) },
    {
      key: 'due',
      header: t('prj.monList.col.due'),
      render: (file) =>
        file.notice.due_on === null ? (
          '–'
        ) : (
          <span className="prj-figure">
            <span data-testid={`due-${file.id}`}>{dayText(file.notice.due_on)}</span>
            <Provenance
              name={t('prj.mon.info.notice.name')}
              formula={t('prj.mon.info.notice.formula', { days: file.notice_days ?? 0 })}
              source={t('prj.mon.info.notice.source')}
              asOf={asOf}
              version={file.notice_rule_version ?? 0}
              unverified={(file.notice_rule_version ?? 0) === 0}
              owner={owner}
            />
          </span>
        ),
    },
    { key: 'notice', header: t('prj.monList.col.notice'), render: (file) => <NoticePill notice={file.notice} /> },
    { key: 'open', header: t('prj.monList.col.open'), align: 'right', render: (file) => file.summary.open },
    {
      key: 'overdue',
      header: t('prj.monList.col.overdue'),
      align: 'right',
      render: (file) => (
        <span className="prj-figure">
          <span data-testid={`overdue-${file.id}`}>{file.summary.overdue}</span>
          <Provenance
            name={t('prj.mon.info.response.name')}
            formula={t('prj.mon.info.response.formula')}
            source={t('prj.mon.info.notice.source')}
            asOf={asOf}
            version={0}
            unverified
            owner={owner}
          />
        </span>
      ),
    },
    { key: 'status', header: t('prj.monList.col.status'), render: (file) => <StatusPill tone={file.status === 'OPEN' ? 'info' : 'neutral'}>{t(`prj.common.file.${file.status.toLowerCase()}`)}</StatusPill> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.monList.page.title')}</h1>
          <p>{t('prj.monList.page.subtitle')}</p>
        </div>
        {canManage ? (
          <button type="button" className="ui-button ui-button--primary" data-testid="open-file" onClick={() => setOpening(true)}>
            {t('prj.monList.open.button')}
          </button>
        ) : null}
      </div>
      <ContextBar items={[{ label: t('prj.monList.context.scope'), value: owner }]} {...(data === undefined ? {} : { asOf: dayText(data.as_of) })} stale={refreshFailed} />
      <p className="callout" role="note" data-testid="unverified-note">
        {t('prj.monList.unverified')}
      </p>
      <label className="prj-inline">
        {t('prj.monList.filter.status')}
        <select
          value={status}
          data-testid="filter-status"
          onChange={(event) => {
            setOffset(0);
            setStatus(event.target.value as 'ALL' | 'OPEN' | 'CLOSED');
          }}
        >
          <option value="ALL">{t('prj.monList.filter.all')}</option>
          <option value="OPEN">{t('prj.common.file.open')}</option>
          <option value="CLOSED">{t('prj.common.file.closed')}</option>
        </select>
      </label>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <>
            <DataTable caption={t('prj.monList.table.caption')} columns={columns} rows={data.items} rowKey={(file) => file.id} />
            <Pager offset={offset} size={SIZE} hasMore={data.has_more} onOffset={setOffset} />
          </>
        )}
      </StateBoundary>
      {opening ? <OpenDialog onClose={() => setOpening(false)} /> : null}
      <p className="prototype-note">{t('prj.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
