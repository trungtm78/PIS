import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { PostingDetailPanel } from './PostingDetailPanel';
import { PostingDialogs } from './PostingDialogs';
import type { PostingDialog } from './PostingDialogs';
import { RateInfo, RateValue, UrgencyInfo } from './PostingInfo';
import { usePostings } from './posting-hooks';
import { clockLabel, groupLabel, kindLabel, leftText, stateLabel } from './posting-labels';
import { CLOCKS, CTR_EXPORT_PATH, GROUPS, KINDS, PREPARE_PERMISSION, SUBMIT_PERMISSION, appliedCount, filtersOf, instantDay, instantTime, searchOf, shortHash } from './posting-model';
import type { ClockFilter, ClockStatus, Filters, PostingGroup, PostingKind, PostingPage, PostingRow, PostingState } from './posting-model';
import './posting.css';

type T = Translator['t'];

const NEVER_EMPTY = (): boolean => false;
const BID_IMPORT_PATH = '/bid/bid-24';
const STATE_TONE: Readonly<Record<PostingState, Tone>> = { DUE: 'info', PREPARED: 'info', SUBMITTED: 'warning', RECEIPTED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };
const STATE_ICON: Readonly<Record<PostingState, string>> = { DUE: '◔', PREPARED: '◑', SUBMITTED: '◕', RECEIPTED: '✓', REJECTED: '✕', CANCELLED: '○' };
const CLOCK_TONE: Readonly<Record<ClockStatus, Tone>> = { ON_TIME: 'neutral', DUE_SOON: 'warning', OVERDUE: 'danger', MET: 'success', MET_LATE: 'warning', CANCELLED: 'neutral' };
const CLOCK_ICON: Readonly<Record<ClockStatus, string>> = { ON_TIME: '○', DUE_SOON: '◔', OVERDUE: '!', MET: '✓', MET_LATE: '◑', CANCELLED: '–' };

/**
 * BID-32, "Posting obligations on the national procurement network" (EGP-2): every duty to post a plan, a notice, a result, a contract, the evaluation of a contractor or a violation, with the deadline the rule gives, the clock,
 * the person who prepared and the other who submitted, and the receipt the network gave. The platform never posts: a person posts by hand and writes down what the network answered; the receipt closes the duty and its alert.
 * The deadlines are defaults nobody has confirmed against the legal text (UNVERIFIED), and the layout of the files is a working assumption (PENDING-EXTERNAL).
 */
export default function PostingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters, the dialogs and the receipt belong to one membership: a switch of tenant or of membership starts the screen over.
  return <PostingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PostingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search), [search]);
  const list = usePostings(filters);
  const [dialog, setDialog] = useState<PostingDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const frozen = mode === 'READ_ONLY';
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: NEVER_EMPTY });
  const applied = appliedCount(filters);
  const denied = state === 'denied';
  const mayPrepare = first !== undefined && first.actions.prepare && (permissions === undefined || permissions.includes(PREPARE_PERMISSION)) && !frozen;
  const maySubmit = first !== undefined && first.actions.submit && (permissions === undefined || permissions.includes(SUBMIT_PERMISSION)) && !frozen;
  const refreshFailed = list.isError && !list.isFetchNextPageError && list.data !== undefined;
  const asOf = first === undefined ? undefined : `${instantDay(first.asOf)} ${instantTime(first.asOf)}`.trim();
  const unverified = rows.some((row) => row.legalStatus === 'UNVERIFIED') || (first !== undefined && first.severityRule.unverified);

  const change = (next: Filters): void => setSearch(searchOf(next));
  const open = (next: PostingDialog): void => {
    setReceipt(undefined);
    setDialog(next);
  };
  const openBlank = (kind: 'open' | 'sweep'): void => {
    setNonce((value) => value + 1);
    open({ kind, nonce: nonce + 1 });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('egp.posting.page.title')}</h1>
          <p>{t('egp.posting.page.subtitle')}</p>
          <div className="posting-badges">
            <span className="bid-badge warning" data-testid="assumption-badge">
              {t('egp.posting.badge.assumption')}
            </span>
            {unverified && (
              <span className="bid-badge warning" data-testid="unverified-badge">
                {t('egp.posting.badge.unverified')}
              </span>
            )}
          </div>
        </div>
        {!denied && (
          <div className="actions posting-actions">
            {mayPrepare && (
              <>
                <button type="button" className="ui-button ui-button--primary" data-testid="sweep-button" onClick={() => openBlank('sweep')}>
                  {t('egp.posting.action.sweep')}
                </button>
                <button type="button" className="ui-button ui-button--outline" data-testid="open-button" onClick={() => openBlank('open')}>
                  {t('egp.posting.action.open')}
                </button>
              </>
            )}
            <Link className="ui-button ui-button--outline" to={CTR_EXPORT_PATH} data-testid="export-link">
              {t('egp.posting.action.export')}
            </Link>
          </div>
        )}
      </div>
      <ContextBar
        items={[
          { label: t('egp.posting.context.scope.label'), value: tenant?.name ?? t('egp.posting.cell.none') },
          { label: t('egp.posting.context.adapter.label'), value: t('egp.posting.context.adapter.value') },
        ]}
        {...(asOf === undefined ? {} : { asOf })}
        stale={refreshFailed}
      />
      <p className="callout" data-testid="receipt-note">
        {t('egp.posting.note.receipt')}
      </p>
      {receipt !== undefined && (
        <p className="callout posting-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {first !== undefined && !denied && !mayPrepare && !maySubmit && (
        <p className="callout" role="status" data-testid="readonly-note">
          {frozen ? t('egp.posting.readonly.mode') : t('egp.posting.readonly.right')}
        </p>
      )}
      {denied ? (
        <div className="posting-state posting-state--denied" role="alert" data-testid="denied">
          <h2>{t('egp.posting.denied.title')}</h2>
          <p>{t('egp.posting.denied.body')}</p>
        </div>
      ) : (
        <>
          {first !== undefined && <Figures page={first} />}
          <SectionCard title={t('egp.posting.list.title')} status={first === undefined ? undefined : <span>{t('egp.posting.list.asOf', { day: instantDay(first.asOf) })}</span>}>
            {first !== undefined && (first.counts.total > 0 || applied > 0) && <Chips filters={filters} page={first} onChange={change} />}
            <FilterBar filters={filters} onChange={change} />
            {state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
              <div className="posting-state posting-state--error" role="alert" data-testid="error">
                <h2>{t('egp.posting.error.title')}</h2>
                <p>{t('egp.posting.error.body')}</p>
                <button type="button" className="ui-button ui-button--outline" onClick={() => void list.refetch()}>
                  {t('states.retry.action')}
                </button>
              </div>
            ) : first !== undefined && applied === 0 && first.counts.total === 0 && rows.length === 0 ? (
              <div className="posting-state" role="status" data-testid="empty">
                <h2>{t('egp.posting.empty.title')}</h2>
                <p>{t('egp.posting.empty.body')}</p>
                <Link to={BID_IMPORT_PATH}>{t('egp.posting.empty.import.link')}</Link>
              </div>
            ) : (
              <>
                <DataTable
                  caption={t('egp.posting.table.caption')}
                  columns={columns(t, (next) => open(next), (id) => setSelected(id))}
                  rows={rows}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-posting-id': row.id, 'data-state': row.state, 'data-clock': row.clock, 'data-kind': row.kind })}
                  severity={(row) => row.severity}
                  state={state === 'loading' ? 'loading' : 'ready'}
                  emptyKind={applied > 0 ? 'filtered' : 'none'}
                  onClearFilters={() => change({})}
                />
                {first !== undefined && (
                  <div className="posting-more">
                    <span className="sub" role="status" data-testid="shown">
                      {t('egp.posting.paging.summary', { shown: rows.length })}
                    </span>
                    {list.isFetchNextPageError && <span role="alert">{t('egp.posting.paging.error')}</span>}
                    {list.hasNextPage && (
                      <button type="button" className="ui-button ui-button--outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                        {list.isFetchingNextPage ? t('egp.posting.paging.loading') : t('egp.posting.paging.more')}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </SectionCard>
          {selected !== undefined && <PostingDetailPanel id={selected} onClose={() => setSelected(undefined)} />}
        </>
      )}
      <PostingDialogs dialog={dialog} onClose={() => setDialog(undefined)} onDone={(text) => setReceipt(text)} />
      <p className="prototype-note">{t('egp.posting.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The four figures of the board, each with its "i": the rate posted on time, the duties past their deadline, those inside their reminder window and those that wait for a receipt. */
function Figures({ page }: { page: PostingPage }) {
  const { t } = useTranslation();
  return (
    <section className="posting-figures" aria-label={t('egp.posting.figures.label')} data-testid="figures">
      <div className="posting-figure" data-testid="figure-rate">
        <span className="posting-figure__name">{t('egp.posting.figure.rate.name')}</span>
        <strong>
          <RateValue page={page} /> <RateInfo page={page} />
        </strong>
        <small>{t('egp.posting.figure.rate.detail', { met: page.onTime.met, late: page.onTime.metLate, overdue: page.onTime.overdue })}</small>
      </div>
      <div className="posting-figure" data-testid="figure-overdue">
        <span className="posting-figure__name">{t('egp.posting.figure.overdue.name')}</span>
        <strong>
          <span data-testid="overdue-value">{page.counts.overdue}</span> <UrgencyInfo page={page} />
        </strong>
        <small>{t('egp.posting.figure.overdue.detail', { hours: page.severityRule.urgentWithinHours })}</small>
      </div>
      <div className="posting-figure" data-testid="figure-soon">
        <span className="posting-figure__name">{t('egp.posting.figure.soon.name')}</span>
        <strong data-testid="soon-value">{page.counts.dueSoon}</strong>
        <small>{t('egp.posting.figure.soon.detail')}</small>
      </div>
      <div className="posting-figure" data-testid="figure-waiting">
        <span className="posting-figure__name">{t('egp.posting.figure.waiting.name')}</span>
        <strong data-testid="waiting-value">{page.counts.byState.SUBMITTED}</strong>
        <small>{t('egp.posting.figure.waiting.detail')}</small>
      </div>
    </section>
  );
}

/** The groups as chips, each with its count: a press sets the group in the address, "all" clears it. */
function Chips({ filters, page, onChange }: { filters: Filters; page: PostingPage; onChange: (next: Filters) => void }) {
  const { t } = useTranslation();
  const counts: Record<PostingGroup, number> = {
    OPEN: page.counts.byState.DUE + page.counts.byState.PREPARED + page.counts.byState.REJECTED,
    SUBMITTED: page.counts.byState.SUBMITTED,
    CLOSED: page.counts.byState.RECEIPTED + page.counts.byState.CANCELLED,
  };
  const choose = (group: PostingGroup | undefined): void => {
    const next: Filters = { ...filters };
    if (group === undefined) delete next.group;
    else next.group = group;
    onChange(next);
  };
  return (
    <fieldset className="posting-chips">
      <legend>{t('egp.posting.chip.group.label')}</legend>
      <button type="button" className="posting-chip" aria-pressed={filters.group === undefined} onClick={() => choose(undefined)}>
        {t('egp.posting.chip.all', { count: page.counts.total })}
      </button>
      {GROUPS.map((group) => (
        <button key={group} type="button" className="posting-chip" aria-pressed={filters.group === group} onClick={() => choose(group)}>
          {t('egp.posting.chip.label', { label: groupLabel(t, group), count: counts[group] })}
        </button>
      ))}
    </fieldset>
  );
}

/** The kind, the clock and "mine"; the group is the chips. They live in the address, so a link keeps the view. */
function FilterBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const { t } = useTranslation();
  return (
    <form className="posting-filters" role="search" aria-label={t('egp.posting.filter.group.label')} onSubmit={(event) => event.preventDefault()}>
      <div className="field">
        <label htmlFor="posting-filter-kind">{t('egp.posting.filter.kind.label')}</label>
        <select
          id="posting-filter-kind"
          value={filters.kind ?? ''}
          onChange={(event) => {
            const next: Filters = { ...filters };
            if (event.target.value === '') delete next.kind;
            else next.kind = event.target.value as PostingKind;
            onChange(next);
          }}
        >
          <option value="">{t('egp.posting.filter.all.option')}</option>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(t, kind)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="posting-filter-clock">{t('egp.posting.filter.clock.label')}</label>
        <select
          id="posting-filter-clock"
          value={filters.clock ?? ''}
          onChange={(event) => {
            const next: Filters = { ...filters };
            if (event.target.value === '') delete next.clock;
            else next.clock = event.target.value as ClockFilter;
            onChange(next);
          }}
        >
          <option value="">{t('egp.posting.filter.all.option')}</option>
          {CLOCKS.map((clock) => (
            <option key={clock} value={clock}>
              {clock === 'OVERDUE' ? t('egp.posting.filter.clock.overdue') : t('egp.posting.filter.clock.dueSoon')}
            </option>
          ))}
        </select>
      </div>
      <label className="posting-mine">
        <input
          type="checkbox"
          checked={filters.mine === true}
          onChange={(event) => {
            const next: Filters = { ...filters };
            if (event.target.checked) next.mine = true;
            else delete next.mine;
            onChange(next);
          }}
        />{' '}
        {t('egp.posting.filter.mine.label')}
      </label>
    </form>
  );
}

function columns(t: T, open: (dialog: PostingDialog) => void, show: (id: string) => void): Array<DataTableColumn<PostingRow>> {
  const none = t('egp.posting.cell.none');
  return [
    {
      key: 'kind',
      header: t('egp.posting.column.kind'),
      pinned: true,
      render: (row) => (
        <span className="posting-cell">
          <strong>{kindLabel(t, row.kind)}</strong>
          {row.obligation !== null && <small>{row.obligation}</small>}
        </span>
      ),
    },
    { key: 'subject', header: t('egp.posting.column.subject'), render: (row) => <span className="posting-code">{row.subjectCode}</span> },
    {
      key: 'due',
      header: t('egp.posting.column.due'),
      render: (row) => (
        <span className="posting-cell">
          <span>{`${instantDay(row.dueAt)} ${instantTime(row.dueAt)}`.trim()}</span>
          <small data-testid="legal">{row.legalStatus === 'UNVERIFIED' ? t('egp.posting.cell.legal.unverified', { version: row.ruleVersion }) : t('egp.posting.cell.legal.verified', { version: row.ruleVersion })}</small>
        </span>
      ),
    },
    {
      key: 'clock',
      header: t('egp.posting.column.clock'),
      render: (row) => (
        <span className="posting-cell">
          <StatusPill tone={CLOCK_TONE[row.clock]} icon={CLOCK_ICON[row.clock]}>
            {clockLabel(t, row.clock)}
          </StatusPill>
          {leftText(t, row) !== null && <small>{leftText(t, row)}</small>}
          {row.alert !== null && <small data-testid="alert-code">{row.alert}</small>}
        </span>
      ),
    },
    {
      key: 'state',
      header: t('egp.posting.column.state'),
      render: (row) => (
        <StatusPill tone={STATE_TONE[row.state]} icon={STATE_ICON[row.state]}>
          {stateLabel(t, row.state)}
        </StatusPill>
      ),
    },
    {
      key: 'people',
      header: t('egp.posting.column.people'),
      render: (row) => (
        <span className="posting-cell">
          <small data-testid="owner">{t('egp.posting.cell.owner', { name: row.ownerName ?? none })}</small>
          {row.preparedByName !== null && <small data-testid="prepared-by">{t('egp.posting.cell.preparedBy', { name: row.preparedByName })}</small>}
          {row.submittedByName !== null && <small data-testid="submitted-by">{t('egp.posting.cell.submittedBy', { name: row.submittedByName })}</small>}
          {row.rejectionReason !== null && row.state === 'REJECTED' && <small>{t('egp.posting.cell.rejection', { reason: row.rejectionReason })}</small>}
          {row.cancelReason !== null && <small>{t('egp.posting.cell.cancellation', { reason: row.cancelReason })}</small>}
        </span>
      ),
    },
    {
      key: 'packet',
      header: t('egp.posting.column.packet'),
      render: (row) =>
        row.packetSha256 === null ? (
          none
        ) : (
          <span className="posting-cell">
            <span className="posting-code" title={row.packetSha256}>
              {shortHash(row.packetSha256)}
            </span>
            {row.exportBatchId !== null && (
              <small>
                <Link to={CTR_EXPORT_PATH}>{t('egp.posting.cell.batch', { status: row.exportBatchStatus ?? none })}</Link>
              </small>
            )}
          </span>
        ),
    },
    {
      key: 'receipt',
      header: t('egp.posting.column.receipt'),
      render: (row) =>
        row.receiptRef === null ? (
          none
        ) : (
          <span className="posting-cell">
            <span className="posting-code" data-testid="receipt-ref">
              {row.receiptRef}
            </span>
            {row.receiptedAt !== null && <small>{`${instantDay(row.receiptedAt)} ${instantTime(row.receiptedAt)}`.trim()}</small>}
          </span>
        ),
    },
    {
      key: 'actions',
      header: t('egp.posting.column.actions'),
      render: (row) => {
        const labels = { kind: kindLabel(t, row.kind), code: row.subjectCode };
        return (
          <span className="posting-row-actions">
            {row.actions.prepare && (
              <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('egp.posting.action.prepare.label', labels)} onClick={() => open({ kind: 'prepare', row })}>
                {t('egp.posting.action.prepare')}
              </button>
            )}
            {row.actions.submit && (
              <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('egp.posting.action.submit.label', labels)} onClick={() => open({ kind: 'submit', row })}>
                {t('egp.posting.action.submit')}
              </button>
            )}
            {row.actions.receipt && (
              <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('egp.posting.action.receipt.label', labels)} onClick={() => open({ kind: 'receipt', row })}>
                {t('egp.posting.action.receipt')}
              </button>
            )}
            {row.actions.reject && (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('egp.posting.action.reject.label', labels)} onClick={() => open({ kind: 'reject', row })}>
                {t('egp.posting.action.reject')}
              </button>
            )}
            {row.actions.cancel && (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('egp.posting.action.cancel.label', labels)} onClick={() => open({ kind: 'cancel', row })}>
                {t('egp.posting.action.cancel')}
              </button>
            )}
            {row.state === 'PREPARED' && !row.actions.submit && (
              <span className="posting-words" data-testid="waiting-words">
                {t('egp.posting.row.waitingSubmit')}
              </span>
            )}
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('egp.posting.action.details.label', labels)} onClick={() => show(row.id)}>
              {t('egp.posting.action.details')}
            </button>
          </span>
        );
      },
    },
  ];
}
