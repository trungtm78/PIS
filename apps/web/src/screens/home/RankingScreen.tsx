import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { formatVnd } from '../dis/report/money';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { FORMULA_REFERENCE, shortId } from './model';
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
      <div className="card">
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
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {rankings === undefined ? null : (
            <>
              <p className="sub" data-testid="ranking-context">
                {t('home.ranking.snapshot', { id: shortId(rankings.snapshotId), date: rankings.asOfDate })}
              </p>
              {rankings.definitionStatus === 'SIGNED' ? null : <p className="pill warn">{t('home.tile.definition.pending', { ref: FORMULA_REFERENCE })}</p>}
              {rankings.visibility === 'OWN_ONLY' ? (
                <p className="pill" data-testid="ranking-own-only">
                  {t('home.ranking.visibility.ownOnly')}
                </p>
              ) : null}
              {tables.length === 0 ? <p data-testid="ranking-no-table">{t('home.ranking.noTable')}</p> : null}
              {tables.map((table) => (
                <section key={`${table.comparisonGroup}|${table.denominator}`} aria-labelledby={`ranking-${table.comparisonGroup}-title`} data-table={`${table.comparisonGroup}|${table.denominator}`} data-testid="ranking-table">
                  <h2 id={`ranking-${table.comparisonGroup}-title`}>{t('home.ranking.table.title', { group: table.comparisonGroup, denominator: denominatorLabel(t, table.denominator) })}</h2>
                  <RankedTable rows={table.ranked} />
                  {table.excluded.length === 0 ? null : (
                    <div data-testid="ranking-excluded">
                      <h3>{t('home.ranking.excluded.title')}</h3>
                      <ul className="mne-lines">
                        {table.excluded.map((row) => (
                          <li key={row.unitId} data-unit-id={row.unitId}>
                            {row.unitCode} {row.unitName}: {reasonLabel(t, row.excludedReason)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              ))}
            </>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}

function RankedTable({ rows }: { rows: RankingRow[] }) {
  const { t } = useTranslation();
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{t('home.ranking.column.rank')}</th>
            <th scope="col">{t('home.ranking.column.unit')}</th>
            <th scope="col">{t('home.ranking.column.plan')}</th>
            <th scope="col">{t('home.ranking.column.disbursed')}</th>
            <th scope="col">{t('home.ranking.column.rate')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.unitId} data-unit-id={row.unitId}>
              <td>{row.rank}</td>
              <td>
                {row.unitCode} <span className="sub">{row.unitName}</span>
              </td>
              <td>{money(row.planVnd)}</td>
              <td>{money(row.disbursedVnd)}</td>
              <td data-testid={`rate-${row.unitId}`}>{row.ratePct === null ? t('home.tile.nullReason.noData') : t('home.tile.value.percent', { value: row.ratePct })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
