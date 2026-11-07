import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, InfoFormula, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, InfoFormulaLabels, Tone } from '../../../ui';
import { Field } from '../../ctr/components';
import { ScopeBar } from '../../ctr/kit';
import { useMembers } from '../recon/hooks';
import { resolutionLabel } from '../recon/labels';
import { AssignDialog, ResolveDialog } from './DailyReconDialogs';
import { useItems, useRunDay, useRunDetail, useRuns } from './hooks';
import { dayStateLabel, itemStatusLabel, kindLabel, partialReasonLabel, problemMessage } from './labels';
import { ASSIGN_PERMISSION, ITEM_STATUSES, MEMBER_READ_PERMISSION, READ_PERMISSION, RESOLVE_PERMISSION, RUN_PERMISSION, addDays, dayRows, describeProblem, differenceText, differingLines, isWaiting, validateRunDay, vndText } from './model';
import type { DayRow, ItemStatus, Line, ReconItem, ReconRule, Resolution } from './model';
import '../pay.css';

/** The days the strip shows: the latest two weeks. */
const DAY_COUNT = 14;

const itemTone = (status: ItemStatus): Tone => (status === 'RESOLVED' || status === 'AUTO_CLEARED' ? 'success' : status === 'EXPLAINED' ? 'info' : status === 'OPEN' ? 'warning' : 'neutral');
const dayTone = (state: DayRow['state']): Tone => (state === 'COMPLETE' ? 'success' : state === 'PARTIAL' ? 'warning' : 'neutral');

/**
 * PAY-20: the daily reconciliation with the Treasury by project code and fund (G4-4). A strip of the latest days says which have a pass and which are only PARTIAL because the statement is not in (never "no difference"); a pass is
 * opened to see its lines (the books against the Treasury, signed, the difference never rounded); the items of difference that went over the threshold wait for an owner with a due day in working days, and are explained, resolved or
 * written off by someone other than their owner, explainer or opener. The thresholds are shown with where they come from and whether anyone confirmed them.
 */
export default function DailyReconScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <DailyReconContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function infoLabels(t: ReturnType<typeof useTranslation>['t'], name: string): InfoFormulaLabels {
  return {
    open: t('govd.recon.info.open', { name }),
    close: t('govd.recon.info.close'),
    formula: t('govd.recon.info.formula'),
    numerator: t('govd.recon.info.numerator'),
    denominator: t('govd.recon.info.denominator'),
    exclusions: t('govd.recon.info.exclusions'),
    source: t('govd.recon.info.source'),
    asOf: t('govd.recon.info.asOf'),
    owner: t('govd.recon.info.owner'),
    version: t('govd.recon.info.version'),
    unverified: t('govd.recon.info.unverified'),
  };
}

/** What a refused pass says: the scope of the caller, the day, or any other refusal. */
function runRefusal(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  switch (describeProblem(error).problem) {
    case 'denied':
      return t('govd.recon.error.denied');
    case 'validation':
      return t('govd.recon.error.validation');
    default:
      return t('govd.recon.error.general');
  }
}

function DailyReconContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const writable = mode !== 'READ_ONLY';
  const mayRead = holds(READ_PERMISSION);
  const mayRun = holds(RUN_PERMISSION) && writable;
  const mayAssign = holds(ASSIGN_PERMISSION) && writable;
  const mayResolve = holds(RESOLVE_PERMISSION) && writable;
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [runDay, setRunDay] = useState('');
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [assigning, setAssigning] = useState<ReconItem | undefined>(undefined);
  const [resolving, setResolving] = useState<{ item: ReconItem; resolution: Resolution } | undefined>(undefined);
  // The range is the latest two weeks ending today; today comes from the server, so the first read has no range and the second has.
  const first = useRuns(undefined, mayRead);
  const today = first.data?.today ?? '';
  const range = today === '' ? undefined : { from: addDays(today, -(DAY_COUNT - 1)), to: today };
  const runs = useRuns(range, mayRead && range !== undefined);
  const page = first.data;
  const daysPage = runs.data;
  const items = useItems({ status }, mayRead);
  const members = useMembers(mayAssign && holds(MEMBER_READ_PERMISSION));
  const run = useRunDay();
  // The days are known only once the read of the range has answered: until then no day is shown as having no pass.
  const days = daysPage === undefined || range === undefined ? undefined : dayRows(daysPage, DAY_COUNT);
  const detail = useRunDetail(selected, mayRead);
  const state = useScreenState({ isLoading: first.isLoading, error: first.error, data: page, isEmpty: () => false });
  const rows = items.data?.items ?? [];
  const summary = items.data?.summary;
  const rule: ReconRule | undefined = page?.rule;
  const problem = sent ? validateRunDay(runDay, today) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (run.isPending || validateRunDay(runDay, today) !== undefined) return;
    run.mutate(
      { day: runDay.trim() },
      {
        onSuccess: (answer) => {
          setSelected(answer?.id);
          setDone(
            answer === undefined
              ? t('govd.recon.run.done')
              : answer.reused
                ? t('govd.recon.run.done.reused', { day: answer.reconDate })
                : t('govd.recon.run.done.written', { day: answer.reconDate, lines: answer.lineCount, opened: answer.openedItems, cleared: answer.clearedItems }),
          );
        },
      },
    );
  };

  const dayColumns: DataTableColumn<DayRow>[] = [
    { key: 'date', header: t('govd.recon.days.column.date'), pinned: true, render: (day) => <span data-testid="day-date">{day.reconDate}</span> },
    {
      key: 'state',
      header: t('govd.recon.days.column.state'),
      render: (day) => (
        <span data-testid="day-state" data-state={day.state}>
          <StatusPill tone={dayTone(day.state)}>{dayStateLabel(t, day.state)}</StatusPill>
        </span>
      ),
    },
    {
      key: 'reason',
      header: t('govd.recon.days.column.reason'),
      render: (day) => <span data-testid="day-reason">{day.state === 'NO_RUN' ? t('govd.recon.days.noRunHint') : partialReasonLabel(t, day.partialReason)}</span>,
    },
    {
      key: 'actions',
      header: t('govd.recon.column.actions'),
      render: (day) =>
        day.runId === null ? null : (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="open-run" onClick={() => setSelected(day.runId ?? undefined)}>
            {t('govd.recon.days.open')}
          </button>
        ),
    },
  ];

  const lineColumns: DataTableColumn<Line>[] = [
    { key: 'project', header: t('govd.recon.lines.column.project'), pinned: true, render: (line) => <span data-testid="line-project">{line.projectCode}</span> },
    { key: 'fund', header: t('govd.recon.lines.column.fund'), render: (line) => <span data-testid="line-fund">{line.fundLabel ?? line.fundKey}</span> },
    { key: 'books', header: t('govd.recon.lines.column.books'), align: 'right', render: (line) => <span data-testid="line-books">{vndText(line.booksVnd, locale)}</span> },
    { key: 'treasury', header: t('govd.recon.lines.column.treasury'), align: 'right', render: (line) => <span data-testid="line-treasury">{vndText(line.treasuryVnd, locale)}</span> },
    { key: 'difference', header: t('govd.recon.lines.column.difference'), align: 'right', render: (line) => <span data-testid="line-difference">{differenceText(line.differenceVnd, locale)}</span> },
    {
      key: 'kind',
      header: t('govd.recon.lines.column.kind'),
      render: (line) => (
        <span data-testid="line-kind" data-kind={line.kind ?? ''}>
          {line.kind === null ? '' : kindLabel(t, line.kind)}
          {line.opensItem ? (
            <>
              {' '}
              <StatusPill tone="warning">{t('govd.recon.lines.opens')}</StatusPill>
            </>
          ) : null}
        </span>
      ),
    },
  ];

  const itemColumns: DataTableColumn<ReconItem>[] = [
    { key: 'project', header: t('govd.recon.items.column.project'), pinned: true, render: (item) => <span data-testid="item-project">{item.projectCode}</span> },
    { key: 'fund', header: t('govd.recon.items.column.fund'), render: (item) => <span data-testid="item-fund">{item.fundLabel ?? item.fundKey}</span> },
    { key: 'day', header: t('govd.recon.items.column.day'), render: (item) => <span data-testid="item-day">{item.reconDate}</span> },
    { key: 'kind', header: t('govd.recon.items.column.kind'), render: (item) => <span data-testid="item-kind">{kindLabel(t, item.kind)}</span> },
    { key: 'books', header: t('govd.recon.items.column.books'), group: t('govd.recon.items.group.figures'), align: 'right', render: (item) => <span data-testid="item-books">{vndText(item.booksVnd, locale)}</span> },
    { key: 'treasury', header: t('govd.recon.items.column.treasury'), group: t('govd.recon.items.group.figures'), align: 'right', render: (item) => <span data-testid="item-treasury">{vndText(item.treasuryVnd, locale)}</span> },
    { key: 'difference', header: t('govd.recon.items.column.difference'), group: t('govd.recon.items.group.figures'), align: 'right', render: (item) => <span data-testid="item-difference">{differenceText(item.differenceVnd, locale)}</span> },
    { key: 'owner', header: t('govd.recon.items.column.owner'), render: (item) => <span data-testid="item-owner">{item.ownerName ?? item.ownerMembershipId}</span> },
    {
      key: 'due',
      header: t('govd.recon.items.column.due'),
      render: (item) => (
        <>
          <span data-testid="item-due">{item.dueOn}</span>
          {item.overdue ? (
            <span data-testid="item-overdue">
              {' '}
              <StatusPill tone="warning">{t('govd.recon.items.overdue')}</StatusPill>
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: 'status',
      header: t('govd.recon.items.column.status'),
      render: (item) => (
        <span data-testid="item-status" data-status={item.status}>
          <StatusPill tone={itemTone(item.status)}>{itemStatusLabel(t, item.status)}</StatusPill>
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('govd.recon.column.actions'),
      render: (item) =>
        isWaiting(item) ? (
          <span className="pay-row-actions">
            {mayAssign && item.actions.assign ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="assign" onClick={() => setAssigning(item)}>
                {t('govd.recon.item.assign')}
              </button>
            ) : null}
            {mayResolve && item.actions.explain ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="explain" onClick={() => setResolving({ item, resolution: 'EXPLAINED' })}>
                {resolutionLabel(t, 'EXPLAINED')}
              </button>
            ) : null}
            {mayResolve && item.actions.resolve ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="resolve" onClick={() => setResolving({ item, resolution: 'RESOLVED' })}>
                {resolutionLabel(t, 'RESOLVED')}
              </button>
            ) : null}
            {mayResolve && item.actions.writeOff ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="write-off" onClick={() => setResolving({ item, resolution: 'WRITTEN_OFF' })}>
                {resolutionLabel(t, 'WRITTEN_OFF')}
              </button>
            ) : null}
          </span>
        ) : null,
    },
  ];

  const partial = detail.data?.run.status === 'PARTIAL' ? detail.data.run : undefined;
  const lines = detail.data?.lines ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govd.recon.title')}</h1>
          <p>{t('govd.recon.subtitle')}</p>
        </div>
      </div>
      <ScopeBar
        money
        extra={[{ label: t('govd.recon.ctx.status'), value: ITEM_STATUSES.find((candidate) => candidate === status) === undefined ? t('govd.recon.filter.all') : itemStatusLabel(t, status as ItemStatus) }]}
        updatedAt={items.dataUpdatedAt}
        stale={items.isRefetchError || runs.isRefetchError}
      />
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('govd.recon.read.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void first.refetch()}>
          {rule === undefined ? null : (
            <SectionCard title={t('govd.recon.rule.title')} unit={t('w2pay.ctx.unit')}>
              <p data-testid="rule" data-source={rule.source} data-unverified={rule.unverified ? 'yes' : 'no'}>
                {rule.source === 'DEFAULT' ? t('govd.recon.rule.default') : t('govd.recon.rule.approved', { version: rule.version })}{' '}
                {t('govd.recon.rule.numbers', { threshold: vndText(rule.thresholdVnd, locale), days: rule.dueDays, grace: rule.partialAfterDays })}
              </p>
              <InfoFormula
                name={t('govd.recon.info.name')}
                formula={t('govd.recon.info.formulaText')}
                numerator={t('govd.recon.info.numeratorText')}
                denominator={null}
                exclusions={[t('govd.recon.info.exclusionTiming')]}
                source={t('govd.recon.info.sourceText')}
                asOf={page?.today ?? ''}
                owner={t('govd.recon.info.ownerText')}
                version={rule.source === 'DEFAULT' ? t('govd.recon.info.versionDefault') : t('govd.recon.info.versionRule', { version: rule.version })}
                unverified={rule.unverified}
                labels={infoLabels(t, t('govd.recon.info.name'))}
              />
              {rule.unverified ? (
                <p className="callout warning" role="status" data-testid="rule-unverified">
                  {t('govd.recon.rule.unverified')}
                </p>
              ) : null}
            </SectionCard>
          )}
          <KpiStrip label={t('govd.recon.kpi.label')}>
            <KpiTile label={t('govd.recon.kpi.waiting')} value={String(summary?.waiting ?? 0)} tone="info" state={items.isLoading ? 'loading' : items.isError ? 'error' : 'ready'} onRetry={() => void items.refetch()} />
            <KpiTile label={t('govd.recon.kpi.overdue')} value={String(summary?.overdue ?? 0)} tone={(summary?.overdue ?? 0) > 0 ? 'warning' : 'neutral'} state={items.isLoading ? 'loading' : items.isError ? 'error' : 'ready'} onRetry={() => void items.refetch()} />
            <KpiTile label={t('govd.recon.kpi.difference')} value={differenceText(summary?.waitingDifferenceVnd ?? '0', locale)} unit={t('w2pay.ctx.unit')} state={items.isLoading ? 'loading' : items.isError ? 'error' : 'ready'} onRetry={() => void items.refetch()} />
          </KpiStrip>

          <SectionCard title={t('govd.recon.days.title')}>
            <div data-testid="days">
              {runs.isError ? (
                <div className="pay-row-actions">
                  <p className="callout warning" role="alert" data-testid="days-failed">
                    {t('govd.recon.days.failed')}
                  </p>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void runs.refetch()}>
                    {t('ui.common.retry')}
                  </button>
                </div>
              ) : days === undefined ? (
                <DataTable caption={t('govd.recon.days.title')} columns={dayColumns} rows={[]} rowKey={(day) => day.reconDate} state="loading" />
              ) : (
                <DataTable caption={t('govd.recon.days.title')} columns={dayColumns} rows={days} rowKey={(day) => day.reconDate} rowAttrs={(day) => ({ 'data-day': day.reconDate, 'data-state': day.state })} />
              )}
            </div>
            {mayRun ? (
              <form onSubmit={send} noValidate className="pay-row-actions" data-testid="run-form">
                <Field id="daily-run-day" label={t('govd.recon.run.day')} hint={t('govd.recon.run.dayHint')} error={problem === undefined ? undefined : problemMessage(t, problem)}>
                  <input id="daily-run-day" type="date" max={today === '' ? undefined : today} value={runDay} onChange={(event) => setRunDay(event.target.value)} />
                </Field>
                <button type="submit" className="ui-button ui-button--primary" disabled={run.isPending} data-action="run">
                  {run.isPending ? t('govd.recon.run.pending') : t('govd.recon.run.submit')}
                </button>
                {run.isError ? (
                  <p className="callout warning" role="alert" data-testid="run-refusal">
                    {runRefusal(t, run.error)}
                  </p>
                ) : null}
              </form>
            ) : null}
          </SectionCard>

          {selected === undefined ? null : (
            <SectionCard title={t('govd.recon.lines.title')} unit={t('w2pay.ctx.unit')}>
              {detail.isLoading ? (
                <p className="sub" role="status" data-testid="lines-loading">
                  {t('govd.recon.lines.loading')}
                </p>
              ) : detail.isError ? (
                <div className="pay-row-actions">
                  <p className="callout warning" role="alert" data-testid="lines-failed">
                    {t('govd.recon.lines.failed')}
                  </p>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void detail.refetch()}>
                    {t('ui.common.retry')}
                  </button>
                </div>
              ) : detail.data === null || detail.data === undefined ? (
                <p className="sub" data-testid="lines-missing">
                  {t('govd.recon.lines.missing')}
                </p>
              ) : (
                <>
                  <p data-testid="run-summary">
                    {t('govd.recon.run.summary', { no: detail.data.run.runNo, day: detail.data.run.reconDate, lines: detail.data.run.lineCount, imports: detail.data.run.statementImports })}
                    {detail.data.run.booksTotalVnd === null || detail.data.run.treasuryTotalVnd === null
                      ? ''
                      : ` ${t('govd.recon.run.totals', { books: vndText(detail.data.run.booksTotalVnd, locale), treasury: vndText(detail.data.run.treasuryTotalVnd, locale) })}`}
                  </p>
                  {partial === undefined ? null : (
                    <p className="callout warning" role="alert" data-testid="partial">
                      {partial.partialReason === 'SOURCE_UNREADABLE' ? t('govd.recon.partial.sourceUnreadable', { day: partial.reconDate }) : t('govd.recon.partial.statementMissing', { day: partial.reconDate })}
                    </p>
                  )}
                  {detail.data.run.calendarBasis === 'WEEKDAYS_ASSUMED' ? (
                    <p className="sub" data-testid="calendar-assumed">
                      {t('govd.recon.run.calendarAssumed')}
                    </p>
                  ) : null}
                  {lines.length === 0 ? (
                    <p className="sub" data-testid="no-lines">
                      {partial === undefined ? t('govd.recon.lines.empty') : t('govd.recon.lines.emptyPartial')}
                    </p>
                  ) : (
                    <div data-testid="lines">
                      <DataTable caption={t('govd.recon.lines.title')} columns={lineColumns} rows={lines} rowKey={(line) => line.id} rowAttrs={(line) => ({ 'data-line': line.id, 'data-kind': line.kind ?? '' })} />
                      <p className="sub" data-testid="differing">
                        {t('govd.recon.lines.differing', { count: differingLines(lines).length })}
                      </p>
                    </div>
                  )}
                  {detail.data.hiddenLines > 0 ? (
                    <p className="sub" data-testid="hidden-lines">
                      {t('govd.recon.lines.hidden', { count: detail.data.hiddenLines })}
                    </p>
                  ) : null}
                </>
              )}
            </SectionCard>
          )}

          <FilterPanel applied={status === '' ? 0 : 1} unitLabel={t('w2pay.ctx.unit')}>
            <div className="field">
              <label htmlFor="daily-status">{t('govd.recon.filter.status')}</label>
              <select id="daily-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">{t('govd.recon.filter.all')}</option>
                {ITEM_STATUSES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {itemStatusLabel(t, candidate)}
                  </option>
                ))}
              </select>
            </div>
          </FilterPanel>
          <SectionCard title={t('govd.recon.items.title')} unit={t('w2pay.ctx.unit')}>
            {items.isError ? (
              <div className="pay-row-actions">
                <p className="callout warning" role="alert" data-testid="items-failed">
                  {t('govd.recon.items.failed')}
                </p>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void items.refetch()}>
                  {t('ui.common.retry')}
                </button>
              </div>
            ) : rows.length === 0 && status === '' ? (
              <p className="sub" data-testid="nothing">
                {t('govd.recon.items.empty')}
              </p>
            ) : (
              <div data-testid="items">
                <DataTable
                  caption={t('govd.recon.items.title')}
                  columns={itemColumns}
                  rows={rows}
                  rowKey={(item) => item.id}
                  rowAttrs={(item) => ({ 'data-item': item.id, 'data-status': item.status, 'data-overdue': item.overdue ? 'yes' : 'no' })}
                  emptyKind={status === '' ? 'none' : 'filtered'}
                  onClearFilters={() => setStatus('')}
                />
              </div>
            )}
          </SectionCard>
        </StateBoundary>
      )}
      {assigning === undefined ? null : (
        <AssignDialog
          item={assigning}
          people={members.data ?? []}
          today={today}
          onDone={() => {
            setDone(t('govd.recon.done.assigned'));
            setAssigning(undefined);
          }}
          onClose={() => setAssigning(undefined)}
        />
      )}
      {resolving === undefined ? null : (
        <ResolveDialog
          item={resolving.item}
          resolution={resolving.resolution}
          onDone={() => {
            setDone(t('govd.recon.done.resolved'));
            setResolving(undefined);
          }}
          onClose={() => setResolving(undefined)}
        />
      )}
      <p className="prototype-note">{t('govd.recon.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
