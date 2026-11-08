import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { can, dayText, stampText, vnd } from '../claims/common';
import { CalendarNotice, FigureInfo, StatePill, TruncatedNotice, WithInfo } from '../claims/components';
import { useContractChoices } from '../claims/hooks';
import { basisLabel } from '../claims/labels';
import { useRegister, useWarnings } from './hooks';
import { categoryLabel, clockLabel, issueKindLabel, partyLabel, reviewLabel, statusLabel, likelihoodLabel } from './labels';
import { CATEGORIES, EMPTY_FILTER, MANAGE_PERMISSION, PARTIES, PATHS, RAISE_PERMISSION, STATUSES, isFiltered, isOpen } from './model';
import type { Register, RegisterClock, WarningFilter, WarningLine, WarningPage } from './model';
import { WarningDialogs } from './WarningDialogs';
import type { WarningDialog } from './WarningDialogs';
import '../claims/claims.css';

type T = Translator['t'];
const NONE = '–';

/**
 * CTR-35, the early-warning register of the contracts in scope (G1-15): the warnings the parties of a contract raise, with the expected impact on time and cost, the person who answers for each, and the rhythm of the register (the first issue,
 * the review meeting, the re-issue after a meeting) read by the server from the rule of the tenant. This is not the disbursement warning of the money plan (HOME-06): it is the register one contract keeps with its parties.
 */
export default function EarlyWarningRegisterScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The register belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <RegisterContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function Clock({ clock, register }: { clock: RegisterClock; register: Register }) {
  const { t } = useTranslation();
  const name = clockLabel(t, clock.code);
  return (
    <li className="ctrreg-clock" data-testid={`clock-${clock.code.toLowerCase()}`} data-state={clock.state}>
      <header>
        <h3>{name}</h3>
        <StatePill group="deadline" state={clock.state} />
      </header>
      {clock.state === 'NOT_STARTED' && <p className="sub">{t('ctrWarn.clock.notStarted.text')}</p>}
      {clock.state === 'CALENDAR_UNAVAILABLE' && <p className="sub">{t('ctrWarn.clock.calendar.text')}</p>}
      <dl className="ctrreg-facts">
        <dt>{t('ctrWarn.clock.period.label')}</dt>
        <dd>{t('ctrWarn.clock.period.text', { days: clock.period_days, basis: basisLabel(t, clock.basis) })}</dd>
        <dt>{t('ctrWarn.clock.startedOn.label')}</dt>
        <dd>{clock.started_on === null ? NONE : dayText(clock.started_on)}</dd>
        <dt>{t('ctrWarn.clock.dueOn.label')}</dt>
        <dd data-testid="due">
          {clock.due_on === null ? (
            NONE
          ) : (
            <WithInfo info={<FigureInfo name={name} formula={t('ctrWarn.figure.clock.formula')} source={t('ctrWarn.figure.clock.source')} asOf={dayText(register.as_of)} rule={register.policy.rule} />}>
              <span>{dayText(clock.due_on)}</span>
            </WithInfo>
          )}
        </dd>
        {clock.days_left !== null && (
          <>
            <dt>{t('ctrWarn.clock.daysLeft.label')}</dt>
            <dd>{clock.days_left >= 0 ? t('ctrWarn.clock.daysLeft.text', { days: clock.days_left }) : t('ctrWarn.clock.daysPast.text', { days: -clock.days_left })}</dd>
          </>
        )}
        <dt>{t('ctrWarn.clock.doneOn.label')}</dt>
        <dd>{clock.done_on === null ? NONE : dayText(clock.done_on)}</dd>
      </dl>
    </li>
  );
}

function Rhythm({ register, canManage, canRaise, onDialog }: { register: Register; canManage: boolean; canRaise: boolean; onDialog: (dialog: WarningDialog) => void }) {
  const { t } = useTranslation();
  const policy = register.policy;
  const clocks = [register.clocks.initial, register.clocks.meeting, ...(register.clocks.reissue === null ? [] : [register.clocks.reissue])];
  return (
    <SectionCard
      title={t('ctrWarn.rhythm.title')}
      status={policy.rule.unverified ? <StatusPill tone="warning">{t('ctrWarn.rhythm.unverified.label')}</StatusPill> : undefined}
      actions={
        <>
          {canRaise && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onDialog({ kind: 'raise', contract: { id: register.contract.id, code: register.contract.code } })} data-testid="raise-button">
              {t('ctrWarn.register.raise.action')}
            </button>
          )}
          {canManage && (
            <>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onDialog({ kind: 'meeting', register })} data-testid="meeting-button">
                {t('ctrWarn.rhythm.meeting.action')}
              </button>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onDialog({ kind: 'issue', register })} data-testid="issue-button">
                {t('ctrWarn.rhythm.issue.action')}
              </button>
            </>
          )}
        </>
      }
    >
      <p className="sub" data-testid="policy-line">
        {t('ctrWarn.rhythm.policy.text', {
          initial: policy.initial_issue_within_days,
          meeting: policy.meeting_every_days,
          reissue: policy.reissue_within_days_after_meeting,
        })}
      </p>
      <CalendarNotice published={register.calendar_published} />
      <ul className="ctrreg-clocks" aria-label={t('ctrWarn.rhythm.title')}>
        {clocks.map((clock) => (
          <Clock key={`${clock.code}:${clock.meeting_id ?? ''}`} clock={clock} register={register} />
        ))}
      </ul>
      <h3>{t('ctrWarn.meetings.title')}</h3>
      {register.meetings.length === 0 ? (
        <p className="sub" data-testid="no-meetings">
          {t('ctrWarn.meetings.none.text')}
        </p>
      ) : (
        <ol className="ctrreg-timeline" data-testid="meetings">
          {register.meetings.map((meeting) => (
            <li key={meeting.id}>
              <strong>{t('ctrWarn.meetings.entry.text', { ordinal: meeting.ordinal, day: dayText(meeting.held_on) })}</strong>
              <span className="sub">{meeting.attendees}</span>
              <span>{meeting.reissued_on === null ? t('ctrWarn.meetings.notReissued.text') : t('ctrWarn.meetings.reissued.text', { day: dayText(meeting.reissued_on) })}</span>
              <span className="sub">{meeting.reviews.map((review) => `${review.warning_code}: ${reviewLabel(t, review.outcome)}`).join(' · ')}</span>
            </li>
          ))}
        </ol>
      )}
      <h3>{t('ctrWarn.issues.title')}</h3>
      {register.issues.length === 0 ? (
        <p className="sub" data-testid="no-issues">
          {t('ctrWarn.issues.none.text')}
        </p>
      ) : (
        <ol className="ctrreg-timeline" data-testid="issues">
          {register.issues.map((issue) => (
            <li key={issue.id}>
              <strong>{t('ctrWarn.issues.entry.text', { ordinal: issue.ordinal, kind: issueKindLabel(t, issue.kind), day: dayText(issue.issued_on) })}</strong>
              <span>{t('ctrWarn.issues.counts.text', { open: issue.open_count, total: issue.warning_count })}</span>
              <span className="sub">{t('ctrWarn.issues.hash.text', { hash: issue.content_hash.slice(0, 12) })}</span>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function Summary({ page }: { page: WarningPage }) {
  const { t, locale } = useTranslation();
  const summary = page.summary;
  const lower = page.truncated ? t('ctrWarn.summary.lowerBound.text') : undefined;
  const tile = (key: string, label: string, value: string, formula: string, unit?: string): ReactNode => (
    <div className="ctrreg-tile" data-testid={`tile-${key}`} key={key}>
      <KpiTile label={label} value={value} {...(unit === undefined ? {} : { unit })} {...(lower === undefined ? {} : { sub: lower })} />
      <FigureInfo name={label} formula={formula} source={t('ctrWarn.figure.register.source')} asOf={dayText(page.as_of)} />
    </div>
  );
  return (
    <div className="ctrreg-tiles">
      {tile('total', t('ctrWarn.summary.total.label'), String(summary.total), t('ctrWarn.figure.count.formula'))}
      {tile('open', t('ctrWarn.summary.open.label'), String(summary.open), t('ctrWarn.figure.count.formula'))}
      {tile('unassessed', t('ctrWarn.summary.unassessed.label'), String(summary.unassessed), t('ctrWarn.figure.count.formula'))}
      {tile('withoutOwner', t('ctrWarn.summary.withoutOwner.label'), String(summary.without_owner), t('ctrWarn.figure.count.formula'))}
      {tile('overdue', t('ctrWarn.summary.overdueActions.label'), String(summary.overdue_actions), t('ctrWarn.figure.overdue.formula'))}
      {tile('exposureCost', t('ctrWarn.summary.exposureCost.label'), vnd(summary.exposure_cost_vnd, locale), t('ctrWarn.figure.exposure.formula'), t('ctrWarn.unit.vnd.text'))}
      {tile('exposureDays', t('ctrWarn.summary.exposureDays.label'), String(summary.exposure_time_days), t('ctrWarn.figure.exposure.formula'), t('ctrWarn.unit.days.text'))}
      {tile('impactUnknown', t('ctrWarn.summary.impactUnknown.label'), String(summary.impact_unknown), t('ctrWarn.figure.unknown.formula'))}
    </div>
  );
}

function columnsOf(t: T, locale: string): DataTableColumn<WarningLine>[] {
  return [
    {
      key: 'code',
      header: t('ctrWarn.column.code.label'),
      pinned: true,
      render: (line) => (
        <Link to={`${PATHS.record}?warning=${line.id}`} data-testid="warning-link">
          {line.code}
        </Link>
      ),
    },
    { key: 'title', header: t('ctrWarn.column.title.label'), render: (line) => line.title },
    { key: 'contract', header: t('ctrWarn.column.contract.label'), render: (line) => line.contract.code },
    { key: 'category', header: t('ctrWarn.column.category.label'), render: (line) => categoryLabel(t, line.category) },
    { key: 'party', header: t('ctrWarn.column.party.label'), render: (line) => partyLabel(t, line.raised_by_party) },
    { key: 'likelihood', header: t('ctrWarn.column.likelihood.label'), render: (line) => (line.likelihood === null ? NONE : likelihoodLabel(t, line.likelihood)) },
    {
      key: 'time',
      header: t('ctrWarn.column.time.label'),
      align: 'right',
      render: (line) => (line.expected_time_days !== null ? String(line.expected_time_days) : line.no_impact_expected ? t('ctrWarn.cell.noImpact.text') : NONE),
    },
    {
      key: 'cost',
      header: t('ctrWarn.column.cost.label'),
      align: 'right',
      render: (line) => (line.expected_cost_vnd !== null ? vnd(line.expected_cost_vnd, locale) : line.no_impact_expected ? t('ctrWarn.cell.noImpact.text') : NONE),
    },
    { key: 'owner', header: t('ctrWarn.column.owner.label'), render: (line) => line.owner_name ?? t('ctrWarn.cell.noOwner.text') },
    { key: 'status', header: t('ctrWarn.column.status.label'), render: (line) => statusLabel(t, line.status) },
    { key: 'actions', header: t('ctrWarn.column.actions.label'), align: 'right', render: (line) => (line.overdue_actions > 0 ? t('ctrWarn.cell.actions.overdue', { open: line.open_actions, late: line.overdue_actions }) : String(line.open_actions)) },
  ];
}

function Filters({ filter, onChange, onClear }: { filter: WarningFilter; onChange: (next: WarningFilter) => void; onClear: () => void }) {
  const { t } = useTranslation();
  const contracts = useContractChoices();
  const set = (patch: Partial<WarningFilter>): void => onChange({ ...filter, ...patch });
  return (
    <FilterPanel applied={Object.values(filter).filter((value) => value !== '' && value !== false).length}>
      <label className="ctrreg-filter">
        <span>{t('ctrWarn.filter.contract.label')}</span>
        <select value={filter.contractId} onChange={(event) => set({ contractId: event.target.value })} data-testid="filter-contract">
          <option value="">{t('ctrWarn.filter.all.option')}</option>
          {(contracts.data ?? []).map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.code}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-filter">
        <span>{t('ctrWarn.filter.status.label')}</span>
        <select value={filter.status} onChange={(event) => set({ status: event.target.value })} data-testid="filter-status">
          <option value="">{t('ctrWarn.filter.all.option')}</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {statusLabel(t, status)}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-filter">
        <span>{t('ctrWarn.filter.category.label')}</span>
        <select value={filter.category} onChange={(event) => set({ category: event.target.value })} data-testid="filter-category">
          <option value="">{t('ctrWarn.filter.all.option')}</option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {categoryLabel(t, category)}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-filter">
        <span>{t('ctrWarn.filter.party.label')}</span>
        <select value={filter.party} onChange={(event) => set({ party: event.target.value })} data-testid="filter-party">
          <option value="">{t('ctrWarn.filter.all.option')}</option>
          {PARTIES.map((party) => (
            <option key={party} value={party}>
              {partyLabel(t, party)}
            </option>
          ))}
        </select>
      </label>
      <label className="ctrreg-check">
        <input type="checkbox" checked={filter.open} onChange={(event) => set({ open: event.target.checked })} data-testid="filter-open" />
        <span>{t('ctrWarn.filter.open.label')}</span>
      </label>
      <label className="ctrreg-check">
        <input type="checkbox" checked={filter.mine} onChange={(event) => set({ mine: event.target.checked })} data-testid="filter-mine" />
        <span>{t('ctrWarn.filter.mine.label')}</span>
      </label>
      {isFiltered(filter) && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClear} data-testid="filter-clear">
          {t('ctrWarn.filter.clear.action')}
        </button>
      )}
    </FilterPanel>
  );
}

function RegisterContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<WarningFilter>({ ...EMPTY_FILTER, contractId: params.get('contract') ?? '' });
  const [dialog, setDialog] = useState<WarningDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const query = useWarnings(filter);
  const register = useRegister(filter.contractId === '' ? null : filter.contractId);
  const first = query.data?.pages[0];
  const rows = (query.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: query.isLoading, error: first === undefined ? query.error : undefined, data: first, isEmpty: () => false });
  const frozen = mode === 'READ_ONLY';
  const canManage = can(permissions, MANAGE_PERMISSION, frozen) && register.data?.allowed.record_meeting !== false;
  const canRaise = can(permissions, RAISE_PERMISSION, frozen) && register.data?.allowed.raise !== false;
  const refreshFailed = query.isError && first !== undefined;
  const openDialog = (next: WarningDialog): void => {
    setReceipt(undefined);
    setDialog(next);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ctrreg-page">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctrWarn.register.page.title')}</h1>
          <p>{t('ctrWarn.register.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[{ label: t('ctrWarn.context.separate.label'), value: t('ctrWarn.context.separate.value') }]}
        unit={t('ctrWarn.unit.vnd.text')}
        stale={refreshFailed}
        {...(first === undefined ? {} : { asOf: stampText(first.as_of) })}
      />
      {receipt !== undefined && (
        <p className="ctrreg-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      <Filters filter={filter} onChange={setFilter} onClear={() => setFilter(EMPTY_FILTER)} />
      {filter.contractId !== '' && register.isError && (
        <p className="ctrreg-notice" role="alert" data-testid="register-error">
          {t('ctrWarn.rhythm.error.text')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void register.refetch()}>
            {t('ctrWarn.rhythm.retry.action')}
          </button>
        </p>
      )}
      {filter.contractId !== '' && register.isLoading && (
        <div className="card" role="status" aria-busy="true" aria-label={t('ctrWarn.rhythm.loading.label')}>
          <div className="skeleton" />
        </div>
      )}
      {register.data !== undefined && <Rhythm register={register.data} canManage={canManage} canRaise={canRaise} onDialog={openDialog} />}
      {filter.contractId === '' && (
        <p className="sub" data-testid="pick-contract-note">
          {t('ctrWarn.register.pickContract.text')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {first !== undefined && (
          <>
            <TruncatedNotice truncated={first.truncated} />
            <Summary page={first} />
            <DataTable
              caption={t('ctrWarn.register.table.caption')}
              columns={columnsOf(t, locale)}
              rows={rows}
              rowKey={(line) => line.id}
              rowAttrs={(line) => ({ 'data-warning': line.id, 'data-status': line.status })}
              severity={(line) => (isOpen(line.status) && line.overdue_actions > 0 ? 'ACTION' : null)}
              emptyKind={isFiltered(filter) ? 'filtered' : 'none'}
              onClearFilters={() => setFilter(EMPTY_FILTER)}
            />
            {query.hasNextPage && (
              <button type="button" className="ui-button ui-button--outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} data-testid="load-more">
                {t('ctrWarn.register.more.action')}
              </button>
            )}
          </>
        )}
      </StateBoundary>
      {dialog !== undefined && (
        <WarningDialogs
          dialog={dialog}
          onClose={() => setDialog(undefined)}
          onDone={(text) => {
            setReceipt(text);
            setDialog(undefined);
          }}
        />
      )}
    </section>
  );
}
