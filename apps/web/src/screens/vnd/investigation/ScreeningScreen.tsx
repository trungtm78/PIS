import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import { errorText } from '../shared/vnd-labels';
import { PATHS, isUuid } from '../shared/vnd-model';
import { Fact, PartialNotice, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { useScreening, useScreeningHit, useVendorCommand } from './investigation-hooks';
import { hitBasisLabel, hitClockLabel, hitMoveLabel, hitStatusLabel, sourceLabel } from './investigation-labels';
import { HIT_SOURCES, HIT_STATUSES, INV_PATHS, INV_PERMISSION, dayText, hitTone, numberText, percentText, vietnamStamp } from './investigation-model';
import type { HitDetail, HitLine, ScreeningOverview } from './investigation-model';
import { ConfirmHitDialog, DismissHitDialog, ImportListDialog } from './screening-dialogs';
import './investigation.css';

interface Filters {
  status: string;
  source: string;
  contractor: string;
}

const NO_FILTERS: Filters = { status: '', source: '', contractor: '' };
const applied = (filters: Filters): number => [filters.status !== '', filters.source !== '', filters.contractor.trim() !== ''].filter(Boolean).length;
type Dialog = { kind: 'confirm'; hit: HitLine } | { kind: 'dismiss'; hit: HitLine } | { kind: 'import' };

/**
 * VND-15, the continuous screening of the contractor registry against the lists of parties that may not be dealt with (V14). A hit above the hold line puts a hold on the contractor: no new bid, result, contract or payment
 * until a person confirms it (for the national list this opens a case of the register, and the ban itself stays with the authority) or dismisses it with a reason of 20 characters. A name alone is never enough for a hold.
 * The page says in words what a hold is, shows the lists and the day each is as of (a stale list is said, never hidden), the runs, and the hit chosen with its history.
 */
export default function ScreeningScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const hit = useIdParam('hit', 'id');
  return <ScreeningContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} initialHit={hit} />;
}

function ScreeningContent({ route, initialHit }: ScreenProps & { initialHit: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | undefined>(initialHit);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [runFailure, setRunFailure] = useState<unknown>(undefined);
  const query = useScreening({ ...filters, contractor: isUuid(filters.contractor) ? filters.contractor.trim() : '' });
  const run = useVendorCommand('runVendorScreening');
  const receipt = useReceipt();
  const data = query.data;
  const denied = data === undefined && query.error instanceof ApiError && (query.error.status === 403 || query.error.status === 404);
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined && !denied ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const badContractor = draft.contractor.trim() !== '' && !isUuid(draft.contractor);

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    if (badContractor) return;
    setFilters(draft);
  };
  const clear = (): void => {
    setDraft(NO_FILTERS);
    setFilters(NO_FILTERS);
  };
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  const runNow = (): void => {
    setRunFailure(undefined);
    run.mutateAsync({}).then(
      () => receipt.show(t('vnd3.screening.run.receipt', { time: vietnamStamp(new Date().toISOString()) })),
      (error: unknown) => setRunFailure(error),
    );
  };

  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd3.screening.page.title')}
        subtitle={t('vnd3.screening.page.subtitle')}
        asOf={data?.as_of}
        stale={refreshFailed}
        actions={
          <>
            {writer.can(INV_PERMISSION.screeningImport) && (
              <button type="button" className="ui-button ui-button--outline" data-testid="import-list" onClick={() => setDialog({ kind: 'import' })}>
                {t('vnd3.screening.import.action')}
              </button>
            )}
            {writer.can(INV_PERMISSION.screeningRun) && (
              <button type="button" className="ui-button ui-button--primary" data-testid="run-screening" disabled={run.isPending} onClick={runNow}>
                {run.isPending ? t('vnd3.screening.run.pending') : t('vnd3.screening.run.action')}
              </button>
            )}
          </>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {runFailure !== undefined && (
        <p className="callout" role="alert" data-testid="run-error">
          {errorText(t, runFailure)}
        </p>
      )}
      <p className="callout inv-notice" data-testid="hold-explained">
        {t('vnd3.screening.hold.text')}
      </p>
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      {denied && (
        <p className="callout" role="alert" data-testid="screening-hidden">
          {t('vnd3.screening.hidden.text')}
        </p>
      )}
      {!denied && (
        <>
          <Strip data={data} loading={query.isLoading} failed={query.isError && data === undefined} onRetry={() => void query.refetch()} />
          <FilterPanel applied={applied(filters)} {...(data === undefined ? {} : { updatedAt: dayText(data.as_of) })}>
            <form className="vnd-filters" onSubmit={apply} aria-label={t('vnd3.screening.filters.label')}>
              <label>
                {t('vnd3.screening.filter.status.label')}
                <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
                  <option value="">{t('vnd.register.filter.any.option')}</option>
                  {HIT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {hitStatusLabel(t, status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('vnd3.screening.filter.source.label')}
                <select value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })}>
                  <option value="">{t('vnd.register.filter.any.option')}</option>
                  {HIT_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {sourceLabel(t, source)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('vnd3.screening.filter.contractor.label')}
                <input type="text" value={draft.contractor} aria-invalid={badContractor} onChange={(event) => setDraft({ ...draft, contractor: event.target.value })} />
              </label>
              <span className="vnd-row">
                <button type="submit" className="ui-button ui-button--primary" disabled={badContractor}>
                  {t('vnd.register.filter.apply.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline" onClick={clear}>
                  {t('vnd.register.filter.clear.action')}
                </button>
              </span>
            </form>
          </FilterPanel>
          <StateBoundary state={state} onRetry={() => void query.refetch()}>
            {data !== undefined && (
              <div className="vnd-page">
                <div className="inv-split">
                  <HitsSection data={data} filtered={applied(filters) > 0} onClear={clear} selected={selected} onSelect={setSelected} />
                  {selected !== undefined && <HitAside id={selected} writable={!writer.readOnly && writer.can(INV_PERMISSION.screeningDecide)} onClose={() => setSelected(undefined)} onConfirm={(hit) => setDialog({ kind: 'confirm', hit })} onDismiss={(hit) => setDialog({ kind: 'dismiss', hit })} />}
                </div>
                <SourcesSection data={data} />
                <RunsSection data={data} />
              </div>
            )}
          </StateBoundary>
        </>
      )}
      {dialog?.kind === 'confirm' && <ConfirmHitDialog hit={dialog.hit} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd3.screening.confirm.title'))} />}
      {dialog?.kind === 'dismiss' && <DismissHitDialog hit={dialog.hit} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd3.screening.dismiss.title'))} />}
      {dialog?.kind === 'import' && <ImportListDialog onClose={() => setDialog(undefined)} onDone={() => done(t('vnd3.import.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function Strip({ data, loading, failed, onRetry }: { data: ScreeningOverview | undefined; loading: boolean; failed: boolean; onRetry: () => void }) {
  const { t, locale } = useTranslation();
  const state = data !== undefined ? 'ready' : loading || !failed ? 'loading' : 'error';
  return (
    <KpiStrip label={t('vnd3.screening.figures.label')}>
      <KpiTile label={t('vnd3.screening.figure.pending.name')} value={data === undefined ? '' : numberText(data.counts.pending, locale)} state={state} onRetry={onRetry} sub={data === undefined ? undefined : <span data-testid="figure-pending">{t('vnd3.screening.figure.pending.sub', { confirmed: data.counts.confirmed, dismissed: data.counts.dismissed })}</span>} />
      <KpiTile
        label={t('vnd3.screening.figure.holds.name')}
        value={data === undefined ? '' : numberText(data.counts.holds, locale)}
        state={state}
        onRetry={onRetry}
        tone={data !== undefined && data.counts.holds > 0 ? 'danger' : 'default'}
        sub={data === undefined ? undefined : <span data-testid="figure-holds">{t('vnd3.screening.figure.holds.sub')}</span>}
      />
      <KpiTile
        label={t('vnd3.screening.figure.overdue.name')}
        value={data === undefined ? '' : numberText(data.counts.overdue, locale)}
        state={state}
        onRetry={onRetry}
        tone={data !== undefined && data.counts.overdue > 0 ? 'warning' : 'default'}
        sub={data === undefined ? undefined : <span data-testid="figure-overdue">{t('vnd3.screening.figure.overdue.sub', { days: paramDays(data) })}</span>}
      />
      <KpiTile
        label={t('vnd3.screening.figure.inTime.name')}
        value={data === undefined ? '' : percentText(data.in_time_pct, locale)}
        state={state}
        onRetry={onRetry}
        sub={
          data === undefined ? undefined : (
            <span className="vnd-row" data-testid="figure-in-time">
              <span>{t('vnd3.screening.figure.inTime.sub')}</span>
              <PolicyInfo name={t('vnd3.screening.figure.inTime.name')} policy={data.policy} />
              {data.policy.unverified && <UnverifiedPill />}
            </span>
          )
        }
      />
    </KpiStrip>
  );
}

const paramDays = (data: ScreeningOverview): number => {
  const value = data.policy.params.decide_within_days;
  return typeof value === 'number' ? value : 0;
};

function HitsSection({ data, filtered, onClear, selected, onSelect }: { data: ScreeningOverview; filtered: boolean; onClear: () => void; selected: string | undefined; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd3.screening.section.hits.title')}>
      <DataTable<HitLine>
        caption={t('vnd3.screening.table.caption')}
        rows={data.hits}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-hit-id': row.id, 'data-selected': row.id === selected ? 'true' : 'false', 'data-hold': row.hold ? 'true' : 'false' })}
        state={data.hits.length === 0 ? 'empty' : 'ready'}
        emptyKind={filtered ? 'filtered' : 'none'}
        onClearFilters={onClear}
        severity={(row) => (row.hold && (row.status === 'PENDING' || row.status === 'CONFIRMED') ? 'URGENT' : row.status === 'PENDING' && row.clock === 'OVERDUE' ? 'ACTION' : null)}
        columns={[
          {
            key: 'contractor',
            header: t('vnd3.screening.column.contractor'),
            pinned: true,
            render: (row) => (
              <span className="vnd-stack">
                <Link to={PATHS.profile(row.contractor_id)}>{row.contractor_name}</Link>
                <span className="vnd-days">{t('vnd.register.taxCode.text', { code: row.contractor_tax_identifier })}</span>
              </span>
            ),
          },
          {
            key: 'entry',
            header: t('vnd3.screening.column.entry'),
            render: (row) => (
              <span className="vnd-stack">
                <span>{sourceLabel(t, row.source)}</span>
                <span className="vnd-days">{[row.entry_name, row.entry_tax_code].filter((item): item is string => item !== null).join(' · ') || row.entry_ref}</span>
                {!row.in_force && <StatusPill tone="neutral">{t('vnd3.screening.notInForce.badge')}</StatusPill>}
              </span>
            ),
          },
          {
            key: 'score',
            header: t('vnd3.screening.column.score'),
            align: 'right',
            render: (row) => (
              <span className="vnd-stack">
                <strong data-testid={`score-${row.id}`}>{row.score}</strong>
                <span className="vnd-days">{row.basis.map((basis) => hitBasisLabel(t, basis)).join(', ')}</span>
              </span>
            ),
          },
          {
            key: 'hold',
            header: t('vnd3.screening.column.hold'),
            render: (row) =>
              row.hold && (row.status === 'PENDING' || row.status === 'CONFIRMED') ? (
                <StatusPill tone="danger" icon="⛔">
                  {t('vnd3.screening.hold.badge')}
                </StatusPill>
              ) : (
                <StatusPill tone="neutral">{t('vnd3.screening.noHold.badge')}</StatusPill>
              ),
          },
          {
            key: 'status',
            header: t('vnd3.screening.column.status'),
            render: (row) => (
              <span className="vnd-stack">
                <StatusPill tone={hitTone(row.status)}>{hitStatusLabel(t, row.status)}</StatusPill>
                <StatusPill tone={row.clock === 'OVERDUE' ? 'danger' : row.clock === 'DECIDED' ? 'success' : 'info'}>{hitClockLabel(t, row.clock)}</StatusPill>
              </span>
            ),
          },
          { key: 'seen', header: t('vnd3.screening.column.seen'), render: (row) => dayText(row.first_seen_at) },
          {
            key: 'actions',
            header: t('vnd3.screening.column.actions'),
            render: (row) => (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="open-hit" aria-pressed={row.id === selected} onClick={() => onSelect(row.id)}>
                {t('vnd3.screening.detail.action')}
              </button>
            ),
          },
        ]}
      />
    </SectionCard>
  );
}

function HitAside({ id, writable, onClose, onConfirm, onDismiss }: { id: string; writable: boolean; onClose: () => void; onConfirm: (hit: HitLine) => void; onDismiss: (hit: HitLine) => void }) {
  const { t } = useTranslation();
  const query = useScreeningHit(id);
  const data = query.data;
  return (
    <aside className="inv-aside" aria-label={t('vnd3.screening.aside.label')} data-testid="hit-aside">
      <div className="vnd-row">
        <h2 className="ui-section__title">{t('vnd3.screening.aside.title')}</h2>
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>
          {t('vnd3.screening.aside.close')}
        </button>
      </div>
      {query.isLoading && (
        <p className="vnd-none" role="status" aria-busy="true" data-testid="hit-loading">
          {t('states.loading.label')}
        </p>
      )}
      {query.isError && data === undefined && <PartialNotice text={t('vnd3.screening.aside.error')} onRetry={() => void query.refetch()} testId="hit-error" />}
      {data !== undefined && <HitBody data={data} writable={writable} onConfirm={onConfirm} onDismiss={onDismiss} />}
    </aside>
  );
}

function HitBody({ data, writable, onConfirm, onDismiss }: { data: HitDetail; writable: boolean; onConfirm: (hit: HitLine) => void; onDismiss: (hit: HitLine) => void }) {
  const { t } = useTranslation();
  const hit = data.hit;
  return (
    <>
      <dl className="vnd-facts" data-testid="hit-facts">
        <Fact label={t('vnd3.screening.column.contractor')} testId="hit-contractor">
          <Link to={PATHS.profile(hit.contractor_id)}>{hit.contractor_name}</Link>
        </Fact>
        <Fact label={t('vnd3.screening.column.entry')} testId="hit-entry">
          {sourceLabel(t, hit.source)}: {hit.entry_name ?? hit.entry_tax_code ?? hit.entry_ref}
        </Fact>
        <Fact label={t('vnd3.screening.aside.period.label')} testId="hit-period">
          {t('vnd3.screening.aside.period.text', { from: hit.entry_valid_from === null ? '–' : dayText(hit.entry_valid_from), until: hit.entry_valid_until === null ? '–' : dayText(hit.entry_valid_until) })}
        </Fact>
        <Fact label={t('vnd3.screening.column.score')} testId="hit-score">
          <span className="vnd-row">
            <strong>{hit.score}</strong>
            <span>{hit.basis.map((basis) => hitBasisLabel(t, basis)).join(', ')}</span>
            <PolicyInfo name={t('vnd3.screening.rule.name')} policy={data.policy} />
          </span>
        </Fact>
        <Fact label={t('vnd3.screening.column.status')} testId="hit-status">
          <StatusPill tone={hitTone(hit.status)}>{hitStatusLabel(t, hit.status)}</StatusPill>
        </Fact>
        {hit.decision_reason !== null && (
          <Fact label={t('vnd3.screening.aside.decision.label')} testId="hit-decision">
            {t('vnd3.screening.aside.decision.text', { name: hit.decided_by_name ?? '–', reason: hit.decision_reason })}
          </Fact>
        )}
        {hit.case_id !== null && (
          <Fact label={t('vnd3.screening.aside.case.label')} testId="hit-case">
            <Link to={PATHS.caseOf(hit.case_id)}>{t('vnd3.screening.aside.case.link')}</Link>
          </Fact>
        )}
      </dl>
      {writable && (
        <span className="vnd-row">
          {data.may_confirm && (
            <button type="button" className="ui-button ui-button--primary" data-testid="confirm-hit" onClick={() => onConfirm(hit)}>
              {t('vnd3.screening.confirm.action')}
            </button>
          )}
          {data.may_dismiss && (
            <button type="button" className="ui-button ui-button--outline" data-testid="dismiss-hit" onClick={() => onDismiss(hit)}>
              {t('vnd3.screening.dismiss.action')}
            </button>
          )}
        </span>
      )}
      <h3 className="ui-section__title">{t('vnd3.screening.aside.events.title')}</h3>
      <ol className="vnd-list" data-testid="hit-events">
        {data.events.map((event) => (
          <li key={event.id}>
            {t('vnd3.screening.aside.event.text', { time: vietnamStamp(event.at), move: hitMoveLabel(t, event.move), status: hitStatusLabel(t, event.to_status), name: event.actor_name ?? t('vnd3.screening.aside.system') })}
            {event.reason !== null && <span className="vnd-days"> {event.reason}</span>}
          </li>
        ))}
      </ol>
      <p className="vnd-days">
        <Link to={INV_PATHS.screening}>{t('vnd3.screening.aside.list.link')}</Link>
      </p>
    </>
  );
}

function SourcesSection({ data }: { data: ScreeningOverview }) {
  const { t, locale } = useTranslation();
  return (
    <SectionCard title={t('vnd3.screening.section.sources.title')}>
      <p className="vnd-note">{t('vnd3.screening.sources.note')}</p>
      <DataTable
        caption={t('vnd3.screening.sources.caption')}
        rows={[...data.sources]}
        rowKey={(row) => row.source}
        rowAttrs={(row) => ({ 'data-source': row.source })}
        state={data.sources.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'source', header: t('vnd3.screening.sources.column.source'), pinned: true, render: (row) => sourceLabel(t, row.source) },
          { key: 'entries', header: t('vnd3.screening.sources.column.entries'), align: 'right', render: (row) => numberText(row.entries, locale) },
          {
            key: 'asOf',
            header: t('vnd3.screening.sources.column.asOf'),
            render: (row) => (row.as_of === null ? <StatusPill tone="warning">{t('vnd3.screening.sources.never')}</StatusPill> : <span className="vnd-stack"><span>{dayText(row.as_of)}</span>{row.reference !== null && <span className="vnd-days">{row.reference}</span>}</span>),
          },
        ]}
      />
    </SectionCard>
  );
}

function RunsSection({ data }: { data: ScreeningOverview }) {
  const { t, locale } = useTranslation();
  return (
    <SectionCard title={t('vnd3.screening.section.runs.title')}>
      <DataTable
        caption={t('vnd3.screening.runs.caption')}
        rows={[...data.runs]}
        rowKey={(row) => row.id}
        rowAttrs={(row) => ({ 'data-run-id': row.id })}
        state={data.runs.length === 0 ? 'empty' : 'ready'}
        columns={[
          { key: 'time', header: t('vnd3.screening.runs.column.time'), pinned: true, render: (row) => vietnamStamp(row.finished_at) },
          { key: 'trigger', header: t('vnd3.screening.runs.column.trigger'), render: (row) => triggerOf(t, row.trigger_kind) },
          { key: 'compared', header: t('vnd3.screening.runs.column.compared'), render: (row) => t('vnd3.screening.runs.compared.text', { contractors: numberText(row.contractors, locale), entries: numberText(row.entries, locale) }) },
          { key: 'found', header: t('vnd3.screening.runs.column.found'), render: (row) => t('vnd3.screening.runs.found.text', { fresh: row.hits_new, reopened: row.hits_reopened, resolved: row.hits_resolved, holds: row.holds }) },
          { key: 'by', header: t('vnd3.screening.runs.column.by'), render: (row) => row.requested_by_name ?? t('vnd3.screening.aside.system') },
        ]}
      />
    </SectionCard>
  );
}

const triggerOf = (t: ReturnType<typeof useTranslation>['t'], code: string): string => {
  switch (code) {
    case 'NIGHTLY':
      return t('vnd3.screening.trigger.nightly.name');
    case 'PROFILE_CHANGE':
      return t('vnd3.screening.trigger.profileChange.name');
    case 'LIST_IMPORT':
      return t('vnd3.screening.trigger.listImport.name');
    case 'MANUAL':
      return t('vnd3.screening.trigger.manual.name');
    default:
      return code;
  }
};
