import { useState } from 'react';
import { ApiError } from '@machvon/api-client';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../dis.css';
import { useSnapshotLines } from '../snapshot/hooks';
import type { LinesPage, SnapshotLineView } from '../snapshot/model';
import { DefinitionBadge, NONE, SnapshotPicker, coverageLabel, money, rateText, signedVnd } from './components';
import { useFrozenSnapshots, useRates } from './hooks';
import { PAIRED_PATH, NULL_REASONS } from './model';
import type { NullReason } from './model';

type T = Translator['t'];

/** The columns a person can switch on and off; the project and the cell stay, pinned. The two rates are one column of the choice: they never come alone. */
export const COLUMNS = ['planPm', 'planLocal', 'planTotal', 'treasury', 'reported', 'ctmtqg', 'delta', 'rates', 'coverage'] as const;
export type Column = (typeof COLUMNS)[number];
const STORAGE_KEY = 'machvon.dis16.columns';

function savedColumns(tenantId: string | undefined): Column[] {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}.${tenantId ?? ''}`);
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    return Array.isArray(parsed) ? COLUMNS.filter((column) => parsed.includes(column)) : [...COLUMNS];
  } catch {
    return [...COLUMNS];
  }
}

function columnLabel(t: T, column: Column): string {
  switch (column) {
    case 'planPm':
      return t('dis.full.column.planPm');
    case 'planLocal':
      return t('dis.full.column.planLocal');
    case 'planTotal':
      return t('dis.full.column.planTotal');
    case 'treasury':
      return t('dis.full.column.treasury');
    case 'reported':
      return t('dis.full.column.reported');
    case 'ctmtqg':
      return t('dis.full.column.ctmtqg');
    case 'delta':
      return t('dis.full.column.delta');
    case 'rates':
      return t('dis.full.column.rates');
    case 'coverage':
      return t('dis.full.column.coverage');
  }
}

const reasonOf = (value: string | null): NullReason | null => NULL_REASONS.find((candidate) => candidate === value) ?? null;
const sum = (lines: readonly SnapshotLineView[], pick: (line: SnapshotLineView) => string | null): string | null =>
  lines.reduce<bigint | null>((total, line) => {
    const value = pick(line);
    return value === null ? total : (total ?? 0n) + BigInt(value);
  }, null)?.toString() ?? null;

function bucketLabel(t: T, bucket: string): string {
  return bucket === 'CURRENT_YEAR' ? t('dis.snapshot.bucket.currentYear') : bucket === 'CARRYOVER' ? t('dis.snapshot.bucket.carryover') : t('dis.snapshot.bucket.other');
}

/**
 * DIS-16: the full table of the figures of a frozen snapshot, a line for each project and cell of the report (ST-DIS-010, FR-DIS-16, FR-DIS-19). The project and the cell are pinned, the other columns are chosen
 * by the person (kept for the next visit), the two rates are one choice and come together, and the CTMTQG is a column of its own: it is part of the cell above it and never added to the total.
 */
export default function FullTableScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <FullTableContent key={tenantId ?? 'none'} route={route} />;
}

function FullTableContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenantId = useSession().tenant?.id;
  const [params, setParams] = useSearchParams();
  const frozen = useFrozenSnapshots();
  const [visible, setVisible] = useState<Column[]>(() => savedColumns(tenantId));
  const [configuring, setConfiguring] = useState(false);
  const named = params.get('snapshot') ?? '';
  // The newest frozen close figure when none is named: the server says which, the way it does for the two rates.
  const resolved = useRates({ snapshotId: named, basis: 'CURRENT_YEAR' });
  const chosen = named !== '' ? named : resolved.data?.snapshotId;
  const lines = useSnapshotLines(chosen);
  const state = useScreenState({
    isLoading: frozen.isLoading || (named === '' && resolved.isLoading) || (chosen !== undefined && lines.isLoading),
    error: frozen.error ?? lines.error ?? (named === '' && resolved.error instanceof ApiError && resolved.error.status === 404 ? undefined : resolved.error),
    data: chosen === undefined ? (resolved.isLoading ? undefined : []) : lines.data,
    isEmpty: (data) => (Array.isArray(data) ? true : (data as { pages: LinesPage[] }).pages.every((page) => page.items.length === 0)),
  });
  const items: SnapshotLineView[] = (lines.data?.pages ?? []).flatMap((page) => page.items);
  const header = lines.data?.pages[0]?.snapshot;
  const shown = (column: Column): boolean => visible.includes(column);
  const toggle = (column: Column): void => {
    const next = visible.includes(column) ? visible.filter((item) => item !== column) : COLUMNS.filter((item) => item === column || visible.includes(item));
    setVisible(next);
    try {
      window.localStorage.setItem(`${STORAGE_KEY}.${tenantId ?? ''}`, JSON.stringify(next));
    } catch {
      // The choice is kept for this visit only.
    }
  };
  const choose = (next: string): void => {
    const value = new URLSearchParams(params);
    if (next === '') value.delete('snapshot');
    else value.set('snapshot', next);
    setParams(value, { replace: true });
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.full.page.title')}</h1>
          <p>{t('dis.full.page.subtitle')}</p>
        </div>
        {header === undefined ? null : <DefinitionBadge definition={header.definitionStatus} />}
      </div>
      <div className="card">
        <div className="dis-filters">
          <SnapshotPicker id="full-snapshot" value={named} onChange={choose} snapshots={frozen.data ?? []} />
          <div>
            <button type="button" aria-expanded={configuring} aria-controls="full-columns" onClick={() => setConfiguring((open) => !open)}>
              {t('dis.full.columns.action')}
            </button>
          </div>
        </div>
        {configuring ? (
          <fieldset id="full-columns" className="dis-scope" data-testid="column-config">
            <legend>{t('dis.full.columns.legend')}</legend>
            <p className="sub">{t('dis.full.columns.hint')}</p>
            {COLUMNS.map((column) => (
              <label key={column} className="dis-radio">
                <input type="checkbox" checked={shown(column)} onChange={() => toggle(column)} />
                {columnLabel(t, column)}
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void lines.refetch()}>
        <section className="card" aria-labelledby="full-table-title">
          <h2 id="full-table-title">{t('dis.full.table.title')}</h2>
          {header === undefined ? null : (
            <p className="sub" data-testid="full-cutoff">
              {t('dis.full.cutoff.text', { cutoff: header.cutoffDate })} · <Link to={`${PAIRED_PATH}?snapshot=${header.id}`}>{t('dis.full.link.paired')}</Link>
            </p>
          )}
          <dl className="aud-facts" data-testid="full-totals">
            <dt>{t('dis.full.total.reported')}</dt>
            <dd data-testid="total-reported">{money(sum(items, (line) => line.reportedVnd))}</dd>
            <dt>{t('dis.full.total.ctmtqg')}</dt>
            <dd data-testid="total-ctmtqg">{money(sum(items, (line) => line.ctmtqgVnd))}</dd>
          </dl>
          <p className="sub">{t('dis.full.total.note')}</p>
          <div className="tablewrap">
            <table className="table dis-full-table" aria-label={t('dis.full.table.aria')} data-testid="full-table">
              <thead>
                <tr>
                  <th scope="col" className="pinned pinned-first">
                    {t('dis.snapshot.line.project')}
                  </th>
                  <th scope="col" className="pinned pinned-second">
                    {t('dis.snapshot.line.cell')}
                  </th>
                  {shown('planPm') ? <th scope="col" className="num">{t('dis.snapshot.line.planPm')}</th> : null}
                  {shown('planLocal') ? <th scope="col" className="num">{t('dis.snapshot.line.planLocal')}</th> : null}
                  {shown('planTotal') ? <th scope="col" className="num">{t('dis.full.column.planTotal')}</th> : null}
                  {shown('treasury') ? <th scope="col" className="num">{t('dis.snapshot.line.treasury')}</th> : null}
                  {shown('reported') ? <th scope="col" className="num">{t('dis.snapshot.line.reported')}</th> : null}
                  {shown('ctmtqg') ? <th scope="col" className="num">{t('dis.full.col.ctmtqg')}</th> : null}
                  {shown('delta') ? <th scope="col" className="num">{t('dis.snapshot.line.delta')}</th> : null}
                  {shown('rates') ? (
                    <>
                      <th scope="col" className="num">{t('dis.rates.col.ratePm')}</th>
                      <th scope="col" className="num">{t('dis.rates.col.rateTotal')}</th>
                    </>
                  ) : null}
                  {shown('coverage') ? <th scope="col">{t('dis.rates.col.coverage')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((line) => (
                  <tr key={line.id} data-line={line.id}>
                    <td className="pinned pinned-first">{line.projectCode}</td>
                    <td className="pinned pinned-second">{t('dis.snapshot.line.cell.text', { bucket: bucketLabel(t, line.bucket), level: line.budgetLevel === 'CENTRAL' ? t('dis.snapshot.level.central') : t('dis.snapshot.level.local') })}</td>
                    {shown('planPm') ? <td className="num">{money(line.planPmVnd)}</td> : null}
                    {shown('planLocal') ? <td className="num">{money(line.planLocalVnd)}</td> : null}
                    {shown('planTotal') ? <td className="num">{money(line.planTotalVnd)}</td> : null}
                    {shown('treasury') ? <td className="num">{money(line.treasuryVnd)}</td> : null}
                    {shown('reported') ? <td className="num" data-col="reported">{money(line.reportedVnd)}</td> : null}
                    {shown('ctmtqg') ? <td className="num" data-col="ctmtqg">{money(line.ctmtqgVnd)}</td> : null}
                    {shown('delta') ? <td className="num">{line.deltaVnd === null ? NONE : signedVnd(line.deltaVnd)}</td> : null}
                    {shown('rates') ? (
                      <>
                        <td className="num" data-rate="pm">{rateText(t, line.ratePmPct, reasonOf(line.rateNullReason))}</td>
                        <td className="num" data-rate="total">{rateText(t, line.rateTotalPct, reasonOf(line.rateNullReason))}</td>
                      </>
                    ) : null}
                    {shown('coverage') ? <td>{coverageLabel(t, line.coverage === 'COMPLETE' || line.coverage === 'PARTIAL' ? line.coverage : 'NONE')}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lines.hasNextPage ? (
            <p>
              <button type="button" disabled={lines.isFetchingNextPage} onClick={() => void lines.fetchNextPage()}>
                {t('dis.snapshot.lines.more.action')}
              </button>
            </p>
          ) : null}
        </section>
      </StateBoundary>
      <p className="prototype-note">{t('dis.full.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
