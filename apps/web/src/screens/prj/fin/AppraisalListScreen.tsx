import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import { useAppraisalList, useCreateAppraisal } from './hooks';
import { asOfText, decimalText, idFrom, isId, workbenchPath } from './model';
import type { ListItem } from './model';
import './fin.css';

const statusTone = (status: string): 'neutral' | 'info' | 'success' => (status === 'APPROVED' ? 'success' : status === 'SUBMITTED' ? 'info' : 'neutral');
const stateTone = (state: string): 'neutral' | 'warning' | 'success' => (state === 'FROZEN' ? 'success' : state === 'COMPUTED' ? 'warning' : 'neutral');

/**
 * PRJ-23: the appraisals of the effectiveness of investments in the scope of the viewer (lane FIN-1, AI.06). The figures in a row are the results the server computed: frozen at approval for an approved
 * appraisal, "tentative" for a draft or a submission (they may be out of date), and none when nothing was computed. Nothing is computed here. An approved appraisal changes only by a new version.
 */
export default function AppraisalListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ListContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode } = useSession();
  const [params] = useSearchParams();
  const projectId = idFrom(params.get('project'));
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useAppraisalList({ status, kind, q, projectId, offset });
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const data = list.data ?? undefined;
  const filtered = status !== '' || kind !== '' || q.trim() !== '' || projectId !== undefined;
  const writable = mode !== 'READ_ONLY';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('fin1.list.title')}</h1>
          <p>{t('fin1.list.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('fin1.ctx.scope'), value: tenant?.name ?? t('fin1.ctx.scope.all') }]} unit={t('fin1.unit.vnd')} {...(data === undefined ? {} : { asOf: asOfText(data.asOf) })} />
      <FilterPanel applied={[status, kind, q.trim(), projectId ?? ''].filter((value) => value !== '').length}>
        <label className="fin1-field">
          {t('fin1.list.filter.status')}
          <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }} data-testid="filter-status">
            <option value="">{t('fin1.list.filter.any')}</option>
            <option value="DRAFT">{t('fin1.status.draft')}</option>
            <option value="SUBMITTED">{t('fin1.status.submitted')}</option>
            <option value="APPROVED">{t('fin1.status.approved')}</option>
          </select>
        </label>
        <label className="fin1-field">
          {t('fin1.list.filter.kind')}
          <select value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); }} data-testid="filter-kind">
            <option value="">{t('fin1.list.filter.any')}</option>
            <option value="FINANCIAL">{t('fin1.kind.financial')}</option>
            <option value="NON_FINANCIAL">{t('fin1.kind.nonFinancial')}</option>
          </select>
        </label>
        <label className="fin1-field">
          {t('fin1.list.filter.search')}
          <input value={q} onChange={(event) => { setQ(event.target.value); setOffset(0); }} data-testid="filter-q" />
        </label>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {data === undefined ? null : (
          <>
            {data.canCreate && writable ? <CreateForm projectId={projectId} /> : null}
            <SectionCard title={t('fin1.list.table.title', { total: data.total })} unit={t('fin1.unit.vnd')}>
              <DataTable<ListItem>
                caption={t('fin1.list.table.title', { total: data.total })}
                rows={data.items}
                rowKey={(row) => row.id}
                state={data.items.length === 0 ? 'empty' : 'ready'}
                emptyKind={filtered ? 'filtered' : 'none'}
                onClearFilters={() => {
                  setStatus('');
                  setKind('');
                  setQ('');
                  setOffset(0);
                }}
                page={{ from: data.items.length === 0 ? 0 : offset + 1, to: offset + data.items.length, total: data.total, size: 50, index: Math.floor(offset / 50), onPage: (index) => setOffset(index * 50), onSize: () => undefined }}
                columns={[
                  { key: 'code', header: t('fin1.list.col.code'), pinned: true, render: (row) => <Link to={workbenchPath(row.id)}>{`${row.code} · ${t('fin1.ctx.revision', { revision: row.revision })}`}</Link> },
                  { key: 'title', header: t('fin1.list.col.title'), render: (row) => row.title },
                  { key: 'kind', header: t('fin1.list.col.kind'), render: (row) => t(`fin1.kind.${row.kind === 'FINANCIAL' ? 'financial' : 'nonFinancial'}`) },
                  { key: 'link', header: t('fin1.list.col.link'), render: (row) => [row.project?.code, row.package?.code, row.contract?.code].filter((part): part is string => part !== undefined).join(' · ') || row.ownerUnit.code },
                  { key: 'status', header: t('fin1.list.col.status'), render: (row) => <StatusPill tone={statusTone(row.status)}>{t(`fin1.status.${row.status.toLowerCase()}`)}</StatusPill> },
                  { key: 'state', header: t('fin1.list.col.state'), render: (row) => <StatusPill tone={stateTone(row.resultState)}>{t(`fin1.results.state.${row.resultState.toLowerCase()}`)}</StatusPill> },
                  { key: 'npv', header: t('fin1.measure.npv'), align: 'right', render: (row) => (row.npv === null ? '' : decimalText(row.npv, locale)) },
                  { key: 'irr', header: t('fin1.measure.irr'), align: 'right', render: (row) => (row.irrPct === null ? '' : `${decimalText(row.irrPct, locale)}%`) },
                  { key: 'payback', header: t('fin1.measure.payback'), align: 'right', render: (row) => (row.paybackPeriods === null ? '' : decimalText(row.paybackPeriods, locale)) },
                  { key: 'index', header: t('fin1.list.col.index'), align: 'right', render: (row) => (row.indexPct === null ? '' : `${decimalText(row.indexPct, locale)}%`) },
                  { key: 'who', header: t('fin1.list.col.who'), render: (row) => `${row.createdByName ?? ''}${row.approvedByName === null ? '' : ` → ${row.approvedByName}`}` },
                ]}
              />
              <p className="muted">{t('fin1.list.note')}</p>
            </SectionCard>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('fin1.list.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** Opens a draft: a title, a kind, and the project or the unit that answers for it; the server judges the scope and the links again. */
function CreateForm({ projectId }: { projectId: string | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateAppraisal();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('FINANCIAL');
  const [project, setProject] = useState(projectId ?? '');
  const [unit, setUnit] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const valid = title.trim() !== '' && ((project.trim() !== '' && isId(project)) || (project.trim() === '' && isId(unit)));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    setError(undefined);
    create.mutate(
      { body: { title: title.trim(), kind, ...(project.trim() === '' ? { owner_unit_id: unit.trim().toLowerCase() } : { project_id: project.trim().toLowerCase() }) } },
      {
        onSuccess: (done) => {
          if (done.resource_id !== undefined) navigate(workbenchPath(done.resource_id));
        },
        onError: (failure) => setError(failure instanceof ApiError ? t('fin1.error.refused', { code: failure.code }) : t('fin1.error.failed')),
      },
    );
  };
  return (
    <SectionCard title={t('fin1.create.title')}>
      <form onSubmit={submit} className="fin1-form" aria-label={t('fin1.create.title')}>
        <label className="fin1-field">
          {t('fin1.create.name')}
          <input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="create-title" />
        </label>
        <label className="fin1-field">
          {t('fin1.create.kind')}
          <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="create-kind">
            <option value="FINANCIAL">{t('fin1.kind.financial')}</option>
            <option value="NON_FINANCIAL">{t('fin1.kind.nonFinancial')}</option>
          </select>
        </label>
        <label className="fin1-field">
          {t('fin1.create.project')}
          <input value={project} onChange={(event) => setProject(event.target.value.trim())} aria-invalid={project !== '' && !isId(project)} data-testid="create-project" />
        </label>
        <label className="fin1-field">
          {t('fin1.create.unit')}
          <input value={unit} onChange={(event) => setUnit(event.target.value.trim())} disabled={project !== ''} aria-invalid={unit !== '' && !isId(unit)} data-testid="create-unit" />
        </label>
        <p className="muted">{t('fin1.create.note')}</p>
        {error === undefined ? null : (
          <p className="callout fin1-error" role="alert" data-testid="create-error">
            {error}
          </p>
        )}
        <button type="submit" className="ui-button ui-button--primary" disabled={!valid || create.isPending} data-testid="create-submit">
          {create.isPending ? t('fin1.common.sending') : t('fin1.create.submit')}
        </button>
      </form>
    </SectionCard>
  );
}
