import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { CountInfo, DeniedBlock, EmptyBlock, ErrorBlock, MoreRow, StatusChips } from '../int-common';
import { useProjectCodes, useSourceSystems } from '../int-hooks';
import { CODE_STATUSES, dayText, filtersOf, instantDay, instantText, searchOf } from '../int-model';
import type { ProjectCode, SourceSystem } from '../int-model';
import { CodeDialogs } from './CodeDialogs';
import type { CodeDialog } from './CodeDialogs';
import { codeStatusLabel, systemKindLabel } from './code-labels';
import { CODE_FILTERS } from './code-model';
import { CoverageStrip } from './CoverageStrip';
import '../int.css';

type T = Translator['t'];

const STATUS_TONE: Readonly<Record<string, Tone>> = { PROPOSED: 'info', ACTIVE: 'success', REJECTED: 'danger', RETIRED: 'neutral' };
const STATUS_ICON: Readonly<Record<string, string>> = { PROPOSED: '◔', ACTIVE: '✓', REJECTED: '✕', RETIRED: '○' };
const NEVER_EMPTY = (): boolean => false;

/**
 * INT-03, "Project codes across systems" (INT-1): the code each of our projects has in the other systems of the organization, on `master_crosswalk` (no table of external identities). A code is proposed by one
 * person and approved by another (never the person who proposed it); one code stands for one project at a time and a project holds one ACTIVE code per system; a code must fit the format its system declared.
 */
export default function CodesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters, the dialogs and the receipt belong to one membership: a switch of tenant or of membership starts the screen over.
  return <CodesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CodesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search, CODE_FILTERS), [search]);
  const list = useProjectCodes(filters);
  const systems = useSourceSystems();
  const [dialog, setDialog] = useState<CodeDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const frozen = mode === 'READ_ONLY';
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: NEVER_EMPTY });
  const denied = state === 'denied';
  const applied = Object.keys(filters).length;
  const total = first === undefined ? 0 : CODE_STATUSES.reduce((sum, status) => sum + first.counts[status], 0);
  const mayPropose = first?.can_propose === true && !frozen;
  const change = (next: Record<string, string | undefined>): void => setSearch(searchOf(next));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('int.codes.page.title')}</h1>
          <p>{t('int.codes.page.subtitle')}</p>
        </div>
        {mayPropose && !denied && (
          <div className="actions int-actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'propose' })}>
              {t('int.codes.action.propose')}
            </button>
          </div>
        )}
      </div>
      <p className="callout" data-testid="crosswalk-note">
        {t('int.codes.note.crosswalk')}
      </p>
      {receipt !== undefined && (
        <p className="callout int-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {first !== undefined && !first.can_propose && !denied && (
        <p className="callout" role="status" data-testid="readonly-note">
          {t('int.codes.readonly.notice')}
        </p>
      )}
      {denied ? (
        <DeniedBlock title={t('int.codes.denied.title')} body={t('int.codes.denied.body')} />
      ) : (
        <>
          <SectionCard
            title={t('int.codes.system.title')}
            status={
              systems.data === undefined ? undefined : (
                <span>
                  {t('int.codes.system.asOf', { time: instantText(systems.data.as_of) })}{' '}
                  <CountInfo name={t('int.codes.system.info.name')} formula={t('int.codes.system.info.formula')} source={t('int.codes.system.info.source')} asOf={instantText(systems.data.as_of)} owner={t('int.codes.system.info.owner')} />
                </span>
              )
            }
          >
            {systems.data?.can_register === true && !frozen && (
              <div className="int-actions">
                <button type="button" className="ui-button ui-button--outline" onClick={() => setDialog({ kind: 'register' })}>
                  {t('int.codes.system.action.register')}
                </button>
              </div>
            )}
            {systems.isError ? (
              <ErrorBlock title={t('int.codes.error.title')} body={t('int.codes.error.body')} onRetry={() => void systems.refetch()} />
            ) : (
              <DataTable
                caption={t('int.codes.system.caption')}
                columns={systemColumns(t, frozen, setDialog)}
                rows={systems.data?.items ?? []}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-system': row.code, 'data-status': row.status })}
                state={systems.isLoading ? 'loading' : 'ready'}
                emptyKind="none"
              />
            )}
          </SectionCard>
          <CoverageStrip coverage={first?.coverage} />
          <SectionCard
            title={t('int.codes.list.title')}
            status={
              first === undefined ? undefined : (
                <span>
                  {t('int.codes.list.asOf', { day: instantDay(first.as_of) })}{' '}
                  <CountInfo name={t('int.codes.info.name')} formula={t('int.codes.info.formula')} source={t('int.codes.info.source')} asOf={instantText(first.as_of)} owner={t('int.codes.info.owner')} />
                </span>
              )
            }
          >
            {first !== undefined && (total > 0 || applied > 0) && (
              <StatusChips
                statuses={CODE_STATUSES}
                counts={first.counts}
                active={filters.status}
                label={t('int.codes.chip.group.label')}
                allLabel={t('int.codes.chip.all', { count: total })}
                chipLabel={(status, count) => t('int.codes.chip.label', { label: codeStatusLabel(t, status), count })}
                onChoose={(status) => change({ ...filters, status })}
              />
            )}
            <FilterBar filters={filters} systems={first?.systems.map((system) => system.code) ?? []} onChange={change} />
            {state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
              <ErrorBlock title={t('int.codes.error.title')} body={t('int.codes.error.body')} onRetry={() => void list.refetch()} />
            ) : first !== undefined && applied === 0 && total === 0 && rows.length === 0 ? (
              <EmptyBlock title={t('int.codes.empty.title')} body={t('int.codes.empty.body')} />
            ) : (
              <>
                <DataTable
                  caption={t('int.codes.table.caption')}
                  columns={codeColumns(t, frozen, setDialog)}
                  rows={rows}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-code-id': row.id, 'data-status': row.status, 'data-external-code': row.external_code })}
                  severity={(row) => (row.actions.decide && !frozen ? 'ACTION' : null)}
                  state={state === 'loading' ? 'loading' : 'ready'}
                  emptyKind={applied > 0 ? 'filtered' : 'none'}
                  onClearFilters={() => change({})}
                />
                {first !== undefined && <MoreRow shown={rows.length} hasNext={list.hasNextPage} loading={list.isFetchingNextPage} failed={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />}
              </>
            )}
          </SectionCard>
        </>
      )}
      <CodeDialogs dialog={dialog} page={first} onClose={() => setDialog(undefined)} onDone={setReceipt} />
      <p className="prototype-note">{t('int.codes.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function FilterBar({ filters, systems, onChange }: { filters: Record<string, string | undefined>; systems: string[]; onChange: (next: Record<string, string | undefined>) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => setText(filters.q ?? ''), [filters.q]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onChange({ ...filters, q: text.trim() === '' ? undefined : text.trim() });
  };
  return (
    <form className="int-filters" role="search" aria-label={t('int.codes.filter.group.label')} onSubmit={submit}>
      <div className="field">
        <label htmlFor="int-codes-system">{t('int.codes.filter.system.label')}</label>
        <select id="int-codes-system" value={filters.source_system ?? ''} onChange={(event) => onChange({ ...filters, source_system: event.target.value === '' ? undefined : event.target.value })}>
          <option value="">{t('int.codes.filter.all.option')}</option>
          {systems.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="int-codes-q">{t('int.codes.filter.q.label')}</label>
        <input id="int-codes-q" type="search" value={text} autoComplete="off" onChange={(event) => setText(event.target.value)} />
      </div>
      <button type="submit" className="ui-button ui-button--outline">
        {t('int.codes.filter.apply.action')}
      </button>
    </form>
  );
}

function systemColumns(t: T, frozen: boolean, open: (dialog: CodeDialog) => void): Array<DataTableColumn<SourceSystem>> {
  return [
    { key: 'code', header: t('int.codes.system.column.code'), pinned: true, render: (row) => <span className="int-code">{row.code}</span> },
    { key: 'name', header: t('int.codes.system.column.name'), render: (row) => row.name },
    { key: 'kind', header: t('int.codes.system.column.kind'), render: (row) => systemKindLabel(t, row.kind) },
    { key: 'pattern', header: t('int.codes.system.column.pattern'), render: (row) => (row.code_pattern === null ? t('int.codes.cell.anyCode') : <code>{row.code_pattern}</code>) },
    { key: 'active', header: t('int.codes.system.column.active'), align: 'right', render: (row) => row.active_codes },
    { key: 'proposed', header: t('int.codes.system.column.proposed'), align: 'right', render: (row) => row.proposed_codes },
    { key: 'status', header: t('int.codes.system.column.status'), render: (row) => <StatusPill tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{row.status === 'ACTIVE' ? t('int.codes.system.status.active') : t('int.codes.system.status.retired')}</StatusPill> },
    {
      key: 'actions',
      header: t('int.codes.system.column.actions'),
      render: (row) =>
        !frozen && row.can_retire ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.codes.systemActionRetire.label', { code: row.code })} onClick={() => open({ kind: 'retireSystem', system: row })}>
            {t('int.codes.system.action.retire')}
          </button>
        ) : (
          <span className="int-words">{row.status === 'RETIRED' ? (row.retire_reason ?? '') : ''}</span>
        ),
    },
  ];
}

function codeColumns(t: T, frozen: boolean, open: (dialog: CodeDialog) => void): Array<DataTableColumn<ProjectCode>> {
  const none = t('int.codes.cell.none');
  const person = (name: string | null): string => name ?? none;
  return [
    { key: 'system', header: t('int.codes.column.system'), pinned: true, render: (row) => <span className="int-code">{row.source_system}</span> },
    {
      key: 'ours',
      header: t('int.codes.column.ours'),
      render: (row) => (
        <span className="int-cell">
          <span className="int-code">{row.project_code}</span>
          <small>{row.project_name}</small>
        </span>
      ),
    },
    { key: 'external', header: t('int.codes.column.external'), render: (row) => <span className="int-code">{row.external_code}</span> },
    { key: 'validity', header: t('int.codes.column.validity'), render: (row) => t('int.codes.cell.validity', { from: dayText(row.valid_from), until: row.valid_until === null ? t('int.codes.cell.unlimited') : dayText(row.valid_until) }) },
    {
      key: 'status',
      header: t('int.codes.column.status'),
      render: (row) => (
        <StatusPill tone={STATUS_TONE[row.status] ?? 'neutral'} icon={STATUS_ICON[row.status] ?? '○'}>
          {codeStatusLabel(t, row.status)}
        </StatusPill>
      ),
    },
    {
      key: 'people',
      header: t('int.codes.column.people'),
      render: (row) => {
        const reason = row.retire_reason ?? row.decision_reason ?? row.proposal_reason;
        return (
          <span className="int-cell">
            <small data-testid="proposed-by">{t('int.codes.cell.proposed', { name: person(row.proposed_by_name), day: instantDay(row.created_at) })}</small>
            {row.status !== 'PROPOSED' && row.approved_by_name !== null && (
              <small data-testid="decided-by">{t(row.status === 'REJECTED' ? 'int.codes.cell.rejected' : 'int.codes.cell.approved', { name: row.approved_by_name, day: instantDay(row.approved_at) })}</small>
            )}
            {row.retired_by_name !== null && <small data-testid="retired-by">{t('int.codes.cell.retired', { name: row.retired_by_name, day: instantDay(row.retired_at) })}</small>}
            {reason !== null && <small>{t('int.codes.cell.reason', { reason })}</small>}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: t('int.codes.column.actions'),
      render: (row) => {
        const labels = { code: row.project_code, external: row.external_code };
        return (
          <span className="int-row-actions">
            {!frozen && row.actions.decide && (
              <>
                <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('int.codes.action.approve.label', labels)} onClick={() => open({ kind: 'decide', code: row, decision: 'APPROVE' })}>
                  {t('int.codes.action.approve')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.codes.action.reject.label', labels)} onClick={() => open({ kind: 'decide', code: row, decision: 'REJECT' })}>
                  {t('int.codes.action.reject')}
                </button>
              </>
            )}
            {!frozen && row.actions.retire && (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('int.codes.action.retire.label', labels)} onClick={() => open({ kind: 'retire', code: row })}>
                {t('int.codes.action.retire')}
              </button>
            )}
            {row.status === 'PROPOSED' && !row.actions.decide && <span className="int-words">{t('int.codes.row.waiting')}</span>}
          </span>
        );
      },
    },
  ];
}
