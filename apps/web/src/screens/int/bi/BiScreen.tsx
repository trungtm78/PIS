import { useMemo, useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { CountInfo, DeniedBlock, EmptyBlock, ErrorBlock, MoreRow, SecretDialog } from '../int-common';
import { useBiReader, useBiReaders, useExportDatasets } from '../int-hooks';
import { dayText, instantText } from '../int-model';
import type { BiReader, ExportDataset } from '../int-model';
import { BiDialogs } from './BiDialogs';
import type { BiDialog, BiOutcome } from './BiDialogs';
import { datasetLabel, eventLabel, gateReasonLabel, readerStatusLabel } from './bi-labels';
import '../int.css';

type T = Translator['t'];
type SecretOutcome = Extract<BiOutcome, { kind: 'secret' }>;

const READER_TONE: Readonly<Record<string, Tone>> = { ACTIVE: 'success', SUSPENDED: 'warning', RETIRED: 'neutral' };
const NEVER_EMPTY = (): boolean => false;

/**
 * INT-04, "BI logins and certified datasets" (INT-1, R6 and R13): what leaves the platform for Lakehouse and Power BI. A dataset leaves only while the organization has switched it on AND its data product is
 * CERTIFIED and in date. A BI tool connects with ONE database login per organization, read-only, bound to the organization by its own name (never by the session setting `app.tenant_id`, which a login can change);
 * the password is shown once and the database keeps only a verifier of it.
 */
export default function BiScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The dialogs and the password belong to one membership: a switch of tenant or of membership starts the screen over (and drops a password).
  return <BiContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BiContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const readers = useBiReaders();
  const datasets = useExportDatasets();
  const [dialog, setDialog] = useState<BiDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [secret, setSecret] = useState<SecretOutcome | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const frozen = mode === 'READ_ONLY';
  const pages = readers.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: readers.isLoading, error: readers.data === undefined ? readers.error : undefined, data: readers.data, isEmpty: NEVER_EMPTY });
  const datasetState = useScreenState({ isLoading: datasets.isLoading, error: datasets.data === undefined ? datasets.error : undefined, data: datasets.data, isEmpty: NEVER_EMPTY });
  const denied = state === 'denied' && datasetState === 'denied';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('int.bi.page.title')}</h1>
          <p>{t('int.bi.page.subtitle')}</p>
        </div>
        {first?.can_create === true && !frozen && !denied && (
          <div className="actions int-actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'create' })}>
              {t('int.bi.action.create')}
            </button>
          </div>
        )}
      </div>
      <p className="callout" data-testid="binding-note">
        {t('int.bi.note.binding')}
      </p>
      {receipt !== undefined && (
        <p className="callout int-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {first !== undefined && !first.can_create && !denied && (
        <p className="callout" role="status" data-testid="readonly-note">
          {t('int.bi.readonly.notice')}
        </p>
      )}
      {denied ? (
        <DeniedBlock title={t('int.bi.denied.title')} body={t('int.bi.denied.body')} />
      ) : (
        <>
          <SectionCard
            title={t('int.bi.dataset.title')}
            status={
              datasets.data === undefined ? undefined : (
                <span>
                  {t('int.bi.dataset.asOf', { time: instantText(datasets.data.as_of) })}{' '}
                  <CountInfo name={t('int.bi.dataset.info.name')} formula={t('int.bi.dataset.info.formula')} source={t('int.bi.dataset.info.source')} asOf={instantText(datasets.data.as_of)} owner={t('int.bi.dataset.info.owner')} />
                </span>
              )
            }
          >
            {datasetState === 'error' || datasetState === 'offline' || datasetState === 'signedOut' || datasetState === 'expired' ? (
              <ErrorBlock title={t('int.bi.error.title')} body={t('int.bi.error.body')} onRetry={() => void datasets.refetch()} />
            ) : datasetState === 'denied' ? (
              <DeniedBlock title={t('int.bi.dataset.denied.title')} body={t('int.bi.dataset.denied.body')} />
            ) : (
              <DataTable
                caption={t('int.bi.dataset.caption')}
                columns={datasetColumns(t, frozen, setDialog)}
                rows={datasets.data?.items ?? []}
                rowKey={(row) => row.dataset_code}
                rowAttrs={(row) => ({ 'data-dataset': row.dataset_code, 'data-open': String(row.gate.open) })}
                state={datasetState === 'loading' ? 'loading' : 'ready'}
                emptyKind="none"
              />
            )}
          </SectionCard>
          <SectionCard
            title={t('int.bi.list.title')}
            status={
              first === undefined ? undefined : (
                <span>
                  {t('int.bi.list.asOf', { time: instantText(first.as_of) })}{' '}
                  <CountInfo name={t('int.bi.info.name')} formula={t('int.bi.info.formula')} source={t('int.bi.info.source')} asOf={instantText(first.as_of)} owner={t('int.bi.info.owner')} />
                </span>
              )
            }
          >
            {first !== undefined && (
              <p className="sub" data-testid="schema-note">
                {t('int.bi.list.schema', { schema: first.schema_name, views: first.views.map((view) => view.view).join(', ') })}
              </p>
            )}
            {state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
              <ErrorBlock title={t('int.bi.error.title')} body={t('int.bi.error.body')} onRetry={() => void readers.refetch()} />
            ) : first !== undefined && rows.length === 0 ? (
              <EmptyBlock title={t('int.bi.empty.title')} body={t('int.bi.empty.body')} />
            ) : (
              <>
                <DataTable
                  caption={t('int.bi.table.caption')}
                  columns={readerColumns(t, frozen, setDialog, setSelected)}
                  rows={rows}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-reader-id': row.id, 'data-status': row.status })}
                  state={state === 'loading' ? 'loading' : 'ready'}
                  emptyKind="none"
                />
                {first !== undefined && <MoreRow shown={rows.length} hasNext={readers.hasNextPage} loading={readers.isFetchingNextPage} failed={readers.isFetchNextPageError} onMore={() => void readers.fetchNextPage()} />}
              </>
            )}
          </SectionCard>
          {selected !== undefined && <ReaderHistory id={selected} onClose={() => setSelected(undefined)} />}
          {first !== undefined && (
            <SectionCard title={t('int.bi.views.title')}>
              <p className="sub">{t('int.bi.views.intro', { schema: first.schema_name })}</p>
              {first.views.map((view) => (
                <div key={view.view} className="int-section" data-testid="view-entry">
                  <h3>
                    {datasetLabel(t, view.dataset_code)} <StatusPill tone={view.open ? 'success' : 'warning'}>{view.open ? t('int.bi.views.open') : t('int.bi.views.closed')}</StatusPill>
                  </h3>
                  <p className="sub">{`${first.schema_name}.${view.view} - ${view.grain}`}</p>
                  <ul className="int-columns" aria-label={t('int.bi.views.columns.label', { view: view.view })}>
                    {view.columns.map((column) => (
                      <li key={column}>{column}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </SectionCard>
          )}
        </>
      )}
      <BiDialogs
        dialog={dialog}
        datasets={datasets.data}
        onClose={() => setDialog(undefined)}
        onDone={(outcome) => {
          if (outcome.kind === 'secret') {
            setReceipt(undefined);
            setSecret(outcome);
          } else {
            setReceipt(outcome.text);
          }
        }}
      />
      {secret !== undefined && (
        <SecretDialog
          title={secret.title === 'created' ? t('int.bi.secret.created.title', { name: secret.readerName }) : t('int.bi.secret.rotated.title', { name: secret.readerName })}
          intro={t('int.bi.secret.intro', { schema: secret.schemaName })}
          items={[
            { label: t('int.bi.secret.login.label'), value: secret.loginName },
            { label: t('int.bi.secret.password.label'), value: secret.password },
          ]}
          onClose={() => {
            setSecret(undefined);
            setReceipt(secret.title === 'created' ? t('int.bi.success.created', { name: secret.readerName }) : t('int.bi.success.rotated', { name: secret.readerName }));
          }}
        />
      )}
      <p className="prototype-note">{t('int.bi.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ReaderHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useBiReader(id);
  return (
    <SectionCard title={t('int.bi.history.title', { name: detail.data?.reader.name ?? '' })} status={<button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>{t('int.bi.history.close.action')}</button>}>
      {detail.isError ? (
        <ErrorBlock title={t('int.bi.error.title')} body={t('int.bi.error.body')} onRetry={() => void detail.refetch()} />
      ) : detail.data === undefined ? (
        <p role="status">{t('int.bi.history.loading')}</p>
      ) : (
        <ul className="int-columns" aria-label={t('int.bi.history.label')} data-testid="history">
          {detail.data.events.map((event) => (
            <li key={event.id}>{t('int.bi.history.entry', { action: eventLabel(t, event.action), actor: event.actor_name ?? t('int.bi.cell.none'), time: instantText(event.occurred_at), reason: event.reason ?? '' })}</li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function datasetColumns(t: T, frozen: boolean, open: (dialog: BiDialog) => void): Array<DataTableColumn<ExportDataset>> {
  const none = t('int.bi.cell.none');
  return [
    { key: 'dataset', header: t('int.bi.dataset.column.dataset'), pinned: true, render: (row) => <span className="int-cell"><span className="int-code">{datasetLabel(t, row.dataset_code)}</span><small>{row.dataset_code}</small></span> },
    { key: 'view', header: t('int.bi.dataset.column.view'), render: (row) => <code>{row.view_name}</code> },
    { key: 'product', header: t('int.bi.dataset.column.product'), render: (row) => (row.product_code === null ? none : row.product_code) },
    { key: 'certification', header: t('int.bi.dataset.column.certification'), render: (row) => (row.certification === null ? none : row.certification) },
    { key: 'expires', header: t('int.bi.dataset.column.expires'), render: (row) => (row.certification_expires_on === null ? none : dayText(row.certification_expires_on)) },
    {
      key: 'gate',
      header: t('int.bi.dataset.column.gate'),
      render: (row) => (
        <span className="int-cell">
          <StatusPill tone={row.gate.open ? 'success' : 'warning'} icon={row.gate.open ? '✓' : '○'}>
            {row.gate.open ? t('int.bi.gate.open') : t('int.bi.gate.closed')}
          </StatusPill>
          {!row.gate.open && <small>{gateReasonLabel(t, row.gate.reason)}</small>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('int.bi.dataset.column.actions'),
      render: (row) =>
        !frozen && row.can_set ? (
          <span className="int-row-actions">
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.bi.datasetActionEnable.label', { name: datasetLabel(t, row.dataset_code) })} onClick={() => open({ kind: 'dataset', dataset: row, enable: true })}>
              {row.enabled ? t('int.bi.dataset.action.change') : t('int.bi.dataset.action.enable')}
            </button>
            {row.enabled && (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.bi.datasetActionDisable.label', { name: datasetLabel(t, row.dataset_code) })} onClick={() => open({ kind: 'dataset', dataset: row, enable: false })}>
                {t('int.bi.dataset.action.disable')}
              </button>
            )}
          </span>
        ) : (
          <span className="int-words">{none}</span>
        ),
    },
  ];
}

function readerColumns(t: T, frozen: boolean, open: (dialog: BiDialog) => void, select: (id: string) => void): Array<DataTableColumn<BiReader>> {
  const none = t('int.bi.cell.none');
  return [
    { key: 'name', header: t('int.bi.column.name'), pinned: true, render: (row) => <span className="int-code">{row.name}</span> },
    { key: 'tool', header: t('int.bi.column.tool'), render: (row) => row.tool ?? none },
    { key: 'login', header: t('int.bi.column.login'), render: (row) => <code>{row.login_name}</code> },
    {
      key: 'status',
      header: t('int.bi.column.status'),
      render: (row) => (
        <span className="int-cell">
          <StatusPill tone={READER_TONE[row.status] ?? 'neutral'}>{readerStatusLabel(t, row.status)}</StatusPill>
          {row.status_reason !== null && <small>{t('int.bi.cell.reason', { reason: row.status_reason })}</small>}
        </span>
      ),
    },
    { key: 'limit', header: t('int.bi.column.limit'), align: 'right', render: (row) => row.connection_limit },
    { key: 'rotated', header: t('int.bi.column.rotated'), render: (row) => instantText(row.password_rotated_at) },
    {
      key: 'actions',
      header: t('int.bi.column.actions'),
      render: (row) => (
        <span className="int-row-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.bi.action.history.label', { name: row.name })} onClick={() => select(row.id)}>
            {t('int.bi.action.history')}
          </button>
          {!frozen && row.actions.rotate && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.bi.action.rotate.label', { name: row.name })} onClick={() => open({ kind: 'rotate', reader: row })}>
              {t('int.bi.action.rotate')}
            </button>
          )}
          {!frozen && row.actions.decide && row.status === 'ACTIVE' && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.bi.action.suspend.label', { name: row.name })} onClick={() => open({ kind: 'decide', reader: row, decision: 'SUSPEND' })}>
              {t('int.bi.action.suspend')}
            </button>
          )}
          {!frozen && row.actions.decide && row.status === 'SUSPENDED' && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.bi.action.reactivate.label', { name: row.name })} onClick={() => open({ kind: 'decide', reader: row, decision: 'REACTIVATE' })}>
              {t('int.bi.action.reactivate')}
            </button>
          )}
          {!frozen && row.actions.decide && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.bi.action.retire.label', { name: row.name })} onClick={() => open({ kind: 'decide', reader: row, decision: 'RETIRE' })}>
              {t('int.bi.action.retire')}
            </button>
          )}
        </span>
      ),
    },
  ];
}
