import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import '../dis.css';
import { Field } from '../components';
import { NONE, money, signedVnd } from '../rates/components';
import { useWeeklyPlans } from './hooks';
import { isValidationRefusal, planYearOf, standingOf } from './model';
import type { Standing, WeeklyPlanView } from './model';

/** The commitment is a plan: a week below it is a warning, a week at or over it is met, and a week that is not frozen has no standing at all. */
const TONE: Readonly<Record<Standing, Tone>> = { short: 'warning', met: 'success', over: 'success', unknown: 'neutral' };

type Plan = WeeklyPlanView;

/**
 * DIS-24: the weekly commitment of each project against what the Treasury paid in the week, with the leader in charge (ST-DIS-014, FR-DIS-24, Directive 162). Read only: the commitments are registered
 * on the capital schedule and the actuals are the frozen close snapshots. A commitment is a plan: it is never added to what was disbursed, and a week that is not frozen yet has no actual (it is not zero).
 */
export default function WeeklyPlanScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <WeeklyPlanContent key={tenantId ?? 'none'} route={route} />;
}

function WeeklyPlanContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  const [yearInput, setYearInput] = useState('');
  const year = planYearOf(yearInput);
  const plans = useWeeklyPlans({ planYear: year.year });
  const state = useScreenState({ isLoading: plans.isLoading, error: plans.error, data: plans.data, isEmpty: (data) => (data as { pages: Array<{ items: unknown[] }> }).pages.every((page) => page.items.length === 0) });
  const items = (plans.data?.pages ?? []).flatMap((page) => page.items);
  const shownYear = plans.data?.pages[0]?.planYear;
  const refused = plans.isError && isValidationRefusal(plans.error);
  const columns: DataTableColumn<Plan>[] = [
    {
      key: 'project',
      header: t('dis.weekly.col.project'),
      pinned: true,
      render: (row) => (
        <span data-project={row.projectId} data-period={row.periodId}>
          <strong>{row.projectCode}</strong>
          <span className="dis-code">{row.projectName}</span>
        </span>
      ),
    },
    { key: 'leader', header: t('dis.weekly.col.leader'), render: (row) => <span data-cell="leader">{row.leader === null ? t('dis.weekly.leader.none') : row.leader.displayName}</span> },
    {
      key: 'week',
      header: t('dis.weekly.col.week'),
      render: (row) => (
        <>
          {row.periodCode}
          <span className="dis-code">{t('dis.weekly.week.range', { start: row.startDate, end: row.endDate })}</span>
        </>
      ),
    },
    { key: 'commitment', header: t('dis.weekly.col.commitment'), align: 'right', render: (row) => <span data-cell="commitment">{money(row.commitmentVnd)}</span> },
    {
      key: 'actual',
      header: t('dis.weekly.col.actual'),
      align: 'right',
      render: (row) => (
        <span data-cell="actual">
          {row.actualVnd === null ? <span className="muted">{t('dis.weekly.actual.pending')}</span> : money(row.actualVnd)}
          {row.actualVnd !== null && row.fromYearStart ? <span className="dis-code">{t('dis.weekly.actual.fromYearStart')}</span> : null}
        </span>
      ),
    },
    {
      key: 'difference',
      header: t('dis.weekly.col.difference'),
      align: 'right',
      render: (row) => {
        const standing = standingOf(row.differenceVnd);
        return (
          <span data-cell="difference">
            {row.differenceVnd === null ? (
              NONE
            ) : (
              <span data-standing={standing}>
                <StatusPill tone={TONE[standing]}>{signedVnd(row.differenceVnd)}</StatusPill>
              </span>
            )}
          </span>
        );
      },
    },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.weekly.page.title')}</h1>
          <p>{t('dis.weekly.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
          { label: t('w2dis.forecast.ctx.year'), value: shownYear === undefined ? NONE : String(shownYear) },
        ]}
        unit={t('dis.wr.unit')}
      />
      <FilterPanel
        applied={yearInput === '' ? 0 : 1}
        actions={
          yearInput === '' ? undefined : (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setYearInput('')}>
              {t('dis.reports.filter.clear.action')}
            </button>
          )
        }
      >
        <div className="dis-filters" role="group" aria-label={t('dis.weekly.filter.title')}>
          <Field id="weekly-year" label={t('dis.weekly.filter.year')} error={year.valid ? undefined : t('dis.weekly.filter.year.invalid')} hint={t('dis.weekly.filter.year.hint')}>
            <input id="weekly-year" inputMode="numeric" maxLength={4} value={yearInput} onChange={(event) => setYearInput(event.target.value)} />
          </Field>
        </div>
      </FilterPanel>
      {refused ? (
        <p className="dis-w2-banner" role="alert" data-testid="weekly-refusal">
          {t('dis.weekly.problem.validation')}
        </p>
      ) : null}
      <StateBoundary state={refused ? 'default' : state === 'empty' ? 'default' : state} onRetry={() => void plans.refetch()}>
        <SectionCard title={t('dis.weekly.table.title', { year: shownYear === undefined ? NONE : String(shownYear) })} unit={t('dis.wr.unit')}>
          <p className="dis-w2-note">{t('dis.weekly.table.note')}</p>
          <DataTable caption={t('dis.weekly.table.aria')} columns={columns} rows={items} rowKey={(row) => `${row.projectId}|${row.periodId}`} emptyKind={yearInput === '' ? 'none' : 'filtered'} onClearFilters={() => setYearInput('')} />
          {plans.hasNextPage ? (
            <p className="dis-w2-more">
              <button type="button" className="ui-button ui-button--outline" disabled={plans.isFetchingNextPage} onClick={() => void plans.fetchNextPage()}>
                {t('dis.weekly.more.action')}
              </button>
            </p>
          ) : null}
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('dis.weekly.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
