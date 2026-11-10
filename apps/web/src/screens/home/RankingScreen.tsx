import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { formatVnd } from '../dis/report/money';
import { Field } from '../mne/components';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import '../dis/dis.css';
import './home.css';
import { FORMULA_REFERENCE, shortId } from './model';
import { dayText } from './overview-model';
import { useRankings } from './warning-hooks';
import { DENOMINATORS, groupsOf, tablesFor } from './warning-model';
import type { Denominator, RankingRow } from './warning-model';

type T = Translator['t'];

function denominatorLabel(t: T, denominator: Denominator): string {
  return denominator === 'PM_ASSIGNED' ? t('home.ranking.denominator.pm') : t('home.ranking.denominator.total');
}

/** Why a unit is not in the order: a plan of nothing, a plan below the minimum, or no figure. */
function reasonLabel(t: T, reason: string | null): string {
  switch (reason) {
    case 'ZERO_DENOMINATOR':
      return t('home.ranking.reason.zeroDenominator');
    case 'PLAN_BELOW_MINIMUM':
      return t('home.ranking.reason.belowMinimum');
    case 'NO_DATA':
      return t('home.ranking.reason.noData');
    default:
      return t('home.ranking.reason.other');
  }
}

const money = (value: string | null): string => (value === null ? '—' : formatVnd(value));

/**
 * HOME-04: the ranking of the units (ST-HOME-003, HOME 3 F3, BR-HOME-06): the ranking DIS computed when the close snapshot was frozen, a table for each comparison group over the denominator the reader chooses (the plan the
 * Prime Minister gave, or the plan with what the province added: two tables, never mixed), the units in their order and, apart, the ones that were left out with the reason and no position. Read-only.
 */
export default function RankingScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <RankingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RankingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  const [denominator, setDenominator] = useState<Denominator>('PM_ASSIGNED');
  const [group, setGroup] = useState('');
  const query = useRankings();
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data, isEmpty: (data) => (data as { tables: unknown[] }).tables.length === 0 });
  const rankings = query.data;
  const groups = useMemo(() => (rankings === undefined ? [] : groupsOf(rankings)), [rankings]);
  const tables = rankings === undefined ? [] : tablesFor(rankings, denominator, group);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.ranking.page.title')}</h1>
          <p>{t('home.ranking.page.subtitle')}</p>
        </div>
      </div>
      <div className="home-stack">
        {rankings === undefined ? null : (
          <ContextBar
            items={[
              { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
              { label: t('home.drill.fact.asOf'), value: dayText(rankings.asOfDate) },
              { label: t('home.ranking.denominator.label'), value: denominatorLabel(t, denominator) },
            ]}
            unit={t('dis.wr.unit')}
          />
        )}
        <FilterPanel
          unitLabel={t('dis.wr.unit')}
          applied={group === '' ? 0 : 1}
          actions={
            group === '' ? undefined : (
              <button type="button" className="ui-button ui-button--outline" onClick={() => setGroup('')}>
                {t('w2dis.home.filter.clear')}
              </button>
            )
          }
        >
          <div className="dis-filters" role="group" aria-label={t('home.ranking.filter.title')}>
            <Field id="ranking-denominator" label={t('home.ranking.denominator.label')} error={undefined}>
              <select id="ranking-denominator" value={denominator} onChange={(event) => setDenominator(event.target.value as Denominator)}>
                {DENOMINATORS.map((option) => (
                  <option key={option} value={option}>
                    {denominatorLabel(t, option)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="ranking-group" label={t('home.ranking.group.label')} error={undefined}>
              <select id="ranking-group" value={group} onChange={(event) => setGroup(event.target.value)}>
                <option value="">{t('home.ranking.group.all')}</option>
                {groups.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </FilterPanel>
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {rankings === undefined ? null : (
            <>
              <p className="home-note" data-testid="ranking-context">
                {t('home.ranking.snapshot', { id: shortId(rankings.snapshotId), date: dayText(rankings.asOfDate) })}
              </p>
              {rankings.definitionStatus === 'SIGNED' ? null : (
                <p>
                  <StatusPill tone="warning">{t('home.tile.definition.pending', { ref: FORMULA_REFERENCE })}</StatusPill>
                </p>
              )}
              {rankings.visibility === 'OWN_ONLY' ? (
                <p data-testid="ranking-own-only">
                  <StatusPill tone="info">{t('home.ranking.visibility.ownOnly')}</StatusPill>
                </p>
              ) : null}
              {tables.length === 0 ? <p data-testid="ranking-no-table">{t('home.ranking.noTable')}</p> : null}
              {tables.map((table) => (
                <div key={`${table.comparisonGroup}|${table.denominator}`} data-table={`${table.comparisonGroup}|${table.denominator}`} data-testid="ranking-table">
                  <SectionCard title={t('home.ranking.table.title', { group: table.comparisonGroup, denominator: denominatorLabel(t, table.denominator) })} unit={t('dis.wr.unit')}>
                    <RankedTable rows={table.ranked} caption={t('home.ranking.table.title', { group: table.comparisonGroup, denominator: denominatorLabel(t, table.denominator) })} />
                    {table.excluded.length === 0 ? null : (
                      <div data-testid="ranking-excluded" className="home-excluded">
                        <h3>{t('home.ranking.excluded.title')}</h3>
                        <ul className="home-lines">
                          {table.excluded.map((row) => (
                            <li key={row.unitId} data-unit-id={row.unitId}>
                              {row.unitCode} {row.unitName}: {reasonLabel(t, row.excludedReason)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </SectionCard>
                </div>
              ))}
            </>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}

function RankedTable({ rows, caption }: { rows: RankingRow[]; caption: string }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<RankingRow>[] = [
    { key: 'rank', header: t('home.ranking.column.rank'), pinned: true, render: (row) => <span data-unit-id={row.unitId}>{row.rank}</span> },
    {
      key: 'unit',
      header: t('home.ranking.column.unit'),
      render: (row) => (
        <>
          <strong>{row.unitCode}</strong>
          <span className="dis-code">{row.unitName}</span>
        </>
      ),
    },
    { key: 'plan', header: t('home.ranking.column.plan'), align: 'right', render: (row) => money(row.planVnd) },
    { key: 'disbursed', header: t('home.ranking.column.disbursed'), align: 'right', render: (row) => money(row.disbursedVnd) },
    {
      key: 'rate',
      header: t('home.ranking.column.rate'),
      align: 'right',
      render: (row) => <span data-testid={`rate-${row.unitId}`}>{row.ratePct === null ? t('home.tile.nullReason.noData') : t('home.tile.value.percent', { value: row.ratePct })}</span>,
    },
  ];
  return <DataTable caption={caption} columns={columns} rows={rows} rowKey={(row) => row.unitId} />;
}
