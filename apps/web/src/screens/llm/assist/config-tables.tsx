import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog, DataTable, StatusPill } from '../../../ui';
import { DetailDrawer, Facts, SectionDenied, SectionFailed } from './assist-components';
import { usePublishChecklist, usePublishCriteria, useReload } from './assist-hooks';
import { checkKindLabel, configStatusLabel, configStatusTone, errorText, severityLabel, severityTone } from './assist-labels';
import { WEIGHT_TOTAL_BP, bpPercent, failureStatus, isVersionConflict, paramsSummary, shortId, stamp, weightState } from './assist-model';
import type { Checklist, CriteriaSet } from './assist-model';

interface ListState {
  isLoading: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface PanelProps<T> {
  rows: T[];
  list: ListState;
  /** The membership may publish a draft (another person than its author: the server decides). */
  mayPublish: boolean;
  onPublish: (row: T) => void;
  onOpen: (row: T) => void;
}

/** What a list shows while it has no rows: the part the membership may not read, the failed read with its retry in place, or the table in its own states. */
function Frame({ list, what, children }: { list: ListState; what: string; children: ReactNode }) {
  if (failureStatus(list.error) === 403) return <SectionDenied what={what} />;
  if (list.error !== null && list.error !== undefined) return <SectionFailed what={what} onRetry={() => void list.refetch()} />;
  return <>{children}</>;
}

export function ChecklistTable({ rows, list, mayPublish, onPublish, onOpen }: PanelProps<Checklist>) {
  const { t } = useTranslation();
  return (
    <Frame list={list} what={t('llm.config.tab.checklists')}>
      <DataTable<Checklist>
        caption={t('llm.config.checklist.caption')}
        rows={rows}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-checklist-id': row.id, 'data-status': row.status })}
        state={list.isLoading ? 'loading' : 'ready'}
        columns={[
          { key: 'code', header: t('llm.config.column.code'), pinned: true, render: (row) => <code>{row.code}</code> },
          { key: 'revision', header: t('llm.config.column.revision'), align: 'right', render: (row) => row.revision },
          { key: 'title', header: t('llm.config.column.title'), render: (row) => row.title },
          { key: 'applies', header: t('llm.config.column.appliesTo'), render: (row) => row.appliesTo },
          { key: 'items', header: t('llm.config.column.items'), align: 'right', render: (row) => row.items.length },
          { key: 'status', header: t('llm.config.column.status'), render: (row) => <StatusPill tone={configStatusTone(row.status)}>{configStatusLabel(t, row.status)}</StatusPill> },
          { key: 'author', header: t('llm.config.column.author'), render: (row) => shortId(row.createdBy) },
          { key: 'publisher', header: t('llm.config.column.publisher'), render: (row) => (row.publishedBy === null ? '–' : shortId(row.publishedBy)) },
          {
            key: 'actions',
            header: t('llm.config.column.actions'),
            render: (row) => (
              <span className="assist-actions">
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onOpen(row)}>
                  {t('llm.config.action.details', { code: row.code })}
                </button>
                {mayPublish && row.status === 'DRAFT' ? (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => onPublish(row)}>
                    {t('llm.config.action.publish', { code: row.code })}
                  </button>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </Frame>
  );
}

export function CriteriaTable({ rows, list, mayPublish, onPublish, onOpen }: PanelProps<CriteriaSet>) {
  const { t } = useTranslation();
  return (
    <Frame list={list} what={t('llm.config.tab.criteria')}>
      <DataTable<CriteriaSet>
        caption={t('llm.config.criteria.caption')}
        rows={rows}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-criteria-id': row.id, 'data-status': row.status })}
        state={list.isLoading ? 'loading' : 'ready'}
        columns={[
          { key: 'code', header: t('llm.config.column.code'), pinned: true, render: (row) => <code>{row.code}</code> },
          { key: 'revision', header: t('llm.config.column.revision'), align: 'right', render: (row) => row.revision },
          { key: 'title', header: t('llm.config.column.title'), render: (row) => row.title },
          { key: 'scale', header: t('llm.config.column.scale'), align: 'right', render: (row) => row.scaleMax },
          { key: 'count', header: t('llm.config.column.criteria'), align: 'right', render: (row) => row.criteria.length },
          {
            key: 'weights',
            header: t('llm.config.column.weights'),
            align: 'right',
            render: (row) => (
              <StatusPill tone={weightState(row.weightsTotalBp) === 'COMPLETE' ? 'success' : 'warning'}>
                {row.weightsTotalBp}/{WEIGHT_TOTAL_BP}
              </StatusPill>
            ),
          },
          { key: 'status', header: t('llm.config.column.status'), render: (row) => <StatusPill tone={configStatusTone(row.status)}>{configStatusLabel(t, row.status)}</StatusPill> },
          { key: 'author', header: t('llm.config.column.author'), render: (row) => shortId(row.createdBy) },
          { key: 'publisher', header: t('llm.config.column.publisher'), render: (row) => (row.publishedBy === null ? '–' : shortId(row.publishedBy)) },
          {
            key: 'actions',
            header: t('llm.config.column.actions'),
            render: (row) => (
              <span className="assist-actions">
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onOpen(row)}>
                  {t('llm.config.action.details', { code: row.code })}
                </button>
                {mayPublish && row.status === 'DRAFT' ? (
                  <button type="button" className="ui-button ui-button--primary ui-button--small" disabled={weightState(row.weightsTotalBp) !== 'COMPLETE'} onClick={() => onPublish(row)}>
                    {t('llm.config.action.publish', { code: row.code })}
                  </button>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </Frame>
  );
}

// ---- the detail drawers ------------------------------------------------------------------------------------------------------------------------------------------------------

export function ChecklistDrawer({ row, onClose }: { row: Checklist; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <DetailDrawer title={t('llm.config.drawer.checklist', { code: row.code, revision: row.revision })} onClose={onClose}>
      <Facts
        items={[
          { label: t('llm.config.column.title'), value: row.title },
          { label: t('llm.config.column.appliesTo'), value: row.appliesTo },
          { label: t('llm.config.column.status'), value: <StatusPill tone={configStatusTone(row.status)}>{configStatusLabel(t, row.status)}</StatusPill> },
          { label: t('llm.config.column.author'), value: `${shortId(row.createdBy)} · ${stamp(row.createdAt)}` },
          { label: t('llm.config.column.publisher'), value: row.publishedBy === null ? '–' : `${shortId(row.publishedBy)} · ${stamp(row.publishedAt)}` },
        ]}
      />
      {row.status === 'PUBLISHED' ? <p className="sub">{t('llm.config.drawer.locked')}</p> : null}
      <DataTable
        caption={t('llm.config.drawer.itemsCaption')}
        rows={row.items}
        rowKey={(item) => item.code}
        columns={[
          { key: 'code', header: t('llm.config.item.code'), pinned: true, render: (item) => <code>{item.code}</code> },
          { key: 'label', header: t('llm.config.item.label'), render: (item) => item.label },
          { key: 'kind', header: t('llm.config.item.kind'), render: (item) => checkKindLabel(t, item.kind) },
          { key: 'severity', header: t('llm.config.item.severity'), render: (item) => <StatusPill tone={severityTone(item.severity)}>{severityLabel(t, item.severity)}</StatusPill> },
          { key: 'params', header: t('llm.config.drawer.params'), render: (item) => <span className="assist-param">{paramsSummary(item)}</span> },
        ]}
      />
    </DetailDrawer>
  );
}

export function CriteriaDrawer({ row, onClose }: { row: CriteriaSet; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <DetailDrawer title={t('llm.config.drawer.criteria', { code: row.code, revision: row.revision })} onClose={onClose}>
      <Facts
        items={[
          { label: t('llm.config.column.title'), value: row.title },
          { label: t('llm.config.column.scale'), value: String(row.scaleMax) },
          { label: t('llm.config.column.weights'), value: `${row.weightsTotalBp}/${WEIGHT_TOTAL_BP} (${bpPercent(row.weightsTotalBp)})` },
          { label: t('llm.config.column.status'), value: <StatusPill tone={configStatusTone(row.status)}>{configStatusLabel(t, row.status)}</StatusPill> },
          { label: t('llm.config.column.author'), value: `${shortId(row.createdBy)} · ${stamp(row.createdAt)}` },
          { label: t('llm.config.column.publisher'), value: row.publishedBy === null ? '–' : `${shortId(row.publishedBy)} · ${stamp(row.publishedAt)}` },
        ]}
      />
      {row.status === 'PUBLISHED' ? <p className="sub">{t('llm.config.drawer.locked')}</p> : null}
      <DataTable
        caption={t('llm.config.drawer.criteriaCaption')}
        rows={row.criteria}
        rowKey={(criterion) => criterion.code}
        columns={[
          { key: 'code', header: t('llm.config.item.code'), pinned: true, render: (criterion) => <code>{criterion.code}</code> },
          { key: 'label', header: t('llm.config.item.label'), render: (criterion) => criterion.label },
          { key: 'weight', header: t('llm.config.criteria.weight'), align: 'right', render: (criterion) => `${criterion.weightBp} (${bpPercent(criterion.weightBp)})` },
          { key: 'evidence', header: t('llm.config.criteria.evidenceColumn'), render: (criterion) => (criterion.evidenceRequired ? t('llm.config.yes') : t('llm.config.no')) },
          { key: 'guidance', header: t('llm.config.criteria.guidance'), render: (criterion) => criterion.guidance },
        ]}
      />
    </DetailDrawer>
  );
}

// ---- publishing ------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type PublishTarget = { kind: 'checklist'; row: Checklist } | { kind: 'criteria'; row: CriteriaSet };

export interface PublishDialogProps {
  target: PublishTarget;
  onClose: () => void;
  onDone: (receipt: string) => void;
}

/** Publishes a draft under the version the person saw (If-Match). A refusal is said inside the dialog; a version that moved offers the reading again; one press sends once. */
export function PublishDialog({ target, onClose, onDone }: PublishDialogProps) {
  const { t } = useTranslation();
  const publishChecklist = usePublishChecklist();
  const publishCriteria = usePublishCriteria();
  const reload = useReload();
  const [failure, setFailure] = useState<unknown>(undefined);
  const sending = useRef(false);
  const row = target.row;
  const pending = publishChecklist.isPending || publishCriteria.isPending;
  const confirm = (): void => {
    if (sending.current) return;
    sending.current = true;
    setFailure(undefined);
    const callbacks = {
      onSuccess: () => {
        sending.current = false;
        onClose();
        onDone(t('llm.config.publish.done', { code: row.code, revision: row.revision }));
      },
      onError: (error: unknown) => {
        sending.current = false;
        setFailure(error);
      },
    };
    if (target.kind === 'checklist') publishChecklist.mutate({ id: row.id, version: row.version }, callbacks);
    else publishCriteria.mutate({ id: row.id, version: row.version }, callbacks);
  };
  return (
    <ConfirmDialog
      open
      title={t('llm.config.publish.title', { code: row.code, revision: row.revision })}
      context={[
        { label: t('llm.config.column.code'), value: row.code },
        { label: t('llm.config.column.revision'), value: String(row.revision) },
        { label: t('llm.config.column.title'), value: row.title },
        { label: t('llm.config.column.author'), value: shortId(row.createdBy) },
      ]}
      confirmLabel={t('llm.config.publish.confirm')}
      cancelLabel={t('llm.config.dialog.cancel')}
      pending={pending}
      {...(failure === undefined ? {} : { error: errorText(t, failure) })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <p className="assist-note">{t('llm.config.publish.note')}</p>
      {isVersionConflict(failure) ? (
        <button
          type="button"
          className="ui-button ui-button--outline ui-button--small"
          onClick={() => {
            reload();
            onClose();
          }}
        >
          {t('llm.config.dialog.reload')}
        </button>
      ) : null}
    </ConfirmDialog>
  );
}
